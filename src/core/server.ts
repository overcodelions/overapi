// The MCP server: a project and one of its environments, offered to an
// agent as tools. Built on the SDK's low-level Server because the tools'
// input schemas come from the project as plain JSON Schema, not zod.
//
// The safety model, in the order it applies:
//   1. A tool that is off is never listed.
//   2. Write and destructive tools are listed only when the environment
//      allows writes. A call to one that is not listed is refused, so a
//      client with a stale list cannot reach it either.
//   3. Destructive tools take a required `confirm: true`. That is a speed
//      bump, not a lock — the agent can set it — so it pairs with the
//      annotations below, which clients such as Claude Code use to decide
//      what needs the person's approval.
//   4. Every tool carries readOnlyHint/destructiveHint from its safety.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { offered, type EnvDef, type Project, type ToolDef } from '../shared/project';
import { ArgumentError } from './http';
import { callTool, type Peer } from './flow';
import type { VarSource } from './vars';
import { mergedNames } from '../shared/system';

/// A system served as one server: its members as they are now.
export interface SystemSource {
  name: string;
  title: string;
  description?: string;
  instructions?: string;
  members: { path: string; project: Project; vars: VarSource }[];
}

export interface ServeOptions {
  /// Returns the project as it is now. Called on every request, so edits
  /// made in the app reach a running server without a restart.
  project: () => Project;
  envName: string;
  vars: VarSource;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /// How often to look for changes to the project between requests. 0 = never.
  watchMs?: number;
  /// Values to start the session with (the app passes the ones it kept).
  runtime?: Record<string, string>;
  /// Offer only tools that read — whatever the environment allows.
  readOnly?: boolean;
  /// Finds another API by name, for "signed in by another API".
  peer?: (api: string, path?: string) => Peer | undefined;
  /// Serve a system — all its members, as one server — instead of
  /// `project`. Each member uses its own environment of `envName`.
  system?: () => SystemSource;
}

export function pickEnv(project: Project, envName?: string): EnvDef {
  if (!project.envs.length) throw new Error(`${project.name} has no environments. Add one with a base URL first.`);
  if (!envName) return project.envs[0];
  const env = project.envs.find((e) => e.name === envName);
  if (!env) throw new Error(`No environment "${envName}" in ${project.name}. It has: ${project.envs.map((e) => e.name).join(', ')}.`);
  return env;
}

export function toMcpTool(tool: ToolDef): Tool {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const p of tool.params) {
    const description = [p.description ?? p.schema.description, p.in === 'header' ? '(sent as a header)' : ''].filter(Boolean).join(' ');
    properties[p.name] = { ...p.schema, ...(description ? { description } : {}) };
    if (p.required) required.push(p.name);
  }
  if (tool.safety === 'destructive') {
    properties.confirm = { type: 'boolean', description: 'Must be true. This call deletes or irreversibly changes data; only set it when the user has asked for exactly this.' };
    required.push('confirm');
  }
  const verb = tool.safety === 'read' ? '' : tool.safety === 'write' ? ' Changes data.' : ' Destructive: deletes or irreversibly changes data.';
  return {
    name: tool.name,
    description: `${tool.description || `${tool.method} ${tool.path}`}${verb}`.trim(),
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations: {
      title: tool.origin?.summary ?? tool.name,
      readOnlyHint: tool.safety === 'read',
      destructiveHint: tool.safety === 'destructive',
      idempotentHint: tool.method === 'GET' || tool.method === 'PUT' || tool.method === 'DELETE',
      openWorldHint: true,
    },
  };
}

export function instructionsFor(project: Project, env: EnvDef): string {
  const lines = [
    `${project.title}${project.description ? ` — ${project.description}` : ''}`,
    project.instructions?.trim() ?? '',
    `Environment: ${env.name} (${env.baseUrl}). ${env.allowWrites ? 'Writes are allowed.' : 'Read-only: tools that change data are not offered.'}`,
  ];
  return lines.filter(Boolean).join('\n\n');
}

export function systemInstructions(sys: SystemSource, envName: string): string {
  const lines = [
    `${sys.title}${sys.description ? ` — ${sys.description}` : ''}`,
    sys.instructions?.trim() ?? '',
    `It is ${sys.members.length} services, served together:`,
    ...sys.members.map((m) => `- ${m.project.title}${m.project.description ? `: ${m.project.description.split('\n')[0].slice(0, 160)}` : ''}`),
    `Environment: ${envName}. Sign-in is handled for you. Ids from one service's tools can be passed to another's.`,
  ];
  return lines.filter(Boolean).join('\n');
}

interface Entry {
  name: string;
  tool: ToolDef;
  project: Project;
  env: EnvDef;
  vars: VarSource;
  key: string;
}

