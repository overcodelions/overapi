// A GraphQL API from its schema (an introspection result): each query field
// becomes a read tool, each mutation a write — with the query written out,
// asking for the fields worth having back. GraphQL needs this more than
// most: one endpoint, a schema an agent can't see, and queries it would
// otherwise have to write itself.

import type { JsonSchema, ParamDef, Project, Safety, ToolDef } from '../../shared/project';
import { emptyProject } from '../../shared/project';
import { clamp, distinctNames, snake } from '../../shared/naming';

type Obj = Record<string, any>;
interface TypeRef {
  kind: string;
  name?: string | null;
  ofType?: TypeRef | null;
}
interface InputValue {
  name: string;
  description?: string | null;
  type: TypeRef;
  defaultValue?: string | null;
}
interface Field {
  name: string;
  description?: string | null;
  args?: InputValue[];
  type: TypeRef;
}
interface FullType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: Field[] | null;
  inputFields?: InputValue[] | null;
  enumValues?: { name: string }[] | null;
}

/// What overapi asks a GraphQL endpoint for: enough of the schema to write
/// tools, nothing more.
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: false) { name description args { name description defaultValue type { ...T } } type { ...T } }
      inputFields { name description defaultValue type { ...T } }
      enumValues(includeDeprecated: false) { name }
    }
  }
}
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`;

function schemaOf(doc: unknown): Obj | null {
  const d = doc as Obj | null;
  const s = d?.data?.__schema ?? d?.__schema;
  return s && Array.isArray(s.types) ? s : null;
}

export const isGraphqlIntrospection = (doc: unknown) => !!schemaOf(doc);

const named = (t: TypeRef): TypeRef => (t.ofType ? named(t.ofType) : t);
/// The type as a variable declaration writes it: [ID!]!
const typeRef = (t: TypeRef): string => (t.kind === 'NON_NULL' ? `${typeRef(t.ofType!)}!` : t.kind === 'LIST' ? `[${typeRef(t.ofType!)}]` : String(t.name));

function jsonSchema(t: TypeRef, types: Map<string, FullType>, depth = 0): JsonSchema {
  if (t.kind === 'NON_NULL') return jsonSchema(t.ofType!, types, depth);
  if (t.kind === 'LIST') return { type: 'array', items: jsonSchema(t.ofType!, types, depth) };
  const full = types.get(String(t.name));
  if (t.kind === 'ENUM') return { type: 'string', enum: (full?.enumValues ?? []).map((e) => e.name) };
  if (t.kind === 'INPUT_OBJECT') {
    if (depth >= 3 || !full?.inputFields) return { type: 'object' };
    const properties = Object.fromEntries(full.inputFields.map((f) => [f.name, { ...jsonSchema(f.type, types, depth + 1), ...(f.description ? { description: f.description } : {}) }]));
    const required = full.inputFields.filter((f) => f.type.kind === 'NON_NULL' && f.defaultValue == null).map((f) => f.name);
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  if (t.name === 'Int') return { type: 'integer' };
  if (t.name === 'Float') return { type: 'number' };
  if (t.name === 'Boolean') return { type: 'boolean' };
  if (t.name === 'ID' || t.name === 'String') return { type: 'string' };
  // A custom scalar (DateTime, JSON…): sent as the API writes it.
  return { type: 'string', description: `A ${t.name}.` };
}

/// What to ask for back: the type's plain fields, and the plain fields of
/// the objects it holds, one level down. Fields that need arguments are
/// left out; the person can add them to the query.
function selection(t: TypeRef, types: Map<string, FullType>, depth = 0): string {
  const full = types.get(String(named(t).name));
  if (!full || (full.kind !== 'OBJECT' && full.kind !== 'INTERFACE' && full.kind !== 'UNION')) return '';
  const parts: string[] = [];
  for (const f of full.fields ?? []) {
    if ((f.args ?? []).some((a) => a.type.kind === 'NON_NULL')) continue;
    const inner = types.get(String(named(f.type).name));
    if (!inner || inner.kind === 'SCALAR' || inner.kind === 'ENUM') parts.push(f.name);
    else if (depth < 1 && inner.kind === 'OBJECT') {
      const sub = selection(f.type, types, depth + 1);
      if (sub) parts.push(`${f.name} ${sub}`);
    }
    if (parts.length >= 25) break;
  }
  if (!parts.length) parts.push('__typename');
  return `{ ${parts.join(' ')} }`;
}

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/// `endpoint`: where the schema came from — the base URL and path tools
/// are sent to. Absent (a saved introspection file), it's /graphql on a
/// base URL to fill in.
export function importGraphql(doc: unknown, ref?: string, endpoint?: string): Project {
  const s = schemaOf(doc);
  if (!s) throw new Error('Not a GraphQL introspection result.');
  const types = new Map<string, FullType>((s.types as FullType[]).map((t) => [t.name, t]));
  let base = '';
  let path = '/graphql';
  let title = 'GraphQL API';
  if (endpoint) {
    try {
      const u = new URL(endpoint);
      base = u.origin;
      path = u.pathname && u.pathname !== '/' ? u.pathname : '/graphql';
      title = `${u.hostname.replace(/^(www|api)\./, '')} GraphQL`;
    } catch {
      // Not a URL: keep the defaults.
    }
  }
  const project = emptyProject(title);
  project.source = { kind: 'graphql', ref, importedAt: new Date().toISOString() };
  project.envs = [{ name: 'default', baseUrl: base, auth: { type: 'none' }, allowWrites: false }];

  const tools: ToolDef[] = [];
  for (const [op, root] of [
    ['query', s.queryType?.name],
    ['mutation', s.mutationType?.name],
  ] as const) {
    const type = root ? types.get(root) : undefined;
    for (const f of type?.fields ?? []) {
      if (f.name.startsWith('__')) continue;
      const args = f.args ?? [];
      const vars = args.map((a) => `$${a.name}: ${typeRef(a.type)}`).join(', ');
      const call = args.map((a) => `${a.name}: $${a.name}`).join(', ');
      const sel = selection(f.type, types);
      const operationName = pascal(f.name);
      const query = `${op} ${operationName}${vars ? `(${vars})` : ''} {\n  ${f.name}${call ? `(${call})` : ''}${sel ? ` ${sel}` : ''}\n}`;
      const params: ParamDef[] = args.map((a) => ({
        name: a.name,
        in: 'body',
        required: a.type.kind === 'NON_NULL' && a.defaultValue == null,
        description: a.description?.trim() || undefined,
        schema: jsonSchema(a.type, types),
      }));
      const safety: Safety = op === 'query' ? 'read' : /^(delete|remove|destroy|purge|drop|revoke)/i.test(f.name) ? 'destructive' : 'write';
      tools.push({
        id: `POST ${path}#${op}.${f.name}`,
        name: clamp(snake(f.name)) || f.name,
        description: (f.description?.trim() || `${op === 'query' ? 'Query' : 'Mutation'} ${f.name}.`).slice(0, 1000),
        enabled: true,
        safety,
        method: 'POST',
        path,
        params,
        bodyMode: 'graphql',
        graphql: { query, operationName },
        group: op === 'query' ? 'Queries' : 'Mutations',
        origin: { summary: f.name, tags: [op === 'query' ? 'Queries' : 'Mutations'] },
      });
    }
  }
  if (!tools.length) throw new Error('That GraphQL schema has no queries or mutations.');
  const names = distinctNames(tools.map((t) => ({ name: t.name, path: `${t.path}/${t.group}` })));
  project.tools = tools.map((t, i) => ({ ...t, name: names[i] }));
  return project;
}
