// A request from a pasted `curl` command — the way most people already
// have a working call to a legacy API: "Copy as cURL" from the browser's
// network tab, or the one line in a wiki page.
//
// Like the HAR importer, it keeps the *kind* of auth and never its value:
// an Authorization header or API key in the command becomes a variable
// name, and the secret itself is handed back separately so the app can
// offer to put it in the keychain — never into the project file.

import type { AuthSpec, BodyMode, HttpMethod, JsonSchema, ParamDef, ToolDef } from './project';
import { toolId } from './project';
import { nameFromRoute } from './naming';
import { safetyFor } from './safety';

export interface ParsedCurl {
  method: HttpMethod;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

/// Shell-style words: quotes, escapes and line continuations.
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const src = text.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) cur += src[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) words.push(cur);
  // Windows "Copy as cURL (cmd)" escapes with ^.
  return words.map((w) => (/\^/.test(w) && !/\s/.test(w) ? w.replace(/\^(.)/g, '$1') : w));
}

/// Chrome's "Copy as cURL (cmd)" escapes for Windows cmd: every value in
/// ^"…^", a caret before & | < > ^ and ", and ^ at the end of a line. Undo it,
/// so the rest reads it like the bash form.
export function fromCmd(text: string): string {
  if (!/\^"/.test(text)) return text;
  return text.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
}

export function parseCurl(text: string): ParsedCurl {
  const words = shellWords(fromCmd(text.trim()));
  if (!/^curl(\.exe)?$/i.test(words[0] ?? '')) throw new Error('That does not start with curl.');
  let method: string | undefined;
  let url: string | undefined;
  const headers: Record<string, string> = {};
  const data: string[] = [];
  let user: string | undefined;
  let get = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = () => words[++i] ?? '';
    if (w === '-X' || w === '--request') method = next().toUpperCase();
    else if (w.startsWith('-X') && w.length > 2) method = w.slice(2).toUpperCase();
    else if (w === '-H' || w === '--header') {
      const h = next();
      const at = h.indexOf(':');
      if (at > 0) headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json'].includes(w)) {
      data.push(next());
      if (w === '--json') {
        headers['content-type'] ??= 'application/json';
        headers.accept ??= 'application/json';
      }
    } else if (w === '-u' || w === '--user') user = next();
    else if (w === '-G' || w === '--get') get = true;
    else if (w === '--url') url = next();
    else if (['-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out'].includes(w)) next();
    else if (!w.startsWith('-') && !url) url = w;
  }
  if (!url) throw new Error('No URL in that curl command.');
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  if (user) headers.authorization = `Basic ${typeof btoa === 'function' ? btoa(user) : Buffer.from(user).toString('base64')}`;
  let body: string | undefined;
  if (data.length) {
    if (get) for (const d of data) for (const [k, v] of new URLSearchParams(d)) parsed.searchParams.append(k, v);
    else body = data.join('&');
  }
  const m = (method ?? (body !== undefined ? 'POST' : 'GET')) as HttpMethod;
  return { method: m, url: parsed, headers, body };
}

export interface CurlTool {
  tool: ToolDef;
  /// origin + any mount prefix: what the environment's base URL should be.
  baseUrl: string;
  auth: AuthSpec;
  /// The credential found in the command, for the keychain. Never saved
  /// to the project.
  secret?: { value: string };
}

