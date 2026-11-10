// One tool call, with everything around it: sign in first when the API
// needs it, send, sign in again and retry once if the server refuses, then
// keep what the request keeps. The app's Send and the MCP server both call
// this, so a person and an agent get the same behaviour — including the
// "POST /login, then call everything with the token" pattern legacy APIs
// use, which an agent then never has to know about.

import { applyCaptures, getPath } from '../shared/capture';
import type { AuthSpec, EnvDef, Project, ToolDef } from '../shared/project';
import { buildRequest, send, viaKey, type Borrowed, type CallResult } from './http';
import { providerEnv } from '../shared/system';
import type { VarSource } from './vars';
import { sessionExpiredHint } from '../shared/session';

type LoginAuth = Extract<AuthSpec, { type: 'login' }>;

/// Where the token lives in the session's values. Internal: the leading
/// underscores keep it out of the app's list of kept variables.
export const loginKey = (env: string) => `__login:${env}`;
export const loginAtKey = (env: string) => `__login_at:${env}`;

/// Another API, for borrowing its sign-in: the project, where its secrets
/// come from, and its session's kept values (read and written — a login
/// there is a login for everyone it signs in).
export interface Peer {
  project: Project;
  vars: VarSource;
  runtime: Record<string, string>;
}

export interface CallDeps {
  vars: VarSource;
  /// Finds the API a "signed in by another API" environment names.
  peer?: (api: string, path?: string) => Peer | undefined;
  /// The session's kept values; read and written.
  runtime: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface CallOutcome {
  result: CallResult;
  /// Values this call kept (captures), names to values.
  kept: Record<string, string>;
  /// Whether it signed in on the way.
  signedIn: boolean;
  /// Requests it ran first (before steps), by name.
  ranFirst: string[];
  /// What to do about a refusal overapi can't fix itself — a browser
  /// sign-in that ended.
  hint?: string;
}

export function loginFor(tool: ToolDef, env: EnvDef): LoginAuth | null {
  const auth = tool.auth ?? env.auth;
  return auth.type === 'login' && auth.toolId !== tool.id ? auth : null;
}

function needsLogin(auth: LoginAuth, env: EnvDef, deps: CallDeps): boolean {
  const token = deps.runtime[loginKey(env.name)];
  if (!token) return true;
  if (!auth.refreshMinutes) return false;
  const at = Number(deps.runtime[loginAtKey(env.name)] ?? 0);
  return (deps.now ?? Date.now)() - at > auth.refreshMinutes * 60_000;
}

/// Runs the login request with the values saved on it (its example — where
/// `${SECRET}`s fill from the keychain) and keeps the token it answers with.
export async function signIn(project: Project, env: EnvDef, auth: LoginAuth, deps: CallDeps): Promise<{ token: string; result: CallResult }> {
  const login = project.tools.find((t) => t.id === auth.toolId);
  if (!login) throw new Error(`The sign-in request for "${env.name}" is gone. Pick another in Environments → Sign-in.`);
  // The login request itself never signs in first — that would loop.
  const own = login.auth && login.auth.type !== 'login' ? login.auth : ({ type: 'none' } as const);
  const built = buildRequest({ ...login, auth: own }, env, login.example ?? {}, deps.vars, deps.runtime);
  const result = await send(built, { limit: login.responseLimit, timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl });
  if (!result.ok) throw new Error(`Signing in failed: ${login.name} answered ${result.status} ${result.statusText}. Check the values saved on it, and its secrets.`);
  const raw = auth.from === 'header' ? result.headers[auth.path.toLowerCase()] : getPath(result.json, auth.path);
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`${login.name} worked, but there is no token at ${auth.from === 'header' ? `header ${auth.path}` : auth.path}. Check where the token is in its response.`);
  }
  const token = String(raw);
  deps.runtime[loginKey(env.name)] = token;
  deps.runtime[loginAtKey(env.name)] = String((deps.now ?? Date.now)());
  return { token, result };
}

type ViaAuth = Extract<AuthSpec, { type: 'via' }>;

