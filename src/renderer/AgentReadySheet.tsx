import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Sheet } from './ui';
import { Icon } from './icons';
import { aiPlan, applyChanges, rulePlan, type Change, type ChangeGroup } from '@shared/agentReady';
import { checkProject } from '@shared/check';
import { scanProject } from '@shared/scan';
import { varPrefix, type Project } from '@shared/project';

const ORDER: ChangeGroup[] = ['Tidy up', 'Same every time', 'Chains', 'Descriptions', 'Arguments', 'Names', 'Hide from agents', 'Agent brief', 'Example questions'];

/// "Make it agent-ready": tidy, fix, connect (rules), then the person's own
/// claude or codex documents it — one list of before → after to accept.
export function AgentReadySheet(): JSX.Element {
  const { project, env: envName, secrets, info, update, say, openSheet, setTab, setMcpTab } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [phase, setPhase] = useState<'intro' | 'running' | 'review'>('intro');
  const [samples, setSamples] = useState(true);
  const [steps, setSteps] = useState<string[]>([]);
  const [rules, setRules] = useState<Change[]>([]);
  const [ai, setAi] = useState<Change[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const aiTool = info?.ai.claude ? 'claude' : info?.ai.codex ? 'codex' : null;
  const preview = useMemo(() => rulePlan(p, env), [p, env]);

  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type === 'doc:step') setSteps((s) => [...s.slice(-5), e.text]);
      }),
    [],
  );

  const run = async (useAi: boolean) => {
    const r = rulePlan(p, env);
    setRules(r);
    setAi([]);
    setAiError(null);
    if (!useAi) return setPhase('review');
    setPhase('running');
    setSteps([]);
    // The AI documents the API as it will be: tidied, fixed and connected.
    const ready = applyChanges(p, r);
    const res = await window.overapi.invoke('ai:document', ready, env.name, samples);
    if (res.ok) setAi(aiPlan(ready, res.doc));
    else setAiError(res.error);
    setPhase('review');
  };

  const all = [...rules, ...ai];
  const chosen = all.filter((c) => !off.has(c.id));
  const vars = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v]));
  const score = (x: Project) => ({ ready: checkProject(x, vars).score, security: scanProject(x, varPrefix(x.name)).score });
  const before = useMemo(() => score(p), [p]);
  const after = useMemo(() => score(applyChanges(applyChanges(p, chosen.filter((c) => rules.includes(c))), chosen.filter((c) => ai.includes(c)))), [p, chosen.length, rules, ai]);

  const accept = () => {
    update((x) => applyChanges(applyChanges(x, chosen.filter((c) => rules.includes(c))), chosen.filter((c) => ai.includes(c))));
    openSheet(null);
    setTab('mcp');
    setMcpTab('tools');
    say(`Applied ${chosen.length} change${chosen.length === 1 ? '' : 's'}. Ready ${before.ready} → ${after.ready}.`);
  };
  const toggle = (ids: string[], on: boolean) =>
    setOff((s) => {
      const n = new Set(s);
      for (const id of ids) on ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <Sheet
      title={`Make ${p.title} agent-ready`}
      onClose={() => {
        if (phase === 'running') void window.overapi.invoke('ai:cancel');
        openSheet(null);
      }}
      wide
      footer={
        phase === 'review' ? (
          <div className="flex w-full items-center gap-3">
            <span className="text-[12px] text-ink-muted">
              {chosen.length} of {all.length} change{all.length === 1 ? '' : 's'} selected
            </span>
            <span className="flex-1" />
            <button className="btn" onClick={() => openSheet(null)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!chosen.length} onClick={accept}>
              Apply {chosen.length} change{chosen.length === 1 ? '' : 's'}
            </button>
          </div>
        ) : undefined
      }
    >
      {phase === 'intro' && (
        <div className="space-y-4 text-[13px]">
          <p className="leading-relaxed text-ink-muted">One pass that does what makes an API good for agents. You see every change before anything is applied.</p>
          <ol className="space-y-2">
            {[
              ['Tidy up', 'what the recording picked up that isn’t the API', preview.filter((c) => c.group === 'Tidy up').length],
              ['Fix what never changes', 'values every request sends the same, like a competition or season', preview.filter((c) => c.group === 'Same every time').length],
              ['Connect the chains', 'which request gives the ids the others need', preview.filter((c) => c.group === 'Chains').length],
              ['Document it', `${aiTool ?? 'claude or codex'} writes what each tool is for, what each argument means, clearer names, what to hide, and a brief for the agent`, null],
            ].map(([title, text, n], i) => (
              <li key={i} className="flex items-start gap-3 rounded-lg border border-rule px-3 py-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span>
                <span className="flex-1">
                  <b className="font-medium">{title}</b> <span className="text-ink-muted">— {text}</span>
                </span>
                {n !== null && <span className="text-[12px] text-ink-faint">{n ? `${n} found` : 'nothing to do'}</span>}
                {n === null && <Icon name="sparkle" size={14} className="mt-0.5 text-accent" />}
              </li>
            ))}
          </ol>
          {aiTool ? (
            <label className="flex items-start gap-2 text-[12px] text-ink-muted">
              <input type="checkbox" className="mt-0.5" checked={samples} onChange={(e) => setSamples(e.target.checked)} />
              <span>
                Include a few example values (team ids, season years) so the descriptions can be concrete. Secrets are never sent — anything that looks like one is left out. It runs
                through your own {aiTool}.
              </span>
            </label>
          ) : (
            <p className="rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">Neither claude nor codex is installed, so step 4 can’t run. Steps 1–3 still can.</p>
          )}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={!aiTool} onClick={() => void run(true)}>
              <Icon name="sparkle" size={13} /> Make it agent-ready
            </button>
            <button className="btn" onClick={() => void run(false)}>
              Steps 1–3 only
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="space-y-4 text-[13px]">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
            <b>{aiTool} is documenting {p.tools.length} tools</b>
            <span className="text-ink-faint">— usually a minute or two</span>
            <span className="flex-1" />
            <button className="btn" onClick={() => void window.overapi.invoke('ai:cancel')}>
              Stop
            </button>
          </div>
          <p className="text-ink-muted">
            Steps 1–3 are ready: {rules.length} change{rules.length === 1 ? '' : 's'}. The documentation is written for the API as it will be after them.
          </p>
          <ul className="space-y-1 rounded-lg bg-wash p-3 font-mono text-[11px] text-ink-muted">
            {steps.length ? steps.map((s, i) => <li key={i} className="truncate">{s}</li>) : <li>Starting…</li>}
          </ul>
        </div>
      )}

      {phase === 'review' && (
        <div className="space-y-4 text-[13px]">
          <div className="grid grid-cols-2 gap-3">
            <ScoreMove label="Ready for agents" from={before.ready} to={after.ready} />
            <ScoreMove label="Security" from={before.security} to={after.security} />
          </div>
          {aiError && (
            <p className="rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
              The documentation step didn’t finish: {aiError} The other changes are below.
            </p>
          )}
          {!all.length && <p className="text-ink-muted">Nothing to change — it’s already in good shape.</p>}
          {ORDER.map((g) => {
            const list = all.filter((c) => c.group === g);
            if (!list.length) return null;
            const allOn = list.every((c) => !off.has(c.id));
            return (
              <section key={g} className="rounded-xl border border-rule">
                <label className="flex cursor-pointer items-center gap-2.5 border-b border-rule bg-wash px-3.5 py-2">
                  <input type="checkbox" checked={allOn} onChange={(e) => toggle(list.map((c) => c.id), e.target.checked)} />
                  <span className="font-semibold">{g}</span>
                  <span className="text-[12px] text-ink-faint">{list.length}</span>
                  {['Descriptions', 'Arguments', 'Names', 'Hide from agents', 'Agent brief', 'Example questions'].includes(g) && <Icon name="sparkle" size={12} className="text-accent" />}
                </label>
                <ul>
                  {list.map((c) => (
                    <li key={c.id} className="flex items-start gap-2.5 border-t border-rule px-3.5 py-2 first:border-t-0">
                      <input type="checkbox" className="mt-1" checked={!off.has(c.id)} onChange={(e) => toggle([c.id], e.target.checked)} />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[12px]">{c.title}</div>
                        {c.before && c.after && c.group !== 'Names' && <div className="mt-0.5 text-[12px] text-ink-faint line-through decoration-ink-faint/40">{c.before}</div>}
                        {c.after && c.group !== 'Names' && <div className="mt-0.5 whitespace-pre-line text-[12.5px] leading-relaxed">{c.after}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

function ScoreMove({ label, from, to }: { label: string; from: number; to: number }): JSX.Element {
  const tone = (n: number) => (n >= 90 ? 'text-good' : n >= 60 ? 'text-warn' : 'text-bad');
  return (
    <div className="rounded-xl border border-rule px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</div>
      <div className="display mt-0.5 text-[24px] font-semibold tabular-nums">
        <span className={tone(from)}>{from}</span>
        <span className="mx-2 text-ink-faint">→</span>
        <span className={tone(to)}>{to}</span>
      </div>
    </div>
  );
}
