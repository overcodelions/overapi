// Values seen in responses — so a parameter can offer the partners, groups
// and ids an earlier call answered with, by name, instead of a blank box.
//
// From each response: every id-like field (with the name beside it as its
// label), and small sets of short strings (a status, a type) as quick
// picks. Kept on this Mac only, per environment — they are real data —
// never in the project file.

import { isIdLike } from './chains';

export interface SeenValue {
  v: string | number;
  label?: string;
  /// The record the id came from, flattened to its short fields — so a
  /// picker can show which one this is, not just its id.
  row?: SeenRow;
}

export type SeenRow = Record<string, string | number | boolean>;

/// Path with lists as [] → values seen there, newest first.
export type SeenPaths = Record<string, SeenValue[]>;

const LABEL_KEYS = ['name', 'displayName', 'display_name', 'title', 'label', 'fullName', 'full_name', 'companyName', 'company_name', 'username', 'userName', 'email', 'description'];
const ENUMISH = /^(status|state|type|kind|category|role|level|stage|mode|language|locale|country|currency)$/i;
const OWN_ID = /^(id|_id|uuid|slug|key|code)$/i;
const MAX = 50;
const ROW_FIELDS = 24;
const ROW_TEXT = 80;
const ENUM_MAX = 12;

/// Text that is itself an id (a uuid, a long hex key) — no use as a name.
export const looksLikeId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()) || /^[0-9a-f]{16,}$/i.test(v.trim());

/// A name given as parts — {firstName, lastName}, {display: …} — as one.
const NAME_PARTS = ['display', 'displayName', 'full', 'fullName', 'name', 'value', 'text'];
const nameFrom = (o: Record<string, unknown>): string | undefined => {
  for (const k of NAME_PARTS) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
  const first = Object.entries(o).find(([k, v]) => /^(first|given)/i.test(k) && typeof v === 'string')?.[1] as string | undefined;
  const last = Object.entries(o).find(([k, v]) => /^(last|family|sur)/i.test(k) && typeof v === 'string')?.[1] as string | undefined;
  return [first, last].filter((x) => x?.trim()).join(' ').trim() || undefined;
};

const labelOf = (obj: Record<string, unknown>, own: string): string | undefined => {
  for (const k of LABEL_KEYS) {
    let v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) v = nameFrom(v as Record<string, unknown>);
    if (k !== own && typeof v === 'string' && v.trim() && v.length <= 120 && !looksLikeId(v)) return v.trim();
  }
  return undefined;
};

/// A record's short fields: its own first, then one level into the objects
/// it holds (team.name), as dotted keys. Lists and long text are left out.
export function rowOf(own: Record<string, unknown>, rec: Record<string, unknown>): SeenRow | undefined {
  const row: SeenRow = {};
  let n = 0;
  const put = (k: string, v: unknown) => {
    if (n >= ROW_FIELDS || k in row) return;
    if (typeof v === 'number' || typeof v === 'boolean') row[k] = v;
    else if (typeof v === 'string' && v.trim()) row[k] = v.length > ROW_TEXT ? `${v.slice(0, ROW_TEXT - 1)}…` : v;
    else return;
    n++;
  };
  const flat = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === own && obj !== own) continue;
      if (v !== null && typeof v === 'object') {
        if (!Array.isArray(v) && depth > 0) flat(v as Record<string, unknown>, `${prefix}${k}.`, depth - 1);
      } else put(`${prefix}${k}`, v);
    }
  };
  flat(own, '', 1);
  if (rec !== own) flat(rec, '', 1);
  return n > 1 ? row : undefined;
}

