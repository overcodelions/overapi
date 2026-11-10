// Tool names. MCP clients accept [a-zA-Z0-9_-] up to 64 characters, and
// several prefix the server name, so short and snake_case reads best:
// `acme_orders__get_order` beats `acme-orders__GETApiV2OrdersOrderId`.

import type { HttpMethod } from './project';

const VERB: Record<string, string> = {
  GET: 'get',
  POST: 'create',
  PUT: 'replace',
  PATCH: 'update',
  DELETE: 'delete',
  HEAD: 'head',
  OPTIONS: 'options',
};

export function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

/// Segments that say nothing: version prefixes and the ubiquitous `api`.
function noise(segment: string): boolean {
  return /^(api|rest|v\d+(\.\d+)?|services?)$/i.test(segment);
}

/// A name from method and path when the spec gave no operationId:
///   GET  /api/v2/orders           -> list_orders
///   GET  /api/v2/orders/{id}      -> get_order
///   POST /api/v2/orders/{id}/cancel -> cancel_order  (a verb-ish action)
///   POST /orders                  -> create_order
export function nameFromRoute(method: HttpMethod, path: string): string {
  const segs = path.split('/').filter(Boolean).filter((s) => !noise(s));
  const statics = segs.filter((s) => !s.startsWith('{'));
  const endsWithParam = segs.length > 0 && segs[segs.length - 1].startsWith('{');
  const last = statics[statics.length - 1] ?? 'root';
  const parent = statics.length > 1 ? statics[statics.length - 2] : undefined;

  // POST /orders/{id}/cancel: the last static after a param is an action.
  const lastIsAction = method === 'POST' && !endsWithParam && segs.length >= 2 && segs[segs.length - 2].startsWith('{');
  if (lastIsAction && parent) return clamp(`${snake(last)}_${singular(snake(parent))}`);

  let verb = VERB[method] ?? method.toLowerCase();
  let noun = snake(last);
  if (method === 'GET' && !endsWithParam) verb = 'list';
  else noun = singular(noun);
  // Nested collections keep their owner: /customers/{id}/orders -> list_customer_orders
  if (parent && segs.some((s) => s.startsWith('{')) && segs.indexOf(last) > segs.indexOf(parent) + 1) {
    noun = `${singular(snake(parent))}_${noun}`;
  }
  return clamp(`${verb}_${noun}`);
}

export function nameFromOperationId(operationId: string): string {
  return clamp(snake(operationId));
}

export function singular(word: string): string {
  // No vowels: an acronym (lms, cms, sms), not a plural — leave it.
  if (!/[aeiou]/i.test(word)) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(word)) return word;
  if (/(x|ch|sh|ss)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function clamp(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, '') || 'tool';
  return cleaned.slice(0, 64);
}

export const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/// Makes every name unique by suffixing _2, _3… in order of appearance.
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    if (count === 1) return n;
    const suffix = `_${count}`;
    return n.slice(0, 64 - suffix.length) + suffix;
  });
}

const VERBS = new Set(['list', 'get', 'create', 'replace', 'update', 'delete', 'head', 'options']);

/// Unique names that say how they differ: when two requests would share a
/// name, the one with the shortest path keeps it and the others take a word
/// from their own path — /fields and /campaigns/activities/fields become
/// list_fields and list_activity_fields, not list_fields and list_fields_2.
/// Nobody's shorter? Each takes a word. Names marked `keep` (chosen by the
/// person) never change. A number is the last resort.
export function distinctNames(items: { name: string; path: string; keep?: boolean }[]): string[] {
  const out = items.map((i) => i.name);
  const used = items.map(() => 0);
  const statics = (path: string) => path.split('/').filter((s) => s && !s.startsWith('{') && !noise(s));
  for (let round = 0; round < 4; round++) {
    const by = new Map<string, number[]>();
    out.forEach((n, i) => by.set(n, [...(by.get(n) ?? []), i]));
    let changed = false;
    for (const idx of by.values()) {
      if (idx.length < 2) continue;
      const depth = (i: number) => statics(items[i].path).length;
      const kept = idx.find((i) => items[i].keep);
      const min = Math.min(...idx.map(depth));
      const shortest = idx.filter((i) => depth(i) === min);
      const keeper = kept ?? (shortest.length === 1 ? shortest[0] : undefined);
      for (const i of idx) {
        if (i === keeper || items[i].keep) continue;
        // The nearest folder above the resource not already in the name.
        const parents = statics(items[i].path).slice(0, -1).reverse().map((s) => singular(snake(s)));
        let q: string | undefined;
        while (used[i] < parents.length && !q) {
          const c = parents[used[i]++];
          if (c && !out[i].split('_').includes(c)) q = c;
        }
        if (!q) continue;
        const [verb, ...rest] = out[i].split('_');
        out[i] = clamp(VERBS.has(verb) && rest.length ? `${verb}_${q}_${rest.join('_')}` : `${q}_${out[i]}`);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return uniqueNames(out);
}
