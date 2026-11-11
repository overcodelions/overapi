import crypto from 'node:crypto';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { signInWithBrowser, waitForCode } from './oauthBrowser';
import { oauthKey, type OAuth2 } from './oauth';
import type { EnvDef } from '../shared/project';

/// A port nothing is listening on.
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const auth = (port: number): OAuth2 => ({
  type: 'oauth2',
  grant: 'authorization_code',
  tokenUrl: 'https://auth.acme.test/token',
  authUrl: 'https://auth.acme.test/authorize',
  clientIdVar: 'ID',
  refreshTokenVar: 'RT',
  scope: 'openid offline_access',
  redirectPort: port,
});
const env = (a: OAuth2): EnvDef => ({ name: 'staging', baseUrl: 'https://api.acme.test', auth: a, allowWrites: false });
const vars = (n: string) => (n === 'ID' ? 'acme-client' : undefined);

/// A provider and a browser. The browser reads the sign-in page's address
/// and comes back to the redirect with whatever `answer` says; the token
/// endpoint only gives tokens for the right code and a verifier that
/// matches the challenge the browser carried.
function provider(answer: (signIn: URL) => Record<string, string>) {
  let challenge = '';
  const forms: URLSearchParams[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const f = new URLSearchParams(String(init!.body));
    forms.push(f);
    const ok =
      f.get('code') === 'code-123' &&
      crypto
        .createHash('sha256')
        .update(f.get('code_verifier') ?? '')
        .digest('base64url') === challenge;
    return new Response(JSON.stringify(ok ? { access_token: 'tok', expires_in: 3600, refresh_token: 'rt' } : { error: 'invalid_grant' }), { status: ok ? 200 : 400 });
  }) as typeof fetch;
  const open = (url: string) => {
    const u = new URL(url);
    challenge = u.searchParams.get('code_challenge') ?? '';
    const back = new URL(u.searchParams.get('redirect_uri')!);
    for (const [k, v] of Object.entries(answer(u))) back.searchParams.set(k, v);
    void fetch(back).catch(() => undefined);
  };
  return { fetchImpl, open, forms };
}

describe('signInWithBrowser', () => {
  it('signs in end to end: PKCE, the code back on the loopback, the tokens kept', async () => {
    const port = await freePort();
    const p = provider((u) => ({ code: 'code-123', state: u.searchParams.get('state')! }));
    const runtime: Record<string, string> = {};
    const saved: Record<string, string> = {};
    await signInWithBrowser(auth(port), env(auth(port)), { vars, runtime, fetchImpl: p.fetchImpl, open: p.open, saveSecret: (n, v) => (saved[n] = v) });
    expect(runtime[oauthKey('staging')]).toBe('tok');
    expect(saved).toEqual({ RT: 'rt' });
    expect(Object.fromEntries(p.forms[0])).toMatchObject({ grant_type: 'authorization_code', code: 'code-123', client_id: 'acme-client', redirect_uri: `http://127.0.0.1:${port}/callback` });
  });

  it('refuses an answer meant for another sign-in', async () => {
    const port = await freePort();
    const p = provider(() => ({ code: 'code-123', state: 'someone-elses' }));
    await expect(signInWithBrowser(auth(port), env(auth(port)), { vars, runtime: {}, fetchImpl: p.fetchImpl, open: p.open })).rejects.toThrow('The answer didn’t match this sign-in.');
    expect(p.forms).toHaveLength(0);
  });

  it('passes on what the provider said when the person says no', async () => {
    const port = await freePort();
    const p = provider(() => ({ error: 'access_denied', error_description: 'The user declined' }));
    await expect(signInWithBrowser(auth(port), env(auth(port)), { vars, runtime: {}, fetchImpl: p.fetchImpl, open: p.open })).rejects.toThrow('The provider said: The user declined.');
  });

  it('needs the client id before opening anything', async () => {
    let opened = false;
    await expect(signInWithBrowser(auth(1), env(auth(1)), { vars: () => undefined, runtime: {}, open: () => (opened = true) })).rejects.toThrow('Set the client id (ID) first.');
    expect(opened).toBe(false);
  });
});

describe('waitForCode', () => {
  it('ignores other paths (a favicon), then takes the callback', async () => {
    const port = await freePort();
    const statuses: number[] = [];
    const code = await waitForCode({
      port,
      state: 's1',
      open: () =>
        void (async () => {
          statuses.push((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status);
          await fetch(`http://127.0.0.1:${port}/callback?code=c-1&state=s1`);
        })(),
    });
    expect([code, statuses]).toEqual(['c-1', [404]]);
  });

  it('gives up after waiting, and stops listening', async () => {
    const port = await freePort();
    await expect(waitForCode({ port, state: 's', timeoutMs: 50, open: () => undefined })).rejects.toThrow(/^No sign-in after/);
    // The port is free again.
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer().once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });

  it('says plainly when the redirect port is taken', async () => {
    const port = await freePort();
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(port, '127.0.0.1', () => r()));
    try {
      await expect(waitForCode({ port, state: 's', open: () => undefined })).rejects.toThrow(`Port ${port} is busy. Pick another redirect port`);
    } finally {
      busy.close();
    }
  });
});
