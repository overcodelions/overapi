// Recorded routes added to an existing API. The importer works out its own
// base path from the calls it is given ("/api" when they all start with
// it); the API already has one. Paths are rebased onto the API's, so the
// new requests line up with the old — and with the traffic that produced
// them.

import type { Project, ToolDef } from './project';
import { toolId } from './project';
import { distinctNames } from './naming';

const pathOf = (url: string | undefined) => {
  try {
    return new URL(url ?? '').pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
};

/// A path that only differs from another by a mount prefix (/api, /rest,
/// /v2): `/orders` beside `/api/orders`.
const MOUNT = /^(\/(api|rest|services?|v\d+(\.\d+)?))+$/i;

/// A copy an earlier add saved without the mount prefix: never turned on,
/// and another request's path minus /api (or /rest, /v2…).
function isShadow(t: ToolDef, all: ToolDef[]): boolean {
  const tail = t.path === '/' ? '' : t.path;
  return !t.enabled && all.some((u) => u !== t && u.method === t.method && u.path.length > t.path.length && u.path.endsWith(tail) && MOUNT.test(u.path.slice(0, u.path.length - tail.length)));
}

/// Names an earlier import numbered (list_fields_2) given words from their
/// paths instead (list_activity_fields). Only names ending in a number, and
/// only when the name without it is taken: anything the person chose stays.
export function tidyNames(project: Project): { project: Project; renamed: [string, string][] } {
  const names = new Set(project.tools.map((t) => t.name));
  const numbered = (t: ToolDef) => {
    const m = t.name.match(/^(.*)_(\d+)$/);
    return m && names.has(m[1]) ? m[1] : undefined;
  };
  if (!project.tools.some(numbered)) return { project, renamed: [] };
  const next = distinctNames(project.tools.map((t) => ({ name: numbered(t) ?? t.name, path: t.path, keep: !numbered(t) })));
  const renamed: [string, string][] = [];
  const tools = project.tools.map((t, i) => {
    if (next[i] === t.name) return t;
    renamed.push([t.name, next[i]]);
    return { ...t, name: next[i] };
  });
  return { project: { ...project, tools }, renamed };
}

/// Removes those copies — run when an API opens, so the mess the old add
/// made goes away without recording again.
export function dropShadows(project: Project): { project: Project; removed: string[]; repaired: string[] } {
  const removedTools = project.tools.filter((t) => isShadow(t, project.tools));
  const gone = new Set(removedTools);
  let tools = project.tools.filter((t) => !gone.has(t));

  // Copies with no twin to compare against: when nearly every request that
  // is on sits under one mount (/api), a turned-off one outside it lost it.
  const mount = dominantMount(tools.filter((t) => t.enabled));
  const repaired: string[] = [];
  if (mount) {
    const ids = new Set(tools.map((t) => t.id));
    tools = tools.flatMap((t) => {
      if (t.enabled || t.path === mount || t.path.startsWith(`${mount}/`) || MOUNT.test(firstSeg(t.path))) return [t];
      const path = `${mount}${t.path === '/' ? '' : t.path}`;
      const id = toolId(t.method, path);
      if (ids.has(id)) {
        removedTools.push(t);
        return [];
      }
      ids.add(id);
      repaired.push(t.name);
      return [{ ...t, path, id }];
    });
  }
  return { project: removedTools.length || repaired.length ? { ...project, tools } : project, removed: removedTools.map((t) => t.name), repaired };
}

const firstSeg = (path: string) => `/${path.split('/').filter(Boolean)[0] ?? ''}`;

/// The mount (/api, /rest/v2…) at least nine in ten of these requests sit
/// under — at least three of them — if there is one.
function dominantMount(tools: ToolDef[]): string | undefined {
  if (tools.length < 3) return undefined;
  const counts = new Map<string, number>();
  for (const t of tools) {
    const segs = t.path.split('/').filter(Boolean);
    let m = '';
    for (const s of segs) {
      if (!MOUNT.test(`/${s}`)) break;
      m += `/${s}`;
    }
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return best && n! >= 3 && n! / tools.length >= 0.9 ? best : undefined;
}

export function mergeRecorded(project: Project, envBaseUrl: string, imported: Project): { project: Project; added: number; removed: number } {
  const envBase = pathOf(envBaseUrl);
  const importedBase = pathOf(imported.envs[0]?.baseUrl);
  const rebased: ToolDef[] = [];
  for (const t of imported.tools) {
    const full = `${importedBase}${t.path === '/' ? '' : t.path}` || '/';
    if (envBase && !(full === envBase || full.startsWith(`${envBase}/`))) continue;
    const path = full.slice(envBase.length) || '/';
    rebased.push({ ...t, path, id: toolId(t.method, path), enabled: false });
  }

  const all = [...project.tools, ...rebased];
  const shadow = (t: ToolDef) => isShadow(t, all);
  const kept = project.tools.filter((t) => !shadow(t));
  const removed = project.tools.length - kept.length;

  const have = new Set(kept.map((t) => t.id));
  const added = rebased.filter((t) => !have.has(t.id) && !shadow(t));
  const names = distinctNames([...kept.map((t) => ({ name: t.name, path: t.path, keep: true })), ...added.map((t) => ({ name: t.name, path: t.path }))]).slice(kept.length);
  return { project: { ...project, tools: [...kept, ...added.map((t, i) => ({ ...t, name: names[i] }))] }, added: added.length, removed };
}