/// Turns a parsed curl into a tool. `base` is the environment's current
/// base URL: when the call is under it, the tool's path is relative to it.
export function toolFromCurl(c: ParsedCurl, opts: { base?: string; varPrefix: string }): CurlTool {
  const origin = c.url.origin;
  const base = opts.base && c.url.href.startsWith(opts.base.replace(/\/+$/, '')) ? opts.base.replace(/\/+$/, '') : origin;
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  let path = c.url.pathname.slice(basePath.length) || '/';
  // Values in the path become parameters, as in a capture.
  const params: ParamDef[] = [];
  path = path
    .split('/')
    .map((seg, i, all) => {
      if (!seg || !(/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg))) return seg;
      const prev = all.slice(0, i).filter((s) => s && !s.startsWith('{')).pop() ?? 'item';
      const name = `${prev.replace(/s$/, '').replace(/[^A-Za-z0-9]/g, '_')}_id`;
      params.push({ name, in: 'path', required: true, schema: { type: /^\d+$/.test(seg) ? 'integer' : 'string' } });
      return `{${name}}`;
    })
    .join('/');

  // The template and the path it came from have the same segments, so the
  // values line up by position.
  const example: Record<string, unknown> = {};
  const sent = (c.url.pathname.slice(basePath.length) || '/').split('/');
  path.split('/').forEach((tpl, i) => {
    const m = tpl.match(/^\{(.+)\}$/);
    if (m) example[m[1]] = /^\d+$/.test(sent[i]) ? Number(sent[i]) : sent[i];
  });

  let auth: AuthSpec = { type: 'none' };
  let secret: CurlTool['secret'];
  const authz = c.headers.authorization;
  if (authz && /^bearer\s+/i.test(authz)) {
    auth = { type: 'bearer', tokenVar: `${opts.varPrefix}_TOKEN` };
    secret = { value: authz.replace(/^bearer\s+/i, '') };
  } else if (authz && /^basic\s+/i.test(authz)) {
    auth = { type: 'basic', userVar: `${opts.varPrefix}_USER`, passVar: `${opts.varPrefix}_PASSWORD` };
  }
  const keyHeader = Object.keys(c.headers).find((h) => /^(x-)?api[-_]?key$|^x-auth-token$|^x-access-token$/i.test(h));
  if (auth.type === 'none' && keyHeader) {
    auth = { type: 'apiKey', in: 'header', name: keyHeader, valueVar: `${opts.varPrefix}_API_KEY` };
    secret = { value: c.headers[keyHeader] };
  }
  const keyQuery = [...c.url.searchParams.keys()].find((k) => /^(api_?key|access_token|token)$/i.test(k));
  if (auth.type === 'none' && keyQuery) {
    auth = { type: 'apiKey', in: 'query', name: keyQuery, valueVar: `${opts.varPrefix}_API_KEY` };
    secret = { value: c.url.searchParams.get(keyQuery) ?? '' };
  }

  for (const [k, v] of c.url.searchParams) {
    if (k === keyQuery) continue;
    params.push({ name: k, in: 'query', required: false, schema: scalarSchema(v) });
    example[k] = /^-?\d+$/.test(v) ? Number(v) : v;
  }

  let bodyMode: BodyMode = 'none';
  if (c.body !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(c.body);
    } catch {
      json = undefined;
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      bodyMode = 'json-fields';
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (params.some((p) => p.name === k)) continue;
        params.push({ name: k, in: 'body', required: false, schema: valueSchema(v) });
        example[k] = v;
      }
    } else if (json !== undefined) {
      bodyMode = 'json-whole';
      params.push({ name: 'body', in: 'body', required: true, description: 'The JSON request body.', schema: valueSchema(json) });
      example.body = json;
    } else if (/=/.test(c.body) && !/[{}[\]]/.test(c.body)) {
      bodyMode = 'form';
      for (const [k, v] of new URLSearchParams(c.body)) {
        params.push({ name: k, in: 'body', required: false, schema: scalarSchema(v) });
        example[k] = v;
      }
    } else {
      bodyMode = 'json-whole';
      params.push({ name: 'body', in: 'body', required: true, schema: {} });
      example.body = c.body;
    }
  }

  return {
    baseUrl: base,
    auth,
    secret,
    tool: {
      id: toolId(c.method, path),
      name: nameFromRoute(c.method, path),
      description: '',
      enabled: true,
      safety: safetyFor(c.method, path),
      method: c.method,
      path,
      params,
      bodyMode,
      example,
    },
  };
}

function scalarSchema(v: string): JsonSchema {
  if (/^-?\d+$/.test(v)) return { type: 'integer' };
  if (/^-?\d+\.\d+$/.test(v)) return { type: 'number' };
  if (v === 'true' || v === 'false') return { type: 'boolean' };
  return { type: 'string' };
}

function valueSchema(v: unknown): JsonSchema {
  if (Array.isArray(v)) return { type: 'array' };
  if (v === null) return {};
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  return { type: typeof v };
}
