// OAuth 2 for a sign-in. Two grants:
//   client_credentials — a service account. overapi asks the token
//     endpoint with the client's id and secret, keeps the token until it
//     runs out, then asks again. Nobody signs in.
//   authorization_code — a person signs in once in the browser, with PKCE.
//     The refresh token is kept as a secret (the keychain), so the app and
//     agents alike get fresh access tokens from it without asking again.
//
// Access tokens are kept with the session's other values (never in the
// project file); the refresh token is a secret like any other.

import crypto from 'node:crypto';
import type { AuthSpec, EnvDef } from '../shared/project';
import type { VarSource } from './vars';

export type OAuth2 = Extract<AuthSpec, { type: 'oauth2' }>;

export const oauthKey = (env: string) => `__oauth:${env}`;
export const oauthExpKey = (env: string) => `__oauth_exp:${env}`;
export const oauthRefreshKey = (env: string) => `__oauth_refresh:${env}`;

/// Where the browser comes back to after signing in. The provider must
/// have this exact address registered for the client.
export const DEFAULT_REDIRECT_PORT = 47801;
export const redirectUri = (a: OAuth2) => `http://127.0.0.1:${a.redirectPort ?? DEFAULT_REDIRECT_PORT}/callback`;

export interface TokenDeps {
  vars: VarSource;
  runtime: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /// Saves a rotated refresh token where the next run will find it.
  saveSecret?: (name: string, value: string) => void;
}

export interface TokenSet {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
}

/// The kept token, while it has more than half a minute left.
export function cachedToken(env: string, runtime: Record<string, string>, now: number): string | undefined {
  const token = runtime[oauthKey(env)];
  if (!token) return undefined;
  const exp = Number(runtime[oauthExpKey(env)] || 0);
  if (exp && now >= exp - 30_000) return undefined;
  return token;
}

const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
};

/// One call to the token endpoint. The client proves itself in the body,
/// or with HTTP Basic when set — or, left to overapi, in the body and then
/// with Basic if the provider says the client is unknown.
export async function requestToken(a: OAuth2, form: Record<string, string>, deps: TokenDeps): Promise<TokenSet> {
  if (!a.tokenUrl) throw new Error('OAuth: set the provider (or its token URL) under Environments → Sign-in.');
  const id = deps.vars(a.clientIdVar) ?? '';
  const secret = a.clientSecretVar ? (deps.vars(a.clientSecretVar) ?? '') : '';
  if (!id) throw new Error(`OAuth: the client id (${a.clientIdVar}) isn't set. Add it under Environments → Sign-in.`);
  const attempt = async (basic: boolean) => {
    const body = new URLSearchParams(form);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (basic) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    } else {
      body.set('client_id', id);
      if (secret) body.set('client_secret', secret);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(a.tokenUrl, { method: 'POST', headers, body: body.toString(), signal: controller.signal });
    } catch (e) {
      throw new Error(`OAuth: could not reach ${origin(a.tokenUrl)}: ${(e as Error).message}.`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Some providers answer form-encoded whatever was asked for.
      json = Object.fromEntries(new URLSearchParams(text));
    }
    return { res, json, ok: res.ok && typeof json.access_token === 'string' && !!json.access_token };
  };
  let r = await attempt(a.clientAuth === 'basic' && !!secret);
  if (!r.ok && !a.clientAuth && secret && (r.json.error === 'invalid_client' || r.res.status === 401)) r = await attempt(true);
  if (!r.ok) {
    const why = [r.json.error, r.json.error_description].filter(Boolean).join(': ') || `${r.res.status} ${r.res.statusText}`;
    throw new Error(`OAuth: the token endpoint refused: ${why}.`);
  }
  return { ...r.json, expires_in: r.json.expires_in === undefined ? undefined : Number(r.json.expires_in) } as TokenSet;
}

