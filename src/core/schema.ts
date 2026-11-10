// JSON Schema helpers: trim what a spec says down to what an agent needs,
// and guess a schema from example values when there is no spec at all.

import type { JsonSchema } from '../shared/project';

const KEEP = new Set([
  'type', 'description', 'enum', 'format', 'default', 'items', 'properties', 'required',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'nullable', 'oneOf', 'anyOf', 'allOf',
  'additionalProperties', 'minItems', 'maxItems',
]);

const MAX_DEPTH = 6;

/// Keeps the keywords an agent can use, drops the rest (examples, xml,
/// vendor extensions), and stops nesting at MAX_DEPTH. The input must
/// already be dereferenced.
export function simplify(schema: unknown, depth = 0): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const src = schema as Record<string, unknown>;
  if (depth >= MAX_DEPTH) {
    return { type: typeof src.type === 'string' ? src.type : 'object', description: 'Nested too deep to describe here; pass what the API expects.' };
  }
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(src)) {
    if (!KEEP.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      // readOnly fields are what the server fills in; an agent sending them
      // is at best ignored and at worst a 400.
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, pv]) => !(pv && typeof pv === 'object' && (pv as Record<string, unknown>).readOnly === true))
          .map(([pk, pv]) => [pk, simplify(pv, depth + 1)]),
      );
    } else if (k === 'items') {
      out.items = simplify(v, depth + 1);
    } else if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(v)) {
      out[k] = v.map((x) => simplify(x, depth + 1));
    } else if (k === 'additionalProperties' && v && typeof v === 'object') {
      out.additionalProperties = simplify(v, depth + 1);
    } else if (k === 'description' && typeof v === 'string') {
      out.description = v.trim().slice(0, 500);
    } else if (k === 'nullable') {
      // OpenAPI 3.0's nullable becomes a type union, which MCP clients read.
      if (v === true && typeof src.type === 'string') out.type = [src.type, 'null'];
    } else {
      out[k] = v;
    }
  }
  if (src.nullable === true && typeof src.type === 'string') out.type = [src.type, 'null'];
  if (out.properties && Array.isArray(out.required)) out.required = out.required.filter((r) => r in out.properties!);
  return out;
}

/// A schema that fits every sample. Objects merge their keys; a key is
/// required only when every sample has it.
export function infer(samples: unknown[]): JsonSchema {
  const present = samples.filter((s) => s !== undefined);
  if (present.length === 0) return {};
  const types = new Set(present.map(kind));
  types.delete('null');
  const nullable = present.some((s) => s === null);
  if (types.size !== 1) {
    if (types.size === 2 && types.has('integer') && types.has('number')) return withNull({ type: 'number' }, nullable);
    return {};
  }
  const t = [...types][0];
  if (t === 'object') {
    const objs = present.filter((s): s is Record<string, unknown> => kind(s) === 'object');
    const keys = new Set(objs.flatMap((o) => Object.keys(o)));
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const k of keys) {
      properties[k] = infer(objs.map((o) => o[k]));
      if (objs.every((o) => k in o)) required.push(k);
    }
    return withNull({ type: 'object', properties, ...(required.length ? { required } : {}) }, nullable);
  }
  if (t === 'array') {
    const items = present.filter(Array.isArray).flat().slice(0, 50);
    return withNull({ type: 'array', ...(items.length ? { items: infer(items) } : {}) }, nullable);
  }
  return withNull({ type: t }, nullable);
}

/// A scalar from a query string or a path: "42" is an integer, "true" a
/// boolean, everything else a string.
export function inferScalar(values: string[]): JsonSchema {
  if (values.length && values.every((v) => /^-?\d+$/.test(v))) return { type: 'integer' };
  if (values.length && values.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return { type: 'number' };
  if (values.length && values.every((v) => v === 'true' || v === 'false')) return { type: 'boolean' };
  return { type: 'string' };
}

function kind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function withNull(s: JsonSchema, nullable: boolean): JsonSchema {
  if (!nullable || typeof s.type !== 'string') return s;
  return { ...s, type: [s.type, 'null'] };
}

/// The top-level keys of a JSON response, for a description: "Returns id,
/// status, total, items[]." Gives an agent the shape without a schema.
export function shapeSummary(value: unknown): string | undefined {
  const target = Array.isArray(value) ? value[0] : value;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const keys = Object.entries(target as Record<string, unknown>)
    .slice(0, 12)
    .map(([k, v]) => (Array.isArray(v) ? `${k}[]` : k));
  if (!keys.length) return undefined;
  return `${Array.isArray(value) ? 'Returns a list of objects with' : 'Returns'} ${keys.join(', ')}.`;
}
