// What a project can do with your secrets and your machine: the parts a
// project file from someone else could use against you. Where each
// environment sends requests, how it signs in, which secrets it reads,
// whose sign-in it borrows, what files and certificates it uses, and how
// each request is labelled for agents.
//
// overapi records your approval of exactly this (core/trust.ts). Projects
// you edit in the app are approved as you go; one that arrives or changes
// outside the app — a clone, a git pull — holds every secret back until you
// review it.

import { exampleSecrets, type AuthSpec, type EnvDef, type Project, type ToolDef } from './project';

const SECRET_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const refs = (values: Record<string, unknown> | undefined) => Object.values(values ?? {}).flatMap((v) => (typeof v === 'string' ? [...v.matchAll(SECRET_REF)].map((m) => m[1]) : []));
const fileArgs = (example: Record<string, unknown> | undefined) => Object.values(example ?? {}).filter((v): v is string => typeof v === 'string' && v.trim().startsWith('@'));

/// The parts approval covers. Anything else in a project (names,
/// descriptions, examples without secrets or files) can change freely.
export function trustSurface(p: Project) {
  return {
    envs: p.envs.map((e) => ({ name: e.name, baseUrl: e.baseUrl, auth: e.auth, headers: e.headers ?? {}, vars: e.vars ?? {}, tls: e.tls ?? null })),
    tools: p.tools.map((t) => ({
      id: t.id,
      method: t.method,
      path: t.path,
      safety: t.safety,
      enabled: t.enabled,
      auth: t.auth ?? null,
      headers: t.headers ?? {},
      before: t.before ?? [],
      secrets: exampleSecrets(t),
      files: fileArgs(t.example),
      graphql: t.bodyMode === 'graphql' ? graphqlKind(t.graphql?.query) : null,
    })),
  };
}

/// query, mutation or subscription: what a GraphQL request really does.
const graphqlKind = (q?: string) => /^\s*(mutation|subscription)\b/.exec(q ?? '')?.[1] ?? 'query';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const SEARCHY = /search|filter|query|find|lookup|preview|evaluate|check|validate|count|report|export|resolve/i;

const host = (u: string) => {
  try {
    return new URL(u).host || u;
  } catch {
    return u || '(no address)';
  }
};

function authSecrets(a: AuthSpec): string[] {
  if (a.type === 'bearer') return [a.tokenVar];
  if (a.type === 'apiKey') return [a.valueVar];
  if (a.type === 'basic' || a.type === 'wsse') return [a.userVar, a.passVar];
  if (a.type === 'oauth2') return [a.clientIdVar, ...(a.clientSecretVar ? [a.clientSecretVar] : []), ...(a.refreshTokenVar ? [a.refreshTokenVar] : [])];
  if (a.type === 'command') return [a.commandVar];
  return [];
}

function signIn(a: AuthSpec, p: Project): string {
  switch (a.type) {
    case 'none':
      return 'No sign-in';
    case 'bearer':
      return 'A bearer token';
    case 'apiKey':
      return `An API key in the ${a.in} ${a.name}`;
    case 'basic':
      return 'A user and password';
    case 'wsse':
      return 'A WS-Security user and password';
    case 'login':
      return `Logs in with ${p.tools.find((t) => t.id === a.toolId)?.name ?? 'one of its requests'}`;
    case 'via':
      return `${a.api}’s sign-in`;
    case 'oauth2':
      return a.tokenUrl ? `OAuth 2 from ${host(a.tokenUrl)}` : 'OAuth 2, not set up yet';
    case 'command':
      return 'A token printed by a command on this Mac';
  }
}

export interface TrustSummary {
  /// `borrowed`: the API whose sign-in it uses, when it borrows one.
  envs: { name: string; host: string; signIn: string; secrets: string[]; borrowed?: string }[];
  /// What deserves a second look: borrowed sign-ins, commands, files,
  /// certificates, and requests labelled safer than they are.
  warnings: string[];
}

