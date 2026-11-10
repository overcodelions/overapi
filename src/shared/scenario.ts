// Test scenarios: a recording kept as steps to run again — the API's own
// requests, in the order they happened, with the values that flowed
// between them (the request graph) passed along as {{variables}} instead of
// the ids recorded on the day. So a replay next week signs in afresh, lists
// partners, and opens whichever partner comes back first — not partner 1042,
// which may be gone.
//
// Checks are about shape, not values: the status is 2xx, the JSON has the
// structure it had, and (optionally) it answers within a budget. Values
// change — timestamps, counts, ids — and a test that fails on them is a
// test people stop running.

import type { Capture, Project } from './project';
import type { RecordedCall } from './recording';
import { argsFromCall, toolForCall, type GraphEdge } from './graph';
import { parsePath } from './capture';

export type Shape =
  | { t: 'object'; keys: Record<string, Shape> }
  | { t: 'array'; of?: Shape }
  | { t: 'string' | 'number' | 'boolean' | 'null' | 'any' };

export interface StepExpect {
  /// '2xx', or one exact status.
  status: '2xx' | number;
  /// The JSON structure to find. Absent: any body.
  shape?: Shape;
  /// Fail when slower than this.
  maxMs?: number;
}

export interface ScenarioStep {
  id: string;
  toolId: string;
  /// Arguments as the request takes them; `{{var}}` for a value an earlier step saved.
  args: Record<string, unknown>;
  /// Values this step's response hands to later steps.
  saves: Capture[];
  expect: StepExpect;
  enabled: boolean;
  /// Run it even though it changes data (only where the environment allows
  /// writes, and never on production). Off: skipped.
  write?: boolean;
  /// What the recording saw, for the person: status and time.
  recorded?: { status: number; ms: number };
  /// Turned on although it failed when recorded — the person's choice.
  included?: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  /// Where it came from, for the person.
  from?: string;
  /// The environment it runs on unless told otherwise — where it was
  /// recorded, or what the person last picked.
  env?: string;
  steps: ScenarioStep[];
}

export interface StepResult {
  stepId: string;
  name: string;
  method: string;
  url?: string;
  status?: number;
  ms?: number;
  ok: boolean;
  /// Why it didn't run.
  skipped?: string;
  problems: string[];
  warnings: string[];
  body?: string;
}

export interface ScenarioRun {
  scenarioId: string;
  env: string;
  at: string;
  ms: number;
  passed: number;
  failed: number;
  skipped: number;
  results: StepResult[];
}

// ---- shape ------------------------------------------------------------------

const MAX_KEYS = 60;

export function shapeOf(v: unknown, depth = 0): Shape {
  if (v === null || v === undefined) return { t: 'null' };
  if (depth > 6) return { t: 'any' };
  if (Array.isArray(v)) {
    const first = v.find((x) => x !== null && x !== undefined);
    return first === undefined ? { t: 'array' } : { t: 'array', of: shapeOf(first, depth + 1) };
  }
  if (typeof v === 'object') {
    const keys: Record<string, Shape> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_KEYS)) keys[k] = shapeOf(x, depth + 1);
    return { t: 'object', keys };
  }
  if (typeof v === 'number') return { t: 'number' };
  if (typeof v === 'boolean') return { t: 'boolean' };
  return { t: 'string' };
}

const kindOf = (v: unknown): Shape['t'] => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');

/// How a response differs from the shape: problems fail the step (a field
/// changed type, an object became a list); warnings don't (a field the
/// recording had is missing — often optional).
export function compareShape(expected: Shape, actual: unknown, at = '$'): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const walk = (e: Shape, a: unknown, p: string) => {
    if (e.t === 'any' || e.t === 'null') return;
    const k = kindOf(a);
    if (k === 'null') return;
    if (k !== e.t) {
      problems.push(`${p} was ${article(e.t)}, now ${article(k)}`);
      return;
    }
    if (e.t === 'object') {
      const obj = a as Record<string, unknown>;
      for (const [key, s] of Object.entries(e.keys)) {
        if (!(key in obj)) warnings.push(`${p}.${key} is missing`);
        else walk(s, obj[key], `${p}.${key}`);
      }
    } else if (e.t === 'array' && e.of) {
      (a as unknown[]).slice(0, 3).forEach((x, i) => walk(e.of!, x, `${p}[${i}]`));
    }
  };
  walk(expected, actual, at);
  return { problems: problems.slice(0, 20), warnings: warnings.slice(0, 20) };
}

