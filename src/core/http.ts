// One tool call as one HTTP request. Building is pure and separate from
// sending so it can be tested and shown ("this is what will go out")
// without a network.

import { DEFAULT_RESPONSE_LIMIT, fillVars, type EnvDef, type ToolDef } from '../shared/project';
import type { VarSource } from './vars';
import { localFetch } from './localFetch';
import { buildEnvelope, readEnvelope, readXml } from '../shared/soap';

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /// Values to scrub from anything shown or returned: the secrets this
  /// request carries.
  secrets: string[];
}

export class ArgumentError extends Error {}

/// A sign-in borrowed from another API: what it would send.
export interface Borrowed {
  headers: Record<string, string>;
  query: Record<string, string>;
  secrets: string[];
  from: string;
}
export const viaKey = (env: string) => `__via:${env}`;

/// `runtime`: values kept from earlier responses ({{token}} after a login),
/// filled into the URL, headers and string arguments.
export function buildRequest(tool: ToolDef, env: EnvDef, rawArgs: Record<string, unknown>, vars: VarSource, runtime?: Record<string, string>): BuiltRequest {
  const secrets: string[] = [];
  // String values may hold {{kept}} values and ${SECRETS} (a login's
  // password) — filled here, and the secrets scrubbed from what is shown.
  const fillArg = (v: string) =>
    fillVars(v, env, runtime).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = vars(name) ?? '';
      if (value) secrets.push(value);
      return value;
    });
  const args: Record<string, unknown> = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [k, typeof v === 'string' && (v.includes('{{') || v.includes('${')) ? fillArg(v) : v]));
  // An argument left out takes its default (a shared value moved to the environment).
  for (const p of tool.params) if ((args[p.name] === undefined || args[p.name] === '') && p.schema.default !== undefined) args[p.name] = p.schema.default;
  const missing = tool.params.filter((p) => p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === ''));
  if (missing.length) throw new ArgumentError(`Missing required argument${missing.length === 1 ? '' : 's'}: ${missing.map((p) => p.name).join(', ')}.`);

  let path = tool.path;
  for (const p of tool.params.filter((x) => x.in === 'path')) {
    path = path.replaceAll(`{${p.name}}`, encodeURIComponent(String(args[p.name])));
  }
  if (!env.baseUrl) throw new ArgumentError(`The "${env.name}" environment has no base URL.`);
  const base = fillVars(env.baseUrl, env, runtime).replace(/\/+$/, '');
  path = fillVars(path, env, runtime);
  let url: URL;
  try {
    url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  } catch {
    throw new ArgumentError(`"${base}" is not a usable base URL. Check the "${env.name}" environment${/\{\{/.test(base) ? ' — a {{variable}} in it has no value' : ''}.`);
  }

  for (const p of tool.params.filter((x) => x.in === 'query')) {
    const v = args[p.name];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(p.name, scalar(item));
    else url.searchParams.set(p.name, scalar(v));
  }

  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5', 'user-agent': 'overapi' };
  const fillHeader = (v: string) =>
    fillVars(v, env, runtime).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = vars(name) ?? '';
      if (value) secrets.push(value);
      return value;
    });
  // The environment's headers, then this request's own on top.
  for (const [k, v] of Object.entries(env.headers ?? {})) headers[k.toLowerCase()] = fillHeader(v);
  for (const [k, v] of Object.entries(tool.headers ?? {})) headers[k.toLowerCase()] = fillHeader(v);
  for (const p of tool.params.filter((x) => x.in === 'header')) {
    const v = args[p.name];
    if (v !== undefined && v !== null && v !== '') headers[p.name.toLowerCase()] = scalar(v);
  }

  // A request's own sign-in wins over its environment's.
  const auth = tool.auth ?? env.auth;
  if (auth.type === 'bearer') {
    const token = vars(auth.tokenVar);
    if (token) {
      headers.authorization = `Bearer ${token}`;
      secrets.push(token);
    }
  } else if (auth.type === 'apiKey') {
    const key = vars(auth.valueVar);
    if (key) {
      if (auth.in === 'header') headers[auth.name.toLowerCase()] = key;
      else url.searchParams.set(auth.name, key);
      secrets.push(key);
    }
  } else if (auth.type === 'via') {
    // Another API's sign-in, worked out before this request (flow.ts):
    // the headers (and query values) it would send.
    const raw = runtime?.[viaKey(env.name)];
    if (raw) {
      const b = JSON.parse(raw) as Borrowed;
      for (const [k, v] of Object.entries(b.headers)) headers[k.toLowerCase()] = v;
      for (const [k, v] of Object.entries(b.query)) url.searchParams.set(k, v);
      secrets.push(...b.secrets);
    }
  } else if (auth.type === 'login') {
    // The token the sign-in request answered with (src/core/flow.ts). Not
    // there yet: the request goes without, and the caller signs in.
    const token = runtime?.[`__login:${env.name}`];
    if (token) {
      if (auth.sendAs === 'bearer') headers.authorization = `Bearer ${token}`;
      else if (auth.sendAs === 'header') headers[(auth.name || 'X-Auth-Token').toLowerCase()] = token;
      else if (auth.sendAs === 'query') url.searchParams.set(auth.name || 'token', token);
      else headers.cookie = `${auth.name || 'session'}=${token}`;
      secrets.push(token);
    }
  } else if (auth.type === 'basic') {
    const user = vars(auth.userVar) ?? '';
    const pass = vars(auth.passVar) ?? '';
    if (user || pass) {
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers.authorization = `Basic ${encoded}`;
      secrets.push(encoded);
      if (pass) secrets.push(pass);
    }
  }

  let body: string | undefined;
  const bodyParams = tool.params.filter((x) => x.in === 'body');
  if (tool.bodyMode === 'soap' && tool.soap) {
    const values: Record<string, unknown> = {};
    for (const p of bodyParams) if (args[p.name] !== undefined) values[p.name] = args[p.name];
    let security: { user: string; password: string } | undefined;
    if (auth.type === 'wsse') {
      const user = vars(auth.userVar) ?? '';
      const password = vars(auth.passVar) ?? '';
      if (user || password) {
        security = { user, password };
        if (password) secrets.push(password);
      }
    }
    const env_ = buildEnvelope(tool.soap, values, security);
    body = env_.body;
    Object.assign(headers, env_.headers);
  } else if (tool.bodyMode === 'json-whole') {
    const v = args.body ?? args[bodyParams[0]?.name ?? 'body'];
    if (v !== undefined) {
      body = typeof v === 'string' && looksLikeJson(v) ? v : JSON.stringify(v);
      headers['content-type'] = 'application/json';
    }
  } else if (tool.bodyMode === 'json-fields') {
    const obj: Record<string, unknown> = {};
    for (const p of bodyParams) if (args[p.name] !== undefined) obj[p.name] = args[p.name];
    body = JSON.stringify(obj);
    headers['content-type'] = 'application/json';
  } else if (tool.bodyMode === 'form') {
    const form = new URLSearchParams();
    for (const p of bodyParams) if (args[p.name] !== undefined && args[p.name] !== null) form.set(p.name, scalar(args[p.name]));
    body = form.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }

  return { method: tool.method, url: url.toString(), headers, body, secrets: secrets.filter((s) => s.length >= 4) };
}

