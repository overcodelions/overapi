// The request graph: which call fed which. Knowing nothing about an API,
// watch its traffic and find values that come back out of one response and
// go into a later request —
//
//   POST /orders        → id 1042        → GET /orders/1042        (path)
//   POST /auth/login    → access_token   → Authorization on 6 calls (sign-in)
//
// Building an API from a recording then writes those links in: the login
// becomes the environment's automatic sign-in (src/core/flow.ts), and the
// other links become captures, so "do this, then that" is already set up.
//
// Pure, so the app draws the graph live as calls arrive.

import { formatPath } from './capture';
import { varPrefix, type Capture, type Project, type ToolDef } from './project';
import { bodyJson, soapRequest } from './soap';
import { applyLinks, findLinks, readablePath } from './chains';
import type { RecordedCall } from './recording';

export interface GraphEdge {
  from: string;
  to: string;
  /// The value that travelled.
  value: string;
  /// Where it came out: a JSON path in the response body, or a header name.
  fromPath: string;
  fromHeader: boolean;
  /// Where it went in: path, query:<name>, body:<path>, header:<name>.
  where: string;
  /// It went into Authorization (or another credential header): a sign-in.
  auth: boolean;
}

type Seg = string | number;

/// Values worth following: ids and tokens, not "open" or 2. A string needs
/// a digit or some length; a number needs a few digits.
function notable(v: unknown): v is string | number {
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) >= 100;
  if (typeof v !== 'string') return false;
  if (v.length < 4 || v.length > 4000) return false;
  if (/^(true|false|null|open|closed|active|pending|available|sold|shipped|cancelled)$/i.test(v)) return false;
  return /\d/.test(v) || v.length >= 12;
}

function walk(v: unknown, segs: Seg[], out: { value: string; segs: Seg[] }[], depth = 0): void {
  if (out.length > 800 || depth > 8) return;
  if (Array.isArray(v)) v.slice(0, 50).forEach((x, i) => walk(x, [...segs, i], out, depth + 1));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...segs, k], out, depth + 1);
  else if (notable(v)) out.push({ value: String(v), segs });
}

/// A body as JSON — JSON as is, SOAP and other XML converted — so values
/// flow between XML calls just as between JSON ones.
function json(text?: string): unknown {
  return bodyJson(text);
}

const PAGING = /^(size|page|page_?size|page_?number|per_?page|limit|offset|skip|take|top|count|max|max_?results|start|from|to|sort|order)$/i;

const CRED_HEADER = /^(authorization|x-api-key|api-key|x-auth-token|x-access-token|x-session[-_a-z]*|cookie)$/i;

/// Where a request carries values: path segments, query values, headers
/// (a bearer token without its "Bearer "), JSON body scalars.
function inputs(c: RecordedCall): { value: string; where: string }[] {
  const out: { value: string; where: string }[] = [];
  let url: URL;
  try {
    url = new URL(c.path, 'http://x');
  } catch {
    return out;
  }
  for (const seg of url.pathname.split('/').filter(Boolean)) out.push({ value: decodeURIComponent(seg), where: 'path' });
  // Paging and sizing take numbers from the app's own code, not from a
  // response — a 100 there matching some 100 upstream is coincidence.
  for (const [k, v] of url.searchParams) if (!PAGING.test(k)) out.push({ value: v, where: `query:${k}` });
  for (const [k, v] of Object.entries(c.requestHeaders)) {
    out.push({ value: v.replace(/^(bearer|token|basic)\s+/i, ''), where: `header:${k.toLowerCase()}` });
    if (k.toLowerCase() === 'cookie') for (const part of v.split(/;\s*/)) out.push({ value: part.split('=').slice(1).join('='), where: 'header:cookie' });
  }
  const body: { value: string; segs: Seg[] }[] = [];
  walk(json(c.requestBody), [], body);
  for (const b of body) out.push({ value: b.value, where: `body:${formatPath(b.segs)}` });
  return out;
}

