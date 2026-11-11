// Running a scenario (shared/scenario.ts): once, as a test — and many times
// at once, as a load test. Both go through callTool, so sign-in, "run
// first" steps and retries on a 401 behave as they do for a person and an
// agent.
//
// Writes are opt-in per step, and only where the environment allows writes
// and isn't production. A load test never writes.

import { applyCaptures } from '../shared/capture';
import { envKind, type EnvDef, type Project } from '../shared/project';
import { compareShape, percentile, unmetVars, type Scenario, type ScenarioRun, type StepResult } from '../shared/scenario';
import { callTool, type CallDeps } from './flow';

export interface RunDeps extends Omit<CallDeps, 'runtime'> {
  /// Writes may run (steps marked as such), where the environment allows.
  allowWrites?: boolean;
  onStep?: (r: StepResult) => void;
  signal?: AbortSignal;
  /// Stop after this step — "replay this step" runs what feeds it, then it.
  until?: string;
}

export function writesAllowed(env: EnvDef, allow?: boolean): boolean {
  return !!allow && env.allowWrites && envKind(env.name) !== 'production';
}

export async function runScenario(project: Project, scenario: Scenario, env: EnvDef, deps: RunDeps): Promise<ScenarioRun> {
  const started = Date.now();
  const runtime: Record<string, string> = {};
  const results: StepResult[] = [];
  const failedSaves = new Set<string>();
  for (let i = 0; i < scenario.steps.length; i++) {
    if (deps.signal?.aborted) break;
    const step = scenario.steps[i];
    if (!step.enabled) continue;
    const tool = project.tools.find((t) => t.id === step.toolId);
    const base: StepResult = { stepId: step.id, name: tool?.name ?? step.toolId, method: tool?.method ?? step.toolId.split(' ')[0], ok: false, problems: [], warnings: [] };
    const done = (r: StepResult) => {
      results.push(r);
      deps.onStep?.(r);
    };
    if (!tool) {
      done({ ...base, problems: [`The request ${step.toolId} is gone from the API.`] });
      continue;
    }
    if (tool.safety !== 'read' && !(step.write && writesAllowed(env, deps.allowWrites))) {
      done({ ...base, skipped: envKind(env.name) === 'production' ? 'changes data — never on production' : step.write ? `changes data — ${env.name} doesn't allow writes` : 'changes data — turn on "Run it" for this step' });
      continue;
    }
    // Values from earlier steps that aren't there: never kept, or an earlier
    // step failed to keep them. Sending `{{s1_id}}` literally helps nobody.
    const usedHere = [...JSON.stringify(step.args).matchAll(/\{\{\s*(s\d+_[A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    const missing = [...new Set([...unmetVars(scenario, i), ...usedHere])].filter((v) => failedSaves.has(v) || runtime[v] === undefined);
    if (missing.length) {
      done({ ...base, skipped: `needs {{${missing[0]}}}, which an earlier step didn't provide` });
      continue;
    }
    try {
      const out = await callTool(project, tool, env, step.args, { ...deps, runtime });
      const r = out.result;
      const res: StepResult = { ...base, url: r.request.url, status: r.status, ms: r.durationMs, ok: true, body: r.body.slice(0, 20_000) };
      const statusOk = step.expect.status === '2xx' ? r.status >= 200 && r.status < 300 : r.status === step.expect.status;
      if (!statusOk) res.problems.push(`answered ${r.status}${r.statusText ? ` ${r.statusText}` : ''}, expected ${step.expect.status}`);
      if (out.hint) res.problems.push(out.hint);
      if (step.expect.maxMs && r.durationMs > step.expect.maxMs) res.problems.push(`took ${r.durationMs} ms, over the ${step.expect.maxMs} ms budget`);
      if (statusOk && step.expect.shape) {
        if (r.json === undefined) res.problems.push('answered something other than JSON');
        else {
          const cmp = compareShape(step.expect.shape, r.json);
          res.problems.push(...cmp.problems);
          res.warnings.push(...cmp.warnings);
        }
      }
      const kept = statusOk ? applyCaptures(step.saves, r.json, r.headers) : {};
      Object.assign(runtime, kept);
      for (const s of step.saves) if (kept[s.var] === undefined) {
        failedSaves.add(s.var);
        if (statusOk) res.warnings.push(`{{${s.var}}} wasn't in the response at ${s.path}`);
      }
      res.ok = res.problems.length === 0;
      done(res);
    } catch (e) {
      for (const s of step.saves) failedSaves.add(s.var);
      done({ ...base, problems: [(e as Error).message] });
    }
    if (deps.until === step.id) break;
  }
  const passed = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  return { scenarioId: scenario.id, env: env.name, at: new Date(started).toISOString(), ms: Date.now() - started, passed, skipped, failed: results.length - passed - skipped, results };
}

// ---- load ---------------------------------------------------------------------

export interface LoadOptions {
  /// Virtual users, each running the scenario's reads in a loop.
  users: number;
  durationSec: number;
  /// Users start evenly over this many seconds.
  rampSec?: number;
}

export interface LoadStep {
  stepId: string;
  name: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /// What went wrong, by kind — "504 Gateway Timeout" ×3 — with a sample of
  /// what the server said the first time.
  failures: { label: string; count: number; sample?: string }[];
}

export interface LoadSnapshot {
  elapsedSec: number;
  done: boolean;
  users: number;
  total: number;
  errors: number;
  /// One point per second: requests finished, errors, latency of that second, users active.
  timeline: { t: number; requests: number; errors: number; p50: number; p95: number; users: number }[];
  /// Across every request so far.
  overall: { p50: number; p95: number; max: number };
  steps: LoadStep[];
  /// Why it stopped early, if it did.
  stopped?: string;
  /// The first few distinct errors.
  sampleErrors: string[];
}

export const LOAD_LIMITS = { users: 100, durationSec: 600 };

export async function runLoad(project: Project, scenario: Scenario, env: EnvDef, deps: Omit<CallDeps, 'runtime'> & { signal?: AbortSignal; onTick?: (s: LoadSnapshot) => void }, opts: LoadOptions): Promise<LoadSnapshot> {
  const users = Math.max(1, Math.min(LOAD_LIMITS.users, Math.round(opts.users)));
  const duration = Math.max(1, Math.min(LOAD_LIMITS.durationSec, opts.durationSec));
  const ramp = Math.max(0, Math.min(duration, opts.rampSec ?? 0));
  const steps = scenario.steps
    .map((s, i) => ({ s, i, tool: project.tools.find((t) => t.id === s.toolId) }))
    .filter((x) => x.s.enabled && x.tool && x.tool.safety === 'read');
  if (!steps.length) throw new Error('This scenario has no reads to load-test. Load tests never send writes.');

  const started = Date.now();
  const end = started + duration * 1000;
  const samples = new Map<string, { ms: number[]; errors: number }>();
  const kinds = new Map<string, Map<string, { count: number; sample?: string }>>();
  const buckets: { requests: number; errors: number; ms: number[]; users: number }[] = [];
  const all: number[] = [];
  const bucket = (sec: number) => {
    while (buckets.length <= sec) buckets.push({ requests: 0, errors: 0, ms: [], users: active });
    buckets[sec].users = Math.max(buckets[sec].users, active);
    return buckets[sec];
  };
  const sampleErrors = new Set<string>();
  let total = 0;
  let errors = 0;
  let active = 0;
  let over = false;
  const record = (stepId: string, ms: number, ok: boolean, err?: string, kind?: string, body?: string) => {
    if (!ok && kind) {
      const byKind = kinds.get(stepId) ?? new Map<string, { count: number; sample?: string }>();
      const k = byKind.get(kind) ?? { count: 0, sample: body ? body.slice(0, 1500) : undefined };
      k.count++;
      byKind.set(kind, k);
      kinds.set(stepId, byKind);
    }
    if (over) return;
    const s = samples.get(stepId) ?? { ms: [], errors: 0 };
    s.ms.push(ms);
    if (!ok) s.errors++;
    samples.set(stepId, s);
    const b = bucket(Math.floor((Date.now() - started) / 1000));
    b.requests++;
    b.ms.push(ms);
    all.push(ms);
    if (!ok) b.errors++;
    total++;
    if (!ok) {
      errors++;
      if (err && sampleErrors.size < 5) sampleErrors.add(err);
    }
  };
  const snapshot = (done: boolean, stopped?: string): LoadSnapshot => ({
    elapsedSec: Math.min(duration, (Date.now() - started) / 1000),
    done,
    users: active,
    total,
    errors,
    stopped,
    sampleErrors: [...sampleErrors],
    timeline: buckets.map((b, t) => {
      const s = [...b.ms].sort((x, y) => x - y);
      return { t, requests: b.requests, errors: b.errors, p50: percentile(s, 50), p95: percentile(s, 95), users: b.users };
    }),
    overall: (() => {
      const s = [...all].sort((x, y) => x - y);
      return { p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1] ?? 0 };
    })(),
    steps: steps.map(({ s, tool }) => {
      const x = samples.get(s.id) ?? { ms: [], errors: 0 };
      const sorted = [...x.ms].sort((a, b) => a - b);
      const failures = [...(kinds.get(s.id)?.entries() ?? [])].map(([label, v]) => ({ label, count: v.count, sample: v.sample })).sort((a, b) => b.count - a.count);
      return { stepId: s.id, name: tool!.name, count: sorted.length, errors: x.errors, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] ?? 0, failures };
    }),
  });

  const vu = async (n: number) => {
    await sleep(ramp ? (ramp * 1000 * n) / users : 0, deps.signal);
    active++;
    const runtime: Record<string, string> = {};
    while (Date.now() < end && !deps.signal?.aborted) {
      for (const { s, i, tool } of steps) {
        if (Date.now() >= end || deps.signal?.aborted) break;
        if (unmetVars(scenario, i).some((v) => runtime[v] === undefined)) continue;
        const t0 = Date.now();
        // No request outlives the test by more than a moment.
        const timeoutMs = Math.max(1000, Math.min(deps.timeoutMs ?? 30_000, end - t0 + 2000));
        try {
          const out = await callTool(project, tool!, env, s.args, { ...deps, runtime, timeoutMs });
          const ok = out.result.status >= 200 && out.result.status < 400;
          record(s.id, out.result.durationMs, ok, ok ? undefined : `${tool!.name}: ${out.result.status} ${out.result.statusText}`.trim(), `${out.result.status} ${out.result.statusText}`.trim(), out.result.body);
          if (ok) Object.assign(runtime, applyCaptures(s.saves, out.result.json, out.result.headers));
        } catch (e) {
          const msg = (e as Error).message;
          // "Could not reach x: no answer after 21 s." → one kind, whatever the host.
          record(s.id, Date.now() - t0, false, `${tool!.name}: ${msg}`, msg.replace(/^Could not reach \S+: /, '').replace(/\.$/, ''));
        }
      }
    }
    active--;
  };

  const ticker = setInterval(() => {
    bucket(Math.floor((Date.now() - started) / 1000));
    deps.onTick?.(snapshot(false));
  }, 1000);
  try {
    // Ends on time even if a request hangs; what comes back late is ignored.
    await Promise.race([Promise.all(Array.from({ length: users }, (_, n) => vu(n))), sleep(duration * 1000 + 3000, deps.signal)]);
  } finally {
    clearInterval(ticker);
  }
  over = true;
  const final = snapshot(true, deps.signal?.aborted ? 'stopped' : undefined);
  deps.onTick?.(final);
  return final;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!ms || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
