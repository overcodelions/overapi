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
}

/// Path with lists as [] → values seen there, newest first.
export type SeenPaths = Record<string, SeenValue[]>;

const LABEL_KEYS = ['name', 'displayName', 'display_name', 'title', 'label', 'fullName', 'full_name', 'companyName', 'company_name', 'username', 'userName', 'email', 'description'];
const ENUMISH = /^(status|state|type|kind|category|role|level|stage|mode|language|locale|country|currency)$/i;
const OWN_ID = /^(id|_id|uuid|slug|key|code)$/i;
const MAX = 50;
const ENUM_MAX = 12;

const labelOf = (obj: Record<string, unknown>, own: string): string | undefined => {
  for (const k of LABEL_KEYS) {
    const v = obj[k];
    if (k !== own && typeof v === 'string' && v.trim() && v.length <= 120) return v.trim();
  }
  return undefined;
};

/// The values worth offering again, by path.
export function extractSeen(json: unknown): SeenPaths {
  const out: SeenPaths = {};
  const enums = new Map<string, Set<string>>();
  let budget = 20_000;
  const add = (path: string, val: SeenValue) => {
    const list = (out[path] ??= []);
    if (list.length < MAX && !list.some((x) => x.v === val.v)) list.push(val);
  };
  const walk = (node: unknown, at: string) => {
    if (budget-- <= 0 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node.slice(0, 200)) walk(x, `${at}[]`);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const path = at ? `${at}.${k}` : k;
      if (v !== null && typeof v === 'object') walk(v, path);
      else if ((typeof v === 'string' && v && v.length <= 200) || typeof v === 'number') {
        // The name beside an id names that record — only for its own id,
        // not a clientId pointing elsewhere.
        if (isIdLike(k)) {
          const label = OWN_ID.test(k) ? labelOf(obj, k) : undefined;
          add(path, label ? { v, label } : { v });
        }
        else if (typeof v === 'string' && ENUMISH.test(k) && v.length <= 40) (enums.get(path) ?? enums.set(path, new Set()).get(path)!).add(v);
      }
    }
  };
  walk(json, '');
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
