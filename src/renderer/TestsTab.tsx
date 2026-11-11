import { isPrivateHost, PUBLIC_LOAD_LIMITS } from '@shared/network';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { Empty, EnvChip, Method, SubTabs, Toggle } from './ui';
import { Icon } from './icons';
import { BodyView, JsonView } from './JsonView';
import { envKind, groupOf, type HttpMethod } from '@shared/project';
import { addStep, emptyScenario } from '@shared/wire';
import { failedWhenRecorded, shapeExample, shapeOf, type Scenario, type ScenarioRun, type ScenarioStep, type StepResult } from '@shared/scenario';
import type { LoadSnapshotDto } from '@shared/ipc';

/// Tests: recorded flows run again. A scenario is the API's own requests in
/// the order they were used, ids passed along from earlier responses, each
/// checked for status and shape. Run it once as a test, or many times at
/// once as a load test.
export function TestsTab(): JSX.Element {
  const { project, path, env: envName, update, say, recorder, setTab } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const scenarios = p.scenarios ?? [];
  const [selected, setSelected] = useState<string | undefined>(scenarios[0]?.id);
  const [runs, setRuns] = useState<Record<string, ScenarioRun>>({});
  const [busy, setBusy] = useState(false);
  const sc = scenarios.find((s) => s.id === selected) ?? scenarios[0];
  const recording = recorder.projectPath === path && recorder.count > 0;

  useEffect(() => {
    void window.overapi.invoke('scenario:runs', path!).then(setRuns);
  }, [path]);

  const fromRecording = async () => {
    setBusy(true);
    const name = `Recorded ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const r = await window.overapi.invoke('scenario:fromRecording', path!, name);
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    update((x) => ({ ...x, scenarios: [...(x.scenarios ?? []), r.scenario] }));
    setSelected(r.scenario.id);
    say(`Saved ${r.scenario.steps.length} steps as a test. Run it to see where ${p.title} stands.`);
  };

  const newTest = () => {
    const sc = emptyScenario('New test', envName);
    update((x) => ({ ...x, scenarios: [...(x.scenarios ?? []), sc] }));
    setSelected(sc.id);
  };

  if (!scenarios.length) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-rule bg-surface p-6 text-[13px]">
          <h2 className="display text-[20px] font-semibold">Tests from real traffic</h2>
          <p className="mt-2 leading-relaxed text-ink-muted">
            Record yourself using {p.title}, then save it as a test. overapi keeps the requests in order, passes ids from one response into the next request, and checks
            each answer’s status and shape — so it keeps working next week, when the data has moved on. Run it before you publish, from CI with{' '}
            <span className="font-mono text-[12px]">overapi test</span>, or many at once as a load test.
          </p>
          <div className="mt-4 flex gap-2">
            {recording ? (
              <button className="btn-primary" disabled={busy} onClick={() => void fromRecording()}>
                Save the current recording as a test
              </button>
            ) : (
              <button className="btn-primary" onClick={() => setTab('traffic')}>
                Record traffic
              </button>
            )}
            <button className="btn" onClick={newTest}>
              Build one step by step
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-rule">
        <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Scenarios</span>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2">
          {scenarios.map((s) => {
            const run = runs[s.id];
            return (
              <button key={s.id} onClick={() => setSelected(s.id)} className={`mb-px flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${s.id === sc?.id ? 'bg-wash-strong' : 'hover:bg-wash'}`}>
                <RunDot run={run} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{s.name}</span>
                  <span className="block text-[11px] text-ink-faint">
                    {s.steps.length} steps · {run ? `${run.failed ? `${run.failed} failing` : `${run.passed}/${run.passed + run.failed} passing`} on ${run.env} · ${ago(run.at)}` : 'not run'}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="space-y-1.5 border-t border-rule p-2">
          <button className="btn h-8 w-full" onClick={newTest} title="An empty test to add requests to, one step at a time">
            <Icon name="plus" size={14} /> New test
          </button>
          <button className="btn h-8 w-full" disabled={busy || !recording} title={recording ? 'Save what’s been recorded for this API as a new scenario' : 'Record traffic for this API first'} onClick={() => void fromRecording()}>
            <Icon name="plus" size={14} /> From the recording
          </button>
        </div>
      </aside>
      {sc && env ? (
        <ScenarioView
          key={sc.id}
          sc={sc}
          run={runs[sc.id]}
          onRun={(r) => setRuns((x) => ({ ...x, [sc.id]: r }))}
          onDelete={() => {
            update((x) => ({ ...x, scenarios: (x.scenarios ?? []).filter((s) => s.id !== sc.id) }));
            setSelected(undefined);
          }}
        />
      ) : (
        <Empty>Pick a scenario.</Empty>
      )}
    </div>
  );
}

type Outcome = 'pass' | 'fail' | 'off' | 'skip' | 'none' | 'running';

function outcomeOf(st: ScenarioStep, r: StepResult | undefined, running: boolean): Outcome {
  if (!st.enabled) return 'off';
  if (!r) return running ? 'running' : 'none';
  if (r.skipped) return 'skip';
  return r.ok ? 'pass' : 'fail';
}

/// The worst of several (a folded row stands for all its variants).
function worst(xs: Outcome[]): Outcome {
  for (const o of ['fail', 'running', 'skip', 'pass', 'none'] as const) if (xs.includes(o)) return o;
  return 'off';
}

const OUTCOME: Record<Outcome, { label: string; tone: string; icon: 'check' | 'x' | 'alert' | 'history' | null }> = {
  pass: { label: 'Passed', tone: 'text-good', icon: 'check' },
  fail: { label: 'Failed', tone: 'text-bad', icon: 'x' },
  off: { label: 'Off', tone: 'text-ink-faint', icon: null },
  skip: { label: 'Skipped', tone: 'text-ink-faint', icon: null },
  none: { label: 'Not run', tone: 'text-ink-faint', icon: null },
  running: { label: 'Running', tone: 'text-accent', icon: 'history' },
};

const msText = (n?: number) => (n === undefined ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

function ScenarioView({ sc, run, onRun, onDelete }: { sc: Scenario; run?: ScenarioRun; onRun: (r: ScenarioRun) => void; onDelete: () => void }): JSX.Element {
  const { project, path, env: envName, update, say, settings } = useStore();
  // Behind a setting (Settings › General): off, there's no way in.
  const load = !!settings?.loadTesting;
  const p = project!;
  // Runs where it was recorded (or where the person last ran it), not
  // wherever the top bar happens to point.
  const env = p.envs.find((e) => e.name === sc.env) ?? p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [view, setView] = useState<'steps' | 'load'>('steps');
  const [writes, setWrites] = useState(false);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<Record<string, StepResult>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<'all' | 'fail' | 'off'>('all');
  const [layout, setLayout] = useState<'area' | 'order'>('area');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const prod = envKind(env.name) === 'production';
  const canWrite = env.allowWrites && !prod;

  const set = (fn: (s: Scenario) => Scenario) => update((x) => ({ ...x, scenarios: (x.scenarios ?? []).map((s) => (s.id === sc.id ? fn(s) : s)) }));
  const setStep = (id: string, fn: (s: ScenarioStep) => ScenarioStep) => set((s) => ({ ...s, steps: s.steps.map((st) => (st.id === id ? fn(st) : st)) }));

  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type === 'scenario:step' && e.scenarioId === sc.id) setLive((x) => ({ ...x, [e.result.stepId]: e.result }));
      }),
    [sc.id],
  );

  const saved: Record<string, StepResult> = Object.fromEntries((run?.results ?? []).map((r) => [r.stepId, r]));
  const results: Record<string, StepResult> = running ? live : saved;
  const outcomes = Object.fromEntries(sc.steps.map((st) => [st.id, outcomeOf(st, results[st.id], running)])) as Record<string, Outcome>;
  const count = (o: Outcome) => Object.values(outcomes).filter((x) => x === o).length;
  const stale = sc.steps.filter((st) => st.enabled && failedWhenRecorded(st) && !st.included);

  const go = async (until?: string) => {
    setRunning(true);
    setLive({});
    const r = await window.overapi.invoke('scenario:run', path!, p, sc.id, env.name, writes && canWrite, until);
    setRunning(false);
    if (!r.ok) return say(r.error, true);
    if (until) {
      // One step replayed: fold its result (and what fed it) into the last run.
      const merged = new Map((run?.results ?? []).map((x) => [x.stepId, x]));
      for (const x of r.run.results) merged.set(x.stepId, x);
      const results = sc.steps.map((s) => merged.get(s.id)).filter((x): x is StepResult => !!x);
      const passed = results.filter((x) => x.ok).length;
      const skipped = results.filter((x) => x.skipped).length;
      onRun({ ...(run ?? r.run), results, passed, skipped, failed: results.length - passed - skipped });
      const mine = r.run.results.find((x) => x.stepId === until);
      return say(mine ? (mine.ok ? `${mine.name} passed this time.` : `${mine.name}: ${mine.skipped ?? mine.problems[0] ?? 'failed'}`) : 'Replayed.', !!mine && !mine.ok);
    }
    onRun(r.run);
    say(r.run.failed ? `${r.run.failed} step${r.run.failed === 1 ? '' : 's'} failed on ${env.name}.` : `All ${r.run.passed} steps passed on ${env.name}.`, r.run.failed > 0);
  };

  // Rows: by area with repeats folded, or flat in run order.
  const visible = (st: ScenarioStep) => filter === 'all' || outcomes[st.id] === filter;
  const groups = useMemo(() => {
    const out = new Map<string, { st: ScenarioStep; i: number }[][]>();
    sc.steps.forEach((st, i) => {
      const tool = p.tools.find((t) => t.id === st.toolId);
      const g = layout === 'order' ? 'In run order' : tool ? groupOf(tool) : 'missing requests';
      const rows = out.get(g) ?? [];
      const same = layout === 'area' ? rows.find((r) => r[0].st.toolId === st.toolId) : undefined;
      if (same) same.push({ st, i });
      else rows.push([{ st, i }]);
      out.set(g, rows);
    });
    return [...out.entries()];
  }, [sc.steps, p.tools, layout]);

  const total = sc.steps.length;
  const seg = (n: number, cls: string, label: string) => (n ? <span className={cls} style={{ flex: n }} title={`${n} ${label}`} /> : null);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-5 pb-2 pt-4">
        <input className="display min-w-[240px] flex-1 bg-transparent text-[22px] font-semibold outline-none" value={sc.name} onChange={(e) => set((s) => ({ ...s, name: e.target.value }))} aria-label="Scenario name" />
        <label className="flex items-center gap-2 text-[12px] text-ink-muted" title="Where this test runs — remembered for this scenario">
          Run on
          <select className="field w-auto py-1 text-[12px]" value={env.name} onChange={(e) => set((x) => ({ ...x, env: e.target.value }))} aria-label="Environment to run on">
            {p.envs.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name} — {e.baseUrl.replace(/^https?:\/\//, '') || 'no base URL'}
              </option>
            ))}
          </select>
        </label>
        <label className={`flex items-center gap-2 text-[12px] text-ink-muted ${canWrite ? '' : 'opacity-50'}`} title={canWrite ? 'Steps marked “Run it” that change data will run' : prod ? 'Never on production' : `${env.name} doesn’t allow writes — turn it on in Environments`}>
          <Toggle on={writes && canWrite} onChange={setWrites} disabled={!canWrite} /> Run writes
        </label>
        <button className="btn-primary" disabled={running} onClick={() => void go()}>
          <Icon name="send" size={13} /> {running ? 'Running…' : 'Run'}
        </button>
        {confirmDelete ? (
          <button className="btn text-bad" onClick={onDelete} onBlur={() => setConfirmDelete(false)} autoFocus>
            Delete it?
          </button>
        ) : (
          <button className="icon-btn" title="Delete this scenario" aria-label="Delete this scenario" onClick={() => setConfirmDelete(true)}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div className="px-3">
        <SubTabs
          tabs={[{ id: 'steps', label: `Steps ${total}` }, ...(load ? [{ id: 'load' as const, label: 'Load test' }] : [])]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === 'load' && load ? (
        <LoadView sc={sc} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          {/* The last run at a glance. */}
          <section className="mx-5 mt-3 space-y-2.5 rounded-xl border border-rule bg-surface p-4" aria-label="Last run">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className={`text-[15px] font-semibold ${count('fail') ? 'text-bad' : run ? 'text-good' : 'text-ink-muted'}`}>
                {running ? 'Running…' : count('fail') ? `${count('fail')} failed` : run ? 'All passed' : 'Not run yet'}
              </span>
              <span className="text-[12px] text-ink-muted">
                {count('pass')} passed · {count('off')} off{sc.steps.some((s) => !s.enabled && failedWhenRecorded(s)) ? ' (failed when recorded)' : ''} · {count('skip')} skipped
                {count('none') ? ` · ${count('none')} not run` : ''}
              </span>
              {run && !running && (
                <span className="ml-auto text-[12px] text-ink-faint">
                  {run.env} · {(run.ms / 1000).toFixed(1)} s · {ago(run.at)}
                </span>
              )}
            </div>
            <div className="flex h-2 gap-[2px] overflow-hidden rounded" role="img" aria-label={`${count('pass')} passed, ${count('fail')} failed, ${count('off')} off, ${count('skip') + count('none')} skipped or not run`}>
              {seg(count('pass'), 'bg-good', 'passed')}
              {seg(count('fail'), 'bg-bad', 'failed')}
              {seg(count('running'), 'bg-accent/60', 'running')}
              {seg(count('off'), 'bg-wash-strong', 'off')}
              {seg(count('skip') + count('none'), 'bg-rule', 'skipped or not run')}
            </div>
            <div className="flex flex-wrap gap-4 text-[11px] text-ink-muted">
              {(
                [
                  ['bg-good', 'Passed'],
                  ['bg-bad', 'Failed'],
                  ['bg-wash-strong', 'Off'],
                  ['bg-rule', 'Skipped / not run'],
                ] as const
              ).map(([c, l]) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-sm ${c}`} />
                  {l}
                </span>
              ))}
            </div>
          </section>

          {stale.length > 0 && (
            <div className="mx-5 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]">
              <span className="flex-1">
                {stale.length} step{stale.length === 1 ? '' : 's'} already failed while you recorded {stale.length === 1 ? 'it' : 'them'} ({[...new Set(stale.map((s) => s.recorded!.status))].join(', ')}) — {stale.length === 1 ? 'it' : 'they'}’ll fail every run for that reason.
              </span>
              <button className="btn" onClick={() => set((s) => ({ ...s, steps: s.steps.map((x) => (stale.includes(x) ? { ...x, enabled: false } : x)) }))}>
                Turn {stale.length === 1 ? 'it' : 'them'} off
              </button>
            </div>
          )}
          <SignInHint run={run} running={running} />

          <div className="flex flex-wrap items-center gap-2 px-5 pb-1.5 pt-3">
            {(
              [
                ['all', `All ${total}`],
                ['fail', `Failed ${count('fail')}`],
                ['off', `Off ${count('off')}`],
              ] as const
            ).map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)} aria-pressed={filter === id} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${filter === id ? 'border-transparent bg-wash-strong text-ink' : id === 'fail' && count('fail') ? 'border-bad/40 text-bad' : 'border-rule text-ink-muted hover:text-ink'}`}>
                {label}
              </button>
            ))}
            <span className="flex-1" />
            <div className="flex rounded-md border border-rule p-0.5 text-[12px]" role="tablist" aria-label="Arrange steps">
              {(
                [
                  ['area', 'By area'],
                  ['order', 'Run order'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={layout === id} onClick={() => setLayout(id)} className={`rounded px-2 py-0.5 ${layout === id ? 'bg-wash-strong text-ink' : 'text-ink-muted hover:text-ink'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5 px-5">
            {groups.map(([g, rows]) => {
              const shown = rows.map((r) => r.filter((x) => visible(x.st))).filter((r) => r.length);
              if (!shown.length) return null;
              const os = rows.flat().map((x) => outcomes[x.st.id]);
              const fails = os.filter((o) => o === 'fail').length;
              const passes = os.filter((o) => o === 'pass').length;
              const offs = os.filter((o) => o === 'off').length;
              return (
                <section key={g} className="overflow-hidden rounded-xl border border-rule">
                  <div className="flex items-center gap-2.5 bg-surface px-3.5 py-2">
                    <span className="font-semibold">{g}</span>
                    <span className="text-[12px] text-ink-faint">
                      {rows.flat().length} step{rows.flat().length === 1 ? '' : 's'}
                      {rows.some((r) => r.length > 1) ? ' · repeats folded' : ''}
                    </span>
                    <span className={`ml-auto text-[12px] ${fails ? 'text-bad' : passes ? 'text-good' : 'text-ink-faint'}`}>
                      {[fails && `${fails} failed`, passes && `${passes} passed`, offs && `${offs} off`].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {shown.map((items) => {
                    const head = items[0];
                    const folded = items.length > 1 && !unfolded[head.st.id];
                    if (folded) {
                      const o = worst(items.map((x) => outcomes[x.st.id]));
                      return (
                        <StepRow
                          key={head.st.id}
                          outcome={o}
                          st={head.st}
                          n={head.i + 1}
                          variants={items.length}
                          r={items.map((x) => results[x.st.id]).find((x) => x && !x.ok) ?? results[head.st.id]}
                          onClick={() => setUnfolded((u) => ({ ...u, [head.st.id]: true }))}
                        />
                      );
                    }
                    return items.map(({ st, i }, k) => (
                      <div key={st.id}>
                        <StepRow
                          outcome={outcomes[st.id]}
                          st={st}
                          n={i + 1}
                          r={results[st.id]}
                          variantOf={items.length > 1 ? `${k + 1} of ${items.length}` : undefined}
                          onClick={() => setOpen(open === st.id ? null : st.id)}
                          onInclude={() => setStep(st.id, (s) => ({ ...s, enabled: true, included: true }))}
                          setStep={(fn) => setStep(st.id, fn)}
                        />
                        {open === st.id && (
                          <StepDetail
                            st={st}
                            r={results[st.id]}
                            setStep={(fn) => setStep(st.id, fn)}
                            move={(d) => set((s) => ({ ...s, steps: moveItem(s.steps, i, d) }))}
                            remove={() => set((s) => ({ ...s, steps: s.steps.filter((x) => x.id !== st.id) }))}
                            replay={() => void go(st.id)}
                            replaying={running}
                          />
                        )}
                      </div>
                    ));
                  })}
                </section>
              );
            })}
            <AddStepRow sc={sc} onAdd={(next, wired, name) => {
              set(() => next);
              say(`Added ${name} as step ${next.steps.length}${wired.length ? ` — ${wired.join(', ')}` : ''}.`);
            }} />
          </div>
        </div>
      )}
    </div>
  );
}