/// The values worth offering again, by path.
export function extractSeen(json: unknown): SeenPaths {
  const out: SeenPaths = {};
  const enums = new Map<string, Set<string>>();
  // Ids inside an id object ({competitionId, seasonId, playerId}): only one
  // names the record — the one that differs on every row. Counted, then judged.
  const parts = new Map<string, { n: number; distinct: Set<string> }>();
  // An id in an object inside the row (currentTeam.id, playerMetadata.id):
  // different on every row, the row is its record; repeated (one team, many
  // players), it points to something shared — keep just its own fields.
  const nested = new Map<string, { n: number; distinct: Set<string>; own: Map<string, SeenRow | undefined> }>();
  let budget = 20_000;
  const add = (path: string, val: SeenValue) => {
    const list = (out[path] ??= []);
    if (list.length < MAX && !list.some((x) => x.v === val.v)) list.push(val);
  };
  // `rec`: the list item (or the whole answer) this object sits in.
  const walk = (node: unknown, at: string, rec?: Record<string, unknown>, under?: string) => {
    if (budget-- <= 0 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node.slice(0, 200)) walk(x, `${at}[]`, x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : rec);
      return;
    }
    const obj = node as Record<string, unknown>;
    const record = rec ?? obj;
    for (const [k, v] of Object.entries(obj)) {
      const path = at ? `${at}.${k}` : k;
      if (v !== null && typeof v === 'object') walk(v, path, record, Array.isArray(v) ? undefined : k);
      else if ((typeof v === 'string' && v && v.length <= 200) || typeof v === 'number') {
        // The name beside an id names that record — only for its own id,
        // not a clientId pointing elsewhere.
        if (isIdLike(k)) {
          const part = !OWN_ID.test(k) && !!under && OWN_ID.test(under) && obj !== record;
          if (part) {
            const c = parts.get(path) ?? parts.set(path, { n: 0, distinct: new Set() }).get(path)!;
            c.n++;
            c.distinct.add(String(v));
          }
          const own = OWN_ID.test(k) || part;
          if (own && !part && obj !== record) {
            const c = nested.get(path) ?? nested.set(path, { n: 0, distinct: new Set(), own: new Map() }).get(path)!;
            c.n++;
            c.distinct.add(String(v));
            if (!c.own.has(String(v))) c.own.set(String(v), rowOf(obj, obj));
          }
          const label = own ? (labelOf(obj, k) ?? (obj !== record ? labelOf(record, '') : undefined)) : undefined;
          const row = own ? rowOf(obj, record) : undefined;
          add(path, { v, ...(label ? { label } : {}), ...(row ? { row } : {}) });
        }
        else if (typeof v === 'string' && ENUMISH.test(k) && v.length <= 40) (enums.get(path) ?? enums.set(path, new Set()).get(path)!).add(v);
      }
    }
  };
  walk(json, '');
  for (const [path, c] of parts)
    if (c.n < 2 || c.distinct.size < c.n) out[path] = out[path]?.map(({ v }) => ({ v }));
  for (const [path, c] of nested)
    if (c.distinct.size < c.n)
      out[path] = out[path]?.map((x) => {
        const row = c.own.get(String(x.v));
        return { v: x.v, ...(x.label ? { label: x.label } : {}), ...(row ? { row } : {}) };
      });
  for (const [path, set] of enums) if (set.size <= ENUM_MAX) out[path] = [...set].map((v) => ({ v }));
  return out;
}

/// New values first, then the older ones not seen again, capped.
export function mergeSeen(old: SeenPaths, fresh: SeenPaths): SeenPaths {
  const out: SeenPaths = { ...old };
  for (const [path, list] of Object.entries(fresh)) {
    const keep = (old[path] ?? []).filter((x) => !list.some((y) => y.v === x.v));
    out[path] = [...list, ...keep].slice(0, MAX);
  }
  return out;
}

/// A chain's path (data[0].id) as a seen path (data[].id).
export const seenPath = (chainPath: string) => chainPath.replace(/\[\d*\]/g, '[]');

/// The field a seen path ends in.
export const seenKey = (path: string) => path.split('.').pop()!.replace(/\[\]$/, '');
