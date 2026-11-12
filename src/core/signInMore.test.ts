// The sign-in paths between the obvious ones: logging in again on a
// timer, a token in a header, another API's OAuth or command sign-in, and
// a 403 treated like a 401.

import { describe, expect, it } from 'vitest';
import { borrowSignIn, callTool } from './flow';
import { withKeychain } from './vars';
import type { AuthSpec, EnvDef, Project, ToolDef } from '../shared/project';

const tool = (id: string, method: ToolDef['method'], p: string): ToolDef => ({
  id,
  name: id.replace(/\W+/g, '_'),
  description: '',
  enabled: true,
  safety: 'read',
  method,
  path: p,
  params: [],
  bodyMode: 'none',
});
const login = tool('POST /login', 'POST', '/login');
const orders = tool('GET /orders', 'GET', '/orders');
const envOf = (auth: AuthSpec, name = 'staging'): EnvDef => ({ name, baseUrl: 'https://api.acme.test', auth, allowWrites: false });
const projectOf = (env: EnvDef, tools: ToolDef[] = [login, orders]): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: '', version: '0.1.0', envs: [env], tools }) as Project;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const none = () => undefined;

describe('log in with a request', () => {
  it('reads the token from a response header, and logs in again once it is older than the limit', async () => {
    const env = envOf({ type: 'login', toolId: login.id, from: 'header', path: 'X-Auth-Token', sendAs: 'bearer', refreshMinutes: 10 });
    let logins = 0;
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/login')) return json({}, 200, { 'x-auth-token': `tok-${++logins}` });
      seen.push((init!.headers as Record<string, string>).authorization);
      return json([]);
    }) as typeof fetch;
    let now = 0;
    const deps = { vars: none, runtime: {}, fetchImpl, now: () => now };
    await callTool(projectOf(env), orders, env, {}, deps);
    now += 5 * 60_000;
    await callTool(projectOf(env), orders, env, {}, deps);
    now += 6 * 60_000;
    await callTool(projectOf(env), orders, env, {}, deps);
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2']);
    expect(logins).toBe(2);
  });

  it('says where it looked when the header is not there', async () => {
    const env = envOf({ type: 'login', toolId: login.id, from: 'header', path: 'X-Auth-Token', sendAs: 'bearer' });
    const fetchImpl = (async () => json({})) as unknown as typeof fetch;
    await expect(callTool(projectOf(env), orders, env, {}, { vars: none, runtime: {}, fetchImpl })).rejects.toThrow('there is no token at header X-Auth-Token');
  });
});

describe('signed in by another API', () => {
  const via: Extract<AuthSpec, { type: 'via' }> = { type: 'via', api: 'acme-sso' };
  const peer =
    (auth: AuthSpec, vars: (n: string) => string | undefined = none) =>
    () => ({ project: projectOf(envOf(auth), []), vars, runtime: {} as Record<string, string> });

  it('borrows its OAuth token, getting one first', async () => {
    const fetchImpl = (async () => json({ access_token: 'peer-tok', expires_in: 3600 })) as unknown as typeof fetch;
    const b = await borrowSignIn(via, 'staging', {
      vars: none,
      runtime: {},
      fetchImpl,
      peer: peer({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://sso.acme.test/token', clientIdVar: 'ID', clientSecretVar: 'SECRET' }, (n) => ({ ID: 'id', SECRET: 'secret' })[n]),
    });
    expect([b.headers.authorization, b.secrets, b.from]).toEqual(['Bearer peer-tok', ['peer-tok'], 'Acme']);
  });

  it('borrows its command token, running the command first', async () => {
    const b = await borrowSignIn(via, 'staging', {
      vars: none,
      runtime: {},
      run: async () => 'cmd-tok\n',
      peer: peer(
        { type: 'command', commandVar: 'ACME_SSO_CMD', sendAs: 'header', name: 'X-Acme-Token' },
        withKeychain((n) => (n === 'ACME_SSO_CMD' ? 'acme-sso token' : undefined), none),
      ),
    });
    expect(b.headers['x-acme-token']).toBe('cmd-tok');
  });
});

describe('a 403 counts as a refusal too', () => {
  /// The API refuses the first token with 403 and takes the second.
  const api = (issue: () => string) => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/token')) return json({ access_token: issue(), expires_in: 3600 });
      const a = (init!.headers as Record<string, string>).authorization;
      seen.push(a);
      return a === 'Bearer tok-2' ? json([]) : json({ error: 'forbidden' }, 403);
    }) as typeof fetch;
    return { seen, fetchImpl };
  };

  it('for OAuth: gets a new token and retries once', async () => {
    let n = 0;
    const { seen, fetchImpl } = api(() => `tok-${++n}`);
    const env = envOf({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.acme.test/token', clientIdVar: 'ID' });
    const out = await callTool(projectOf(env), orders, env, {}, { vars: (x) => (x === 'ID' ? 'id' : undefined), runtime: {}, fetchImpl });
    expect([seen, out.result.ok]).toEqual([['Bearer tok-1', 'Bearer tok-2'], true]);
  });

  it('for a command: runs it again and retries once', async () => {
    const tokens = ['tok-1', 'tok-2'];
    const { seen, fetchImpl } = api(() => 'unused');
    const env = envOf({ type: 'command', commandVar: 'CMD', sendAs: 'bearer' });
    const out = await callTool(projectOf(env), orders, env, {}, { vars: withKeychain(() => 'acme-sso token', none), runtime: {}, fetchImpl, run: async () => tokens.shift()! });
    expect([seen, out.result.ok]).toEqual([['Bearer tok-1', 'Bearer tok-2'], true]);
  });

  it('retries only once: a second refusal comes back as it is', async () => {
    const env = envOf({ type: 'command', commandVar: 'CMD', sendAs: 'bearer' });
    const fetchImpl = (async () => json({ error: 'forbidden' }, 403)) as unknown as typeof fetch;
    let runs = 0;
    const out = await callTool(projectOf(env), orders, env, {}, { vars: withKeychain(() => 'x', none), runtime: {}, fetchImpl, run: async () => `tok-${++runs}` });
    expect([out.result.status, runs]).toEqual([403, 2]);
  });
});
