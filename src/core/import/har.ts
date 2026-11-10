// A project from captured traffic — the API with no spec. Export a HAR
// from the browser's network tab (or a proxy) while using the legacy app,
// and every distinct call becomes a tool, with parameters and body shapes
// inferred from what was actually sent.
//
// What it must never do is keep a credential. Captured requests carry
// live tokens and cookies; only the *kind* of auth is kept, as a variable
// name, and no header or cookie value from the capture is written out.

import type { AuthSpec, BodyMode, HttpMethod, JsonSchema, ParamDef, Project, ToolDef } from '../../shared/project';
import { emptyProject, slug, toolId, varPrefix } from '../../shared/project';
import { nameFromRoute, singular, snake, uniqueNames, distinctNames } from '../../shared/naming';
import { infer, inferScalar, shapeSummary } from '../schema';
import { safetyFor } from '../../shared/safety';
import { shapeOf } from '../../shared/scenario';
import { soapRequest, soapSafety } from '../../shared/soap';

type Obj = Record<string, any>;

interface Sample {
  method: HttpMethod;
  url: URL;
  headers: { name: string; value: string }[];
  body?: { mime: string; text: string };
  status: number;
  responseMime: string;
  responseText?: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|html?|mp4|webm|txt)$/i;

export function isHar(doc: unknown): boolean {
  const d = doc as Obj;
  return !!d?.log && Array.isArray(d.log.entries);
}

export function importHar(doc: Obj, ref?: string): Project {
  const samples = (doc.log.entries as Obj[]).map(toSample).filter((s): s is Sample => !!s && isApiCall(s));
  if (!samples.length) throw new Error('The capture has no API calls in it — only pages and assets. Capture again while using the part of the app that talks to the API.');

  // The API is the origin most calls went to. Analytics, CDNs and
  // third-party widgets are on other origins and are left out.
  const byOrigin = groupBy(samples, (s) => s.url.origin);
  const [origin, calls] = [...byOrigin.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  const prefix = commonPrefix(calls.map((s) => s.url.pathname));
  const project = emptyProject(nameForOrigin(origin));
  project.description = `Inferred from ${calls.length} captured call${calls.length === 1 ? '' : 's'} to ${origin}. There was no spec, so check each tool's description before turning it on.`;
  project.source = { kind: 'har', ref, importedAt: new Date().toISOString() };
  const auth = detectAuth(calls, project.name);
  project.envs = [{ name: 'default', baseUrl: `${origin}${prefix}`, auth, allowWrites: false }];

  const templated = templatePaths(calls.map((s) => s.url.pathname.slice(prefix.length) || '/'));
  // SOAP calls share one address: they split by operation instead.
  const soapOf = (x: Sample) => soapRequest(Object.fromEntries(x.headers.map((h) => [h.name, h.value])), x.body?.text);
  const groups = groupBy(
    calls.map((s, i) => ({ s, path: templated[i], soap: soapOf(s) })),
    (x) => `${x.s.method} ${x.path}${x.soap ? `#${x.soap.operation}` : ''}`,
  );

  const tools: ToolDef[] = [];
  for (const items of groups.values()) {
    const { s: first, path, soap } = items[0];
    tools.push(soap ? soapToolFrom(path, items.map((x) => x.soap!), items.map((x) => x.s)) : toolFrom(first.method, path, items.map((x) => x.s), auth));
  }
  tools.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const names = distinctNames(tools.map((t) => ({ name: t.name, path: t.path })));
  project.tools = tools.map((t, i) => ({ ...t, name: names[i] }));
  return project;
}

/// A first name for an API seen only as traffic: "Erp API" for
/// erp.acme.example, "Local API :5002" for this machine — never "api api".
/// The person renames it; a recording names it better when it can.
export function nameForOrigin(origin: string): string {
  const u = new URL(origin);
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname)) return `Local API${u.port ? ` :${u.port}` : ''}`;
  const word = u.hostname.split('.').find((p) => !/^(www|api|apis|rest|gateway|com|net|org|io|co|dev|app|local)$/i.test(p));
  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)} API` : `${u.hostname} API`;
}

function toSample(e: Obj): Sample | null {
  const r = e?.request;
  if (!r?.url || !METHODS.has(String(r.method).toUpperCase())) return null;
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const content = e.response?.content ?? {};
  const text = typeof content.text === 'string' && content.encoding !== 'base64' ? content.text : undefined;
  return {
    method: String(r.method).toUpperCase() as HttpMethod,
    url,
    headers: Array.isArray(r.headers) ? r.headers : [],
    body: r.postData?.text ? { mime: String(r.postData.mimeType ?? ''), text: String(r.postData.text) } : undefined,
    status: Number(e.response?.status ?? 0),
    responseMime: String(content.mimeType ?? ''),
    responseText: text,
  };
}

function isApiCall(s: Sample): boolean {
  if (STATIC.test(s.url.pathname)) return false;
  if (s.method !== 'GET') return true;
  return /json|xml/i.test(s.responseMime);
}

/// Path segments that are values rather than names: numbers, UUIDs, long
/// hex, and opaque mixed tokens. Plain words stay literal even when they
/// are really values (/users/alice) — guessing there turns /orders/search
/// into /orders/{id} — and the person fixes those in the Tools tab.
function isValueSegment(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{16,}$/i.test(seg) ||
    (/^[A-Za-z0-9_-]{8,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg) && !/^v\d+$/i.test(seg))
  );
}

/// `/orders/1042/items/7` -> `/orders/{order_id}/items/{item_id}`.
export function templatePaths(paths: string[]): string[] {
  return paths.map((p) => {
    const segs = p.split('/');
    const out: string[] = [];
    const used = new Set<string>();
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (i > 0 && seg && isValueSegment(seg)) {
        const prev = out.filter((x) => x && !x.startsWith('{')).pop();
        let name = prev ? `${singular(snake(prev))}_id` : 'id';
        for (let n = 2; used.has(name); n++) name = `${prev ? singular(snake(prev)) : ''}_id${n}`.replace(/^_/, '');
        used.add(name);
        out.push(`{${name}}`);
      } else out.push(seg);
    }
    return out.join('/') || '/';
  });
}

/// One SOAP operation seen in traffic: its elements become arguments.
function soapToolFrom(path: string, seen: NonNullable<ReturnType<typeof soapRequest>>[], samples: Sample[]): ToolDef {
  const first = seen[0];
  const names = [...new Set(seen.flatMap((s) => Object.keys(s.args).filter((k) => !k.startsWith('@'))))];
  const params: ParamDef[] = names.map((name) => {
    const values = seen.map((s) => s.args[name]).filter((v) => v !== undefined);
    const objects = values.filter((v) => v !== null && typeof v === 'object');
    return {
      name,
      in: 'body',
      required: seen.every((s) => name in s.args),
      schema: objects.length ? infer(objects) : inferScalar(values.map(String)),
    };
  });
  const responses = samples.map((x) => x.responseText).filter(Boolean).length;
  return {
    id: `POST ${path}#${first.operation}`,
    name: snake(first.operation),
    description: `SOAP operation ${first.operation}${first.action ? ` (SOAPAction ${first.action})` : ''}. Inferred from ${seen.length} captured call${seen.length === 1 ? '' : 's'}${responses ? '' : ', none with a response'}.`,
    enabled: true,
    safety: soapSafety(first.operation),
    method: 'POST',
    path,
    params,
    bodyMode: 'soap',
    soap: { operation: first.operation, action: first.action, namespace: first.namespace, version: first.version, qualified: first.qualified },
    origin: { samples: seen.length },
  };
}

