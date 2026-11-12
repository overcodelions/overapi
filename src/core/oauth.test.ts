import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authorizeUrl, discover, finishSignIn, oauthKey, oauthRefreshKey, oauthToken, pkce, redirectUri, type OAuth2 } from './oauth';
import { callTool } from './flow';
import type { EnvDef, Project, ToolDef } from '../shared/project';

const cc: OAuth2 = { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.acme.test/token', clientIdVar: 'ID', clientSecretVar: 'SECRET', scope: 'read:orders', audience: 'orders' };
const code: OAuth2 = {
  type: 'oauth2',
  grant: 'authorization_code',
  tokenUrl: 'https://auth.acme.test/token',
  authUrl: 'https://auth.acme.test/authorize',
  clientIdVar: 'ID',
  refreshTokenVar: 'RT',
  scope: 'read:orders offline_access',
};
const env = (auth: OAuth2): EnvDef => ({ name: 'staging', baseUrl: 'https://api.acme.test', auth, allowWrites: false });
const secrets: Record<string, string> = { ID: 'acme-client', SECRET: 'acme-secret-123' };
const vars = (n: string) => secrets[n];

/// A token endpoint answering in turn; the calls it got, decoded.
function tokenEndpoint(answers: Record<string, unknown>[]) {
  const calls: { url: string; headers: Record<string, string>; form: URLSearchParams }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, form: new URLSearchParams(String(init!.body)) });
    const a = answers.shift() ?? { error: 'invalid_grant', error_description: 'Token has been revoked' };
    return new Response(JSON.stringify(a), { status: 'access_token' in a ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('client credentials', () => {
  it('asks with the client id, secret, scope and audience, then reuses the token until it runs out', async () => {
    const { calls, fetchImpl } = tokenEndpoint([
      { access_token: 'tok-1', expires_in: 3600 },
      { access_token: 'tok-2', expires_in: 3600 },
    ]);
    const runtime: Record<string, string> = {};
    let now = 1_000_000;
    const deps = { vars, runtime, fetchImpl, now: () => now };
    expect(await oauthToken(cc, env(cc), deps)).toBe('tok-1');
    expect(calls[0].form.get('grant_type')).toBe('client_credentials');
    expect(calls[0].form.get('client_id')).toBe('acme-client');
    expect(calls[0].form.get('client_secret')).toBe('acme-secret-123');
    expect(calls[0].form.get('scope')).toBe('read:orders');
    expect(calls[0].form.get('audience')).toBe('orders');
    expect(await oauthToken(cc, env(cc), deps)).toBe('tok-1');
    expect(calls).toHaveLength(1);
    // Within half a minute of running out counts as run out.
    now += 3600_000 - 20_000;
    expect(await oauthToken(cc, env(cc), deps)).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  it('proves the client in the body, then with HTTP Basic if the provider says the client is unknown', async () => {
    const { calls, fetchImpl } = tokenEndpoint([{ error: 'invalid_client' }, { access_token: 'tok', expires_in: 60 }]);
    expect(await oauthToken(cc, env(cc), { vars, runtime: {}, fetchImpl })).toBe('tok');
    expect(calls[0].form.get('client_secret')).toBe('acme-secret-123');
    expect(calls[1].headers.authorization).toMatch(/^Basic /);
    // Told to use the body, it doesn't try anything else.
    const strict = tokenEndpoint([{ error: 'invalid_client' }]);
    await expect(oauthToken({ ...cc, clientAuth: 'body' }, env(cc), { vars, runtime: {}, fetchImpl: strict.fetchImpl })).rejects.toThrow('invalid_client');
    expect(strict.calls).toHaveLength(1);
  });

  it('reads a token answered form-encoded, and says when the endpoint cannot be reached', async () => {
    const formEncoded = (async () => new Response('access_token=tok-form&expires_in=60&token_type=bearer', { status: 200 })) as unknown as typeof fetch;
    expect(await oauthToken(cc, env(cc), { vars, runtime: {}, fetchImpl: formEncoded })).toBe('tok-form');
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(oauthToken(cc, env(cc), { vars, runtime: {}, fetchImpl: down })).rejects.toThrow('OAuth: could not reach https://auth.acme.test: ECONNREFUSED.');
    await expect(oauthToken({ ...cc, tokenUrl: '' }, env(cc), { vars, runtime: {}, fetchImpl: down })).rejects.toThrow('set the provider (or its token URL)');
  });

  it('proves the client with HTTP Basic when the provider wants it', async () => {
    const { calls, fetchImpl } = tokenEndpoint([{ access_token: 'tok', expires_in: 60 }]);
    await oauthToken({ ...cc, clientAuth: 'basic' }, env(cc), { vars, runtime: {}, fetchImpl });
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('acme-client:acme-secret-123').toString('base64')}`);
    expect(calls[0].form.get('client_id')).toBeNull();
    expect(calls[0].form.get('client_secret')).toBeNull();
  });

  it('says what the provider said when it refuses, and what is missing before asking', async () => {
    const { fetchImpl } = tokenEndpoint([{ error: 'invalid_scope', error_description: 'Unknown scope' }]);
    await expect(oauthToken(cc, env(cc), { vars, runtime: {}, fetchImpl })).rejects.toThrow('OAuth: the token endpoint refused: invalid_scope: Unknown scope.');
    await expect(oauthToken(cc, env(cc), { vars: () => undefined, runtime: {}, fetchImpl })).rejects.toThrow("the client id (ID) isn't set");
  });
});

describe('authorization code', () => {
  it('asks the person to sign in first when there is no refresh token', async () => {
    const { fetchImpl } = tokenEndpoint([]);
    await expect(oauthToken(code, env(code), { vars, runtime: {}, fetchImpl })).rejects.toThrow('Not signed in to staging yet');
  });

  it('refreshes from the keychain, and saves a rotated refresh token', async () => {
    const { calls, fetchImpl } = tokenEndpoint([
      { access_token: 'tok-1', expires_in: 60, refresh_token: 'rt-2' },
      { access_token: 'tok-2', expires_in: 60 },
    ]);
    const saved: Record<string, string> = {};
    const runtime: Record<string, string> = {};
    let now = 0;
    const deps = { vars: (n: string) => (n === 'RT' ? 'rt-1' : vars(n)), runtime, fetchImpl, now: () => now, saveSecret: (n: string, v: string) => (saved[n] = v) };
    expect(await oauthToken(code, env(code), deps)).toBe('tok-1');
    expect(calls[0].form.get('grant_type')).toBe('refresh_token');
    expect(calls[0].form.get('refresh_token')).toBe('rt-1');
    expect(saved).toEqual({ RT: 'rt-2' });
    now += 120_000;
    expect(await oauthToken(code, env(code), deps)).toBe('tok-2');
    // The rotated one, not the stale one in the keychain read.
    expect(calls[1].form.get('refresh_token')).toBe('rt-2');
  });

  it('tells the person to sign in again when the refresh token is refused', async () => {
    const { fetchImpl } = tokenEndpoint([]);
    const deps = { vars: (n: string) => (n === 'RT' ? 'rt-old' : vars(n)), runtime: {}, fetchImpl };
    await expect(oauthToken(code, env(code), deps)).rejects.toThrow(/Token has been revoked\. The sign-in for staging may have ended — sign in again/);
  });

  it('sends the browser to sign in with a PKCE challenge, and swaps the code for tokens', async () => {
    const { verifier, challenge } = pkce();
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    const u = new URL(authorizeUrl(code, 'acme-client', challenge, 'state-1'));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'acme-client',
      redirect_uri: 'http://127.0.0.1:47801/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-1',
      scope: 'read:orders offline_access',
    });
    expect(redirectUri({ ...code, redirectPort: 9000 })).toBe('http://127.0.0.1:9000/callback');

    const { calls, fetchImpl } = tokenEndpoint([{ access_token: 'tok', expires_in: 60, refresh_token: 'rt-new' }]);
    const runtime: Record<string, string> = {};
    const saved: Record<string, string> = {};
    await finishSignIn(code, env(code), 'the-code', verifier, { vars, runtime, fetchImpl, saveSecret: (n, v) => (saved[n] = v) });
    expect(Object.fromEntries(calls[0].form)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:47801/callback',
      client_id: 'acme-client',
    });
    expect(runtime[oauthKey('staging')]).toBe('tok');
    expect(runtime[oauthRefreshKey('staging')]).toBe('rt-new');
    expect(saved).toEqual({ RT: 'rt-new' });
  });
});

describe('calls with OAuth', () => {
  const tool: ToolDef = { id: 'GET /orders', name: 'list_orders', description: '', enabled: true, safety: 'read', method: 'GET', path: '/orders', params: [], bodyMode: 'none' };
  const project: Project = { overapi: 1, name: 'acme', title: 'Acme', description: '', version: '0.1.0', envs: [env(cc)], tools: [tool] } as Project;

  it('sends the token, and on a 401 gets a new one and retries once', async () => {
    const seen: string[] = [];
    let issued = 0;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith('https://auth.acme.test')) return new Response(JSON.stringify({ access_token: `tok-${++issued}`, expires_in: 3600 }), { status: 200 });
      const auth = (init!.headers as Record<string, string>).authorization;
      seen.push(auth);
      return auth === 'Bearer tok-2' ? new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 401 });
    }) as typeof fetch;
    const out = await callTool(project, tool, env(cc), {}, { vars, runtime: {}, fetchImpl });
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(out.result.ok).toBe(true);
    expect(out.signedIn).toBe(true);
    expect(out.result.request.headers.authorization).toBe('Bearer •••');
  });
});

describe('discover', () => {
  const docs: Record<string, unknown> = {
    'https://auth.acme.test/.well-known/openid-configuration': {
      token_endpoint: 'https://auth.acme.test/oauth/token',
      authorization_endpoint: 'https://auth.acme.test/authorize',
      scopes_supported: ['openid', 'offline_access'],
    },
    'https://login.acme.test/.well-known/oauth-authorization-server/tenant-1': { token_endpoint: 'https://login.acme.test/tenant-1/token' },
  };
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const d = docs[String(url)];
    return d ? new Response(JSON.stringify(d), { status: 200 }) : new Response('not found', { status: 404 });
  }) as typeof fetch;

  it('finds the token and sign-in pages from the provider’s address', async () => {
    expect(await discover('https://auth.acme.test/', fetchImpl)).toEqual({
      tokenUrl: 'https://auth.acme.test/oauth/token',
      authUrl: 'https://auth.acme.test/authorize',
      scopes: ['openid', 'offline_access'],
    });
  });

  it('falls back to OAuth metadata, and takes the discovery document itself', async () => {
    expect((await discover('https://login.acme.test/tenant-1', fetchImpl)).tokenUrl).toBe('https://login.acme.test/tenant-1/token');
    expect((await discover('https://auth.acme.test/.well-known/openid-configuration', fetchImpl)).tokenUrl).toBe('https://auth.acme.test/oauth/token');
  });

  it('says plainly when there is nothing to find', async () => {
    await expect(discover('https://api.acme.test', fetchImpl)).rejects.toThrow('api.acme.test doesn’t describe itself at the usual address. Enter its token URL under More options.');
    await expect(discover('auth dot acme', fetchImpl)).rejects.toThrow('That isn’t an address.');
  });
});
