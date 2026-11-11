// Chains: how an API's requests feed each other — list the teams, take a
// team's id, get that team. Found from what each request returns (its
// shape) and what each one asks for (its arguments), then connected:
// the source keeps the value, the next request uses it, and the argument
// tells an agent where to get it. That last part is what lets an agent
// go from "list teams" to "team details" on its own.
//
// Also here: values every request sends the same (competition 8, season
// 2025) that belong to the environment, not the agent; and recording
// noise worth tidying.

import type { EnvDef, ParamDef, Project, ToolDef } from './project';
import type { Shape } from './scenario';
import { fits, nounOf } from './wire';

export interface Link {
  /// The request that gives the value.
  from: string;
  fromName: string;
  /// Where in its response, with lists as [0]: data[0].id.
  path: string;
  /// The request that needs it, and which argument.
  to: string;
  toName: string;
  param: string;
  /// Already connected.
  done: boolean;
}

const NOISE_KEY = /^_?(limit|offset|page|page_?size|page_?number|size|sort|order|total|count|next|prev|previous|cursor)$/i;
export const isIdLike = (name: string) => /(^id$|_id$|Id$|^uuid$|_uuid$|^slug$|_slug$|_code$|Code$|^code$)/.test(name);

/// Leaves of a shape, lists as [0]: { path: 'data[0].id', key: 'id', inList }.
function leaves(s: Shape | undefined, at = '', inList = false, out: { path: string; key: string; inList: boolean }[] = []): typeof out {
  if (!s) return out;
  if (s.t === 'object') {
    for (const [k, v] of Object.entries(s.keys)) {
      const p = at ? `${at}.${k}` : k;
      if (v.t === 'object' || v.t === 'array') leaves(v, p, inList, out);
      else out.push({ path: p, key: k, inList });
    }
  } else if (s.t === 'array') leaves(s.of, `${at}[0]`, true, out);
  return out;
}

/// `data[44].seasons[27]` → `data[0].seasons[0]`: a recording keeps the
/// item that happened to match; a chain wants "the one you pick".
export const cleanPath = (path: string) => path.replace(/\[\d+\]/g, '[0]');

/// What a path looks like to a person (and an agent): data[].id.
export const readablePath = (path: string) => path.replace(/\[0\]/g, '[]');

const requiredArgs = (t: ToolDef) => t.params.filter((p) => p.required).length;

/// What an id argument is the id of: team_id → team, matchId → match; a
/// bare id → what the request is about.
const stemOf = (param: string, to: ToolDef) => {
  const s = param.replace(/(_id|Id|_uuid|_slug|_code|Code)$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s === 'id' || !s ? nounOf(to) : s;
};
const related = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a));

/// A source has to be about the thing it gives (a team list gives team
/// ids; an id under playerMetadata is a player's) — or need nothing
/// itself, a starting point. And it can't need the value it gives.
function credible(from: ToolDef, to: ToolDef, param: string, path: string): boolean {
  const stem = stemOf(param, to);
  if (from.params.some((x) => x.required && stemOf(x.name, from) === stem && /id|uuid|slug|code/i.test(x.name))) return false;
  const about = related(nounOf(from).replace(/[^a-z0-9]/g, ''), stem) || path.toLowerCase().replace(/[^a-z0-9.]/g, '').split('.').slice(0, -1).some((seg) => seg !== 'id' && related(seg.replace(/(metadata|id)$/, ''), stem));
  return about || requiredArgs(from) === 0;
}

