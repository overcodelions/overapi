// Coverage: what a recording has found, in the words a person uses — teams
// (a list, and one team's details), matches, players — and what's still
// missing, as something to do: "open a team". Read live while recording,
// and the explorer's guide to where to go next.

import type { RecordedCall } from './recording';
import { routeOf } from './metrics';
import { requestGraph } from './graph';
import { singular } from './naming';

export interface Thing {
  /// team, match, player…
  noun: string;
  /// A route that lists them was seen / one that gets one by id.
  list: boolean;
  detail: boolean;
  /// Other routes about it (a team's form, a match's lineups).
  more: number;
}

export interface Coverage {
  requests: number;
  chains: number;
  /// Distinct routes first seen in the last minute.
  recent: number;
  things: Thing[];
  /// What to do next, in words: "Open a team to see its details".
  gaps: string[];
}

const NOISE = /^(api|rest|v\d+(\.\d+)?|services?|public|internal|metadata|stats|leaderboard|search|filters?|config|settings|features?|me)$/i;

/// What a route is about, and whether it lists or fetches one: the last
/// word that isn't a parameter, and whether a parameter follows it.
export function aboutRoute(route: string): { noun: string; kind: 'list' | 'detail' | 'more' } | undefined {
  const segs = route.split('?')[0].split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.startsWith('{') || NOISE.test(s)) continue;
    const noun = singular(s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    if (!noun || /^\d/.test(noun)) return undefined;
    const after = segs.slice(i + 1);
    if (!after.length) return { noun, kind: 'list' };
    if (after.length === 1 && after[0].startsWith('{')) return { noun, kind: 'detail' };
    return { noun, kind: 'more' };
  }
  return undefined;
}

export function coverageOf(calls: RecordedCall[], now = Date.now()): Coverage {
  const ok = calls.filter((c) => !c.error && c.status < 400);
  const firstSeen = new Map<string, number>();
  for (const c of ok) {
    const r = `${c.method} ${routeOf(c.path)}`;
    const at = Date.parse(c.at);
    if (!firstSeen.has(r) || at < firstSeen.get(r)!) firstSeen.set(r, at);
  }
  const things = new Map<string, Thing>();
  for (const r of firstSeen.keys()) {
    const [method, path] = r.split(' ');
    if (method !== 'GET') continue;
    const a = aboutRoute(path);
    if (!a) continue;
    const t = things.get(a.noun) ?? { noun: a.noun, list: false, detail: false, more: 0 };
    if (a.kind === 'list') t.list = true;
    else if (a.kind === 'detail') t.detail = true;
    else t.more++;
    things.set(a.noun, t);
  }
  const edges = requestGraph(ok).filter((e) => !e.auth);
  const chains = new Set(edges.map((e) => `${routeOf(ok.find((c) => c.id === e.from)?.path ?? '')}>${e.where}`)).size;
  const list = [...things.values()].sort((a, b) => Number(b.list && b.detail) - Number(a.list && a.detail) || b.more - a.more);
  const gaps: string[] = [];
  for (const t of list) {
    if (t.list && !t.detail) gaps.push(`Open a ${t.noun} to see one ${t.noun}’s details`);
    else if (t.detail && !t.list) gaps.push(`Find a page that lists ${t.noun}s`);
  }
  return {
    requests: firstSeen.size,
    chains,
    recent: [...firstSeen.values()].filter((at) => now - at < 60_000).length,
    things: list,
    gaps: gaps.slice(0, 6),
  };
}