/// The most of a response the app will show a person.
const FULL_LIMIT = 5_000_000;

export interface CallResult {
  ok: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  contentType: string;
  /// The body as handed to an agent: compact JSON when it was JSON, cut at
  /// the tool's response limit, secrets scrubbed.
  body: string;
  truncated: boolean;
  /// Response headers, lower-cased, secrets scrubbed.
  headers: Record<string, string>;
  /// When the body was cut for agents: the whole of it, for people to read.
  full?: string;
  /// Size of the body as received.
  bytes: number;
  /// The whole body parsed, when it was JSON — for captures, which must see
  /// past the response limit. Never shown or sent to an agent as is.
  json?: unknown;
  /// The request as sent, secrets scrubbed — for the person, not the agent.
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
}

export async function send(req: BuiltRequest, opts: { limit?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<CallResult> {
  const started = Date.now();
  const limit = opts.limit ?? DEFAULT_RESPONSE_LIMIT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  const doFetch = opts.fetchImpl ?? localFetch;
  let res: Response;
  try {
    res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error & { cause?: { code?: string } };
    const reason = err.name === 'AbortError' ? `no answer after ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} s` : (err.cause?.code ?? err.message);
    throw new Error(scrub(`Could not reach ${new URL(req.url).origin}: ${reason}.`, req.secrets));
  }
  const raw = await res.text().finally(() => clearTimeout(timer));
  const contentType = res.headers.get('content-type') ?? '';
  let text = raw;
  let json: unknown;
  let ok = res.ok;
  let statusText = res.statusText;
  if (/json/i.test(contentType) || looksLikeJson(raw)) {
    try {
      json = JSON.parse(raw);
      // Compact: every character is context the agent pays for. The app
      // re-indents it for people.
      text = JSON.stringify(json);
    } catch {
      // Not JSON after all; keep it as sent.
    }
  } else if (/xml/i.test(contentType) || raw.trimStart().startsWith('<?xml') || /^\s*<[\w:]*Envelope[\s>]/.test(raw)) {
    // XML — a SOAP envelope above all — handed on as JSON: agents, kept
    // values and tests all read JSON. A Fault is an error, whatever the
    // HTTP status says.
    const soap = readEnvelope(raw);
    if (soap) {
      json = soap.json;
      if (soap.fault) {
        ok = false;
        statusText = `SOAP Fault: ${soap.fault.message}`;
      }
      text = JSON.stringify(json);
    } else {
      const x = readXml(raw);
      if (x !== undefined) {
        json = x;
        text = JSON.stringify(x);
      }
    }
  }
  text = scrub(text, req.secrets);
  const truncated = text.length > limit;
  // People see all of it (up to a sane size); agents get the cut.
  const full = truncated ? text.slice(0, FULL_LIMIT) : undefined;
  if (truncated) text = `${text.slice(0, limit)}\n… [cut at ${limit} of ${text.length} characters — narrow the request with its filters or paging]`;
  return {
    ok,
    status: res.status,
    statusText,
    durationMs: Date.now() - started,
    contentType,
    body: text,
    truncated,
    full,
    headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), scrub(v, req.secrets)])),
    bytes: Buffer.byteLength(raw),
    json,
    request: shown(req),
  };
}

export function shown(req: BuiltRequest): CallResult['request'] {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, scrub(v, req.secrets)]));
  return { method: req.method, url: scrub(req.url, req.secrets), headers, body: req.body === undefined ? undefined : scrub(req.body, req.secrets) };
}

export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('•••');
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join('•••');
  }
  return out;
}

function scalar(v: unknown): string {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}
