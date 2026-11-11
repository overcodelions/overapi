import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { RenewButton } from './Renew';
import { WorkspaceMcp, workspaceScore } from './WorkspaceMcp';
import { EnvDot, InlineRename, Sheet } from './ui';
import { Icon, Monogram } from './icons';
import type { SystemRef } from '@shared/ipc';
import { offered, type AuthSpec, type Project } from '@shared/project';
import { findLinks, readablePath } from '@shared/chains';
import { mergedNames, systemEnvs } from '@shared/system';

type Member = { path: string; project?: Project; error?: string };

/// A guess at the member that signs the others in.
const SIGN_IN = /secur|auth|identity|login|sso|account|session|token/i;

const authLabel = (a: AuthSpec): string =>
  a.type === 'none'
    ? 'no sign-in'
    : a.type === 'via'
      ? `signed in by ${a.api}`
      : a.type === 'login'
        ? 'logs in with a request'
        : a.type === 'bearer'
          ? 'bearer token'
          : a.type === 'apiKey'
            ? `API key (${a.name})`
            : a.type === 'basic'
              ? 'user + password'
              : 'WS-Security';

/// A system's page: its APIs side by side — where each runs in each
/// environment, who signs them in, and the one MCP server they make.
export function SystemView(): JSX.Element {
  const { system: file, open, refreshSystems, say, openSheet } = useStore();
  const [sys, setSys] = useState<SystemRef | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newEnv, setNewEnv] = useState<string | null>(null);
  const [envPick, setEnvPick] = useState<string>('local');
  const [installs, setInstalls] = useState<Record<string, { at: string; name: string }>>({});
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'overview' | 'mcp'>('overview');

  const load = async () => {
    if (!file) return;
    const r = await window.overapi.invoke('systems:load', file);
    if (!r.ok) return setError(r.error);
    setError(null);
    setSys(r.system);
    setMembers(r.members);
    setInstalls(await window.overapi.invoke('systems:installs', file));
  };
  useEffect(() => void load(), [file]);

  const loaded = members.filter((m): m is Member & { project: Project } => !!m.project);
  const envs = useMemo(() => systemEnvs(loaded.map((m) => m.project)), [members]);
  useEffect(() => {
    if (envs.length && !envs.some((e) => e.name === envPick)) setEnvPick(envs[0].name);
  }, [envs]);
  const provider = loaded.find((m) => m.project.name === sys?.signedInBy);
  const wsScore = useMemo(() => workspaceScore(loaded, envPick), [members, envPick]);

  // The members as one server: names as the agent sees them, and the ids
  // that flow from one service to another.
  const merged = useMemo(() => {
    const withEnv = loaded.map((m) => ({ ...m, env: m.project.envs.find((e) => e.name === envPick) }));
    const named = mergedNames(withEnv.map((m) => ({ project: m.project, tools: m.project.tools })));
    const offeredCount = named.filter((n) => {
      const env = withEnv[n.member].env;
      return env && offered(n.tool, env);
    }).length;
    const renamed = named.filter((n) => n.name !== n.tool.name).length;
    const virtual: Project = {
      overapi: 1,
      name: 'system',
      title: 'system',
      description: '',
      version: '1',
      envs: [],
      tools: named.map((n) => ({ ...n.tool, id: `${n.member}|${n.tool.id}`, name: n.name })),
    };
    const memberOf = (id: string) => Number(id.split('|')[0]);
    const across = findLinks(virtual).filter((l) => memberOf(l.from) !== memberOf(l.to));
    return { offeredCount, renamed, across, memberOf, missing: withEnv.filter((m) => !m.env).map((m) => m.project.title) };
  }, [members, envPick]);

  if (error) return <div className="p-6 text-[13px] text-bad">{error}</div>;
  if (!sys) return <div className="p-6 text-[13px] text-ink-faint">Loading…</div>;

  const save = async (next: SystemRef) => {
    setSys(next);
    const r = await window.overapi.invoke('systems:save', next.path, next);
    if (!r.ok) say(r.error ?? 'Couldn’t save the workspace.', true);
    void refreshSystems();
  };
  const edit = async (m: Member, env: string, change: { baseUrl?: string; auth?: AuthSpec; copySignIn?: string }) => {
    const r = await window.overapi.invoke('systems:editMember', m.path, { env, ...change });
    if (!r.ok) say(r.error ?? 'Couldn’t save that.', true);
  };
  /// Whether an environment signs in by itself: a sign-in of its own, or a
  /// browser session.
  const ownHeaders = (e: Project['envs'][number]) => Object.keys(e.headers ?? {}).some((k) => /^(authorization|cookie)$/i.test(k));
  const signsIn = (e: Project['envs'][number]) => !!e.browserSession || ownHeaders(e) || (e.auth.type !== 'none' && e.auth.type !== 'via');
  const origin = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return u;
    }
  };
  /// Makes `by` the sign-in API: every other member, in every environment,
  /// carries its sign-in. Its own environments that pointed elsewhere take
  /// the sign-in of its environment at the same address, else none.
  const signAllIn = async (by: Member & { project: Project }) => {
    setBusy(true);
    let n = 0;
    for (const e of by.project.envs) {
      if (e.auth.type !== 'via') continue;
      // Its own sign-in headers (a browser session's): keep them.
      if (ownHeaders(e) || e.browserSession) {
        await edit(by, e.name, { auth: { type: 'none' } });
        continue;
      }
      const twin = by.project.envs.find((x) => x !== e && (ownHeaders(x) || x.browserSession) && origin(x.baseUrl) === origin(e.baseUrl));
      await edit(by, e.name, twin ? { copySignIn: twin.name } : { auth: { type: 'none' } });
    }
    for (const m of loaded) {
      if (m === by) continue;
      for (const e of m.project.envs) {
        if (e.auth.type === 'via' && e.auth.api === by.project.name) continue;
        await edit(m, e.name, { auth: { type: 'via', api: by.project.name, path: by.path } });
        n++;
      }
    }
    await save({ ...sys, signedInBy: by.project.name });
    await load();
    setBusy(false);
    say(`${by.project.title} now signs in the other ${loaded.length - 1} API${loaded.length === 2 ? '' : 's'}${n ? ` (${n} environment${n === 1 ? '' : 's'} changed)` : ''}.`);
  };
  const pointing = provider ? loaded.filter((m) => m !== provider && m.project.envs.some((e) => !(e.auth.type === 'via' && e.auth.api === provider.project.name))).length : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-5 px-6 py-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Icon name="folder" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <InlineRename value={sys.title} onRename={(v) => void save({ ...sys, title: v })} className="display text-[22px] font-semibold" />
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {loaded.length} APIs that belong together
              {provider ? (
                <>
                  {' '}
                  · signed in by <b className="text-ink">{provider.project.title}</b>
                </>
              ) : (
                ''
              )}
              . Each stays its own API; here you set where they run, who signs them in, and serve them together as one MCP server.
            </p>
          </div>
          <button className="btn" onClick={() => openSheet({ kind: 'system', members: sys.members })} title="Add or remove APIs">
            <Icon name="plus" size={13} /> APIs
          </button>
          <button
            className="btn"
            title="Removes the workspace; its APIs stay as they are"
            onClick={async () => {
              await window.overapi.invoke('systems:remove', sys.path);
              await refreshSystems();
              useStore.setState({ system: undefined });
              say(`Removed the ${sys.title} workspace. Its APIs are untouched.`);
            }}
          >
            Remove workspace
          </button>
        </div>

        <nav className="flex items-end gap-5 border-b border-rule">
          {(
            [
              ['overview', 'Overview'],
              ['mcp', 'MCP server'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[13.5px] font-medium ${tab === id ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
            >
              {id === 'mcp' && <Icon name="bot" size={14} className={tab === id ? 'text-accent' : 'text-ink-faint'} />}
              {label}
              {id === 'mcp' && (
                <span
                  className={`rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums ${wsScore.score >= 90 ? 'bg-good/15 text-good' : wsScore.score >= 60 ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad'}`}
                >
                  {wsScore.score}
                </span>
              )}
            </button>
          ))}
        </nav>

        <>
          {tab === 'overview' && (
            <>
              {/* Sign-in */}
              <section className="overflow-hidden rounded-xl border border-rule">
                <div className="flex items-center gap-3 border-b border-rule bg-wash px-4 py-3">
                  <Icon name="key" size={15} className="text-ink-muted" />
                  <h3 className="text-[13px] font-semibold">Sign-in</h3>
                  <span className="text-[12px] text-ink-muted">One API signs in; the others carry its sign-in.</span>
                  <span className="flex-1" />
                  <label className="text-[12px] text-ink-muted">Signed in by</label>
                  <select
                    className="field h-8 w-56 text-[12px]"
                    disabled={busy}
                    value={sys.signedInBy ?? ''}
                    onChange={(e) => {
                      const m = loaded.find((x) => x.project.name === e.target.value);
                      if (m) void signAllIn(m);
                      else void save({ ...sys, signedInBy: undefined });
                    }}
                  >
                    <option value="">— pick the sign-in API —</option>
                    {loaded.map((m) => (
                      <option key={m.path} value={m.project.name}>
                        {m.project.title}
                      </option>
                    ))}
                  </select>
                  {busy && <span className="text-[12px] text-ink-faint">Applying…</span>}
                  {!busy && provider && pointing > 0 && (
                    <button className="btn-primary h-8" onClick={() => void signAllIn(provider)} title="Some APIs here still use their own sign-in, or another API's">
                      Point {pointing} more at it
                    </button>
                  )}
                </div>
                {!sys.signedInBy && (
                  <p className="border-b border-rule px-4 py-2.5 text-[12px] text-ink-muted">
                    {loaded.some((m) => SIGN_IN.test(m.project.name)) ? (
                      <>
                        <b className="text-ink">{loaded.find((m) => SIGN_IN.test(m.project.name))!.project.title}</b> looks like the one that signs people in — pick it above.
                      </>
                    ) : (
                      'Pick the API whose sign-in the others accept — usually a security or auth service.'
                    )}
                  </p>
                )}
                <ul>
                  {loaded.map((m) => {
                    const isProvider = m === provider;
                    return (
                      <li key={m.path} className="flex items-center gap-3 border-t border-rule px-4 py-2.5 text-[12.5px] first:border-t-0">
                        <Monogram name={m.project.title} size={20} />
                        <button className="min-w-0 truncate font-medium hover:underline" onClick={() => void open(m.path, 'envs')}>
                          {m.project.title}
                        </button>
                        {isProvider && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] font-medium text-accent">signs the others in</span>}
                        {isProvider && m.project.envs.some((e) => e.name === envPick && signsIn(e) && (e.browserSession || e.auth.type === 'login')) && (
                          <RenewButton path={m.path} env={envPick} small label={`Sign in again (${envPick})`} onDone={() => void load()} />
                        )}
                        <span className="flex-1" />
                        <span className="flex flex-wrap justify-end gap-1.5">
                          {m.project.envs.map((e) => {
                            const ok = isProvider ? signsIn(e) : e.auth.type === 'via' && e.auth.api === sys.signedInBy;
                            if (isProvider && !ok)
                              return (
                                <button
                                  key={e.name}
                                  onClick={() => void open(m.path, 'envs')}
                                  title={`${m.project.title} has no sign-in for ${e.name} — the others get nothing there. Set one up.`}
                                  className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/20"
                                >
                                  <EnvDot name={e.name} />
                                  {e.name} · set up sign-in →
                                </button>
                              );
                            return (
                              <span
                                key={e.name}
                                title={`${e.name}: ${e.browserSession ? 'browser session' : authLabel(e.auth)}`}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${ok ? 'border-good/30 text-ink' : 'border-rule text-ink-faint'}`}
                              >
                                <EnvDot name={e.name} />
                                {e.name}
                                <span className={ok ? 'text-good' : 'text-ink-faint'}>{isProvider ? (e.browserSession ? 'browser' : authLabel(e.auth)) : ok ? '✓' : authLabel(e.auth)}</span>
                              </span>
                            );
                          })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Environments */}
              <section className="overflow-hidden rounded-xl border border-rule">
                <div className="flex items-center gap-3 border-b border-rule bg-wash px-4 py-3">
                  <Icon name="envs" size={15} className="text-ink-muted" />
                  <h3 className="text-[13px] font-semibold">Where each one runs</h3>
                  <span className="text-[12px] text-ink-muted">Every API in every environment, in one place. Saved as you leave a field.</span>
                  <span className="flex-1" />
                  {newEnv === null ? (
                    <button className="btn h-8" onClick={() => setNewEnv('')}>
                      <Icon name="plus" size={12} /> Environment
                    </button>
                  ) : (
                    <input
                      autoFocus
                      className="field h-8 w-40 text-[12px]"
                      placeholder="staging"
                      value={newEnv}
                      onChange={(e) => setNewEnv(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                      onKeyDown={(e) => e.key === 'Escape' && setNewEnv(null)}
                      onBlur={() => !newEnv && setNewEnv(null)}
                    />
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
                        <th className="w-[200px] px-4 py-2 font-semibold">API</th>
                        {[...envs.map((e) => e.name), ...(newEnv ? [newEnv] : [])].map((n) => (
                          <th key={n} className="min-w-[220px] px-2 py-2 font-semibold">
                            <span className="inline-flex items-center gap-1.5 normal-case tracking-normal text-[12px] text-ink">
                              <EnvDot name={n} /> {n}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {loaded.map((m) => (
                        <tr key={m.path} className="border-t border-rule">
                          <td className="px-4 py-1.5">
                            <button className="flex min-w-0 items-center gap-2 hover:underline" onClick={() => void open(m.path)}>
                              <Monogram name={m.project.title} size={18} />
                              <span className="truncate">{m.project.title}</span>
                            </button>
                          </td>
                          {[...envs.map((e) => e.name), ...(newEnv ? [newEnv] : [])].map((n) => {
                            const env = m.project.envs.find((e) => e.name === n);
                            return (
                              <td key={n} className="px-2 py-1.5">
                                <input
                                  key={`${m.path}:${n}:${env?.baseUrl ?? ''}`}
                                  className={`field h-8 font-mono text-[11.5px] ${env ? '' : 'border-dashed'}`}
                                  defaultValue={env?.baseUrl ?? ''}
                                  placeholder={env ? 'no base URL' : `add ${n}…`}
                                  onBlur={async (e) => {
                                    const v = e.target.value.trim();
                                    if (v === (env?.baseUrl ?? '') || (!env && !v)) return;
                                    await edit(m, n, { baseUrl: v });
                                    await load();
                                    if (newEnv === n) setNewEnv(null);
                                  }}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {envs.some((e) => !e.all) && (
                  <p className="border-t border-rule px-4 py-2 text-[11.5px] text-ink-faint">
                    Dashed: that API has no such environment yet — type its address to add it (read-only to agents, like any new environment{provider ? `, signed in by ${provider.project.title}` : ''}
                    ).
                  </p>
                )}
              </section>
            </>
          )}
          {tab === 'mcp' && <WorkspaceMcp sys={sys} loaded={loaded} envs={envs} envPick={envPick} setEnvPick={setEnvPick} reload={load} />}
        </>
        {members.some((m) => m.error) && (
          <p className="text-[12px] text-warn">
            Couldn’t read:{' '}
            {members
              .filter((m) => m.error)
              .map((m) => m.path)
              .join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}

/// Grouping APIs into a workspace, or changing which are in one.
export function SystemSheet({ members: initial }: { members?: string[] }): JSX.Element {
  const { projects, systems, system: openPath, openSheet, refreshSystems, openSystem, say } = useStore();
  const editing = initial ? systems.find((s) => s.path === openPath) : undefined;
  const [title, setTitle] = useState(editing?.title ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set(initial ?? []));
  const [signIn, setSignIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const usable = projects.filter((p) => !p.missing);
  const chosen = usable.filter((p) => picked.has(p.path));
  const provider = chosen.find((p) => SIGN_IN.test(p.name));
  const inOther = (p: string) => systems.find((s) => s.path !== editing?.path && s.members.includes(p));

  const create = async () => {
    setBusy(true);
    if (editing) {
      const r = await window.overapi.invoke('systems:save', editing.path, { ...editing, title: title.trim() || editing.title, members: chosen.map((p) => p.path) });
      setBusy(false);
      if (!r.ok) return say(r.error ?? 'Couldn’t save.', true);
      await refreshSystems();
      openSheet(null);
      useStore.setState({ system: undefined });
      openSystem(editing.path);
      return;
    }
    const r = await window.overapi.invoke('systems:create', { title: title.trim() || 'Workspace', members: chosen.map((p) => p.path), signedInBy: provider?.name });
    if (!r.ok) {
      setBusy(false);
      return say(r.error, true);
    }
    // Sign the others in with the sign-in API, in every environment they have.
    let n = 0;
    if (provider && signIn) {
      for (const m of chosen) {
        if (m === provider) continue;
        const loaded = await window.overapi.invoke('projects:load', m.path);
        if (!loaded.ok) continue;
        for (const e of loaded.project.envs) {
          await window.overapi.invoke('systems:editMember', m.path, { env: e.name, auth: { type: 'via', api: provider.name, path: provider.path } });
          n++;
        }
      }
    }
    setBusy(false);
    await refreshSystems();
    openSheet(null);
    openSystem(r.path);
    say(`Grouped ${chosen.length} APIs${n ? `, signed in by ${provider!.title}` : ''}.`);
  };

  return (
    <Sheet
      title={editing ? `APIs in ${editing.title}` : 'New workspace'}
      onClose={() => openSheet(null)}
      footer={
        <>
          <span className="flex-1 text-[12px] text-ink-muted">
            {chosen.length} API{chosen.length === 1 ? '' : 's'} picked
          </span>
          <button className="btn" onClick={() => openSheet(null)}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy || chosen.length < 2} onClick={() => void create()}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create workspace'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          A workspace holds APIs that belong together — the services of one product. Each keeps its own requests; together they share one sign-in, their environments sit side by side, and they can be
          served as one MCP server.
        </p>
        <div>
          <label className="label">Name</label>
          <input className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Partner platform" />
        </div>
        <div>
          <label className="label">APIs in it</label>
          <ul className="max-h-[280px] overflow-y-auto rounded-xl border border-rule">
            {usable.map((p) => {
              const other = inOther(p.path);
              return (
                <li key={p.path} className="border-t border-rule first:border-t-0">
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[12.5px] hover:bg-wash">
                    <input
                      type="checkbox"
                      checked={picked.has(p.path)}
                      onChange={(e) =>
                        setPicked((s) => {
                          const n = new Set(s);
                          e.target.checked ? n.add(p.path) : n.delete(p.path);
                          return n;
                        })
                      }
                    />
                    <Monogram name={p.title} size={20} />
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    {other && <span className="text-[11px] text-ink-faint">also in {other.title}</span>}
                    {p === provider && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] font-medium text-accent">signs in</span>}
                    <span className="text-[11px] text-ink-faint">{p.tools} requests</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        {!editing && provider && (
          <label className="flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-[12.5px]">
            <input type="checkbox" className="mt-0.5" checked={signIn} onChange={(e) => setSignIn(e.target.checked)} />
            <span>
              Sign the others in with <b>{provider.title}</b> — its sign-in goes on their requests, in each environment of the same name. You can change it later on the workspace page.
            </span>
          </label>
        )}
      </div>
    </Sheet>
  );
}