/// Every argument some other request can supply, with its best source: one
/// that lists them (a list is where you pick from), needing the fewest
/// arguments itself, named after the same thing.
export function findLinks(project: Project): Link[] {
  const out: Link[] = [];
  // Any request can be a source — a create hands back the new id — but
  // reads, and above all lists, come first.
  const sources = project.tools;
  for (const to of project.tools) {
    for (const p of to.params) {
      if (p.in !== 'path' && p.in !== 'query') continue;
      if (!isIdLike(p.name)) continue;
      const already = typeof to.example?.[p.name] === 'string' && /^\{\{.+\}\}$/.test(String(to.example[p.name]));
      const candidates: { from: ToolDef; path: string; score: number }[] = [];
      for (const from of sources) {
        if (from.id === to.id) continue;
        // From what it returns…
        for (const l of leaves(from.returns)) {
          if (NOISE_KEY.test(l.key)) continue;
          if (!fits(l.key, p.name, from) && !fits(`${nounOf(from)}_${l.key}`, p.name) && !(l.key === 'id' && credible(from, to, p.name, l.path) && related(l.path.toLowerCase(), stemOf(p.name, to)))) continue;
          if (!credible(from, to, p.name, l.path)) continue;
          candidates.push({ from, path: l.path, score: (from.method === 'GET' ? 1 : 0) + (l.inList ? 4 : 0) + (fits(l.key, p.name) ? 2 : 0) + (nounOf(from) && p.name.toLowerCase().startsWith(nounOf(from)) ? 2 : 0) - requiredArgs(from) * 0.5 - l.path.split('.').length * 0.1 });
        }
        // …or from what it already keeps.
        for (const c of from.captures ?? []) {
          const key = c.path.split(/[.[\]]/).filter(Boolean).pop() ?? c.var;
          if (NOISE_KEY.test(key) || NOISE_KEY.test(c.var)) continue;
          const ok = fits(c.var, p.name, from) || fits(key, p.name, from) || (key === 'id' && related(c.path.toLowerCase(), stemOf(p.name, to)));
          if (ok && credible(from, to, p.name, c.path)) candidates.push({ from, path: cleanPath(c.path), score: 1 - requiredArgs(from) * 0.5 });
        }
      }
      const best = candidates.sort((a, b) => b.score - a.score)[0];
      if (best) out.push({ from: best.from.id, fromName: best.from.name, path: best.path, to: to.id, toName: to.name, param: p.name, done: already });
    }
  }
  return out;
}

/// Connects links: the source keeps the value as {{param}}, the request
/// uses it, and the argument says where it comes from.
export function applyLinks(project: Project, links: Link[]): Project {
  let tools = project.tools.map((t) => ({ ...t, captures: [...(t.captures ?? [])], example: { ...(t.example ?? {}) }, params: t.params.map((p) => ({ ...p })) }));
  for (const l of links) {
    const from = tools.find((t) => t.id === l.from);
    const to = tools.find((t) => t.id === l.to);
    if (!from || !to) continue;
    const name = l.param;
    const existing = from.captures.find((c) => c.var === name);
    if (!existing) from.captures = [...from.captures.filter((c) => c.path !== l.path || c.var !== name), { var: name, from: 'body', path: l.path }];
    to.example[l.param] = `{{${name}}}`;
    const prm = to.params.find((p) => p.name === l.param);
    if (prm) {
      const hint = `Get it from ${from.name} (${readablePath(l.path)}).`;
      if (!(prm.description ?? '').includes(from.name)) prm.description = [prm.description, hint].filter(Boolean).join(' ');
    }
  }
  // Values kept by the old way (named for the field, from one list item)
  // that nothing uses are dropped.
  const used = new Set(tools.flatMap((t) => [...JSON.stringify(t.example ?? {}).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1])));
  tools = tools.map((t) => ({ ...t, captures: t.captures.filter((c) => used.has(c.var) || !/\[\d*[1-9]\d*\]/.test(c.path)) }));
  return { ...project, tools: tools.map((t) => ({ ...t, captures: t.captures.length ? t.captures : undefined, example: Object.keys(t.example).length ? t.example : undefined })) };
}

export interface SharedValue {
  name: string;
  value: string;
  /// Requests that send it.
  tools: string[];
  in: ParamDef['in'];
}