function toolFrom(method: HttpMethod, path: string, samples: Sample[], auth: AuthSpec): ToolDef {
  const params: ParamDef[] = [];
  for (const m of path.matchAll(/\{([^}]+)\}/g)) {
    params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
  }

  const authQuery = auth.type === 'apiKey' && auth.in === 'query' ? auth.name : undefined;
  const queryValues = new Map<string, string[]>();
  for (const s of samples) {
    for (const [k, v] of s.url.searchParams) {
      if (k === authQuery || /^(access_token|api_?key|token|_)$/i.test(k)) continue;
      // A filter written into the address (kickoff>2026-11-09) isn't an argument.
      if (!/^[A-Za-z_][A-Za-z0-9_.\-[\]]*$/.test(k)) continue;
      queryValues.set(k, [...(queryValues.get(k) ?? []), v]);
    }
  }
  for (const [name, values] of queryValues) {
    const always = samples.every((s) => s.url.searchParams.has(name));
    const distinct = [...new Set(values)];
    const schema: JsonSchema = inferScalar(values);
    // A handful of repeated values looks like an enum (status=open|closed).
    if (schema.type === 'string' && distinct.length > 1 && distinct.length <= 6 && values.length >= distinct.length * 2) schema.enum = distinct;
    params.push({ name, in: 'query', required: always, schema });
  }

  let bodyMode: BodyMode = 'none';
  const bodies = samples.map((s) => s.body).filter((b): b is NonNullable<Sample['body']> => !!b);
  if (bodies.length) {
    const json = bodies.map((b) => tryJson(b.text)).filter((v) => v !== undefined);
    if (json.length === bodies.length) {
      const schema = infer(json);
      if (schema.type === 'object' && schema.properties && Object.keys(schema.properties).length) {
        bodyMode = 'json-fields';
        const required = new Set(schema.required ?? []);
        const taken = new Set(params.map((p) => p.name));
        if ([...Object.keys(schema.properties)].some((k) => taken.has(k))) {
          bodyMode = 'json-whole';
          params.push({ name: 'body', in: 'body', required: true, description: 'The JSON request body.', schema });
        } else {
          for (const [name, ps] of Object.entries(schema.properties)) params.push({ name, in: 'body', required: required.has(name), schema: ps });
        }
      } else {
        bodyMode = 'json-whole';
        params.push({ name: 'body', in: 'body', required: true, description: 'The JSON request body.', schema });
      }
    } else if (bodies.every((b) => /x-www-form-urlencoded/i.test(b.mime))) {
      bodyMode = 'form';
      const forms = bodies.map((b) => new URLSearchParams(b.text));
      const keys = new Set(forms.flatMap((f) => [...f.keys()]));
      for (const k of keys) {
        params.push({ name: k, in: 'body', required: forms.every((f) => f.has(k)), schema: inferScalar(forms.map((f) => f.get(k) ?? '')) });
      }
    } else {
      bodyMode = 'json-whole';
      params.push({ name: 'body', in: 'body', required: true, description: `Request body. The capture sent ${bodies[0].mime || 'a non-JSON body'}; overapi sends JSON.`, schema: {} });
    }
  }

  const statuses = [...new Set(samples.map((s) => s.status))].sort().join(', ');
  const okBody = samples.find((s) => s.status < 300 && s.responseText);
  const shape = okBody ? shapeSummary(tryJson(okBody.responseText ?? '')) : undefined;
  // A first description that says what it is — "seen 5 times in the
  // capture" told agents how it was found, not what it's for.
  const name = nameFromRoute(method, path);
  const [verb, ...words] = name.split('_');
  const what = words.join(' ').replace(/\bid\b/g, 'ID');
  const lead = verb === 'list' ? `Lists ${what}` : verb === 'get' ? `Gets one ${what}` : verb === 'create' ? `Creates a ${what}` : verb === 'update' ? `Updates a ${what}` : verb === 'replace' ? `Replaces a ${what}` : verb === 'delete' ? `Deletes a ${what}` : `${verb[0].toUpperCase()}${verb.slice(1)} ${what}`;
  const by = params.filter((p) => p.in === 'path').map((p) => p.name);
  const description = [`${lead}${by.length ? ` (by ${by.join(', ')})` : ''}.`, shape].filter(Boolean).join(' ');
  void statuses;

  // The values the latest successful call used — ready to send, never a
  // credential — and the shape of what it answered.
  const last = [...samples].reverse().find((s) => s.status < 300) ?? samples[samples.length - 1];
  const example: Record<string, unknown> = {};
  const tpl = path.split('/');
  const got = last.url.pathname.split('/').slice(-tpl.length);
  tpl.forEach((seg, i) => {
    const m = /^\{(.+)\}$/.exec(seg);
    if (m && got[i] !== undefined) example[m[1]] = /^-?\d+$/.test(got[i]) ? Number(got[i]) : decodeURIComponent(got[i]);
  });
  for (const p of params.filter((x) => x.in === 'query')) {
    const v = last.url.searchParams.get(p.name);
    if (v !== null && !/pass|secret|token|key|auth/i.test(p.name)) example[p.name] = /^-?\d+$/.test(v) ? Number(v) : v;
  }
  let returns: ReturnType<typeof shapeOf> | undefined;
  const parsed = okBody ? tryJson(okBody.responseText ?? '') : undefined;
  if (parsed !== undefined) returns = shapeOf(parsed);

  return {
    id: toolId(method, path),
    name,
    description,
    ...(Object.keys(example).length ? { example } : {}),
    ...(returns ? { returns } : {}),
    enabled: true,
    safety: safetyFor(method, path),
    method,
    path,
    params,
    bodyMode,
    origin: { samples: samples.length },
  };
}

