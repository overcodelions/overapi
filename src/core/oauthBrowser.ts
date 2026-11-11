// OAuth's browser sign-in, start to finish: open the provider's sign-in
// page, catch the browser when it comes back to http://127.0.0.1:<port>/callback
// with a code, and swap the code for tokens. The app passes how to open a
// browser; tests pass a fake one.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { EnvDef } from '../shared/project';
import { authorizeUrl, DEFAULT_REDIRECT_PORT, finishSignIn, pkce, type OAuth2, type TokenDeps, type TokenSet } from './oauth';

const page = (text: string) => `<!doctype html><meta charset="utf-8"><title>overapi</title><body style="font:15px system-ui;padding:48px;color:#222">${text.replace(/</g, '&lt;')}</body>`;

/// Listens on the loopback port until the browser comes back with a code
/// for this `state`, then stops listening. `open` is called once listening.
export function waitForCode(opts: { port: number; state: string; timeoutMs?: number; open: () => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((rq, rs) => {
      const u = new URL(rq.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        rs.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const ok = !err && u.searchParams.get('state') === opts.state && !!code;
      rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        page(ok ? 'Signed in. You can close this tab and go back to overapi.' : 'Sign-in didn’t finish. Go back to overapi to try again.'),
      );
      clearTimeout(timer);
      server.close();
      if (ok) resolve(code!);
      else reject(new Error(err ? `The provider said: ${u.searchParams.get('error_description') ?? err}.` : 'The answer didn’t match this sign-in. Try again.'));
    });
    const timer = setTimeout(
      () => {
        server.close();
        reject(new Error(`No sign-in after ${Math.round((opts.timeoutMs ?? 5 * 60_000) / 60_000) || 1} minute(s). Try again.`));
      },
      opts.timeoutMs ?? 5 * 60_000,
    );
    server.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${opts.port} is busy. Pick another redirect port, and register it with the provider.` : e.message));
    });
    server.listen(opts.port, '127.0.0.1', opts.open);
  });
}

/// The whole browser sign-in: PKCE, the provider's page, the code, the
/// tokens. The access token lands in `deps.runtime`, the refresh token in
/// `deps.saveSecret`.
/// `waitMs`: how long to wait for the person (five minutes); `timeoutMs` is
/// the token request's own.
export async function signInWithBrowser(a: OAuth2, env: EnvDef, deps: TokenDeps & { open: (url: string) => void; waitMs?: number }): Promise<TokenSet> {
  const clientId = deps.vars(a.clientIdVar);
  if (!clientId) throw new Error(`Set the client id (${a.clientIdVar}) first.`);
  const { verifier, challenge } = pkce();
  const state = randomUUID();
  const url = authorizeUrl(a, clientId, challenge, state);
  const code = await waitForCode({ port: a.redirectPort ?? DEFAULT_REDIRECT_PORT, state, timeoutMs: deps.waitMs, open: () => deps.open(url) });
  return finishSignIn(a, env, code, verifier, deps);
}
