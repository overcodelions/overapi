// Agent-readiness: what in a project will make an agent pick the wrong
// tool, call it wrongly, or do something it should not. Not a validator —
// a list of things a person should look at, in the order they matter.

import { VALID_NAME } from './naming';
import { envVars, offered, type Project, type ToolDef } from './project';

export type IssueLevel = 'error' | 'warn' | 'info';

export interface Issue {
  level: IssueLevel;
  message: string;
  toolId?: string;
  env?: string;
}

export interface CheckResult {
  score: number;
  issues: Issue[];
  offeredByEnv: Record<string, number>;
}

/// Beyond this many tools, models choose noticeably worse and every turn
/// pays for the whole list in context.
export const TOOL_BUDGET = 40;

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/// `vars` says which variables are set where the server will run. Omit it
/// and the check says nothing about variables.
export function checkProject(project: Project, vars?: Record<string, boolean>): CheckResult {
  const issues: Issue[] = [];
  const enabled = project.tools.filter((t) => t.enabled);

  if (project.tools.length === 0) issues.push({ level: 'error', message: 'The project has no tools. Import a spec, a capture or a collection.' });
  else if (enabled.length === 0) issues.push({ level: 'error', message: 'No request is a tool yet, so agents will see nothing. Send one in Requests and choose Make it a tool.' });
  if (enabled.length > TOOL_BUDGET) {
    issues.push({
      level: 'warn',
      message: `${enabled.length} tools are on. Past about ${TOOL_BUDGET}, agents pick worse and every turn pays for the list. Turn off the ones nobody will ask for.`,
    });
  }
  if (!project.description.trim() && !project.instructions?.trim()) {
    issues.push({ level: 'warn', message: 'The project has no description or instructions, so an agent is told nothing about what this API is for.' });
  }

  // Names
  const byName = new Map<string, ToolDef[]>();
  for (const t of enabled) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  for (const [name, tools] of byName) {
    if (tools.length > 1) issues.push({ level: 'error', message: `${tools.length} tools are named "${name}". Names must be unique.`, toolId: tools[1].id });
  }

  for (const t of enabled) issues.push(...checkTool(t));

  // Environments
  if (project.envs.length === 0) issues.push({ level: 'error', message: 'There is no environment, so there is nowhere to send calls. Add one with a base URL.' });
  const offeredByEnv: Record<string, number> = {};
  for (const env of project.envs) {
    offeredByEnv[env.name] = project.tools.filter((t) => offered(t, env)).length;
    if (!env.baseUrl.trim()) issues.push({ level: 'error', env: env.name, message: `"${env.name}" has no base URL.` });
    else if (!/^https?:\/\//i.test(env.baseUrl)) issues.push({ level: 'error', env: env.name, message: `"${env.name}" base URL must start with http:// or https://.` });
    else if (/^http:\/\//i.test(env.baseUrl) && !LOOPBACK.test(env.baseUrl)) {
      issues.push({ level: 'warn', env: env.name, message: `"${env.name}" sends credentials over plain http to a host that is not this machine.` });
    }
    if (env.auth.type === 'login') {
      const login = project.tools.find((t) => t.id === (env.auth as { toolId: string }).toolId);
      if (!login) issues.push({ level: 'error', env: env.name, message: `"${env.name}" signs in with a request that no longer exists. Pick one in Environments → Sign-in.` });
      else if (!Object.keys(login.example ?? {}).length && login.params.some((p) => p.required)) {
        issues.push({ level: 'warn', env: env.name, toolId: login.id, message: `"${env.name}" signs in with ${login.name}, which has no saved values yet. Send it once with the credentials (use \${SECRET} for passwords).` });
      }
    }
    if (/prod/i.test(env.name) && env.allowWrites) {
      issues.push({ level: 'warn', env: env.name, message: `"${env.name}" lets agents write. Make sure that is meant — most teams start production read-only.` });
    }
    if (vars) {
      const missing = envVars(env).filter((v) => !vars[v]);
      if (missing.length) {
        issues.push({ level: 'warn', env: env.name, message: `"${env.name}" reads ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not set here. Calls will go out without ${missing.length === 1 ? 'it' : 'them'}.` });
      }
    }
  }
  const writes = enabled.filter((t) => t.safety !== 'read');
  if (writes.length && project.envs.length && !project.envs.some((e) => e.allowWrites)) {
    issues.push({ level: 'info', message: `${writes.length} write tool${writes.length === 1 ? ' is' : 's are'} on but no environment allows writes, so agents won't see ${writes.length === 1 ? 'it' : 'them'}.` });
  }

  const weight = { error: 20, warn: 5, info: 1 } as const;
  const penalty = issues.reduce((sum, i) => sum + weight[i.level], 0);
  return { score: Math.max(0, 100 - penalty), issues: sortIssues(issues), offeredByEnv };
}

function checkTool(t: ToolDef): Issue[] {
  const out: Issue[] = [];
  const at = { toolId: t.id };
  if (!VALID_NAME.test(t.name)) out.push({ level: 'error', ...at, message: `"${t.name}" is not a valid tool name: letters, digits, _ and - only, 64 at most.` });
  const desc = t.description.trim();
  if (!desc) out.push({ level: 'warn', ...at, message: `${t.name} has no description. The agent will guess from the name.` });
  else if (desc.length < 25) out.push({ level: 'info', ...at, message: `${t.name}'s description is very short. Say what it returns and when to use it.` });
  else if (desc.length > 1200) out.push({ level: 'info', ...at, message: `${t.name}'s description is ${desc.length} characters. Long descriptions cost context on every turn.` });

  // {{name}} is an environment value filled in for the agent, not an argument.
  const pathParams = [...t.path.replace(/\{\{[^}]+\}\}/g, '').matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  for (const p of pathParams) {
    if (!t.params.some((x) => x.in === 'path' && x.name === p)) {
      out.push({ level: 'error', ...at, message: `${t.name}'s path has {${p}} but no path parameter by that name.` });
    }
  }
  const undocumented = t.params.filter((p) => !p.description?.trim() && !p.schema.enum && p.in !== 'path');
  if (undocumented.length >= 3) {
    out.push({ level: 'info', ...at, message: `${t.name} has ${undocumented.length} parameters with no description (${undocumented.slice(0, 4).map((p) => p.name).join(', ')}${undocumented.length > 4 ? '…' : ''}).` });
  }
  if (t.params.length > 20) out.push({ level: 'info', ...at, message: `${t.name} takes ${t.params.length} parameters. Long parameter lists are where agents make mistakes; describe the ones that matter.` });
  return out;
}

function sortIssues(issues: Issue[]): Issue[] {
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return [...issues].sort((a, b) => rank[a.level] - rank[b.level]);
}
