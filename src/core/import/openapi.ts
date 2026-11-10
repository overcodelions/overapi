// OpenAPI 3.x and Swagger 2.0 into a project. The easy case — the spec
// says what every operation is — so the work here is in the details an
// agent trips on: merged path-level parameters, request bodies flattened
// into named arguments, auth turned into variable names, $refs resolved.

import type { AuthSpec, BodyMode, EnvDef, HttpMethod, JsonSchema, ParamDef, Project, Safety, ToolDef } from '../../shared/project';
import { emptyProject, slug, toolId, varPrefix } from '../../shared/project';
import { nameFromOperationId, nameFromRoute, uniqueNames, distinctNames } from '../../shared/naming';
import { simplify } from '../schema';
import { safetyFor } from '../../shared/safety';

type Obj = Record<string, any>;

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function isOpenApi(doc: unknown): boolean {
  const d = doc as Obj;
  return !!d && typeof d === 'object' && (typeof d.openapi === 'string' || d.swagger === '2.0') && typeof d.paths === 'object';
}

export function importOpenApi(raw: Obj, ref?: string): Project {
  const doc = deref(raw) as Obj;
  const swagger2 = doc.swagger === '2.0';
  const info = (doc.info ?? {}) as Obj;
  const title = String(info.title ?? 'API');
  const project = emptyProject(title);
  project.description = trimText(info.description ?? '', 600);
  project.version = String(info.version ?? '0.1.0');
  project.source = { kind: swagger2 ? 'swagger' : 'openapi', ref, importedAt: new Date().toISOString() };

  const auth = authFrom(doc, swagger2, project.name);
  project.envs = envsFrom(doc, swagger2, auth, ref);

  const tools: ToolDef[] = [];
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Obj)) {
    if (!item || typeof item !== 'object') continue;
    const shared: Obj[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method.toLowerCase()] as Obj | undefined;
      if (!op || typeof op !== 'object') continue;
      tools.push(toolFrom(method, path, op, shared, swagger2, doc));
    }
  }
  const names = distinctNames(tools.map((t) => ({ name: t.name, path: t.path })));
  project.tools = tools.map((t, i) => ({ ...t, name: names[i] }));
  return project;
}

function toolFrom(method: HttpMethod, path: string, op: Obj, shared: Obj[], swagger2: boolean, doc: Obj): ToolDef {
  // Operation-level parameters override path-level ones of the same name+in.
  const merged = new Map<string, Obj>();
  for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
    if (p && typeof p === 'object' && p.name) merged.set(`${p.in}:${p.name}`, p);
  }
  const params: ParamDef[] = [];
  let bodyMode: BodyMode = 'none';
  let bodySchema: Obj | undefined;
  const formFields: Obj[] = [];

  for (const p of merged.values()) {
    if (p.in === 'cookie') continue;
    if (swagger2 && p.in === 'body') {
      bodySchema = p.schema ?? {};
      continue;
    }
    if (swagger2 && p.in === 'formData') {
      formFields.push(p);
      continue;
    }
    if (p.in !== 'path' && p.in !== 'query' && p.in !== 'header') continue;
    // Auth headers are the environment's job, never the agent's.
    if (p.in === 'header' && /^(authorization|x-api-key|api-key)$/i.test(p.name)) continue;
    const schema = swagger2 ? swagger2ParamSchema(p) : simplify(p.schema ?? { type: 'string' });
    params.push({
      name: p.name,
      in: p.in,
      required: p.in === 'path' ? true : !!p.required,
      description: trimText(p.description ?? '', 300) || undefined,
      schema,
    });
  }

  if (!swagger2 && op.requestBody) {
    const content = (op.requestBody.content ?? {}) as Obj;
    const jsonKey = Object.keys(content).find((k) => /json/i.test(k));
    const formKey = Object.keys(content).find((k) => /x-www-form-urlencoded/i.test(k));
    if (jsonKey) bodySchema = content[jsonKey]?.schema ?? {};
    else if (formKey) {
      const s = content[formKey]?.schema ?? {};
      for (const [name, ps] of Object.entries((s.properties ?? {}) as Obj)) {
        formFields.push({ name, required: (s.required ?? []).includes(name), description: ps.description, schema: ps });
      }
    }
  }

  if (bodySchema) {
    const s = mergeAllOf(bodySchema);
    const props = s.properties as Obj | undefined;
    const taken = new Set(params.map((p) => p.name));
    if (s.type !== 'array' && props && Object.keys(props).length && !Object.keys(props).some((k) => taken.has(k))) {
      bodyMode = 'json-fields';
      const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
      for (const [name, ps] of Object.entries(props)) {
        if ((ps as Obj)?.readOnly) continue;
        const schema = simplify(ps);
        params.push({ name, in: 'body', required: required.has(name), description: schema.description, schema });
      }
    } else {
      bodyMode = 'json-whole';
      params.push({ name: 'body', in: 'body', required: true, description: 'The JSON request body.', schema: simplify(s) });
    }
  } else if (formFields.length) {
    bodyMode = 'form';
    for (const f of formFields) {
      const schema = swagger2 ? swagger2ParamSchema(f) : simplify(f.schema ?? { type: 'string' });
      params.push({ name: f.name, in: 'body', required: !!f.required, description: trimText(f.description ?? '', 300) || undefined, schema });
    }
  }

  const name = op.operationId ? nameFromOperationId(String(op.operationId)) : nameFromRoute(method, path);
  const safety: Safety = op['x-overapi-safety'] ?? safetyFor(method, path);
  return {
    id: toolId(method, path),
    name,
    description: describe(op, doc, swagger2),
    enabled: !op.deprecated,
    safety,
    method,
    path,
    params,
    bodyMode,
    origin: { operationId: op.operationId, summary: op.summary, tags: Array.isArray(op.tags) ? op.tags : undefined },
  };
}

