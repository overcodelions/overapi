import { useEffect, useState } from 'react';
import { useStore } from './store';
import { Icon, Monogram } from './icons';
import { EnvDot } from './ui';
import { InstallsCard } from './Installs';
import { checkProject } from '@shared/check';
import { envKind, envVars, fillVars, offered, type ToolDef } from '@shared/project';
import type { Published } from '@shared/ipc';

const SOURCE: Record<string, string> = {
  openapi: 'From an OpenAPI spec',
  swagger: 'From a Swagger 2 spec',
  har: 'Inferred from a traffic capture',
  postman: 'From a Postman collection',
  docs: 'Drafted from documentation',
  curl: 'Started from a cURL',
  manual: 'Built by hand',
};

/// Starter lines for the agent brief: the things agents most often get
/// wrong about an API, as prompts the person completes.
const STARTERS: [string, string][] = [
  ['Id formats', 'Ids look like: '],
  ['Paging', 'Lists return at most N items; page with: '],
  ['Units', 'Amounts are in: '],
  ['Call order', 'Search before fetching by id. '],
];

/// The API's home: what it is and the one next step; what an agent actually
/// gets, per environment; and down the side, ranked by impact, readiness,
/// the agent brief and the environments.
/// `embedded`: shown as the MCP server page's Tools view, which has its own
/// header — so no title block here.
export function OverviewTab({ embedded }: { embedded?: boolean } = {}): JSX.Element {
  const { project, path, secrets, history, update, setTab, openSheet, env: activeEnv } = useStore();
  const p = project!;
  const [envName, setEnvName] = useState(activeEnv ?? p.envs[0]?.name);
  const [published, setPublished] = useState<Published | null>(null);
  useEffect(() => {
    void window.overapi.invoke('overgo:published', path!).then(setPublished);
  }, [path]);
  useEffect(() => {
    if (activeEnv) setEnvName(activeEnv);
  }, [activeEnv]);

  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const vars = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v]));
  const r = checkProject(p, vars);
  const enabled = p.tools.filter((t) => t.enabled);
  const offeredHere = env ? p.tools.filter((t) => offered(t, env)) : [];
  const hiddenHere = env ? enabled.filter((t) => !offered(t, env)) : [];
  const notTools = p.tools.filter((t) => !t.enabled);
  const tried = history.some((h) => h.ok);
  const shaped = enabled.length > 0 && enabled.every((t) => t.description.trim().length >= 25) && !r.issues.some((i) => i.level === 'error');
  const steps: [string, boolean][] = [
    ['Build', p.tools.length > 0],
    ['Try', tried],
    ['Shape', shaped],
    ['Publish', !!published],
  ];
  const next = steps.findIndex(([, d]) => !d);
  const primary =
    next === 0
      ? { label: 'New request', go: () => openSheet({ kind: 'request' }) }
      : next === 1 || next === 2
        ? { label: next === 1 ? 'Try a request' : 'Shape requests', go: () => setTab('requests') }
        : { label: published ? 'Publish an update…' : 'Publish…', go: () => setTab('publish') };

  const allowWrites = (name: string) => {
    // Production needs its name typed, which lives on the Environments page.
    if (envKind(name) === 'production') {
      useStore.getState().setEnv(name);
      setTab('envs');
      return;
    }
    update((x) => ({ ...x, envs: x.envs.map((e) => (e.name === name ? { ...e, allowWrites: true } : e)) }));
  };
  const firstFixable = p.envs.find((e) => !e.allowWrites && envKind(e.name) !== 'production');
  const writesHiddenEverywhere = enabled.some((t) => t.safety !== 'read') && !p.envs.some((e) => e.allowWrites);

  return (
    <div className="h-full overflow-y-auto">
      <div className={`flex flex-col gap-6 px-8 pb-10 ${embedded ? 'pt-5' : 'pt-7'}`}>
        {/* Header */}
        {!embedded && (
        <section className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 flex-[1_1_520px] items-start gap-4">
            <Monogram name={p.title} size={48} />
            <div className="min-w-0">
              <input
                className="display w-full bg-transparent text-[30px] font-semibold leading-tight outline-none"
                value={p.title}
                onChange={(e) => update((x) => ({ ...x, title: e.target.value }))}
                aria-label="API name"
              />
              <input
                className="mt-1 w-full max-w-[720px] bg-transparent text-[14px] text-ink-muted outline-none placeholder:text-ink-faint"
                value={p.description}
                onChange={(e) => update((x) => ({ ...x, description: e.target.value }))}
                placeholder="What this API is, in a sentence — agents read this."
                aria-label="Description"
              />
              <p className="mt-1.5 text-[12px] text-ink-faint">
                {p.source ? SOURCE[p.source.kind] : 'Built by hand'}
                {p.source?.ref && (
                  <>
                    {' '}· <span className="font-mono text-[11px]">{p.source.ref}</span>
                  </>
                )}
                {p.source?.importedAt && <> · {new Date(p.source.importedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</>}
                {' '}·{' '}
                <button className="hover:text-ink" onClick={() => void window.overapi.invoke('projects:reveal', path!)}>Show file</button>
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-3">
            <ol aria-label="Progress" className="flex gap-1.5 text-[12px]">
              {steps.map(([label, done], i) => (
                <li
                  key={label}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                    done ? 'bg-good/15 text-good' : i === next ? 'border border-accent font-semibold text-accent' : 'border border-rule-strong text-ink-faint'
                  }`}
                >
                  {done ? <Icon name="check" size={11} /> : <span className="tabular-nums">{i + 1} ·</span>}
                  {label}
                </li>
              ))}
            </ol>
            <div className="flex gap-2">
              <button className="btn h-[34px] px-3.5 text-[13px]" onClick={() => setTab('agent')}>
                See it as an agent
              </button>
              <button className="btn-primary h-[34px] px-4 text-[13px]" onClick={primary.go}>
                {primary.label}
              </button>
            </div>
          </div>
        </section>
        )}

        <div className="flex flex-wrap items-start gap-5">
          {/* What an agent gets */}
          <section aria-labelledby="agent-gets" className="min-w-0 flex-[999_1_560px] rounded-xl border border-rule bg-wash">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-4">
              <div className="min-w-0">
                <h2 id="agent-gets" className="display text-[18px] font-semibold">What an agent gets</h2>
                {env && (
                  <p className="mt-1 truncate text-[12px] text-ink-faint">
                    <span className="font-mono text-[11px]">{fillVars(env.baseUrl, env) || 'no base URL'}</span> ·{' '}
                    {env.allowWrites ? 'writes allowed — destructive tools still need confirm' : 'read-only — tools that change data are hidden'}
                  </p>
                )}
              </div>
              {p.envs.length > 0 && (
                <div role="group" aria-label="Environment" className="flex gap-0.5 rounded-lg bg-wash-strong p-0.5">
                  {p.envs.map((e) => (
                    <button
                      key={e.name}
                      aria-pressed={e.name === env?.name}
                      onClick={() => setEnvName(e.name)}
                      className={`inline-flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium ${
                        e.name === env?.name ? 'bg-surface-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                      }`}
                    >
                      <EnvDot name={e.name} />
                      {e.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="py-1.5">
              <GroupHead left={`Offered · ${offeredHere.length} tool${offeredHere.length === 1 ? '' : 's'}`} right={offeredHere.every((t) => t.safety === 'read') && offeredHere.length ? 'all read-only' : undefined} />
              {offeredHere.length === 0 && (
                <p className="px-5 pb-3 text-[12px] text-ink-faint">
                  {p.tools.length === 0 ? 'No requests yet.' : 'Nothing is offered here yet — send a request and choose Make it a tool.'}
                </p>
              )}
              {offeredHere.map((t) => (
                <ToolRow key={t.id} t={t} />
              ))}

              {hiddenHere.length > 0 && env && (
                <>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-rule-strong px-5 pb-1.5 pt-3">
                    <span className="label mb-0">
                      Hidden on {env.name} · {hiddenHere.length} change data
                    </span>
                    <button className="btn" onClick={() => allowWrites(env.name)}>
                      Allow writes on {env.name}…
                    </button>
                  </div>
                  {hiddenHere.map((t) => (
                    <ToolRow key={t.id} t={t} dim />
                  ))}
                </>
              )}

              {notTools.length > 0 && (
                <>
                  <div className="mt-2.5 border-t border-dashed border-rule-strong px-5 pb-1.5 pt-3">
                    <span className="label mb-0">Requests, not tools · {notTools.length}</span>
                  </div>
                  {notTools.slice(0, 6).map((t) => (
                    <ToolRow key={t.id} t={t} dim />
                  ))}
                  {notTools.length > 6 && <p className="px-5 py-1.5 text-[11px] text-ink-faint">and {notTools.length - 6} more</p>}
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-rule px-5 py-3 text-[12px] text-ink-faint">
              <span>
                {p.tools.length} request{p.tools.length === 1 ? '' : 's'} · {enabled.length} tool{enabled.length === 1 ? '' : 's'} · {history.length} call{history.length === 1 ? '' : 's'} made
              </span>
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5" title="Which requests agents can call as tools">
                  Make tools:
                  <button className="text-ink-muted hover:text-ink" onClick={() => update((x) => ({ ...x, tools: x.tools.map((t) => ({ ...t, enabled: true })) }))}>all</button>·
                  <button className="text-ink-muted hover:text-ink" onClick={() => update((x) => ({ ...x, tools: x.tools.map((t) => ({ ...t, enabled: t.safety === 'read' })) }))}>reads only</button>·
                  <button className="text-ink-muted hover:text-ink" onClick={() => update((x) => ({ ...x, tools: x.tools.map((t) => ({ ...t, enabled: false })) }))}>none</button>
                </span>
                <button className="text-accent hover:underline" onClick={() => setTab('requests')}>
                  Edit in Requests →
                </button>
              </span>
            </div>
          </section>

          {/* Right rail, ranked by impact */}
          <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-5">
            <InstallsCard compact />
            <section aria-labelledby="ready" className="rounded-xl border border-rule bg-wash px-5 py-4">
              <div className="flex items-baseline justify-between">
                <h2 id="ready" className="text-[13px] font-semibold">Readiness</h2>
                <span className="text-[12px] text-ink-faint">
                  {r.issues.length} {r.issues.length === 1 ? 'note' : 'notes'}
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className={`display text-[40px] font-semibold leading-none ${r.score >= 90 ? 'text-good' : r.score >= 60 ? 'text-warn' : 'text-bad'}`}>{r.score}</span>
                <span className="text-[12px] text-ink-faint">of 100</span>
              </div>
              <div className="mt-2.5 h-1 rounded bg-wash-strong" aria-hidden>
                <div className={`h-1 rounded ${r.score >= 90 ? 'bg-good' : r.score >= 60 ? 'bg-warn' : 'bg-bad'}`} style={{ width: `${r.score}%` }} />
              </div>
              {r.issues.length === 0 ? (
                <p className="mt-3 text-[12px] text-good">Nothing to fix.</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {r.issues.slice(0, 4).map((i, n) => (
                    <li key={n} className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-muted">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${i.level === 'error' ? 'bg-bad' : i.level === 'warn' ? 'bg-warn' : 'bg-ink-faint'}`} />
                      <span className="flex-1">{i.message}</span>
                    </li>
                  ))}
                  {r.issues.length > 4 && <li className="text-[11px] text-ink-faint">and {r.issues.length - 4} more</li>}
                </ul>
              )}
              {writesHiddenEverywhere && firstFixable && (
                <button className="btn mt-3" onClick={() => allowWrites(firstFixable.name)}>
                  Allow writes on {firstFixable.name}
                </button>
              )}
            </section>

            <section aria-labelledby="brief" className="rounded-xl border border-rule bg-wash px-5 py-4">
              <h2 id="brief" className="text-[13px] font-semibold">Agent brief</h2>
              <p className="mb-3 mt-0.5 text-[12px] text-ink-faint">Sent once when an agent connects, with the environment and whether it may write.</p>
              {!p.instructions?.trim() && (
                <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-warn/10 px-3 py-2.5 text-[12px] leading-snug text-warn">
                  <Icon name="alert" size={14} className="mt-px" />
                  <span>No instructions yet. Agents only have the tool descriptions to go on.</span>
                </div>
              )}
              <label htmlFor="instructions" className="label">Instructions</label>
              <textarea
                id="instructions"
                className="field min-h-[84px] text-[12px] leading-relaxed"
                value={p.instructions ?? ''}
                onChange={(e) => update((x) => ({ ...x, instructions: e.target.value || undefined }))}
                placeholder="Order ids are numbers. Search before fetching by id. Amounts are in cents."
              />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {STARTERS.map(([label, line]) => (
                  <button
                    key={label}
                    className="h-[26px] rounded-full border border-rule-strong px-2.5 text-[11px] text-ink-muted hover:border-accent/50 hover:text-ink"
                    onClick={() => update((x) => ({ ...x, instructions: `${(x.instructions ?? '').replace(/\s*$/, '')}${x.instructions?.trim() ? '\n' : ''}${line}` }))}
                  >
                    + {label}
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="envs" className="rounded-xl border border-rule bg-wash px-5 pb-2 pt-4">
              <div className="flex items-baseline justify-between">
                <h2 id="envs" className="text-[13px] font-semibold">Environments</h2>
                <button className="text-[12px] text-accent hover:underline" onClick={() => setTab('envs')}>
                  Manage
                </button>
              </div>
              {p.envs.length === 0 && <p className="py-3 text-[12px] text-ink-faint">None yet — add where requests go.</p>}
              {p.envs.map((e) => {
                const missing = envVars(e).filter((v) => !secrets[v]);
                return (
                  <button
                    key={e.name}
                    onClick={() => setEnvName(e.name)}
                    className="flex w-full items-center gap-2.5 border-b border-rule py-2.5 text-left last:border-b-0"
                  >
                    <EnvDot name={e.name} />
                    <span className="w-[84px] shrink-0 truncate text-[12px] font-medium">{e.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{e.baseUrl || 'no base URL'}</span>
                    {missing.length > 0 && (
                      <span className="text-[11px] text-warn" title={`${missing.join(', ')} not set`}>
                        <Icon name="key" size={12} />
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] text-ink-faint">{e.allowWrites ? 'writes' : 'read-only'}</span>
                  </button>
                );
              })}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupHead({ left, right }: { left: string; right?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-5 pb-1.5 pt-2.5">
      <span className="label mb-0">{left}</span>
      {right && <span className="text-[11px] text-ink-faint">{right}</span>}
    </div>
  );
}

function ToolRow({ t, dim }: { t: ToolDef; dim?: boolean }): JSX.Element {
  const { selectTool, setTab } = useStore();
  const badge =
    t.safety === 'read' ? null : (
      <span className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${t.safety === 'write' ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad'}`}>
        {t.safety}
      </span>
    );
  return (
    <button
      onClick={() => {
        selectTool(t.id);
        setTab('requests');
      }}
      className={`grid w-full grid-cols-[200px_minmax(0,1fr)_auto] items-baseline gap-4 border-t border-rule px-5 py-2.5 text-left hover:bg-wash ${dim ? 'opacity-60' : ''}`}
    >
      <span className="truncate font-mono text-[12px]">{t.name}</span>
      <span className="truncate text-[12px] text-ink-muted">{t.description || <i className="text-ink-faint">No description yet</i>}</span>
      <span className="whitespace-nowrap font-mono text-[11px] text-ink-faint">{dim && badge ? badge : `${t.method} ${t.path}`}</span>
    </button>
  );
}
