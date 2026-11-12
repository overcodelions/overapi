// What the app remembers between launches: settings, the list of
// projects, request history and what was published where. All under
// userData, all plain JSON, none of it a secret.

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HistoryEntry, Published, Settings } from '../shared/ipc';
import { mergeSeen } from '../shared/seen';

const dir = () => app.getPath('userData');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---- test runs: the last run of each scenario, per project --------------------

type Runs = Record<string, Record<string, import('../shared/scenario').ScenarioRun>>;
const runsFile = () => path.join(dir(), 'test-runs.json');

export function lastRuns(p: string): Record<string, import('../shared/scenario').ScenarioRun> {
  return readJson<Runs>(runsFile(), {})[p] ?? {};
}

export function saveRun(p: string, run: import('../shared/scenario').ScenarioRun): void {
  const all = readJson<Runs>(runsFile(), {});
  // Bodies stay out: the file is a record of outcomes, not of data.
  const slim = { ...run, results: run.results.map(({ body: _b, ...r }) => r) };
  all[p] = { ...(all[p] ?? {}), [run.scenarioId]: slim };
  writeJson(runsFile(), all);
}

// ---- settings --------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  ai: 'auto',
  aiModel: '',
  projectsDir: path.join(os.homedir(), 'overapi'),
  timeoutSec: 30,
  autoUpdate: true,
  updateChannel: 'stable',
  loadTesting: false,
  toured: false,
};

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(path.join(dir(), 'settings.json'), {}) };
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  next.timeoutSec = Math.min(300, Math.max(1, Number(next.timeoutSec) || 30));
  writeJson(path.join(dir(), 'settings.json'), next);
  return next;
}

// ---- projects ----------------------------------------------------------------

interface State {
  projects: string[];
  /// System files (overapi-system.json), newest first.
  systems: string[];
  published: Record<string, Published>;
  /// Where each project's server was installed from the app.
  /// claudeByEnv: one entry per environment installed — each is its own server.
  installed: Record<string, { claude?: { at: string; env: string; name: string }; claudeByEnv?: Record<string, { at: string; name: string }> }>;
  /// Approved projects: path → the fingerprint approved (core/trust.ts).
  trusted?: Record<string, string>;
}

function state(): State {
  const s = readJson<Partial<State>>(path.join(dir(), 'state.json'), {});
  return { projects: Array.isArray(s.projects) ? s.projects.filter((p) => typeof p === 'string') : [], systems: Array.isArray(s.systems) ? s.systems.filter((p) => typeof p === 'string') : [], published: s.published ?? {}, installed: s.installed ?? {}, trusted: s.trusted };
}

export function markInstalled(p: string, claude: { at: string; env: string; name: string }): void {
  const s = state();
  const byEnv = { ...claudeByEnv(s, p), [claude.env]: { at: claude.at, name: claude.name } };
  writeJson(path.join(dir(), 'state.json'), { ...s, installed: { ...s.installed, [p]: { claudeByEnv: byEnv } } });
}

/// Per environment, reading the older single-entry shape too.
function claudeByEnv(s: State, p: string): Record<string, { at: string; name: string }> {
  const i = s.installed[p] ?? {};
  const out = { ...(i.claudeByEnv ?? {}) };
  if (i.claude && !out[i.claude.env]) out[i.claude.env] = { at: i.claude.at, name: i.claude.name };
  return out;
}

export function clearInstalled(p: string, env: string): void {
  const s = state();
  const byEnv = claudeByEnv(s, p);
  delete byEnv[env];
  writeJson(path.join(dir(), 'state.json'), { ...s, installed: { ...s.installed, [p]: { claudeByEnv: byEnv } } });
}

export function installedFor(p: string): Record<string, { at: string; name: string }> {
  return claudeByEnv(state(), p);
}

export function listProjects(): string[] {
  return state().projects;
}

export function rememberProject(p: string): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, projects: [p, ...s.projects.filter((x) => x !== p)] });
}

export function listSystems(): string[] {
  return state().systems;
}

export function rememberSystem(p: string): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, systems: [p, ...s.systems.filter((x) => x !== p)] });
}

export function forgetSystem(p: string): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, systems: s.systems.filter((x) => x !== p) });
}

export function forgetProject(p: string): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, projects: s.projects.filter((x) => x !== p) });
}

export function markPublished(p: string, entry: Published): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, published: { ...s.published, [p]: entry } });
}

export function publishedFor(p: string): Published | null {
  return state().published[p] ?? null;
}

// ---- history -----------------------------------------------------------------

const HISTORY_MAX = 200;
const historyFile = (p: string) => path.join(dir(), 'history', `${createHash('sha256').update(p).digest('hex').slice(0, 16)}.json`);

export function history(p: string): HistoryEntry[] {
  return readJson<HistoryEntry[]>(historyFile(p), []);
}

export function addHistory(p: string, e: HistoryEntry): void {
  writeJson(historyFile(p), [e, ...history(p)].slice(0, HISTORY_MAX));
}

export function clearHistory(p: string): void {
  writeJson(historyFile(p), []);
  clearSeen(p);
}

// ---- values seen in responses (shared/seen.ts) --------------------------------

/// Per environment, per request: what its responses held. Real data, so
/// here beside the history — never in the project file.
type SeenStore = Record<string, Record<string, import('../shared/seen').SeenPaths>>;
const seenFile = (p: string) => path.join(dir(), 'seen', `${createHash('sha256').update(p).digest('hex').slice(0, 16)}.json`);

export function seenFor(p: string): SeenStore {
  return readJson<SeenStore>(seenFile(p), {});
}

export function recordSeen(p: string, env: string, toolId: string, fresh: import('../shared/seen').SeenPaths): void {
  if (!Object.keys(fresh).length) return;
  const all = seenFor(p);
  const byEnv = (all[env] ??= {});
  byEnv[toolId] = mergeSeen(byEnv[toolId] ?? {}, fresh);
  writeJson(seenFile(p), all);
}

export function clearSeen(p: string): void {
  writeJson(seenFile(p), {});
}

// ---- approvals ----------------------------------------------------------------

export function hasTrustStore(): boolean {
  return !!state().trusted;
}

/// The first run with approvals: the projects already here are the person's.
export function seedTrust(map: Record<string, string>): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, trusted: { ...map, ...(s.trusted ?? {}) } });
}

export function trustOf(p: string): string | undefined {
  return state().trusted?.[p];
}

export function trustProject(p: string, fingerprint: string): void {
  const s = state();
  writeJson(path.join(dir(), 'state.json'), { ...s, trusted: { ...(s.trusted ?? {}), [p]: fingerprint } });
}