/// An argument most requests send with the same value — the competition,
/// the season, the tenant — which belongs to the environment: agents
/// shouldn't have to know that the a football league is 8.
export function sharedValues(project: Project, env: EnvDef | undefined): SharedValue[] {
  const by = new Map<string, { values: Set<string>; tools: string[]; in: ParamDef['in'] }>();
  for (const t of project.tools) {
    for (const p of t.params) {
      if (p.in !== 'path' && p.in !== 'query') continue;
      const v = t.example?.[p.name];
      if (v === undefined || v === null || v === '' || (typeof v === 'string' && v.includes('{{'))) continue;
      if (typeof v === 'object') continue;
      const e = by.get(p.name) ?? { values: new Set<string>(), tools: [], in: p.in };
      e.values.add(String(v));
      e.tools.push(t.id);
      by.set(p.name, e);
    }
  }
  return [...by.entries()]
    .filter(([name, e]) => e.values.size === 1 && e.tools.length >= 3 && !NOISE_KEY.test(name) && env?.vars?.[name] === undefined)
    .map(([name, e]) => ({ name, value: [...e.values][0], tools: e.tools, in: e.in }))
    .sort((a, b) => b.tools.length - a.tools.length);
}

/// Moves a shared value into the environment: path arguments become
/// {{name}} in the path (agents never see them); query arguments keep a
/// default, so agents can leave them out.
export function applyShared(project: Project, envName: string, s: SharedValue): Project {
  return {
    ...project,
    envs: project.envs.map((e) => (e.name === envName ? { ...e, vars: { ...(e.vars ?? {}), [s.name]: s.value } } : e)),
    tools: project.tools.map((t) => {
      const p = t.params.find((x) => x.name === s.name);
      if (!p) return t;
      if (p.in === 'path') {
        const example = { ...(t.example ?? {}) };
        delete example[s.name];
        return { ...t, path: t.path.replaceAll(`{${s.name}}`, `{{${s.name}}}`), params: t.params.filter((x) => x !== p), example: Object.keys(example).length ? example : undefined };
      }
      return { ...t, params: t.params.map((x) => (x === p ? { ...x, required: false, schema: { ...x.schema, default: s.value }, description: x.description ?? `Defaults to ${s.value}.` } : x)) };
    }),
  };
}

export interface Tidy {
  id: string;
  title: string;
  detail: string;
  toolId: string;
  /// Remove the request, or just one argument of it.
  remove: 'tool' | { param: string };
}

/// Recording noise: requests the website got wrong (an "undefined" in the
/// path) and arguments that aren't really arguments (kickoff>2026-11-09).
export function tidyUps(project: Project): Tidy[] {
  const out: Tidy[] = [];
  for (const t of project.tools) {
    if (/\/(undefined|null|NaN|\[object Object\])(\/|$)/.test(t.path)) {
      out.push({ id: `tool:${t.id}`, title: `${t.name} has “${/undefined|null|NaN|\[object Object\]/.exec(t.path)![0]}” in its path`, detail: 'The website sent this by mistake while you recorded — a bug on its side, not a real request.', toolId: t.id, remove: 'tool' });
    }
    for (const p of t.params) {
      if (!/^[A-Za-z_][A-Za-z0-9_.\-[\]]*$/.test(p.name)) {
        out.push({ id: `param:${t.id}:${p.name}`, title: `${t.name} has an argument called “${p.name}”`, detail: 'That came from a filter written into the address, not a real argument name.', toolId: t.id, remove: { param: p.name } });
      }
    }
  }
  return out;
}

export function applyTidy(project: Project, t: Tidy): Project {
  if (t.remove === 'tool') return { ...project, tools: project.tools.filter((x) => x.id !== t.toolId) };
  const param = t.remove.param;
  return { ...project, tools: project.tools.map((x) => (x.id === t.toolId ? { ...x, params: x.params.filter((p) => p.name !== param) } : x)) };
}