export function requestGraph(calls: RecordedCall[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  // value -> the latest call whose response produced it
  const produced = new Map<string, { call: RecordedCall; path: string; header: boolean }>();
  for (const c of calls) {
    for (const input of inputs(c)) {
      const src = produced.get(input.value);
      if (!src || src.call.id === c.id) continue;
      const key = `${src.call.id}>${c.id}>${input.where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: src.call.id,
        to: c.id,
        value: input.value,
        fromPath: src.path,
        fromHeader: src.header,
        where: input.where,
        auth: /^header:/.test(input.where) && CRED_HEADER.test(input.where.slice(7)),
      });
    }
    if (c.error || c.status >= 400) continue;
    const outs: { value: string; segs: Seg[] }[] = [];
    walk(json(c.responseBody), [], outs);
    for (const o of outs) produced.set(o.value, { call: c, path: formatPath(o.segs), header: false });
    for (const [k, v] of Object.entries(c.responseHeaders)) {
      if (/token|session|auth|key/i.test(k) && notable(v)) produced.set(v, { call: c, path: k.toLowerCase(), header: true });
    }
  }
  return edges;
}

/// The tool a recorded call became: same method, path matching the tool's
/// template under the environment's base path.
export function basePathOf(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl ?? '').pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function toolForCall(project: Project, call: RecordedCall, basePath = basePathOf(project.envs[0]?.baseUrl)): ToolDef | undefined {
  const pathname = new URL(call.path, 'http://x').pathname;
  const rel = pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname;
  // SOAP: one address, many operations — which one is in the envelope.
  const soap = soapRequest(call.requestHeaders, call.requestBody);
  return project.tools.find((t) => {
    if (t.method !== call.method.toUpperCase()) return false;
    if (!!t.soap !== !!soap || (soap && t.soap!.operation !== soap.operation)) return false;
    const re = new RegExp(`^${t.path.replace(/\{\{[^}]+\}\}/g, '\u0000').replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, '[^/]+').replace(/\u0000/g, '[^/]+')}$`);
    return re.test(rel);
  });
}

const SECRET_FIELD = /pass(word)?|secret|pin|otp|api_?key|client_?secret/i;

/// Writes a recording's links into a project built from it: the most-used
/// credential link becomes the environment's "log in with a request", with
/// the login's body saved on it (secret fields as ${VARS} — their values
/// returned for the keychain, never the file); other links become captures.
export interface SignInSuggestion {
  toolName: string;
  method: string;
  path: string;
  header: string;
  calls: number;
}

export function applyGraph(
  project: Project,
  calls: RecordedCall[],
  edges: GraphEdge[],
  opts: { signIn: boolean },
): { project: Project; secrets: Record<string, string>; summary: string[]; signIn?: SignInSuggestion } {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const secrets: Record<string, string> = {};
  const summary: string[] = [];
  let p = { ...project, tools: project.tools.map((t) => ({ ...t })) };
  const toolOf = (id: string) => {
    const call = byId.get(id);
    return call ? toolForCall(p, call) : undefined;
  };

  // Sign-in: the call whose output most often went into a credential header.
  const authCounts = new Map<string, { edge: GraphEdge; n: number }>();
  for (const e of edges.filter((x) => x.auth)) {
    const t = toolOf(e.from);
    if (!t) continue;
    const k = `${t.id}|${e.fromPath}|${e.where}`;
    authCounts.set(k, { edge: e, n: (authCounts.get(k)?.n ?? 0) + 1 });
  }
  const best = [...authCounts.values()].sort((a, b) => b.n - a.n)[0];
  let signIn: SignInSuggestion | undefined;
  if (best) {
    const t = toolOf(best.edge.from)!;
    signIn = { toolName: t.name, method: t.method, path: best.edge.fromPath, header: best.edge.where.slice('header:'.length), calls: best.n };
  }
  // A suggestion until the person says so: some tokens are not a login's.
  if (best && opts.signIn) {
    const login = toolOf(best.edge.from)!;
    const call = byId.get(best.edge.from)!;
    const header = best.edge.where.slice('header:'.length);
    const prefix = varPrefix(p.name);
    const body = json(call.requestBody);
    const example: Record<string, unknown> = {};
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (typeof v === 'string' && SECRET_FIELD.test(k)) {
          const name = `${prefix}_${k.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
          secrets[name] = v;
          example[k] = `\${${name}}`;
        } else example[k] = v;
      }
    }
    const sendAs = header === 'authorization' ? 'bearer' : header === 'cookie' ? 'cookie' : 'header';
    p = {
      ...p,
      envs: p.envs.map((env, i) =>
        i === 0
          ? { ...env, auth: { type: 'login' as const, toolId: login.id, from: best.edge.fromHeader ? ('header' as const) : ('body' as const), path: best.edge.fromPath, sendAs, ...(sendAs === 'bearer' ? {} : { name: header }) } }
          : env,
      ),
      tools: p.tools.map((t) => (t.id === login.id ? { ...t, example: Object.keys(example).length ? example : t.example, enabled: false } : t)),
    };
    summary.push(`Sign-in: ${login.name} → ${best.edge.fromPath} → ${header} on ${best.n} call${best.n === 1 ? '' : 's'}${Object.keys(secrets).length ? ` (${Object.keys(secrets).join(', ')} saved to the keychain)` : ''}`);
  }

  // Other links: worked out from what each request returns and asks for
  // (chains.ts) — the recording's own links confirm them, but the chain is
  // named for the argument it feeds and points at "the one you pick", not
  // the list item that happened to match.
  const links = findLinks(p);
  p = applyLinks(p, links);
  for (const l of links) summary.push(`${l.fromName} → ${readablePath(l.path)} → ${l.toName} (${l.param})`);
  void edges;
  return { project: p, secrets, summary, signIn };
}