function describe(op: Obj, _doc: Obj, swagger2: boolean): string {
  const parts: string[] = [];
  const summary = String(op.summary ?? '').trim();
  const description = String(op.description ?? '').trim();
  if (summary) parts.push(summary.endsWith('.') ? summary : `${summary}.`);
  if (description && description !== summary) parts.push(description);
  if (op.deprecated) parts.push('Deprecated.');
  const ok = successSchema(op, swagger2);
  if (ok) {
    const props = Object.keys((mergeAllOf(ok.type === 'array' ? ok.items ?? {} : ok).properties ?? {}) as Obj).slice(0, 12);
    if (props.length) parts.push(`${ok.type === 'array' ? 'Returns a list of objects with' : 'Returns'} ${props.join(', ')}.`);
  }
  return trimText(parts.join(' '), 1000);
}

function successSchema(op: Obj, swagger2: boolean): Obj | undefined {
  const responses = (op.responses ?? {}) as Obj;
  const key = Object.keys(responses).find((k) => /^2\d\d$/.test(k));
  if (!key) return undefined;
  const r = responses[key] ?? {};
  if (swagger2) return r.schema;
  const content = (r.content ?? {}) as Obj;
  const jsonKey = Object.keys(content).find((k) => /json/i.test(k));
  return jsonKey ? content[jsonKey]?.schema : undefined;
}

function swagger2ParamSchema(p: Obj): JsonSchema {
  const s: Obj = { type: p.type ?? 'string' };
  for (const k of ['format', 'enum', 'default', 'minimum', 'maximum', 'items', 'pattern']) if (p[k] !== undefined) s[k] = p[k];
  return simplify(s);
}

/// allOf of objects, flattened — the usual "Base + extra fields" pattern.
function mergeAllOf(s: Obj): Obj {
  if (!Array.isArray(s?.allOf)) return s ?? {};
  const out: Obj = { type: 'object', properties: {}, required: [] };
  for (const part of s.allOf.map(mergeAllOf)) {
    Object.assign(out.properties, part.properties ?? {});
    out.required.push(...(part.required ?? []));
  }
  for (const [k, v] of Object.entries(s)) if (k !== 'allOf') out[k] = v;
  return out;
}

