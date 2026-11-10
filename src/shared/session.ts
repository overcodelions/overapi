// A browser sign-in, as an environment's headers: the cookies the site set
// once the person signed in, any anti-forgery (CSRF) header the web app
// sends, and a bearer token if the app keeps one in the page rather than a
// cookie. Each value goes to the keychain; the project only names them.
//
// It is the person's own session. It expires when the site says so, and it
// must never be published for others to use — check.ts and the overgo push
// both refuse it.

import type { RecordedCall } from './recording';
import { within } from './recording';
import { varPrefix } from './project';

export interface CookieLite {
  name: string;
  value: string;
}

export interface SessionPlan {
  /// Headers for the environment: name -> `${SECRET}`.
  headers: Record<string, string>;
  /// Secret name -> value, for the keychain.
  secrets: Record<string, string>;
  /// What it found, for one line to the person.
  found: string[];
}

const CSRF = /csrf|xsrf/i;
const NOT_CSRF = /^(cookie|authorization|content-type|accept|user-agent|referer|origin|host|content-length)$/i;

/// `calls`: what the browser sent to the API (recorded), newest last.
/// `base`: the environment's base URL. `prefix`: the project's secret prefix.
export function sessionPlan(cookies: CookieLite[], calls: RecordedCall[], base: string, prefix: string): SessionPlan {
  const headers: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const found: string[] = [];
  const mine = within(calls, base).filter((c) => c.url);

  const usable = cookies.filter((c) => c.name && c.value);
  if (usable.length) {
    secrets[`${prefix}_SESSION`] = usable.map((c) => `${c.name}=${c.value}`).join('; ');
    headers.Cookie = `\${${prefix}_SESSION}`;
    found.push(`${usable.length} cookie${usable.length === 1 ? '' : 's'}`);
  }

  // A token the page holds and sends itself — common in single-page apps.
  const lastAuth = [...mine].reverse().map((c) => header(c, 'authorization')).find(Boolean);
  if (lastAuth) {
    secrets[`${prefix}_TOKEN`] = lastAuth;
    headers.Authorization = `\${${prefix}_TOKEN}`;
    found.push(/^bearer\s/i.test(lastAuth) ? 'a bearer token' : 'an Authorization header');
  }

  // An anti-forgery header: named like one, or carrying a cookie's value
  // (the double-submit pattern). Prefer the cookie's value — it is fresher
  // than what was last sent.
  const byValue = new Map(usable.filter((c) => c.value.length >= 8).map((c) => [c.value, c]));
  for (const c of [...mine].reverse()) {
    const hit = Object.entries(c.requestHeaders).find(([k, v]) => !NOT_CSRF.test(k) && !k.startsWith(':') && (CSRF.test(k) || byValue.has(v)));
    if (!hit) continue;
    const [name, value] = hit;
    const cookie = byValue.get(value) ?? usable.find((x) => CSRF.test(x.name));
    secrets[`${prefix}_CSRF`] = cookie?.value ?? value;
    headers[canonical(name)] = `\${${prefix}_CSRF}`;
    found.push(`the ${canonical(name)} header`);
    break;
  }

  if (!Object.keys(secrets).length) {
    throw new Error(`No sign-in found for ${hostOf(base)}: the browser has no cookies for it and sent no token. Sign in in the browser window, use the app a little, then try again.`);
  }
  return { headers, secrets, found };
}

function header(c: RecordedCall, name: string): string | undefined {
  return Object.entries(c.requestHeaders).find(([k]) => k.toLowerCase() === name)?.[1];
}

/// x-csrf-token -> X-Csrf-Token, as people write them.
function canonical(name: string): string {
  return name
    .split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join('-');
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/// Said when a call with a browser sign-in is refused: the session ended —
/// or it was made on another site than the one the requests now go to.
export function sessionExpiredHint(envName: string, site: string, baseUrl?: string): string {
  if (baseUrl && !sameSite(site, baseUrl)) {
    const host = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `"${envName}" is signed in to ${host(site)}, but its requests go to ${host(baseUrl)} — that session can't sign them. In overapi, open Environments → ${envName} → Sign in there.`;
  }
  return `The browser sign-in for "${envName}" has probably expired. In overapi, open Environments → ${envName} → Sign in again (it opens ${site}).`;
}

/// Secret names for one environment's session: ACME_STAGING_SESSION, so two
/// environments signed in to two sites never share (or overwrite) a value.
export function sessionPrefix(projectName: string, envName: string): string {
  return `${varPrefix(projectName)}_${envName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'ENV'}`;
}

/// A header value a browser sign-in put there.
export const isSessionHeader = (value: string) => /\$\{[A-Za-z0-9_]+_(SESSION|CSRF|TOKEN)\}$/.test(value);

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

/// Whether a session from `site` can sign requests to `baseUrl`: the same
/// host, or two hosts of one domain (app.acme.example and api.acme.example).
export function sameSite(site: string, baseUrl: string): boolean {
  try {
    const a = new URL(site).hostname.toLowerCase();
    const b = new URL(baseUrl).hostname.toLowerCase();
    if (LOCAL.test(a) || LOCAL.test(b) || /^\d+\.\d+\.\d+\.\d+$/.test(a) || /^\d+\.\d+\.\d+\.\d+$/.test(b)) return a === b;
    const root = (h: string) => h.split('.').slice(-2).join('.');
    return root(a) === root(b);
  } catch {
    return true;
  }
}

/// Where a web app probably lives, from its API's address: api.acme.example
/// → https://acme.example, http://localhost:4200/api → http://localhost:4200.
export function siteGuess(baseUrl: string | undefined): string {
  try {
    const u = new URL(baseUrl ?? '');
    return `${u.protocol}//${u.host.replace(/^(api|apis|rest|gateway)\./i, '')}`;
  } catch {
    return '';
  }
}
