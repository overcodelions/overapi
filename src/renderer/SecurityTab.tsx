import { useMemo, useState } from 'react';
import { useStore } from './store';
import { Icon } from './icons';
import { varPrefix } from '@shared/project';
import { scanProject, type Finding, type Severity } from '@shared/scan';

const SEV: Record<Severity, { label: string; cls: string }> = {
  critical: { label: 'Critical', cls: 'bg-bad text-white' },
  high: { label: 'High', cls: 'bg-bad/15 text-bad' },
  medium: { label: 'Medium', cls: 'bg-warn/15 text-warn' },
  low: { label: 'Low', cls: 'bg-wash-strong text-ink-muted' },
};

const CATEGORY: Record<Finding['category'], string> = {
  secrets: 'Leaked secrets',
  reach: 'What agents can reach',
  injection: 'Prompt injection',
  data: 'Personal data',
  transport: 'Transport',
  'sign-in': 'Sign-in',
};

export function useScan() {
  const { project } = useStore();
  return useMemo(() => (project ? scanProject(project, varPrefix(project.name)) : undefined), [project]);
}

export function ScoreChip({ score, label = 'Security' }: { score: number; label?: string }): JSX.Element {
  return <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold tabular-nums ${score >= 90 ? 'bg-good/15 text-good' : score >= 60 ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad'}`}>{label} {score}</span>;
}

/// The security scan, as a page: the score, what costs points and how to
/// fix it — one click where overapi can do it — or accept it, with why.
export function SecurityTab(): JSX.Element {
  const { project, path, update, say, selectTool, setTab, setEnv } = useStore();
  const p = project!;
  const r = useScan()!;
  const [accepting, setAccepting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const counts = (['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => [s, r.findings.filter((f) => f.severity === s).length] as const);

  const accept = (f: Finding) => {
    update((x) => ({ ...x, review: { ...(x.review ?? {}), accepted: { ...(x.review?.accepted ?? {}), [f.id]: { reason: reason.trim(), at: new Date().toISOString() } } } }));
    setAccepting(null);
    setReason('');
    say('Accepted. It no longer counts, and the reason goes with the API when it’s published.');
  };
  const unaccept = (id: string) =>
    update((x) => {
      const accepted = { ...(x.review?.accepted ?? {}) };
      delete accepted[id];
      return { ...x, review: { ...(x.review ?? {}), accepted } };
    });

  // Moves a leaked value to the keychain and leaves ${NAME} in its place.
  const secretize = async (f: Finding) => {
    const s = f.secretize!;
    const tool = p.tools.find((t) => t.id === f.toolId);
    const env = p.envs.find((e) => e.name === f.env);
    const value = s.where === 'tool-example' ? tool?.example?.[s.key] : s.where === 'tool-header' ? tool?.headers?.[s.key] : env?.headers?.[s.key];
    if (typeof value !== 'string') return;
    const ok = await window.overapi.invoke('secrets:set', path!, s.name, value);
    if (!ok.ok) return say(ok.error ?? 'The keychain refused it.', true);
    const ref = `\${${s.name}}`;
    update((x) => ({
      ...x,
      tools: x.tools.map((t) =>
        t.id !== f.toolId ? t : s.where === 'tool-example' ? { ...t, example: { ...(t.example ?? {}), [s.key]: ref } } : s.where === 'tool-header' ? { ...t, headers: { ...(t.headers ?? {}), [s.key]: ref } } : t,
      ),
      envs: x.envs.map((e) => (e.name === f.env && s.where === 'env-header' ? { ...e, headers: { ...(e.headers ?? {}), [s.key]: ref } } : e)),
    }));
    await useStore.getState().refreshSecrets();
    say(`Moved to the keychain as ${s.name}; the file now says ${ref}.`);
  };

  return (
    <div className="h-full overflow-y-auto px-8 py-5">
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Security score</div>
          <div className={`display text-[40px] font-semibold leading-none tabular-nums ${r.score >= 90 ? 'text-good' : r.score >= 60 ? 'text-warn' : 'text-bad'}`}>
            {r.score}
            <span className="ml-2 text-[20px] text-ink-muted">{r.grade}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {counts.map(([s, n]) => (
            <span key={s} className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${n ? SEV[s].cls : 'bg-wash text-ink-faint'}`}>
              {n} {SEV[s].label.toLowerCase()}
            </span>
          ))}
        </div>
        <p className="min-w-[280px] flex-1 text-[12px] leading-relaxed text-ink-muted">
          Found by rules, so the same API always scores the same. {r.blocking.length ? <b className="text-bad">Critical and high findings stop it being published to the team’s server</b> : 'Nothing blocks publishing to the team’s server.'}
          {r.blocking.length ? ' until they’re fixed or accepted with a reason.' : ''} Run it in CI with <span className="font-mono">overapi scan</span>.
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {!r.findings.length && (
          <div className="flex items-center gap-2 rounded-xl border border-good/40 bg-good/5 px-4 py-3 text-[13px]">
            <Icon name="check" size={15} className="text-good" /> Nothing found{r.accepted.length ? ` — ${r.accepted.length} accepted below` : ''}.
          </div>
        )}
        {r.findings.map((f) => {
          const tool = p.tools.find((t) => t.id === f.toolId);
          return (
            <article key={f.id} className="rounded-xl border border-rule bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${SEV[f.severity].cls}`}>{SEV[f.severity].label}</span>
                <span className="text-[11px] uppercase tracking-[0.06em] text-ink-faint">{CATEGORY[f.category]}</span>
                <span className="ml-auto text-[11px] tabular-nums text-ink-faint">−{f.points}</span>
              </div>
              <h3 className="mt-1.5 text-[14px] font-semibold">{f.title}</h3>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{f.detail}</p>
              <p className="mt-1 text-[12px]">
                <span className="text-ink-faint">Fix: </span>
                {f.fix}
              </p>
              {accepting === f.id ? (
                <form
                  className="mt-3 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (reason.trim()) accept(f);
                  }}
                >
                  <input autoFocus className="field min-w-[320px] flex-1 py-1 text-[12px]" placeholder="Why it’s fine — e.g. internal tool, data is already public" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="btn-primary" disabled={!reason.trim()}>
                    Accept
                  </button>
                  <button type="button" className="btn" onClick={() => setAccepting(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {f.secretize && (
                    <button className="btn-primary" onClick={() => void secretize(f)}>
                      <Icon name="lock" size={12} /> Move to the keychain
                    </button>
                  )}
                  {tool && (
                    <button
                      className="btn"
                      onClick={() => {
                        selectTool(tool.id);
                        setTab('requests');
                      }}
                    >
                      Open {tool.name}
                    </button>
                  )}
                  {f.env && (
                    <button
                      className="btn"
                      onClick={() => {
                        setEnv(f.env!);
                        setTab('envs');
                      }}
                    >
                      Open {f.env}
                    </button>
                  )}
                  <button className="btn" onClick={() => setAccepting(f.id)}>
                    Accept…
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {r.accepted.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-[12px] text-ink-muted">{r.accepted.length} accepted</summary>
          <div className="mt-2 space-y-2">
            {r.accepted.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-rule px-3 py-2 text-[12px]">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEV[f.severity].cls}`}>{SEV[f.severity].label}</span>
                <span className="min-w-0 flex-1">
                  {f.title} <span className="text-ink-faint">— “{f.accepted.reason}”, {new Date(f.accepted.at).toLocaleDateString()}</span>
                </span>
                <button className="text-ink-faint hover:text-ink" onClick={() => unaccept(f.id)}>
                  Undo
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