/// The next step, picked from the API's requests. Its arguments are wired to
/// earlier steps where the names fit; send it once and "Accept the new
/// shape" to start checking what it answers.
function AddStepRow({ sc, onAdd }: { sc: Scenario; onAdd: (next: Scenario, wired: string[], name: string) => void }): JSX.Element {
  const { project } = useStore();
  const p = project!;
  const [pick, setPick] = useState('');
  const tools = [...p.tools].sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || a.name.localeCompare(b.name));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-rule px-3.5 py-2.5 text-[12px]">
      <Icon name="plus" size={13} className="text-ink-faint" />
      <span className="text-ink-muted">{sc.steps.length ? 'Then' : 'First'}</span>
      <select className="field w-auto min-w-[280px] py-1 text-[12px]" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Request to add">
        <option value="">pick a request…</option>
        {tools.map((t) => (
          <option key={t.id} value={t.id}>
            {t.method} {t.name} — {t.path}
          </option>
        ))}
      </select>
      <button
        className="btn"
        disabled={!pick}
        onClick={() => {
          const t = p.tools.find((x) => x.id === pick);
          if (!t) return;
          const { scenario, wired } = addStep(p, sc, t);
          setPick('');
          onAdd(scenario, wired, t.name);
        }}
      >
        Add step
      </button>
      <span className="text-ink-faint">Arguments are taken from earlier steps where the names fit. Or send a request in Requests and use “Add to test”.</span>
    </div>
  );
}