export function createServer(opts: ServeOptions): Server {
  const log = opts.log ?? (() => undefined);
  /// Everything offered right now, from the project or the system's members.
  const resolve = (): { entries: Entry[]; all: Entry[]; title: string } => {
    if (opts.system) {
      const sys = opts.system();
      const members = sys.members.flatMap((m) => {
        const env = m.project.envs.find((e) => e.name === opts.envName);
        return env ? [{ ...m, env }] : [];
      });
      const named = mergedNames(members.map((m) => ({ project: m.project, tools: m.project.tools })));
      const all = named.map((n) => ({ name: n.name, tool: n.tool, project: members[n.member].project, env: members[n.member].env, vars: members[n.member].vars, key: members[n.member].path }));
      return { all, entries: all.filter((e) => offered(e.tool, e.env) && (!opts.readOnly || e.tool.safety === 'read')), title: sys.title };
    }
    const project = opts.project();
    const env = pickEnv(project, opts.envName);
    const all = project.tools.map((t) => ({ name: t.name, tool: t, project, env, vars: opts.vars, key: '' }));
    return { all, entries: all.filter((e) => offered(e.tool, env) && (!opts.readOnly || e.tool.safety === 'read')), title: project.title };
  };
  const head = (() => {
    if (opts.system) {
      const sys = opts.system();
      return { name: sys.name, version: '0.1.0', instructions: systemInstructions(sys, opts.envName) };
    }
    const first = opts.project();
    return { name: first.name, version: first.version || '0.1.0', instructions: instructionsFor(first, pickEnv(first, opts.envName)) };
  })();
  const server = new Server({ name: head.name, version: head.version }, { capabilities: { tools: { listChanged: true } }, instructions: head.instructions });

  // When the offered set changes under a running session (a tool turned
  // on in the app, writes allowed), tell the client to list again rather
  // than leave it calling from a stale list.
  let offeredKey = '';
  /// Values kept from responses this session (captures): a login's token,
  /// filled into the calls after it. Per server process — per agent
  /// session; per member when serving a system.
  const runtimes = new Map<string, Record<string, string>>([['', { ...(opts.runtime ?? {}) }]]);
  const runtimeFor = (key: string) => {
    let r = runtimes.get(key);
    if (!r) runtimes.set(key, (r = {}));
    return r;
  };
  /// A system's own members first — so its sign-in service signs in once
  /// for all of them — then whatever the caller can find.
  const peer = (api: string, at?: string): Peer | undefined => {
    if (opts.system) {
      const m = opts.system().members.find((x) => x.project.name === api);
      if (m) return { project: m.project, vars: m.vars, runtime: runtimeFor(m.path) };
    }
    return opts.peer?.(api, at);
  };

  const current = () => {
    const r = resolve();
    const key = JSON.stringify(r.entries.map((e) => ({ ...toMcpTool(e.tool), name: e.name })));
    if (offeredKey && key !== offeredKey) void server.sendToolListChanged().catch(() => undefined);
    offeredKey = key;
    return r;
  };

  // Changes made while the agent is idle should reach it too, not wait for
  // its next call. A cheap stat every few seconds; unref'd so it never
  // keeps a finished process alive.
  if (opts.watchMs !== 0) {
    const timer = setInterval(() => {
      try {
        current();
      } catch {
        // A broken edit; the next good save recovers.
      }
    }, opts.watchMs ?? 3000);
    timer.unref?.();
    server.onclose = () => clearInterval(timer);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { entries } = current();
    return { tools: entries.map((e) => ({ ...toMcpTool(e.tool), name: e.name })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { entries, all } = current();
    const name = req.params.name;
    const entry = entries.find((e) => e.name === name);
    const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });
    if (!entry) {
      const hidden = all.find((e) => e.name === name);
      if (hidden && !hidden.tool.enabled) return fail(`${name} is turned off in this project.`);
      if (hidden) return fail(`${name} changes data, and the "${hidden.env.name}" environment is read-only.`);
      return fail(`No tool named ${name}.`);
    }
    const { tool, project, env } = entry;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (tool.safety === 'destructive' && args.confirm !== true) {
      return fail(`${name} is destructive. Call it again with confirm: true only if the user asked for exactly this.`);
    }
    try {
      // Signs in first when the API needs it, and retries once on a 401.
      const { result, kept, signedIn, hint } = await callTool(project, tool, env, args, { vars: entry.vars, runtime: runtimeFor(entry.key), fetchImpl: opts.fetchImpl, peer });
      if (signedIn) log(`signed in for ${env.name}`);
      log(`${name} ${result.request.method} ${result.request.url} -> ${result.status} in ${result.durationMs} ms`);
      const head = `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`;
      return {
        isError: !result.ok,
        content: [
          {
            type: 'text' as const,
            text:
              (result.body ? `${head}\n\n${result.body}` : head) +
              // Say what was kept, never the value: it is often a token.
              (Object.keys(kept).length ? `\n\n(overapi kept ${Object.keys(kept).join(', ')} for the calls after this one)` : '') +
              (hint ? `\n\n${hint} Tell the user; retrying won't help until they do.` : ''),
          },
        ],
      };
    } catch (e) {
      const msg = (e as Error).message;
      log(`${name} failed: ${msg}`);
      return fail(e instanceof ArgumentError ? msg : `The call failed before the API answered. ${msg}`);
    }
  });

  return server;
}