function authFrom(doc: Obj, swagger2: boolean, projectName: string): AuthSpec {
  const schemes = (swagger2 ? doc.securityDefinitions : doc.components?.securitySchemes) as Obj | undefined;
  if (!schemes) return { type: 'none' };
  const prefix = varPrefix(projectName);
  // Prefer what the spec says applies globally, then whatever is declared.
  const globalNames = (Array.isArray(doc.security) ? doc.security : []).flatMap((r: Obj) => Object.keys(r ?? {}));
  const ordered = [...globalNames, ...Object.keys(schemes)].map((n) => schemes[n]).filter(Boolean) as Obj[];
  for (const s of ordered) {
    if ((s.type === 'http' && /bearer/i.test(s.scheme ?? '')) || s.type === 'oauth2' || s.type === 'openIdConnect') {
      return { type: 'bearer', tokenVar: `${prefix}_TOKEN` };
    }
    if (s.type === 'apiKey' && (s.in === 'header' || s.in === 'query')) {
      return { type: 'apiKey', in: s.in, name: String(s.name ?? 'X-API-Key'), valueVar: `${prefix}_API_KEY` };
    }
    if ((s.type === 'http' && /basic/i.test(s.scheme ?? '')) || s.type === 'basic') {
      return { type: 'basic', userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` };
    }
  }
  return { type: 'none' };
}

function envsFrom(doc: Obj, swagger2: boolean, auth: AuthSpec, ref?: string): EnvDef[] {
  const urls: { name: string; url: string }[] = [];
  if (swagger2) {
    if (doc.host) {
      const scheme = Array.isArray(doc.schemes) && doc.schemes.includes('https') ? 'https' : (doc.schemes?.[0] ?? 'https');
      urls.push({ name: 'default', url: `${scheme}://${doc.host}${doc.basePath ?? ''}` });
    }
  } else {
    for (const s of (Array.isArray(doc.servers) ? doc.servers : []) as Obj[]) {
      if (!s?.url) continue;
      let url = String(s.url);
      for (const [k, v] of Object.entries((s.variables ?? {}) as Obj)) url = url.replaceAll(`{${k}}`, String(v?.default ?? ''));
      // A relative server ("/api/v3", as Petstore has) is relative to where
      // the spec was fetched from. Imported from a file there is nothing to
      // resolve it against; it stays, and the readiness check says so.
      if (!/^https?:\/\//i.test(url) && ref && /^https?:\/\//i.test(ref)) {
        try {
          url = new URL(url, ref).toString();
        } catch {
          // Left as written.
        }
      }
      urls.push({ name: envNameFor(String(s.description ?? ''), url, urls.length), url });
    }
  }
  if (!urls.length) urls.push({ name: 'default', url: '' });
  const seen = new Set<string>();
  return urls.map(({ name, url }) => {
    let n = name;
    for (let i = 2; seen.has(n); i++) n = `${name}-${i}`;
    seen.add(n);
    return { name: n, baseUrl: url.replace(/\/+$/, ''), auth, allowWrites: false };
  });
}

function envNameFor(description: string, url: string, index: number): string {
  const text = `${description} ${url}`.toLowerCase();
  if (/sandbox/.test(text)) return 'sandbox';
  if (/stag/.test(text)) return 'staging';
  if (/(^|\W)(dev|development)(\W|$)/.test(text) || /localhost|127\.0\.0\.1/.test(text)) return 'local';
  if (/prod|live/.test(text)) return 'production';
  return index === 0 ? 'default' : `server-${index + 1}`;
}

function trimText(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/// Resolves local `#/...` refs in place of themselves. A ref back into its
/// own ancestry becomes a plain object with a note, so a self-referencing
/// schema (a tree, a linked list) cannot recurse forever.
export function deref(root: Obj): unknown {
  const resolve = (pointer: string): unknown => {
    if (!pointer.startsWith('#/')) return undefined;
    return pointer
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Obj)[key] : undefined), root);
  };
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!node || typeof node !== 'object') return node;
    const o = node as Obj;
    if (typeof o.$ref === 'string') {
      if (stack.includes(o.$ref)) return { type: 'object', description: `Recursive (${o.$ref.split('/').pop()}).` };
      const target = resolve(o.$ref);
      if (target === undefined) return { description: `Unresolved reference ${o.$ref}.` };
      return walk(target, [...stack, o.$ref]);
    }
    const out: Obj = {};
    for (const [k, v] of Object.entries(o)) out[k] = walk(v, stack);
    return out;
  };
  return walk(root, []);
}