/// What another API sends to be signed in, in the environment of this
/// name: signs in there first when it uses a login request (or `force`d,
/// after a refusal), then takes the headers and query values its sign-in
/// puts on a request.
export async function borrowSignIn(via: ViaAuth, envName: string, deps: CallDeps, force = false): Promise<Borrowed> {
  const peer = deps.peer?.(via.api, via.path);
  if (!peer) throw new Error(`Signed in by ${via.api}, but overapi can’t find that API on this Mac. Open it in overapi, or pick another sign-in under Environments.`);
  const env = providerEnv(peer.project, envName);
  if (!env) throw new Error(`${peer.project.title} has no “${envName}” environment to sign in with. Add one there with the same name.`);
  if (env.auth.type === 'via') throw new Error(`${peer.project.title} is itself signed in by another API — pick the API that actually signs in.`);
  const pdeps: CallDeps = { ...deps, vars: peer.vars, runtime: peer.runtime, peer: undefined };
  if (env.auth.type === 'login' && (force || needsLogin(env.auth, env, pdeps))) await signIn(peer.project, env, env.auth, pdeps);
  const probe: ToolDef = { id: '__signin_probe', name: 'probe', description: '', enabled: true, safety: 'read', method: 'GET', path: '/', params: [], bodyMode: 'none' };
  const built = buildRequest(probe, env, {}, peer.vars, peer.runtime);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(built.headers)) if (!['accept', 'user-agent', 'content-type'].includes(k) && v) headers[k] = v;
  const query: Record<string, string> = {};
  new URL(built.url).searchParams.forEach((v, k) => (query[k] = v));
  return { headers, query, secrets: built.secrets, from: peer.project.title };
}

/// The requests a tool runs first (its `before` steps), each with the values
/// saved on it. A step that fails stops the call — sending on without what
/// it was meant to set up would only fail more confusingly.
async function runBefore(project: Project, tool: ToolDef, env: EnvDef, deps: CallDeps, depth: number): Promise<string[]> {
  const ran: string[] = [];
  for (const step of tool.before ?? []) {
    if (step.toolId === tool.id) continue;
    if (step.when === 'missing' && step.var && deps.runtime[step.var]) continue;
    const first = project.tools.find((t) => t.id === step.toolId);
    if (!first) throw new Error(`${tool.name} runs a request first that no longer exists. Fix it in its Flow.`);
    if (depth >= 4) throw new Error(`${tool.name}'s "run first" steps go round in a loop. Fix them in Flow.`);
    const r = await callTool(project, first, env, first.example ?? {}, deps, depth + 1);
    if (!r.result.ok) throw new Error(`Running ${first.name} first failed: it answered ${r.result.status} ${r.result.statusText}.`);
    ran.push(first.name, ...r.ranFirst);
  }
  return ran;
}

export async function callTool(project: Project, tool: ToolDef, env: EnvDef, args: Record<string, unknown>, deps: CallDeps & { limit?: number }, depth = 0): Promise<CallOutcome> {
  const login = loginFor(tool, env);
  const auth = tool.auth ?? env.auth;
  const via = auth.type === 'via' ? auth : null;
  let signedIn = false;
  if (login && needsLogin(login, env, deps)) {
    await signIn(project, env, login, deps);
    signedIn = true;
  }
  // Borrowed fresh each call: cheap, and the other API's session (a login
  // it refreshed, a token replaced) is always the current one.
  if (via) deps.runtime[viaKey(env.name)] = JSON.stringify(await borrowSignIn(via, env.name, deps));
  const go = () => send(buildRequest(tool, env, args, deps.vars, deps.runtime), { limit: deps.limit ?? tool.responseLimit, timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl });
  const ranFirst = await runBefore(project, tool, env, deps, depth);
  let result = await go();
  // Refused with a token we did not just get: it expired. Sign in, retry once.
  if (login && !signedIn && (result.status === 401 || result.status === 403)) {
    await signIn(project, env, login, deps);
    signedIn = true;
    result = await go();
  } else if (via && (result.status === 401 || result.status === 403)) {
    // Refused: have the sign-in service sign in again (when it signs in
    // with a request), and retry once.
    const before = deps.runtime[viaKey(env.name)];
    deps.runtime[viaKey(env.name)] = JSON.stringify(await borrowSignIn(via, env.name, deps, true));
    if (deps.runtime[viaKey(env.name)] !== before) {
      signedIn = true;
      result = await go();
    }
  }
  const kept = result.ok ? applyCaptures(tool.captures, result.json, result.headers) : {};
  Object.assign(deps.runtime, kept);
  const hint = via && (result.status === 401 || result.status === 403)
    ? `Refused with ${via.api}’s sign-in for ${env.name} — it may have run out, or ${via.api} has none set for ${env.name}.`
    : !login && env.browserSession && (result.status === 401 || result.status === 403) ? sessionExpiredHint(env.name, env.browserSession.site, env.baseUrl) : undefined;
  return { result, kept, signedIn, ranFirst, hint };
}
