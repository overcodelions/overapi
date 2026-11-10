// A system: several APIs that belong together — services of one product,
// signed in by one of them, running side by side in each environment. It
// is a file of its own (overapi-system.json) naming its members; each
// member stays an ordinary API with its own file, environments and tools.
// Served together, they are one MCP server: one curated toolset for the
// whole product, with ids flowing from one service to the next.

import type { EnvDef, Project, ToolDef } from './project';

export const SYSTEM_FILE = 'overapi-system.json';

export interface SystemDef {
  overapiSystem: 1;
  name: string;
  title: string;
  description?: string;
  /// Member API files, relative to the system file's folder.
  members: string[];
  /// The member that signs the others in (its name).
  signedInBy?: string;
  /// Told to the agent when the system is served as one server.
  instructions?: string;
}

/// A system as the app holds it: member paths resolved.
export interface SystemRef {
  path: string;
  title: string;
  name: string;
  members: string[];
  signedInBy?: string;
  description?: string;
  instructions?: string;
}

export function isSystemFile(data: unknown): data is SystemDef {
  return !!data && typeof data === 'object' && (data as { overapiSystem?: unknown }).overapiSystem === 1 && Array.isArray((data as { members?: unknown }).members);
}

/// A member's short name for prefixes: orders-service → orders.
export function shortName(project: Project): string {
  return (project.name || 'api').replace(/[-_](service|svc|api|rest|server)$/i, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

export interface MemberTool {
  /// The name the merged server offers it under.
  name: string;
  tool: ToolDef;
  member: number;
}

/// The members' tools under one roof. Names stay as they are unless two
/// members share one; then both get their member's short name in front.
export function mergedNames(members: { project: Project; tools: ToolDef[] }[]): MemberTool[] {
  const count = new Map<string, number>();
  for (const m of members) for (const t of m.tools) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  const out: MemberTool[] = [];
  const taken = new Set<string>();
  members.forEach((m, i) => {
    for (const t of m.tools) {
      let name = (count.get(t.name) ?? 0) > 1 ? `${shortName(m.project)}_${t.name}` : t.name;
      for (let n = 2; taken.has(name); n++) name = `${shortName(m.project)}_${t.name}_${n}`;
      taken.add(name);
      out.push({ name: name.slice(0, 64), tool: t, member: i });
    }
  });
  return out;
}

/// The environment names every member has, in the first member's order,
/// then the ones only some have.
export function systemEnvs(projects: Project[]): { name: string; all: boolean }[] {
  const names: string[] = [];
  for (const p of projects) for (const e of p.envs) if (!names.includes(e.name)) names.push(e.name);
  return names.map((name) => ({ name, all: projects.every((p) => p.envs.some((e) => e.name === name)) }));
}

/// The environment a sign-in service uses for a member's environment: the
/// same name, or its only one.
export function providerEnv(provider: Project, envName: string): EnvDef | undefined {
  return provider.envs.find((e) => e.name === envName) ?? (provider.envs.length === 1 ? provider.envs[0] : undefined);
}