/// Where a provider says its token and sign-in pages are: its OpenID
/// Connect discovery document, else its OAuth metadata (RFC 8414). Okta,
/// Auth0, Entra, Google, Keycloak and Cognito all publish one.
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<{ tokenUrl: string; authUrl?: string; scopes?: string[] }> {
  let base: URL;
  try {
    base = new URL(issuer.trim());
  } catch {
    throw new Error('That isn’t an address. Paste the provider’s, like https://auth.acme.example.');
  }
  const root = base.toString().replace(/\/+$/, '');
  const tail = base.pathname.replace(/\/+$/, '');
  const tries = /\/\.well-known\//.test(base.pathname) ? [root] : [`${root}/.well-known/openid-configuration`, `${base.origin}/.well-known/oauth-authorization-server${tail}`];
  for (const u of tries) {
    try {
      const res = await fetchImpl(u, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const d = (await res.json()) as Record<string, unknown>;
      if (typeof d.token_endpoint !== 'string') continue;
      return {
        tokenUrl: d.token_endpoint,
        authUrl: typeof d.authorization_endpoint === 'string' ? d.authorization_endpoint : undefined,
        scopes: Array.isArray(d.scopes_supported) ? d.scopes_supported.map(String) : undefined,
      };
    } catch {
      // Not there, or not JSON: try the next address.
    }
  }
  throw new Error(`${base.host} doesn’t describe itself at the usual address. Enter its token URL under More options.`);
}

function keep(env: string, t: TokenSet, deps: TokenDeps): void {
  const now = (deps.now ?? Date.now)();
  deps.runtime[oauthKey(env)] = t.access_token;
  deps.runtime[oauthExpKey(env)] = t.expires_in ? String(now + t.expires_in * 1000) : '';
  if (t.refresh_token) deps.runtime[oauthRefreshKey(env)] = t.refresh_token;
}

/// An access token for this environment: the kept one while it lasts, else
/// a new one. `force`: the server refused the kept one.
export async function oauthToken(a: OAuth2, env: EnvDef, deps: TokenDeps, force = false): Promise<string> {
  const now = (deps.now ?? Date.now)();
  if (!force) {
    const kept = cachedToken(env.name, deps.runtime, now);
    if (kept) return kept;
  }
  const scope: Record<string, string> = a.scope ? { scope: a.scope } : {};
  if (a.grant === 'client_credentials') {
    const t = await requestToken(a, { grant_type: 'client_credentials', ...scope, ...(a.audience ? { audience: a.audience } : {}) }, deps);
    keep(env.name, t, deps);
    return t.access_token;
  }
  const refresh = deps.runtime[oauthRefreshKey(env.name)] ?? (a.refreshTokenVar ? deps.vars(a.refreshTokenVar) : undefined);
  if (!refresh) throw new Error(`Not signed in to ${env.name} yet. Sign in once under Environments → Sign-in; agents use the same sign-in after that.`);
  let t: TokenSet;
  try {
    t = await requestToken(a, { grant_type: 'refresh_token', refresh_token: refresh, ...scope }, deps);
  } catch (e) {
    throw new Error(`${(e as Error).message} The sign-in for ${env.name} may have ended — sign in again under Environments → Sign-in.`);
  }
  keep(env.name, t, deps);
  // Providers that rotate refresh tokens invalidate the old one: keep the new.
  if (t.refresh_token && t.refresh_token !== refresh && a.refreshTokenVar) deps.saveSecret?.(a.refreshTokenVar, t.refresh_token);
  return t.access_token;
}

/// A PKCE pair: the verifier stays here, the challenge goes to the browser.
export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/// The provider's sign-in page, asking it to come back with a code.
/// An address it's safe to hand the system browser: https, or http on this
/// machine. Never file:, an app's own scheme, or anything else a project
/// file could use to open something locally.
export function isBrowserSafe(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname));
  } catch {
    return false;
  }
}

export function authorizeUrl(a: OAuth2, clientId: string, challenge: string, state: string): string {
  if (!a.authUrl) throw new Error('OAuth: set the authorization URL to sign in with the browser.');
  if (!isBrowserSafe(a.authUrl)) throw new Error(`OAuth: the sign-in page must be an https address, not ${a.authUrl.split(':')[0]}:.`);
  const u = new URL(a.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri(a));
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (a.scope) u.searchParams.set('scope', a.scope);
  if (a.audience) u.searchParams.set('audience', a.audience);
  for (const [k, v] of Object.entries(a.authParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/// Swaps the code the browser came back with for tokens, keeps the access
/// token, and saves the refresh token as a secret.
export async function finishSignIn(a: OAuth2, env: EnvDef, code: string, verifier: string, deps: TokenDeps): Promise<TokenSet> {
  const t = await requestToken(a, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(a), code_verifier: verifier }, deps);
  keep(env.name, t, deps);
  if (t.refresh_token && a.refreshTokenVar) deps.saveSecret?.(a.refreshTokenVar, t.refresh_token);
  return t;
}