export function trustSummary(p: Project): TrustSummary {
  const toolSecrets = p.tools.flatMap((t) => [...exampleSecrets(t), ...refs(t.headers), ...(t.auth ? authSecrets(t.auth) : [])]);
  const envs = p.envs.map((e) => ({
    name: e.name,
    host: host(e.baseUrl),
    signIn: signIn(e.auth, p),
    secrets: [...new Set([...authSecrets(e.auth), ...refs(e.headers), ...toolSecrets, ...(e.tls?.passphraseVar ? [e.tls.passphraseVar] : [])])],
    borrowed: e.auth.type === 'via' ? e.auth.api : undefined,
  }));
  const warnings: string[] = [];
  // A borrowed sign-in going off this machine — once per API and host, however
  // many environments send it there. To localhost it's your own machine.
  const borrowed = new Map<string, string[]>();
  for (const e of p.envs)
    if (e.auth.type === 'via' && !LOOPBACK.test(host(e.baseUrl))) borrowed.set(`${e.auth.api}\u0000${host(e.baseUrl)}`, [...(borrowed.get(`${e.auth.api}\u0000${host(e.baseUrl)}`) ?? []), e.name]);
  for (const [key, names] of borrowed) {
    const [api, to] = key.split('\u0000');
    warnings.push(`${names.join(' and ')}: send${names.length === 1 ? 's' : ''} ${api}’s sign-in to ${to}.`);
  }
  for (const e of p.envs) {
    const a = e.auth;
    if (a.type === 'command') warnings.push(`${e.name}: runs a command on this Mac for its token — the one you saved in the keychain as ${a.commandVar}.`);
    if (a.type === 'oauth2' && a.authUrl && !/^https:\/\//i.test(a.authUrl)) warnings.push(`${e.name}: its sign-in page isn’t https (${a.authUrl}).`);
    const files = [e.tls?.certFile, e.tls?.keyFile, e.tls?.pfxFile].filter(Boolean);
    if (files.length) warnings.push(`${e.name}: presents a client certificate from ${files.join(', ')}.`);
  }
  for (const t of p.tools) {
    // POST is often a search or a filter: only flag one that doesn't say so.
    const reads =
      t.method === 'GET' ||
      t.method === 'HEAD' ||
      t.method === 'OPTIONS' ||
      (t.bodyMode === 'graphql' && graphqlKind(t.graphql?.query) === 'query') ||
      (t.method === 'POST' && SEARCHY.test(`${t.name} ${t.path}`));
    if (t.enabled && t.safety === 'read' && !reads) warnings.push(`${t.name} (${t.method} ${t.path}) can change data but is marked read-only, so agents get it even where writes are off.`);
    if (t.enabled && t.method === 'DELETE' && t.safety !== 'destructive') warnings.push(`${t.name} deletes, but isn’t marked destructive, so agents aren’t asked to confirm.`);
    for (const f of fileArgs(t.example)) warnings.push(`${t.name} is set to upload a file from this Mac: ${f.slice(1).trim()}.`);
  }
  return { envs, warnings };
}

/// Whether a call would carry anything secret: a sign-in, a ${SECRET}, a
/// browser session, a client certificate, or requests run first.
export function usesSecrets(env: EnvDef, tool: ToolDef): boolean {
  const auth = tool.auth ?? env.auth;
  return (
    auth.type !== 'none' || !!env.browserSession || !!env.tls || refs(env.headers).length > 0 || refs(tool.headers).length > 0 || exampleSecrets(tool).length > 0 || (tool.before ?? []).length > 0
  );
}

/// Whether a project carries anything to protect: a sign-in, a ${SECRET},
/// a browser session, a client certificate, or a file argument. One with
/// none needs no review — there's nothing to send anywhere.
export function projectUsesSecrets(p: Project): boolean {
  return (
    p.envs.some((e) => e.auth.type !== 'none' || !!e.browserSession || !!e.tls || refs(e.headers).length > 0) ||
    p.tools.some((t) => (t.auth && t.auth.type !== 'none') || refs(t.headers).length > 0 || exampleSecrets(t).length > 0 || fileArgs(t.example).length > 0)
  );
}
