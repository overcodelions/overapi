// A Postman v2.x collection into a project. For many internal APIs the
// collection *is* the documentation: the folder someone keeps in a team
// workspace with a working example of every call.

import type { AuthSpec, BodyMode, HttpMethod, ParamDef, Project, ToolDef } from '../../shared/project';
import { emptyProject, slug, toolId, varPrefix } from '../../shared/project';
import { nameFromRoute, snake, uniqueNames, clamp, distinctNames } from '../../shared/naming';
import { infer, inferScalar } from '../schema';
import { safetyFor } from '../../shared/safety';

type Obj = Record<string, any>;

export function isPostman(doc: unknown): boolean {
  const d = doc as Obj;
  return !!d?.info && Array.isArray(d.item) && /schema\.getpostman\.com|postman/i.test(String(d.info.schema ?? d.info._postman_id ?? ''));
}

export function importPostman(doc: Obj, ref?: string): Project {
  const project = emptyProject(String(doc.info?.name ?? 'API'));
  project.description = text(doc.info?.description).slice(0, 600);
  project.source = { kind: 'postman', ref, importedAt: new Date().toISOString() };

  const vars = Object.fromEntries(((doc.variable ?? []) as Obj[]).map((v) => [v.key, String(v.value ?? '')]));
  const requests: { name: string; folder: string[]; req: Obj }[] = [];
  const walk = (items: Obj[], folder: string[]) => {
    for (const it of items) {
      if (Array.isArray(it.item)) walk(it.item, [...folder, String(it.name ?? '')]);
      else if (it.request) requests.push({ name: String(it.name ?? ''), folder, req: typeof it.request === 'string' ? { url: it.request, method: 'GET' } : it.request });
    }
  };
  walk(doc.item, []);

  const parsed = requests.map((r) => ({ ...r, url: splitUrl(r.req.url, vars) })).filter((r) => r.url);
  const bases = new Map<string, number>();
  for (const r of parsed) bases.set(r.url!.base, (bases.get(r.url!.base) ?? 0) + 1);
  const base = [...bases.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const auth = authFrom(doc.auth, project.name);
  project.envs = [{ name: 'default', baseUrl: base.replace(/\/+$/, ''), auth, allowWrites: false }];

  const tools: ToolDef[] = parsed.map(({ name, folder, req, url }) => {
    const method = String(req.method ?? 'GET').toUpperCase() as HttpMethod;
    const path = url!.path;
    const params: ParamDef[] = [];
    for (const m of path.matchAll(/\{([^}]+)\}/g)) {
      const v = ((req.url?.variable ?? []) as Obj[]).find((x) => x.key === m[1]);
      params.push({ name: m[1], in: 'path', required: true, description: text(v?.description) || undefined, schema: inferScalar(v?.value ? [String(v.value)] : []) });
    }
    for (const q of (req.url?.query ?? []) as Obj[]) {
      if (!q?.key || /^(api_?key|access_token|token)$/i.test(q.key)) continue;
      params.push({ name: q.key, in: 'query', required: !q.disabled, description: text(q.description) || undefined, schema: inferScalar(q.value ? [String(q.value)] : []) });
    }
    for (const h of (req.header ?? []) as Obj[]) {
      if (!h?.key || h.disabled || /^(authorization|content-type|accept|cookie|x-api-key)$/i.test(h.key)) continue;
      params.push({ name: h.key, in: 'header', required: false, description: text(h.description) || undefined, schema: { type: 'string' } });
    }
    let bodyMode: BodyMode = 'none';
    const body = req.body as Obj | undefined;
    if (body?.mode === 'raw' && body.raw) {
      let json: unknown;
      try {
        // "{{var}}" inside quotes is a string; a bare {{var}} could be anything.
        json = JSON.parse(String(body.raw).replace(/"\{\{[^}]+\}\}"/g, '""').replace(/\{\{[^}]+\}\}/g, 'null'));
      } catch {
        json = undefined;
      }
      const schema = json === undefined ? {} : infer([json]);
      if (schema.type === 'object' && schema.properties && !Object.keys(schema.properties).some((k) => params.some((p) => p.name === k))) {
        bodyMode = 'json-fields';
        // One example says nothing about which fields are optional.
        for (const [k, s] of Object.entries(schema.properties)) params.push({ name: k, in: 'body', required: false, schema: s });
      } else {
        bodyMode = 'json-whole';
        params.push({ name: 'body', in: 'body', required: true, description: 'The JSON request body.', schema });
      }
    } else if (body?.mode === 'urlencoded') {
      bodyMode = 'form';
      for (const f of (body.urlencoded ?? []) as Obj[]) {
        if (!f?.key || f.disabled) continue;
        params.push({ name: f.key, in: 'body', required: false, description: text(f.description) || undefined, schema: inferScalar(f.value ? [String(f.value)] : []) });
      }
    } else if (body?.mode === 'formdata') {
      // Multipart: a file field stays a file.
      bodyMode = 'multipart';
      for (const f of (body.formdata ?? []) as Obj[]) {
        if (!f?.key || f.disabled) continue;
        const file = f.type === 'file';
        params.push({ name: f.key, in: 'body', required: false, description: text(f.description) || undefined, schema: file ? { type: 'string', format: 'binary' } : inferScalar(f.value ? [String(f.value)] : []) });
      }
    } else if (body?.mode === 'graphql' && body.graphql?.query) {
      bodyMode = 'graphql';
      let variables: Record<string, unknown> = {};
      try {
        variables = JSON.parse(String(body.graphql.variables || '{}').replace(/\{\{[^}]+\}\}/g, 'null')) as Record<string, unknown>;
      } catch {
        variables = {};
      }
      for (const [k, v] of Object.entries(variables)) params.push({ name: k, in: 'body', required: false, schema: v === null ? {} : infer([v]) });
    }
    const described = text(req.description);
    return {
      id: toolId(method, path),
      name: name ? clamp(snake(name)) || nameFromRoute(method, path) : nameFromRoute(method, path),
      description: [name && `${name}.`, described, folder.length ? `(${folder.join(' / ')})` : ''].filter(Boolean).join(' ').slice(0, 1000),
      enabled: true,
      safety: safetyFor(method, path),
      method,
      path,
      params,
      bodyMode,
      ...(bodyMode === 'graphql' ? { graphql: { query: String(body!.graphql.query) } } : {}),
      origin: { summary: name, tags: folder.length ? folder : undefined },
    };
  });

  // The same route can appear twice in a collection (examples of one call).
  const seen = new Set<string>();
  const unique = tools.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const names = distinctNames(unique.map((t) => ({ name: t.name, path: t.path })));
  project.tools = unique.map((t, i) => ({ ...t, name: names[i] }));
  return project;
}