/// Steps refused for want of a sign-in, or nothing answering at all.
function SignInHint({ run, running }: { run?: ScenarioRun; running: boolean }): JSX.Element | null {
  const { project, setTab } = useStore();
  const env = project!.envs.find((e) => e.name === run?.env) ?? project!.envs[0];
  if (!run || running) return null;
  const refused = run.results.filter((r) => r.status === 401 || r.status === 403).length;
  const ran = run.results.filter((r) => !r.skipped);
  const unreachable = ran.filter((r) => r.status === undefined).length;
  const noSignIn = env.auth.type === 'none' && !env.browserSession && !Object.keys(env.headers ?? {}).some((h) => /^(authorization|cookie)$/i.test(h));
  if (refused >= 2 && noSignIn)
    return (
      <div className="mx-5 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]">
        <span className="flex-1">
          {refused} steps were refused (401/403) — <b>{env.name}</b> has no sign-in. Tests sign in the way requests do: set one up in Environments (a browser sign-in works for a web app).
        </span>
        <button className="btn" onClick={() => setTab('envs')}>
          Set up sign-in
        </button>
      </div>
    );
  if (unreachable >= 2 && unreachable === ran.length)
    return <div className="mx-5 mt-3 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-[12px] text-bad">Nothing answered at {env.baseUrl}: {ran.find((r) => r.problems.length)?.problems[0]}</div>;
  return null;
}

