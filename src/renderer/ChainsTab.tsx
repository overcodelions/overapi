import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Method } from './ui';
import { Icon } from './icons';
import { applyLinks, applyShared, applyTidy, findLinks, readablePath, sharedValues, tidyUps, type Link } from '@shared/chains';
import { shapeOf } from '@shared/scenario';
import type { Installs } from '@shared/ipc';

/// How the requests connect — in words anyone can follow. One request's
/// answer is the next one's question: list the teams, pick one, ask for
/// that team. Connected chains are what let an agent do that on its own.
export function ChainsTab(): JSX.Element {
  const { project, env: envName, update, say, selectTool, setTab } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const links = useMemo(() => findLinks(p), [p]);
  const shared = useMemo(() => sharedValues(p, env), [p, env]);
  const tidy = useMemo(() => tidyUps(p), [p]);
  const unknown = p.tools.filter((t) => t.method === 'GET' && !t.returns);
  const open = links.filter((l) => !l.done);

  // One card per source: "list_season_teams gives team_id to …".
  const bySource = useMemo(() => {
    const m = new Map<string, Link[]>();
    for (const l of links) m.set(`${l.from}|${l.path}|${l.param}`, [...(m.get(`${l.from}|${l.path}|${l.param}`) ?? []), l]);
    return [...m.values()].sort((a, b) => b.length - a.length);
  }, [links]);

  const connect = (ls: Link[]) => {
    update((x) => applyLinks(x, ls));
    say(ls.length === 1 ? `${ls[0].toName} now takes ${ls[0].param} from ${ls[0].fromName}.` : `Connected ${ls.length} arguments to where they come from.`);
  };
  const open1 = (id: string) => {
    selectTool(id);
    setTab('requests');
  };

  return (
    <div className="h-full overflow-y-auto px-8 py-5">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Some requests need something another request gives back — to get a team, you need the team’s id, and listing the teams is where you find it. These are <b className="text-ink">chains</b>.
        Connected, the first request keeps the value, the next one uses it, and each argument tells an agent where to get it — so an agent can go from “list the teams” to “that
        team’s next match” on its own.
      </p>

      {shared.length > 0 && (
        <section className="mt-6">
          <h3 className="text-[14px] font-semibold">The same every time</h3>
          <p className="mt-0.5 text-[12px] text-ink-muted">These go with every request with the same value. Fix them for {env?.name} and agents never have to know them.</p>
          <div className="mt-3 space-y-2">
            {shared.map((s) => (
              <div key={s.name} className="flex flex-wrap items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3">
                <span className="font-mono text-[13px]">{s.name}</span>
                <span className="text-ink-faint">is always</span>
                <span className="rounded bg-wash-strong px-2 py-0.5 font-mono text-[13px]">{s.value}</span>
                <span className="text-[12px] text-ink-faint">
                  in {s.tools.length} requests{s.in === 'query' ? ' (agents can still change it)' : ''}
                </span>
                <span className="flex-1" />
                <button
                  className="btn-primary"
                  onClick={() => {
                    update((x) => applyShared(x, env!.name, s));
                    say(`${s.name} is now ${s.value} for ${env!.name} — agents won’t be asked for it.`);
                  }}
                >
                  Fix it for {env?.name}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-7">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="text-[14px] font-semibold">Chains</h3>
          <span className="text-[12px] text-ink-muted">
            {links.length ? `${links.length - open.length} of ${links.length} connected` : 'none found yet'}
          </span>
          <span className="flex-1" />
          {open.length > 0 && (
            <button className="btn-primary" onClick={() => connect(open)}>
              Connect all {open.length}
            </button>
          )}
        </div>
        {links.length === 0 && (
          <p className="mt-2 text-[12px] text-ink-faint">
            {unknown.length ? 'overapi doesn’t know yet what these requests answer. Send them once (below), or record the site again, and the chains appear.' : 'No request here needs a value another one gives back.'}
          </p>
        )}
        <div className="mt-3 space-y-2.5">
          {bySource.map((group) => {
            const first = group[0];
            const from = p.tools.find((t) => t.id === first.from);
            const allDone = group.every((l) => l.done);
            return (
              <article key={`${first.from}|${first.path}|${first.param}`} className={`rounded-xl border p-4 ${allDone ? 'border-rule' : 'border-accent/40 bg-accent/[0.04]'}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  {from && <Method method={from.method} />}
                  <button className="font-mono text-[13px] hover:underline" onClick={() => open1(first.from)}>
                    {first.fromName}
                  </button>
                  <span className="text-ink-faint">gives</span>
                  <span className="rounded bg-accent/15 px-2 py-0.5 font-mono text-[12px] text-accent">{first.param}</span>
                  <span className="text-[12px] text-ink-faint">from {readablePath(first.path)}</span>
                  <span className="flex-1" />
                  {allDone ? (
                    <span className="flex items-center gap-1 text-[12px] text-good">
                      <Icon name="check" size={12} /> connected
                    </span>
                  ) : (
                    <button className="btn" onClick={() => connect(group.filter((l) => !l.done))}>
                      Connect
                    </button>
                  )}
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-1">
                  <Icon name="chevron" size={13} className="text-ink-faint" />
                  <span className="text-[12px] text-ink-faint">needed by</span>
                  {group.map((l) => (
                    <button key={l.to} onClick={() => open1(l.to)} className={`rounded-md border px-2 py-0.5 font-mono text-[12px] hover:bg-wash ${l.done ? 'border-good/40 text-ink' : 'border-rule text-ink-muted'}`}>
                      {l.toName}
                      {l.done && <span className="ml-1 text-good">✓</span>}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {unknown.length > 0 && <Learn ids={unknown.map((t) => t.id)} />}

      {tidy.length > 0 && (
        <section className="mt-7">
          <h3 className="text-[14px] font-semibold">Tidy up</h3>
          <p className="mt-0.5 text-[12px] text-ink-muted">Things the recording picked up that aren’t really part of the API.</p>
          <div className="mt-3 space-y-2">
            {tidy.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-rule px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{t.title}</div>
                  <div className="text-[12px] text-ink-muted">{t.detail}</div>
                </div>
                <button
                  className="btn"
                  onClick={() => {
                    update((x) => applyTidy(x, t));
                    say(t.remove === 'tool' ? 'Removed.' : `Removed the argument ${t.remove.param}.`);
                  }}
                >
                  {t.remove === 'tool' ? 'Remove the request' : 'Remove the argument'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/// Requests whose answers overapi hasn't seen: send each once (reads only,
/// with its saved values) to learn their shape — and so their chains.
function Learn({ ids }: { ids: string[] }): JSX.Element {
  const { project, path, env: envName, update, say } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [busy, setBusy] = useState<string | null>(null);
  const ready = ids.map((id) => p.tools.find((t) => t.id === id)!).filter((t) => t && t.params.every((x) => !x.required || (t.example?.[x.name] !== undefined && t.example?.[x.name] !== '') || x.schema.default !== undefined));
  const learn = async () => {
    let n = 0;
    for (const t of ready) {
      setBusy(t.name);
      const r = await window.overapi.invoke('tool:try', { path: path!, project: p, env: env.name, toolId: t.id, args: t.example ?? {} });
      try {
        const json = r.ok ? JSON.parse(r.full ?? r.body ?? '') : undefined;
        if (json !== undefined) {
          n++;
          update((x) => ({ ...x, tools: x.tools.map((y) => (y.id === t.id ? { ...y, returns: shapeOf(json) } : y)) }));
        }
      } catch {
        /* not JSON */
      }
    }
    setBusy(null);
    say(`Learned what ${n} request${n === 1 ? '' : 's'} answer${n === 1 ? 's' : ''}.`);
  };
  return (
    <section className="mt-7 rounded-xl border border-dashed border-rule px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">overapi hasn’t seen what {ids.length} request{ids.length === 1 ? '' : 's'} answer</div>
          <div className="text-[12px] text-ink-muted">
            {ready.length
              ? `Send the ${ready.length} that are ready once — reads only, on ${env?.name} — and the chains they start appear here.`
              : 'They need values nobody has saved yet. Send them from Requests, or record the site again.'}
          </div>
        </div>
        {ready.length > 0 && (
          <button className="btn" disabled={!!busy} onClick={() => void learn()}>
            {busy ? `Sending ${busy}…` : `Send ${ready.length} to learn`}
          </button>
        )}
      </div>
    </section>
  );
}

/// The way from a recording (or an import) to an MCP server, as a small
/// chip in the top bar — "Agent-ready 1/4" — that opens the four steps. Out
/// of the way while the API is being worked on, one click when it's time.
export function Journey(): JSX.Element | null {
  const { project, path, env: envName, setTab, setMcpTab, openSheet } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const key = `overapi:journey:${path}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === 'hidden';
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  const [installs, setInstalls] = useState<Installs | null>(null);
  useEffect(() => {
    void window.overapi.invoke('installs:get', path!).then(setInstalls);
  }, [path]);
  const links = useMemo(() => findLinks(p), [p]);
  const shared = useMemo(() => sharedValues(p, env), [p, env]);
  const tried = (() => {
    try {
      return localStorage.getItem(`overapi:tried:${path}`) === 'yes';
    } catch {
      return false;
    }
  })();
  const published = !!installs && (Object.keys(installs.claude).length > 0 || !!installs.overgo);
  if (hidden || published || !p.tools.length) return null;

  const pending = links.filter((l) => !l.done).length + shared.length;
  const weak = p.tools.filter((t) => t.enabled && (!t.description || /seen \d+ times? in the capture|inferred from \d+ captured/i.test(t.description))).length;
  const tools = p.tools.filter((t) => t.enabled).length;
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const steps = [
    { n: 1, title: `${p.tools.length} requests`, text: p.source?.kind === 'har' ? 'Found from what the site asked its server.' : 'Each one is something you can ask the API.', done: true, go: go(() => setTab('requests')), cta: 'See them' },
    { n: 2, title: 'Make it agent-ready', text: pending || weak ? `${pending ? `${pending} to connect` : ''}${pending && weak ? ', ' : ''}${weak ? `${weak} to describe` : ''} — tidied, connected and documented in one pass.` : 'Connected and described.', done: pending === 0 && weak === 0, go: go(() => openSheet({ kind: 'agentready' })), cta: pending || weak ? 'Make it agent-ready' : 'Review' },
    { n: 3, title: 'Try it as an AI would', text: `Call the ${tools} tools exactly as Claude will see them.`, done: tried, go: go(() => { setTab('mcp'); setMcpTab('test'); }), cta: 'Try it' },
    { n: 4, title: 'Publish', text: 'Add it to Claude Code on this Mac, or share it with your team.', done: false, go: go(() => openSheet({ kind: 'publish' })), cta: 'Publish…' },
  ];
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done) ?? steps[3];
  const r = 7;
  const c = 2 * Math.PI * r;

  return (
    <div className="relative">
      <button
        className={`flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${open ? 'border-accent bg-accent/10 text-ink' : 'border-rule text-ink-muted hover:text-ink'}`}
        title="From this API to an AI tool — what’s done and what’s next"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - done / 4)} strokeLinecap="round" className="text-accent" />
        </svg>
        Agent-ready {done}/4
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1.5 w-[380px] rounded-xl border border-rule bg-surface p-3 shadow-xl">
            <div className="px-1 pb-2">
              <div className="text-[13px] font-semibold">From this API to an AI tool</div>
              <div className="text-[12px] text-ink-muted">An MCP server: the tools Claude and other agents can use.</div>
            </div>
            <ol className="space-y-1.5">
              {steps.map((s) => {
                const current = s === next;
                return (
                  <li key={s.n} className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 ${current ? 'bg-accent/10' : ''}`}>
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${s.done ? 'bg-good/20 text-good' : current ? 'bg-accent text-white' : 'bg-wash-strong text-ink-muted'}`}>{s.done ? '✓' : s.n}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{s.title}</div>
                      <div className="text-[11.5px] leading-snug text-ink-muted">{s.text}</div>
                      {current && (
                        <button className="btn-primary mt-1.5 !py-1 text-[12px]" onClick={s.go}>
                          {s.cta}
                        </button>
                      )}
                    </div>
                    {!current && (
                      <button className="shrink-0 text-[12px] text-accent hover:underline" onClick={s.go}>
                        {s.cta}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="mt-2 flex justify-end border-t border-rule px-1 pt-2">
              <button
                className="text-[11px] text-ink-faint hover:text-ink"
                onClick={() => {
                  setHidden(true);
                  try {
                    localStorage.setItem(key, 'hidden');
                  } catch {
                    /* shown again next time */
                  }
                }}
              >
                Hide for this API
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