/// Splits a Postman URL into the base everything shares and the route.
/// `{{baseUrl}}/orders/:id` with baseUrl=https://x/api -> base https://x/api,
/// path /orders/{id}.
function splitUrl(url: unknown, vars: Record<string, string>): { base: string; path: string } | null {
  let raw = typeof url === 'string' ? url : String((url as Obj)?.raw ?? '');
  if (!raw) return null;
  raw = raw.split('?')[0].split('#')[0];
  let base = '';
  const leadingVar = raw.match(/^\{\{([^}]+)\}\}/);
  if (leadingVar) {
    base = vars[leadingVar[1]] ?? '';
    raw = raw.slice(leadingVar[0].length);
  } else {
    const m = raw.match(/^(https?:\/\/[^/]+)(.*)$/i);
    if (m) {
      base = m[1];
      raw = m[2];
    }
  }
  const path = ('/' + raw.replace(/^\/+/, ''))
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
    .replace(/\{\{([^}]+)\}\}/g, '{$1}');
  return { base: base.replace(/\{\{[^}]+\}\}/g, ''), path: path === '/' ? '/' : path.replace(/\/+$/, '') };
}

function authFrom(a: Obj | undefined, projectName: string): AuthSpec {
  const prefix = varPrefix(projectName);
  if (!a?.type) return { type: 'none' };
  if (a.type === 'oauth2') {
    // Postman keeps its OAuth settings as a key/value list.
    const get = (k: string) => {
      const v = ((a.oauth2 ?? []) as Obj[]).find((x) => x.key === k)?.value;
      return typeof v === 'string' && v && !/^\{\{.*\}\}$/.test(v) ? v : undefined;
    };
    const grant = get('grant_type');
    const tokenUrl = get('accessTokenUrl');
    if (tokenUrl && (grant === 'client_credentials' || grant === 'authorization_code' || grant === 'authorization_code_with_pkce')) {
      return {
        type: 'oauth2',
        grant: grant === 'client_credentials' ? 'client_credentials' : 'authorization_code',
        tokenUrl,
        authUrl: get('authUrl'),
        scope: get('scope'),
        audience: get('audience'),
        clientIdVar: `${prefix}_CLIENT_ID`,
        clientSecretVar: `${prefix}_CLIENT_SECRET`,
        refreshTokenVar: `${prefix}_REFRESH_TOKEN`,
        clientAuth: get('client_authentication') === 'header' ? 'basic' : 'body',
      };
    }
    return { type: 'bearer', tokenVar: `${prefix}_TOKEN` };
  }
  if (a.type === 'bearer') return { type: 'bearer', tokenVar: `${prefix}_TOKEN` };
  if (a.type === 'basic') return { type: 'basic', userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` };
  if (a.type === 'apikey') {
    const get = (k: string) => ((a.apikey ?? []) as Obj[]).find((x) => x.key === k)?.value;
    return { type: 'apiKey', in: get('in') === 'query' ? 'query' : 'header', name: String(get('key') ?? 'X-API-Key'), valueVar: `${prefix}_API_KEY` };
  }
  return { type: 'none' };
}

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && typeof (v as Obj).content === 'string') return (v as Obj).content.trim();
  return '';
}