/// The arguments a recorded call carried, for a request — so real traffic
/// can become each request's saved example. Path values by position in the
/// template, query values by name, body fields as the request takes them.
export function argsFromCall(tool: ToolDef, call: RecordedCall, basePath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const url = new URL(call.path, 'http://x');
  const rel = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : url.pathname;
  const tpl = tool.path.split('/');
  const got = rel.split('/');
  tpl.forEach((seg, i) => {
    const m = seg.startsWith('{{') ? null : seg.match(/^\{(.+)\}$/);
    if (m && got[i] !== undefined) {
      const v = decodeURIComponent(got[i]);
      out[m[1]] = /^-?\d+$/.test(v) ? Number(v) : v;
    }
  });
  for (const p of tool.params.filter((x) => x.in === 'query')) {
    const v = url.searchParams.get(p.name);
    if (v !== null) out[p.name] = /^-?\d+$/.test(v) ? Number(v) : v;
  }
  if (call.requestBody) {
    if (tool.bodyMode === 'soap') {
      const s = soapRequest(call.requestHeaders, call.requestBody);
      for (const p of tool.params.filter((x) => x.in === 'body')) if (s && p.name in s.args) out[p.name] = s.args[p.name];
    } else if (tool.bodyMode === 'json-whole') {
      const v = json(call.requestBody);
      if (v !== undefined) out.body = v;
    } else if (tool.bodyMode === 'json-fields') {
      const v = json(call.requestBody);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const p of tool.params.filter((x) => x.in === 'body')) if (p.name in (v as object)) out[p.name] = (v as Record<string, unknown>)[p.name];
    } else if (tool.bodyMode === 'form') {
      const f = new URLSearchParams(call.requestBody);
      for (const p of tool.params.filter((x) => x.in === 'body')) if (f.has(p.name)) out[p.name] = f.get(p.name);
    }
  }
  return out;
}

export interface SignInPlan {
  toolId: string;
  toolName: string;
  auth: Extract<import('./project').AuthSpec, { type: 'login' }>;
  /// The login's body as its saved example, secret fields as ${VARS}.
  example: Record<string, unknown>;
  /// Values for those VARS, for the keychain — never the file.
  secrets: Record<string, string>;
  calls: number;
}

/// The sign-in a recording suggests, ready to apply when the person says
/// so: the call whose output most often went into a credential header.
export function suggestSignIn(project: Project, calls: RecordedCall[], edges: GraphEdge[], basePath: string): SignInPlan | undefined {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const counts = new Map<string, { edge: GraphEdge; n: number; tool: ToolDef }>();
  for (const e of edges.filter((x) => x.auth)) {
    const call = byId.get(e.from);
    const t = call && toolForCall(project, call, basePath);
    if (!t) continue;
    const k = `${t.id}|${e.fromPath}|${e.where}`;
    counts.set(k, { edge: e, tool: t, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return undefined;
  const header = best.edge.where.slice('header:'.length);
  const sendAs = header === 'authorization' ? 'bearer' : header === 'cookie' ? 'cookie' : 'header';
  const prefix = varPrefix(project.name);
  const example: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const body = json(byId.get(best.edge.from)?.requestBody);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string' && SECRET_FIELD.test(k)) {
        const name = `${prefix}_${k.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
        secrets[name] = v;
        example[k] = `\${${name}}`;
      } else example[k] = v;
    }
  }
  return {
    toolId: best.tool.id,
    toolName: best.tool.name,
    auth: { type: 'login', toolId: best.tool.id, from: best.edge.fromHeader ? 'header' : 'body', path: best.edge.fromPath, sendAs, ...(sendAs === 'bearer' ? {} : { name: header }) },
    example,
    secrets,
    calls: best.n,
  };
}