function StepRow({
  outcome,
  st,
  n,
  r,
  variants,
  variantOf,
  onClick,
  onInclude,
  setStep,
}: {
  outcome: Outcome;
  st: ScenarioStep;
  n: number;
  r?: StepResult;
  variants?: number;
  variantOf?: string;
  onClick: () => void;
  onInclude?: () => void;
  setStep?: (fn: (s: ScenarioStep) => ScenarioStep) => void;
}): JSX.Element {
  const { project } = useStore();
  const tool = project!.tools.find((t) => t.id === st.toolId);
  const o = OUTCOME[outcome];
  const over = r?.problems.some((x) => /budget/.test(x));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={`flex cursor-pointer items-center gap-3 border-t border-rule px-3.5 py-2 hover:bg-wash ${outcome === 'fail' ? 'bg-bad/[0.04]' : ''} ${outcome === 'off' ? 'opacity-75' : ''}`}
    >
      <span className={`flex w-[74px] shrink-0 items-center gap-1.5 text-[12px] font-semibold ${o.tone}`}>
        {o.icon ? <Icon name={o.icon} size={13} /> : <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-current" aria-hidden />}
        {o.label}
      </span>
      <span className="w-6 shrink-0 text-right font-mono text-[10px] text-ink-faint">{n}</span>
      <Method method={(tool?.method ?? 'GET') as HttpMethod} />
      <span className="w-[200px] min-w-0 shrink-0 truncate text-[13px]">
        {tool?.name ?? <span className="text-bad">{st.toolId} (gone)</span>}
        {variantOf && <span className="ml-1.5 text-[11px] text-ink-faint">{variantOf}</span>}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
        {variants ? <span className="mr-2 text-ink">{variants} variants</span> : null}
        <Args args={st.args} />
        {st.saves.map((s) => (
          <span key={s.var} className="ml-2 rounded bg-accent/15 px-1 text-accent">
            → {`{{${s.var}}}`}
          </span>
        ))}
      </span>
      {outcome === 'off' && !variants ? (
        <>
          {failedWhenRecorded(st) ? (
            <span className="shrink-0 rounded-md border border-warn/40 px-2 py-0.5 text-[11px] text-warn">{st.recorded!.status} when recorded</span>
          ) : (
            <span className="shrink-0 text-[11px] text-ink-faint">turned off</span>
          )}
          <button
            className="btn !px-2.5 !py-0.5 text-[12px]"
            onClick={(e) => {
              e.stopPropagation();
              onInclude?.();
            }}
          >
            Include
          </button>
        </>
      ) : (
        <>
          {tool && tool.safety !== 'read' && setStep && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-warn" onClick={(e) => e.stopPropagation()}>
              changes data <Toggle on={!!st.write} onChange={(v) => setStep((s) => ({ ...s, write: v }))} label="Run it" />
            </span>
          )}
          <span className={`w-[150px] shrink-0 text-right text-[11px] tabular-nums ${over ? 'text-warn' : 'text-ink-faint'}`} title={r?.skipped}>
            {r?.skipped ? r.skipped : r ? `${st.recorded ? `${msText(st.recorded.ms)} → ` : ''}${r.status === undefined ? 'no answer' : msText(r.ms)}${over ? ' · over budget' : ''}` : st.recorded ? `recorded ${msText(st.recorded.ms)}` : ''}
          </span>
          <span className={`w-11 shrink-0 rounded-md py-0.5 text-center font-mono text-[11px] font-semibold ${!r || r.skipped ? 'text-ink-faint' : r.ok ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad'}`}>{r && !r.skipped ? (r.status ?? '—') : ''}</span>
        </>
      )}
    </div>
  );
}