function detectAuth(samples: Sample[], projectName: string): AuthSpec {
  const prefix = varPrefix(projectName);
  const header = (s: Sample, name: string) => s.headers.find((h) => h.name.toLowerCase() === name)?.value;
  if (samples.some((s) => /UsernameToken/.test(s.body?.text ?? '') && /<[\w:]*Envelope[\s>]/.test(s.body?.text ?? ''))) return { type: 'wsse', userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` };
  if (samples.some((s) => /^bearer\s/i.test(header(s, 'authorization') ?? ''))) return { type: 'bearer', tokenVar: `${prefix}_TOKEN` };
  if (samples.some((s) => /^basic\s/i.test(header(s, 'authorization') ?? ''))) return { type: 'basic', userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` };
  const keyHeader = samples
    .flatMap((s) => s.headers.map((h) => h.name))
    .find((n) => /^(x-)?api[-_]?key$|^x-auth-token$|^x-access-token$/i.test(n));
  if (keyHeader) return { type: 'apiKey', in: 'header', name: keyHeader, valueVar: `${prefix}_API_KEY` };
  const keyQuery = samples.flatMap((s) => [...s.url.searchParams.keys()]).find((k) => /^(api_?key|access_token|token)$/i.test(k));
  if (keyQuery) return { type: 'apiKey', in: 'query', name: keyQuery, valueVar: `${prefix}_API_KEY` };
  return { type: 'none' };
}

function commonPrefix(paths: string[]): string {
  if (!paths.length) return '';
  const split = paths.map((p) => p.split('/').filter(Boolean));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = split[0][i];
    if (seg === undefined || !split.every((s) => s[i] === seg && s.length > i + 1)) break;
    // Only fold in prefixes that look like mounts, not resources.
    if (!/^(api|rest|v\d+(\.\d+)?|services?)$/i.test(seg)) break;
    out.push(seg);
  }
  return out.length ? `/${out.join('/')}` : '';
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