const article = (t: string) => (t === 'object' || t === 'array' ? `an ${t}` : `a ${t}`);

export function shapeKeys(s: Shape | undefined): number {
  if (!s) return 0;
  if (s.t === 'object') return Object.keys(s.keys).length + Object.values(s.keys).reduce((n, x) => n + shapeKeys(x), 0);
  if (s.t === 'array') return shapeKeys(s.of);
  return 0;
}

/// A shape as a small example value — what the person reads.
export function shapeExample(s: Shape | undefined): unknown {
  if (!s) return null;
  switch (s.t) {
    case 'object':
      return Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, shapeExample(v)]));
    case 'array':
      return s.of ? [shapeExample(s.of)] : [];
    case 'any':
      return '…';
    default:
      return s.t;
  }
}

// ---- from a recording -----------------------------------------------------------

const MAX_STEPS = 60;

/// A scenario from recorded calls: each call this API has a request for
/// becomes a step, repeats of the same read are folded, and every value an
/// earlier response handed a later request (the graph's data links) becomes
/// a saved variable. Credentials are left to the environment's sign-in.
export function scenarioFromCalls(project: Project, calls: RecordedCall[], edges: GraphEdge[], basePath: string, name: string): Scenario {
  const steps: ScenarioStep[] = [];
  const stepOf = new Map<string, number>();
  const seen = new Map<string, number>();
  const ordered = [...calls].filter((c) => !c.error).sort((a, b) => a.at.localeCompare(b.at));
  for (const c of ordered) {
    const tool = toolForCall(project, c, basePath);
    if (!tool) continue;
    const args = argsFromCall(tool, c, basePath);
    // Values that came out of an earlier step: pass them along.
    for (const e of edges) {
      if (e.to !== c.id || e.auth) continue;
      const src = stepOf.get(e.from);
      if (src === undefined) continue;
      const hit = Object.entries(args).find(([, v]) => v !== null && v !== undefined && String(v) === e.value);
      if (!hit) continue;
      const from = steps[src];
      const last = parsePath(e.fromPath).filter((x) => typeof x === 'string').pop() ?? 'value';
      const v = `${from.id}_${String(last).replace(/[^A-Za-z0-9_]/g, '_')}`;
      if (!from.saves.some((s) => s.var === v)) from.saves.push({ var: v, from: e.fromHeader ? 'header' : 'body', path: e.fromPath });
      args[hit[0]] = `{{${v}}}`;
    }
    const key = `${tool.id} ${JSON.stringify(args)}`;
    if (tool.safety === 'read' && seen.has(key)) {
      stepOf.set(c.id, seen.get(key)!);
      continue;
    }
    if (steps.length >= MAX_STEPS) break;
    let json: unknown;
    try {
      json = c.responseBody ? JSON.parse(c.responseBody) : undefined;
    } catch {
      json = undefined;
    }
    steps.push({
      id: `s${steps.length + 1}`,
      toolId: tool.id,
      args,
      saves: [],
      expect: { status: '2xx', ...(json !== undefined && c.status < 400 ? { shape: shapeOf(json) } : {}) },
      // A call that already failed while recording would fail every run
      // for a reason that predates the test: it comes in off, labelled.
      enabled: c.status < 400,
      recorded: { status: c.status, ms: c.ms },
    });
    stepOf.set(c.id, steps.length - 1);
    seen.set(key, steps.length - 1);
  }
  return { id: `sc-${Date.now().toString(36)}`, name, createdAt: new Date().toISOString(), from: `recording of ${ordered.length} calls`, steps };
}

/// `{{var}}`s a step needs that nothing before it saves.
export function unmetVars(scenario: Scenario, index: number): string[] {
  const saved = new Set(scenario.steps.slice(0, index).filter((s) => s.enabled).flatMap((s) => s.saves.map((c) => c.var)));
  const used = [...JSON.stringify(scenario.steps[index].args).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(used.filter((u) => /^s\d+_/.test(u) && !saved.has(u)))];
}

/// Failed while it was being recorded (a 504 from a backend that was down).
export const failedWhenRecorded = (s: ScenarioStep) => (s.recorded?.status ?? 0) >= 400;

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