/// A step opened: what went wrong first, then recorded against now, then
/// what to do about it. Editing sits underneath.
function StepDetail({ st, r, setStep, move, remove, replay, replaying }: { st: ScenarioStep; r?: StepResult; setStep: (fn: (s: ScenarioStep) => ScenarioStep) => void; move: (d: -1 | 1) => void; remove: () => void; replay: () => void; replaying: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [args, setArgs] = useState(JSON.stringify(st.args, null, 2));
  const [argsError, setArgsError] = useState('');
  const lastJson = useMemo(() => {
    try {
      return r?.body ? JSON.parse(r.body) : undefined;
    } catch {
      return undefined;
    }
  }, [r?.body]);
  return (
    <div className="space-y-3 border-t border-rule bg-wash px-3.5 py-4 pl-[100px] text-[12px]">
      {r?.skipped && <p className="rounded-lg bg-wash-strong px-3 py-2 text-ink-muted">Skipped: {r.skipped}</p>}
      {r && r.problems.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-bad/10 px-3 py-2.5 text-bad">
          {r.problems.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {r && r.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-warn/10 px-3 py-2 text-warn">
          {r.warnings.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {!r && <p className="text-ink-faint">Not run yet{st.recorded ? ` — recorded ${st.recorded.status} in ${msText(st.recorded.ms)}` : ''}.</p>}
      {(st.expect.shape || r?.body) && (
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0 rounded-lg border border-rule p-3">
            <div className="label">Recorded{st.recorded ? ` · ${st.recorded.status} in ${msText(st.recorded.ms)}` : ''}</div>
            <div className="max-h-72 overflow-auto">{st.expect.shape ? <JsonView text={JSON.stringify(shapeExample(st.expect.shape))} /> : <p className="text-ink-faint">No shape kept — any answer passes.</p>}</div>
          </div>
          <div className={`min-w-0 rounded-lg border p-3 ${r && !r.ok && !r.skipped ? 'border-bad/40' : 'border-rule'}`}>
            <div className="label">Now{r?.status !== undefined ? ` · ${r.status} in ${msText(r.ms)}` : ''}</div>
            {r?.url && <p className="mb-1 truncate font-mono text-[10px] text-ink-faint">{r.url}</p>}
            <div className="max-h-72 overflow-auto">{r?.body ? <JsonView text={r.body} /> : <p className="text-ink-faint">{r ? 'No body.' : 'Run it to see.'}</p>}</div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {lastJson !== undefined && r && !r.ok && (
          <button className="btn" title="The API changed on purpose: check this shape from now on" onClick={() => setStep((s) => ({ ...s, expect: { ...s.expect, shape: shapeOf(lastJson) } }))}>
            Accept the new shape
          </button>
        )}
        <button className="btn" onClick={() => setEditing((x) => !x)}>
          {editing ? 'Done editing' : 'Edit step'}
        </button>
        <button className="btn" disabled={replaying || !st.enabled} title="Runs the steps that feed this one, then it" onClick={replay}>
          <Icon name="send" size={12} /> Replay this step
        </button>
      </div>
      {editing && (
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-rule bg-surface p-3">
          <div>
            <label className="label">Arguments</label>
            <textarea
              className="field h-28 font-mono text-[11px]"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              onBlur={() => {
                try {
                  const v = JSON.parse(args || '{}');
                  setArgsError('');
                  setStep((s) => ({ ...s, args: v }));
                } catch (e) {
                  setArgsError((e as Error).message);
                }
              }}
            />
            {argsError ? <p className="mt-1 text-bad">{argsError}</p> : <p className="mt-1 text-ink-faint">{'{{s1_id}}'}-style values come from an earlier step’s response, this run.</p>}
            {st.saves.length > 0 && (
              <div className="mt-2 space-y-0.5 font-mono text-[11px]">
                {st.saves.map((s) => (
                  <div key={s.var}>
                    <span className="text-accent">{`{{${s.var}}}`}</span> <span className="text-ink-faint">← {s.from} {s.path}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <div>
                <label className="label">Expect status</label>
                <input
                  className="field w-24 font-mono"
                  value={String(st.expect.status)}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setStep((s) => ({ ...s, expect: { ...s.expect, status: /^\d{3}$/.test(v) ? Number(v) : '2xx' } }));
                  }}
                />
              </div>
              <div>
                <label className="label">Time budget (ms)</label>
                <input className="field w-28 font-mono" type="number" placeholder="none" value={st.expect.maxMs ?? ''} onChange={(e) => setStep((s) => ({ ...s, expect: { ...s.expect, maxMs: Number(e.target.value) || undefined } }))} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {st.expect.shape && (
                <button className="btn" onClick={() => setStep((s) => ({ ...s, expect: { ...s.expect, shape: undefined } }))}>
                  Stop checking shape
                </button>
              )}
              <button className="btn" onClick={() => setStep((s) => ({ ...s, enabled: false, included: false }))}>
                Turn off
              </button>
              <button className="icon-btn" title="Move up" aria-label="Move up" onClick={() => move(-1)}>
                ↑
              </button>
              <button className="icon-btn" title="Move down" aria-label="Move down" onClick={() => move(1)}>
                ↓
              </button>
              <button className="btn text-bad" onClick={remove}>
                Remove step
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- load -----------------------------------------------------------------------

/// The last load test per scenario, kept while the app is open — so leaving
/// the tab and coming back still shows it.
const lastLoads = new Map<string, { snap: LoadSnapshotDto; at: string; env: string; users: number; duration: number }>();

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2).replace(/\.?0+$/, '')} s` : `${Math.round(ms)} ms`);

interface Verdict {
  tone: 'good' | 'warn' | 'bad';
  title: string;
  text: string;
  /// From this second on it was struggling, if it was.
  degradedAt?: number;
}

/// What happened, in a sentence, from the numbers: did it hold up, when did
/// it stop holding up, and where did the errors come from.
function verdictOf(snap: LoadSnapshotDto, ctx: { users: number; duration: number; reads: number; env: string; ramp: number }): Verdict {
  const tl = snap.timeline.filter((x) => x.t < Math.ceil(snap.elapsedSec));
  const peak = tl.reduce((m, x) => (x.requests > m.requests ? x : m), tl[0] ?? { t: 0, requests: 0 });
  // Steady state: after the ramp, the typical p95 and throughput.
  const steady = tl.filter((x) => x.t >= Math.min(ctx.ramp, tl.length / 3) && x.requests > 0);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const baseP95 = median(steady.slice(0, Math.max(3, Math.floor(steady.length / 2))).map((x) => x.p95));
  const baseRps = median(steady.slice(0, Math.max(3, Math.floor(steady.length / 2))).map((x) => x.requests));
  // Degraded from the first second after which latency stays well above
  // normal, or throughput collapses, for the rest of the run (bar a blip).
  let degradedAt: number | undefined;
  for (let i = Math.max(1, Math.ceil(ctx.ramp)); i < tl.length - 1; i++) {
    const rest = tl.slice(i);
    const bad = rest.filter((x) => (baseP95 && x.p95 > baseP95 * 3) || (baseRps && x.requests < baseRps * 0.3)).length;
    if (rest.length >= 3 && bad / rest.length >= 0.7) {
      degradedAt = i;
      break;
    }
  }
  const failingSteps = snap.steps.filter((s) => s.errors > 0);
  const slowest = [...snap.steps].sort((a, b) => b.p95 - a.p95)[0];
  const rate = snap.total ? snap.errors / snap.total : 0;
  const parts = [`${ctx.users} user${ctx.users === 1 ? '' : 's'} ran the ${ctx.reads} read${ctx.reads === 1 ? '' : 's'} in a loop on ${ctx.env} for ${Math.round(snap.elapsedSec)} s.`];
  parts.push(`Throughput peaked at ${peak.requests}/s${degradedAt !== undefined ? `, then fell as ${slowest?.name ?? 'requests'} began taking ${secs(slowest?.p95 ?? 0)}.` : ` at ${peak.t} s.`}`);
  if (snap.errors) parts.push(`${failingSteps.length === 1 ? 'All' : 'The'} ${snap.errors} error${snap.errors === 1 ? '' : 's'} came from ${failingSteps.length} request${failingSteps.length === 1 ? '' : 's'} — the rest answered every time.`);
  else parts.push('Every request answered.');
  if (snap.stopped) parts.unshift('Stopped early.');
  const title =
    degradedAt !== undefined
      ? `Held up until about ${degradedAt} s, then slowed down sharply`
      : rate > 0.2
        ? `Ran, but ${(rate * 100).toFixed(0)}% of requests failed`
        : rate > 0
          ? 'Held up, with a few failing requests'
          : 'Held up for the whole run';
  return { tone: degradedAt !== undefined || rate > 0.2 ? (rate > 0.2 ? 'bad' : 'warn') : rate > 0 ? 'warn' : 'good', title, text: parts.join(' '), degradedAt };
}

function LoadView({ sc }: { sc: Scenario }): JSX.Element {
  const { project, path, env: envName, say } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === sc.env) ?? p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const kept = lastLoads.get(sc.id);
  const [users, setUsers] = useState(kept?.users ?? 10);
  const [duration, setDuration] = useState(kept?.duration ?? 30);
  const [ramp, setRamp] = useState(5);
  const [okProd, setOkProd] = useState(false);
  const [okPublic, setOkPublic] = useState(false);
  const [running, setRunning] = useState(false);
  const [snap, setSnap] = useState<LoadSnapshotDto | null>(kept?.snap ?? null);
  const [done, setDone] = useState(kept ? { at: kept.at, env: kept.env, users: kept.users, duration: kept.duration } : null);
  const [rows, setRows] = useState<'slow' | 'errors' | 'all'>('slow');
  /// The request whose errors are open ('' = closed on purpose; null = not chosen yet).
  const [openRow, setOpenRow] = useState<string | null>(null);
  const prod = envKind(env.name) === 'production';
  // Not a machine you obviously run: held to a polite size, and you say you're allowed.
  const publicHost = !isPrivateHost(env.baseUrl);
  const host = (() => {
    try {
      return new URL(env.baseUrl).host;
    } catch {
      return env.baseUrl;
    }
  })();
  useEffect(() => {
    if (!publicHost) return;
    if (users > PUBLIC_LOAD_LIMITS.users) setUsers(PUBLIC_LOAD_LIMITS.users);
    if (duration > PUBLIC_LOAD_LIMITS.durationSec) setDuration(PUBLIC_LOAD_LIMITS.durationSec);
  }, [publicHost, users, duration]);
  const reads = sc.steps.filter((s) => s.enabled && p.tools.find((t) => t.id === s.toolId)?.safety === 'read').length;

  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type === 'load:tick' && e.scenarioId === sc.id) setSnap(e.snapshot);
      }),
    [sc.id],
  );

  const start = async () => {
    setRunning(true);
    setSnap(null);
    setDone(null);
    const r = await window.overapi.invoke('load:start', path!, p, sc.id, env.name, { users, durationSec: duration, rampSec: ramp });
    setRunning(false);
    if (!r.ok) return say(r.error, true);
    const d = { at: new Date().toISOString(), env: env.name, users, duration };
    setSnap(r.result);
    setDone(d);
    lastLoads.set(sc.id, { snap: r.result, ...d });
  };

  // The second in progress is partial: leave it off the charts.
  const tl = snap ? (snap.done ? snap.timeline.filter((x) => x.t < Math.ceil(snap.elapsedSec)) : snap.timeline.slice(0, -1)) : [];
  const verdict = snap?.done && done ? verdictOf(snap, { users: done.users, duration: done.duration, reads, env: done.env, ramp }) : undefined;
  const peak = tl.reduce((m, x) => (x.requests > m.requests ? x : m), { t: 0, requests: 0 });
  const failingSteps = snap?.steps.filter((s) => s.errors > 0) ?? [];
  const recordedMs = (stepId: string) => sc.steps.find((s) => s.id === stepId)?.recorded?.ms;
  const table = useMemo(() => {
    if (!snap) return [];
    const list = [...snap.steps].sort((a, b) => b.p95 - a.p95);
    if (rows === 'errors') return list.filter((s) => s.errors > 0);
    if (rows === 'slow') return list.slice(0, 8);
    return list;
  }, [snap, rows]);
  const maxP95 = Math.max(1, ...(snap?.steps.map((s) => s.p95) ?? [1]));
  const stepNo = (id: string) => sc.steps.findIndex((s) => s.id === id) + 1;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[12px]">
      <div className="flex flex-wrap items-end gap-3">
        <NumberField label="Users" value={users} set={setUsers} min={1} max={publicHost ? PUBLIC_LOAD_LIMITS.users : 100} />
        <NumberField label="Duration (s)" value={duration} set={setDuration} min={1} max={publicHost ? PUBLIC_LOAD_LIMITS.durationSec : 600} />
        <NumberField label="Ramp-up (s)" value={ramp} set={setRamp} min={0} max={duration} />
        <div className="pb-2 text-ink-muted">
          on <b className="text-ink">{env.name}</b> · {reads} read{reads === 1 ? '' : 's'} per loop · writes are never part of a load test
        </div>
        <span className="flex-1" />
        {running ? (
          <button className="btn-primary !bg-bad" onClick={() => void window.overapi.invoke('load:stop')}>
            Stop
          </button>
        ) : (
          <button className="btn-primary" disabled={!reads || (prod && !okProd) || (publicHost && !okPublic)} onClick={() => void start()}>
            {snap ? 'Run again' : 'Start load test'}
          </button>
        )}
      </div>
      {publicHost && (
        <label className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/[0.07] p-3 leading-relaxed">
          <input type="checkbox" className="mt-1" checked={okPublic} onChange={(e) => setOkPublic(e.target.checked)} />
          <span>
            <b className="text-warn">{host} is a public site.</b>{' '}
            {env.browserSession ? 'You recorded it in a browser, which usually means it’s someone else’s site. ' : ''}
            A load test is a burst of traffic its owners didn’t ask for — it can look like an attack, get your address blocked, or break their terms. Only test systems you run or have
            permission to test. On a public host overapi holds it to {PUBLIC_LOAD_LIMITS.users} users for {PUBLIC_LOAD_LIMITS.durationSec} s.
            <span className="mt-1 block font-medium text-ink">I run this system, or have permission to load test it.</span>
          </span>
        </label>
      )}
      {prod && (
        <label className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/5 p-3">
          <input type="checkbox" className="mt-0.5" checked={okProd} onChange={(e) => setOkProd(e.target.checked)} />
          <span>
            <b className="text-bad">This is production.</b> {users} users for {duration} s is real traffic its users share. I know, and I’m allowed to.
          </span>
        </label>
      )}

      {!snap && !running && (
        <p className="max-w-2xl leading-relaxed text-ink-faint">
          Each user runs this scenario’s reads in a loop, with its own sign-in, passing ids along as the test does. You’ll see throughput, latency and errors as it goes, and a verdict at the end.
        </p>
      )}

      {running && (
        <section className="flex items-center gap-4 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
          </span>
          <span className="font-semibold">Running</span>
          <span className="text-ink-muted">
            {Math.floor(snap?.elapsedSec ?? 0)} of {duration} s · {snap?.users ?? 0} of {users} users active
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-wash-strong">
            <span className="block h-1.5 rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, ((snap?.elapsedSec ?? 0) / duration) * 100)}%` }} />
          </span>
        </section>
      )}

      {verdict && done && (
        <section
          className={`flex items-start gap-4 rounded-xl border px-4 py-3.5 ${verdict.tone === 'good' ? 'border-good/40 bg-good/5' : verdict.tone === 'warn' ? 'border-warn/40 bg-warn/[0.07]' : 'border-bad/40 bg-bad/5'}`}
          aria-label="Verdict"
        >
          <Icon name={verdict.tone === 'good' ? 'check' : 'alert'} size={18} className={`mt-0.5 ${verdict.tone === 'good' ? 'text-good' : verdict.tone === 'warn' ? 'text-warn' : 'text-bad'}`} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-[15px] font-semibold">{verdict.title}</div>
            <div className="leading-relaxed text-ink-muted">{verdict.text}</div>
          </div>
          <div className="shrink-0 text-right text-[11px] leading-relaxed text-ink-faint">
            {done.env} · {done.users} users · {done.duration} s
            <br />
            finished {ago(done.at)}
          </div>
        </section>
      )}

      {snap && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <Tile label="Requests" value={String(snap.total)} note={`in ${Math.round(snap.elapsedSec)} s`} />
            <Tile label="Throughput" value={(snap.total / Math.max(1, snap.elapsedSec)).toFixed(1)} unit="/s" note={peak.requests ? `peak ${peak.requests}/s at ${peak.t} s` : 'warming up'} />
            <Tile label="Latency · all requests" value={secs(snap.overall.p95)} unit=" p95" note={`p50 ${secs(snap.overall.p50)} · slowest ${secs(snap.overall.max)}`} />
            <Tile
              label="Errors"
              value={snap.total ? `${((snap.errors / snap.total) * 100).toFixed(1)}%` : '0%'}
              note={snap.errors ? `${snap.errors} failed · from ${failingSteps.length} request${failingSteps.length === 1 ? '' : 's'}` : 'none'}
              bad={snap.errors > 0}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <figure className="m-0 rounded-xl border border-rule bg-surface p-3.5">
              <figcaption className="mb-2 flex flex-wrap items-center gap-3">
                <span className="font-semibold">Throughput</span>
                <span className="text-[11px] text-ink-faint">requests per second</span>
                <span className="ml-auto flex gap-3 text-[11px] text-ink-muted">
                  <Key className="bg-accent" label="Answered" />
                  <Key className="bg-bad" label="Errors" />
                </span>
              </figcaption>
              <TimeChart
                xs={tl.map((x) => x.t)}
                duration={done?.duration ?? duration}
                bars={{ ok: tl.map((x) => x.requests - x.errors), err: tl.map((x) => x.errors) }}
                format={(v) => `${v}/s`}
                tip={(i) => `${tl[i].requests - tl[i].errors} answered · ${tl[i].errors} errors`}
                label={`Requests per second over the run, peak ${peak.requests} per second at ${peak.t} seconds`}
              />
              <UsersStrip xs={tl.map((x) => x.t)} users={tl.map((x) => x.users)} max={done?.users ?? users} duration={done?.duration ?? duration} />
            </figure>
            <figure className="m-0 rounded-xl border border-rule bg-surface p-3.5">
              <figcaption className="mb-2 flex flex-wrap items-center gap-3">
                <span className="font-semibold">Latency</span>
                <span className="text-[11px] text-ink-faint">per second, all requests</span>
                <span className="ml-auto flex gap-3 text-[11px] text-ink-muted">
                  <Key className="bg-accent" label="p95" line />
                  <Key className="bg-accent/45" label="p50" line />
                </span>
              </figcaption>
              <TimeChart
                xs={tl.map((x) => x.t)}
                duration={done?.duration ?? duration}
                lines={[
                  { values: tl.map((x) => x.p50), className: 'text-accent/45' },
                  { values: tl.map((x) => x.p95), className: 'text-accent' },
                ]}
                shadeFrom={verdict?.degradedAt}
                format={secs}
                tip={(i) => `p95 ${secs(tl[i].p95)} · p50 ${secs(tl[i].p50)}`}
                label={`Latency per second: p95 and p50${verdict?.degradedAt !== undefined ? `, slowing down from ${verdict.degradedAt} seconds` : ''}`}
              />
            </figure>
          </div>

          <section className="overflow-hidden rounded-xl border border-rule bg-surface" aria-label="Requests">
            <div className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-2.5">
              <span className="font-semibold">{rows === 'errors' ? 'Requests with errors' : rows === 'all' ? 'Every request' : 'Slowest requests'}</span>
              <span className="text-[11px] text-ink-faint">by p95 · against the time it took when recorded</span>
              <span className="ml-auto flex gap-1.5">
                {(
                  [
                    ['slow', 'Slowest'],
                    ['errors', `Errors ${failingSteps.length}`],
                    ['all', `All ${snap.steps.length}`],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} aria-pressed={rows === id} onClick={() => setRows(id)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${rows === id ? 'border-transparent bg-wash-strong text-ink' : id === 'errors' && failingSteps.length ? 'border-bad/40 text-bad' : 'border-rule text-ink-muted hover:text-ink'}`}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
            <table className="w-full table-fixed text-left">
              <thead className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                <tr>
                  <th className="w-[30%] px-4 py-2 font-semibold">Request</th>
                  <th className="px-2 py-2 font-semibold">p95</th>
                  <th className="w-[80px] px-2 py-2 text-right font-semibold">p50</th>
                  <th className="w-[80px] px-2 py-2 text-right font-semibold">p99</th>
                  <th className="w-[90px] px-2 py-2 text-right font-semibold">Recorded</th>
                  <th className="w-[110px] px-2 py-2 text-right font-semibold">vs recorded</th>
                  <th className="w-[70px] px-4 py-2 text-right font-semibold">Errors</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {table.map((s, i) => {
                  const rec = recordedMs(s.stepId);
                  const ratio = rec ? s.p50 / Math.max(1, rec) : undefined;
                  const slow = ratio !== undefined && ratio >= 3;
                  const expanded = s.errors > 0 && (openRow === s.stepId || (openRow === null && rows === 'errors' && i === 0));
                  return (
                    <Fragment key={s.stepId}>
                    <tr
                      className={`border-t border-rule ${s.errors ? 'cursor-pointer hover:bg-wash' : ''} ${expanded ? 'bg-bad/[0.04]' : ''}`}
                      onClick={() => s.errors && setOpenRow(expanded ? '' : s.stepId)}
                      title={s.errors ? 'See what went wrong' : undefined}
                    >
                      <td className="truncate px-4 py-2">
                        {s.errors > 0 ? (
                          <Icon name="chevron" size={11} className={`mr-1.5 inline text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
                        ) : (
                          <span className="mr-1.5 inline-block w-[11px]" />
                        )}
                        <span className="mr-2 font-mono text-[10px] text-ink-faint">{stepNo(s.stepId)}</span>
                        {s.name}
                      </td>
                      <td className="px-2 py-2">
                        <span className="flex items-center gap-2.5">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-wash-strong">
                            <span className={`block h-1.5 rounded-full ${s.errors ? 'bg-bad' : slow ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.max(2, (s.p95 / maxP95) * 100)}%` }} />
                          </span>
                          <span className="w-14 text-right">{secs(s.p95)}</span>
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right text-ink-muted">{secs(s.p50)}</td>
                      <td className="px-2 py-2 text-right text-ink-muted">{secs(s.p99)}</td>
                      <td className="px-2 py-2 text-right text-ink-muted">{rec !== undefined ? secs(rec) : '—'}</td>
                      <td className={`px-2 py-2 text-right ${slow ? 'font-semibold text-warn' : 'text-ink-muted'}`}>{ratio === undefined ? '—' : ratio < 0.8 ? 'faster' : ratio < 1.5 ? 'about the same' : `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× ${slow ? 'slower' : ''}`.trim()}</td>
                      <td className={`px-4 py-2 text-right ${s.errors ? 'font-semibold text-bad' : 'text-ink-faint'}`}>{s.errors}</td>
                    </tr>
                    {expanded && (
                      <tr className="bg-bad/[0.04]">
                        <td colSpan={7} className="px-4 pb-4 pt-1">
                          <FailureDetail step={s} toolId={sc.steps.find((x) => x.id === s.stepId)?.toolId} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
                {!table.length && (
                  <tr>
                    <td colSpan={7} className="px-4 py-3 text-ink-faint">
                      {rows === 'errors' ? 'No request failed.' : 'Nothing yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {rows === 'slow' && snap.steps.length > 8 && (
              <div className="border-t border-rule px-4 py-2.5">
                <button className="text-accent hover:underline" onClick={() => setRows('all')}>
                  Show all {snap.steps.length} requests
                </button>
                <span className="text-ink-faint"> · the other {snap.steps.length - 8} stayed under {secs(table[table.length - 1]?.p95 ?? 0)} p95</span>
              </div>
            )}
          </section>

          {snap.sampleErrors.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-bad/10 px-3 py-2 font-mono text-[11px] text-bad">
              {snap.sampleErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Key({ className, label, line }: { className: string; label: string; line?: boolean }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`${line ? 'h-0.5 w-3' : 'h-2 w-2 rounded-sm'} ${className}`} />
      {label}
    </span>
  );
}

function Tile({ label, value, unit, note, bad }: { label: string; value: string; unit?: string; note: string; bad?: boolean }): JSX.Element {
  return (
    <div className={`rounded-xl border px-4 py-3 ${bad ? 'border-bad/40 bg-bad/5' : 'border-rule bg-surface'}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</div>
      <div className={`display mt-0.5 text-[26px] font-semibold tabular-nums ${bad ? 'text-bad' : ''}`}>
        {value}
        {unit && <span className="text-[14px] font-normal text-ink-muted">{unit}</span>}
      </div>
      <div className="text-[11px] text-ink-faint">{note}</div>
    </div>
  );
}

/// One measure over the run, one axis: stacked bars (answered + errors) or
/// lines (p50, p95), a recessive grid, an optional shaded "slowed down"
/// window, and a crosshair with the second's values under the pointer.
function TimeChart({
  xs,
  duration,
  bars,
  lines,
  shadeFrom,
  format,
  tip,
  label,
}: {
  xs: number[];
  duration: number;
  bars?: { ok: number[]; err: number[] };
  lines?: { values: number[]; className: string }[];
  shadeFrom?: number;
  format: (v: number) => string;
  tip: (i: number) => string;
  label: string;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const H = 170;
  const m = { l: 48, r: 8, t: 10, b: 20 };
  const span = Math.max(1, duration);
  const top = niceMax(Math.max(1, ...(bars ? bars.ok.map((v, i) => v + bars.err[i]) : (lines ?? []).flatMap((l) => l.values))));
  const pw = w - m.l - m.r;
  const X = (t: number) => m.l + (t / span) * pw;
  const Y = (v: number) => H - m.b - (v / top) * (H - m.t - m.b);
  const bw = Math.max(2, pw / span - 3);
  const h = hover;
  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <svg
        width={w}
        height={H}
        className="block"
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          if (!xs.length) return;
          const t = ((e.clientX - e.currentTarget.getBoundingClientRect().left - m.l) / pw) * span;
          let best = 0;
          for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] + (bars ? 0.5 : 0) - t) < Math.abs(xs[best] + (bars ? 0.5 : 0) - t)) best = i;
          setHover(best);
        }}
      >
        {shadeFrom !== undefined && (
          <g>
            <rect x={X(shadeFrom)} y={m.t} width={Math.max(0, X(span) - X(shadeFrom))} height={H - m.t - m.b} className="text-warn" fill="currentColor" fillOpacity={0.08} />
            <text x={X(shadeFrom) + 6} y={m.t + 12} className="fill-current text-warn" fontSize={10}>
              slowed down
            </text>
          </g>
        )}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={m.l} x2={w - m.r} y1={Y(top * f)} y2={Y(top * f)} className={f ? 'text-rule' : 'text-ink-faint/40'} stroke="currentColor" />
            <text x={m.l - 6} y={Y(top * f) + 3} textAnchor="end" className="fill-current text-ink-faint" fontSize={10}>
              {format(top * f)}
            </text>
          </g>
        ))}
        <text x={m.l} y={H - 5} className="fill-current text-ink-faint" fontSize={10}>
          0 s
        </text>
        <text x={w - m.r} y={H - 5} textAnchor="end" className="fill-current text-ink-faint" fontSize={10}>
          {span} s
        </text>
        {bars &&
          xs.map((t, i) => {
            const ok = bars.ok[i];
            const err = bars.err[i];
            const okTop = Y(ok);
            return (
              <g key={t}>
                {ok > 0 && <rect x={X(t) + 1.5} y={okTop} width={bw} height={Y(0) - okTop} rx={2} className="text-accent" fill="currentColor" />}
                {err > 0 && <rect x={X(t) + 1.5} y={Y(ok + err) - (ok ? 2 : 0)} width={bw} height={Y(0) - Y(err)} rx={2} className="text-bad" fill="currentColor" />}
              </g>
            );
          })}
        {lines?.map((l, k) =>
          l.values.length > 1 ? (
            <path key={k} d={l.values.map((v, i) => `${i ? 'L' : 'M'}${X(xs[i] + 0.5).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={l.className} />
          ) : null,
        )}
        {h !== null && xs[h] !== undefined && (
          <>
            <line x1={X(xs[h] + 0.5)} x2={X(xs[h] + 0.5)} y1={m.t} y2={H - m.b} className="text-ink-faint" stroke="currentColor" strokeDasharray="3 3" />
            {lines?.map((l, k) => <circle key={k} cx={X(xs[h] + 0.5)} cy={Y(l.values[h])} r={4} fill="currentColor" className={l.className} stroke="rgb(var(--c-surface))" strokeWidth={2} />)}
          </>
        )}
      </svg>
      {!xs.length && <div className="absolute inset-0 flex items-center justify-center text-ink-faint">Waiting for the first second…</div>}
      {h !== null && xs[h] !== undefined && (
        <div className="pointer-events-none absolute top-1 rounded-md border border-rule bg-surface px-2 py-1 text-[11px] shadow" style={{ left: Math.min(X(xs[h] + 0.5) + 10, w - 190) }}>
          <span className="text-ink-faint">{xs[h]} s · </span>
          <b className="tabular-nums">{tip(h)}</b>
        </div>
      )}
    </div>
  );
}

/// Users active over the run, as a thin strip under the throughput chart:
/// its own small scale, so the chart above keeps one axis.
function UsersStrip({ xs, users, max, duration }: { xs: number[]; users: number[]; max: number; duration: number }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const H = 22;
  const l = 48;
  const pw = w - l - 8;
  const X = (t: number) => l + (t / Math.max(1, duration)) * pw;
  const Y = (u: number) => H - 3 - (u / Math.max(1, max)) * (H - 6);
  const d = users.map((u, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(u).toFixed(1)} L${X(xs[i] + 1).toFixed(1)},${Y(u).toFixed(1)}`).join(' ');
  return (
    <div ref={box} className="mt-1 flex items-center">
      <svg width={w} height={H} className="block" role="img" aria-label={`Users active, up to ${max}`}>
        <text x={l - 6} y={H / 2 + 3} textAnchor="end" className="fill-current text-ink-faint" fontSize={10}>
          users
        </text>
        <line x1={l} x2={w - 8} y1={H - 3} y2={H - 3} className="text-rule" stroke="currentColor" />
        {users.length > 0 && <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-ink-muted" />}
        {users.length > 0 && (
          <text x={w - 8} y={10} textAnchor="end" className="fill-current text-ink-faint" fontSize={10}>
            {Math.max(...users)} of {max}
          </text>
        )}
      </svg>
    </div>
  );
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));



function NumberField({ label, value, set, min, max }: { label: string; value: number; set: (n: number) => void; min: number; max: number }): JSX.Element {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="field w-24 font-mono" type="number" min={min} max={max} value={value} onChange={(e) => set(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
    </div>
  );
}

// ---- bits ---------------------------------------------------------------------

function Args({ args }: { args: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(args);
  if (!entries.length) return <span className="text-ink-faint">no arguments</span>;
  return (
    <>
      {entries.map(([k, v], i) => {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return (
          <span key={k}>
            {i > 0 && '  '}
            {k}=<span className={/\{\{/.test(s) ? 'text-accent' : 'text-ink'}>{s.length > 40 ? `${s.slice(0, 40)}…` : s}</span>
          </span>
        );
      })}
    </>
  );
}

function RunDot({ run }: { run?: ScenarioRun }): JSX.Element {
  const c = !run ? 'bg-ink-faint/40' : run.failed ? 'bg-bad' : 'bg-good';
  return <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${c}`} aria-label={!run ? 'not run' : run.failed ? 'failing' : 'passing'} />;
}

function moveItem<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function ago(at: string): string {
  const s = (Date.now() - new Date(at).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/// The latest test result, for the places you publish from: green when the
/// last run passed, red when it didn't, a nudge when there is none.
export function TestsBadge(): JSX.Element | null {
  const { project, path, setTab } = useStore();
  const [runs, setRuns] = useState<Record<string, ScenarioRun>>({});
  useEffect(() => {
    if (path) void window.overapi.invoke('scenario:runs', path).then(setRuns);
  }, [path]);
  const scenarios = project?.scenarios ?? [];
  if (!scenarios.length) return null;
  const latest = scenarios.map((s) => runs[s.id]).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0];
  const failing = scenarios.map((s) => runs[s.id]).filter((r) => r && r.failed).length;
  const tone = !latest ? 'bg-wash-strong text-ink-muted' : failing ? 'bg-bad/15 text-bad' : 'bg-good/15 text-good';
  const text = !latest ? 'Tests not run' : failing ? `${failing} test${failing === 1 ? '' : 's'} failing` : `Tests passing on ${latest.env} · ${ago(latest.at)}`;
  return (
    <button className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${tone}`} onClick={() => setTab('tests')} title="Open Tests">
      {text}
    </button>
  );
}

/// One request's errors from a load test: what kinds, how many of each, and
/// what the server said the first time — then where to go to fix it.
function FailureDetail({ step, toolId }: { step: LoadSnapshotDto['steps'][number]; toolId?: string }): JSX.Element {
  const { selectTool, setTab } = useStore();
  const failures = step.failures ?? [];
  const [pick, setPick] = useState(0);
  const f = failures[pick];
  const timeouts = failures.filter((x) => /no answer after/i.test(x.label)).reduce((n, x) => n + x.count, 0);
  return (
    <div className="space-y-2.5 rounded-lg border border-bad/30 bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium">
          {step.errors} of {step.count} call{step.count === 1 ? '' : 's'} failed
        </span>
        {failures.map((x, i) => (
          <button
            key={x.label}
            onClick={() => setPick(i)}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${i === pick ? 'border-bad/50 bg-bad/10 text-bad' : 'border-rule text-ink-muted hover:text-ink'}`}
          >
            {x.label} ×{x.count}
          </button>
        ))}
        <span className="flex-1" />
        {toolId && (
          <button
            className="btn !px-2.5 !py-0.5 text-[12px]"
            onClick={() => {
              selectTool(toolId);
              setTab('requests');
            }}
          >
            Open the request
          </button>
        )}
      </div>
      {timeouts > 0 && (
        <p className="text-[12px] text-ink-muted">
          {timeouts} gave no answer in time — under load the server stopped responding to this one. That’s the server’s limit, not a broken request.
        </p>
      )}
      {f?.sample ? (
        <div>
          <div className="label">What the server said · first {f.label}</div>
          <div className="max-h-60 overflow-auto rounded-md border border-rule bg-wash p-2">
            <BodyView text={f.sample} />
          </div>
        </div>
      ) : (
        f && <p className="text-[12px] text-ink-faint">No response body — {f.label}.</p>
      )}
      {!failures.length && <p className="text-[12px] text-ink-faint">Run the load test again to see what went wrong — this run was from before overapi kept the details.</p>}
    </div>
  );
}
