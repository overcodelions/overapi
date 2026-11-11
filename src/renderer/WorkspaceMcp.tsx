import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { EnvDot, Method, SafetyBadge, TryAgentTab } from './ui';
import { Icon, Monogram } from './icons';
import { AskPanel } from './AskPanel';
import type { SystemRef } from '@shared/ipc';
import { envVars, groupOf, offered, varPrefix, type Project } from '@shared/project';
import { findLinks, readablePath } from '@shared/chains';
import { mergedNames } from '@shared/system';
import { checkProject, TOOL_BUDGET } from '@shared/check';
import { scanProject, type Finding } from '@shared/scan';
import { suggestOff } from '@shared/curate';

type Member = { path: string; project: Project };
type Sub = 'tools' | 'chains' | 'security' | 'ask';

/// The members as one server on an environment: each tool under the name
/// the merged server gives it, which member it is from, whether it's offered.
function combine(loaded: Member[], envName: string) {
  const withEnv = loaded.map((m) => ({ ...m, env: m.project.envs.find((e) => e.name === envName) }));
  const named = mergedNames(withEnv.map((m) => ({ project: m.project, tools: m.project.tools })));
  const rows = named.map((n) => ({ ...n, on: !!withEnv[n.member].env && offered(n.tool, withEnv[n.member].env!) }));
  const virtual: Project = {
    overapi: 1,
    name: 'workspace',
    title: 'workspace',
    description: '',
    version: '1',
    envs: [],
    tools: rows.map((r) => ({ ...r.tool, id: `${r.member}|${r.tool.id}`, name: r.name, enabled: r.on })),
  };
  const memberOf = (id: string) => Number(id.split('|')[0]);
  const idOf = (id: string) => id.slice(id.indexOf('|') + 1);
  return { rows, virtual, memberOf, idOf, missing: withEnv.filter((m) => !m.env).map((m) => m.project.title) };
}

/// How ready the workspace is for an agent: its APIs' readiness, less a
/// penalty for offering more tools than an agent handles well.
export function workspaceScore(loaded: Member[], envName: string): { score: number; offered: number } {
  if (!loaded.length) return { score: 0, offered: 0 };
  const ready = loaded.map((m) => checkProject(m.project, Object.fromEntries(m.project.envs.flatMap((e) => envVars(e)).map((v) => [v, true]))).score);
  const offeredN = combine(loaded, envName).rows.filter((r) => r.on).length;
  const avg = ready.reduce((a, b) => a + b, 0) / ready.length;
  const penalty = Math.min(40, Math.max(0, offeredN - TOOL_BUDGET) / 2);
  return { score: Math.max(0, Math.round(avg - penalty)), offered: offeredN };
}

export function WorkspaceMcp({
  sys,
  loaded,
  envs,
  envPick,
  setEnvPick,
  reload,
}: {
  sys: SystemRef;
  loaded: Member[];
  envs: { name: string }[];
  envPick: string;
  setEnvPick: (e: string) => void;
  reload: () => Promise<void>;
}): JSX.Element {
  const { say } = useStore();
  const [sub, setSub] = useState<Sub>('tools');
  const [installs, setInstalls] = useState<Record<string, { at: string; name: string }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => void window.overapi.invoke('systems:installs', sys.path).then(setInstalls), [sys.path]);
  const c = useMemo(() => combine(loaded, envPick), [loaded, envPick]);
  const across = useMemo(() => findLinks(c.virtual).filter((l) => c.memberOf(l.from) !== c.memberOf(l.to)), [c]);
  const { score, offered: offeredN } = useMemo(() => workspaceScore(loaded, envPick), [loaded, envPick]);
  const scans = useMemo(() => loaded.map((m) => ({ m, scan: scanProject(m.project, varPrefix(m.project.name)) })), [loaded]);
  const secScore = scans.length ? Math.min(...scans.map((x) => x.scan.score)) : 100;
  const tone = (n: number) => (n >= 90 ? 'text-good' : n >= 60 ? 'text-warn' : 'text-bad');

  const install = async () => {
    setBusy(true);
    const r = await window.overapi.invoke('systems:install', sys.path, envPick);
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    setInstalls(await window.overapi.invoke('systems:installs', sys.path));
    say(`Added ${r.name} to Claude Code — ${offeredN} tools from ${loaded.length} APIs. Start a new Claude session to use it.`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-full border border-rule-strong bg-wash-strong p-0.5">
          {envs.map((e) => (
            <button
              key={e.name}
              onClick={() => setEnvPick(e.name)}
              className={`flex h-[24px] items-center gap-1.5 rounded-full px-2.5 text-[12px] ${envPick === e.name ? 'bg-surface-elevated font-semibold shadow-sm' : 'text-ink-muted hover:text-ink'}`}
            >
              <EnvDot name={e.name} /> {e.name}
            </button>
          ))}
        </div>
        {c.missing.length > 0 && (
          <span className="text-[12px] text-warn">
            {c.missing.join(', ')} {c.missing.length === 1 ? 'has' : 'have'} no {envPick} environment — left out.
          </span>
        )}
        <span className="flex-1" />
        {installs[envPick] && (
          <span className="flex items-center gap-1 text-[12px] text-good">
            <Icon name="check" size={12} /> In Claude Code as <span className="font-mono">{installs[envPick].name}</span>
          </span>
        )}
        <button className="btn-primary" disabled={busy || !offeredN} onClick={() => void install()}>
          <Icon name="publish" size={13} /> {installs[envPick] ? 'Update in Claude Code' : 'Add to Claude Code'}
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2.5">
        <Tile
          label={`Tools on ${envPick}`}
          value={String(offeredN)}
          note={offeredN > TOOL_BUDGET ? `over the budget of ${TOOL_BUDGET} — turn some off` : `within the budget of ${TOOL_BUDGET}`}
          warn={offeredN > TOOL_BUDGET}
          onClick={() => setSub('tools')}
        />
        <Tile
          label="Ready for agents"
          value={String(score)}
          tone={tone(score)}
          note={offeredN > TOOL_BUDGET ? 'held back by the tool count' : 'from its APIs’ readiness'}
          onClick={() => setSub('tools')}
        />
        <Tile label="Ids across services" value={String(across.length)} note="one API’s output, another’s input" onClick={() => setSub('chains')} />
        <Tile
          label="Security"
          value={String(secScore)}
          tone={tone(secScore)}
          note={`its weakest API · ${scans.reduce((n, x) => n + x.scan.blocking.length, 0)} blocking`}
          onClick={() => setSub('security')}
        />
      </div>

      <nav className="flex items-end gap-4 border-b border-rule">
        {(
          [
            ['tools', 'Tools', 'bot'],
            ['chains', 'Chains', 'plug'],
            ['security', 'Security', 'lock'],
            ['ask', 'Try as an agent', 'send'],
          ] as const
        ).map(([id, label, icon]) =>
          id === 'ask' ? (
            <TryAgentTab key={id} on={sub === id} onClick={() => setSub(id)} />
          ) : (
            <button
              key={id}
              onClick={() => setSub(id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[13px] font-medium ${sub === id ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
            >
              <Icon name={icon} size={13} className={sub === id ? 'text-accent' : 'text-ink-faint'} /> {label}
            </button>
          ),
        )}
      </nav>

      {sub === 'tools' && <Tools loaded={loaded} c={c} offeredN={offeredN} reload={reload} />}
      {sub === 'chains' && <Chains loaded={loaded} c={c} across={across} reload={reload} />}
      {sub === 'security' && <Security scans={scans} />}
      {sub === 'ask' && (
        <FillBelow className="-mx-6 -mb-6 overflow-hidden">
          <AskPanel
            key={`${sys.path}:${envPick}`}
            env={envPick}
            target={{
              path: sys.path,
              project: { ...c.virtual, title: sys.title, examples: undefined },
              onOpenTool: (name) => {
                const r = c.rows.find((x) => x.name === name);
                if (r)
                  void useStore
                    .getState()
                    .open(loaded[r.member].path, 'requests')
                    .then(() => useStore.getState().selectTool(r.tool.id));
              },
            }}
          />
        </FillBelow>
      )}
    </div>
  );
}

/// A box from where it starts down to the bottom of the window — so a chat's
/// input sits at the bottom whatever is above it.
function FillBelow({ className, children }: { className?: string; children: React.ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(480);
  useLayoutEffect(() => {
    const fit = () => {
      const top = ref.current?.getBoundingClientRect().top ?? 0;
      setH(Math.max(360, window.innerHeight - top));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div ref={ref} className={className} style={{ height: h }}>
      {children}
    </div>
  );
}

function Tile({ label, value, note, tone, warn, onClick }: { label: string; value: string; note: string; tone?: string; warn?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button onClick={onClick} className={`flex flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 text-left hover:brightness-110 ${warn ? 'border-warn/40 bg-warn/[0.05]' : 'border-rule bg-surface'}`}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className={`display text-[22px] font-semibold tabular-nums leading-tight ${tone ?? (warn ? 'text-warn' : '')}`}>{value}</span>
      <span className="truncate text-[11px] text-ink-muted">{note}</span>
    </button>
  );
}

type Combined = ReturnType<typeof combine>;

type Show = 'all' | 'on' | 'off' | 'suggested';
type GroupBy = 'api' | 'area' | 'safety' | 'none';
type SortBy = 'listed' | 'name' | 'suggested';
const SAFETY_ORDER = { read: 0, write: 1, destructive: 2 } as const;
const SAFETY_TITLE = { read: 'Reads', write: 'Changes data', destructive: 'Destructive' } as const;

/// Every member's tools in one list: what to show, how to group it, how
/// to sort it — on or off for agents, with what to turn off first.
function Tools({ loaded, c, offeredN, reload }: { loaded: Member[]; c: Combined; offeredN: number; reload: () => Promise<void> }): JSX.Element {
  const { say } = useStore();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('api');
  const [sortBy, setSortBy] = useState<SortBy>('listed');
  const [working, setWorking] = useState(false);
  const suggestions = useMemo(() => suggestOff(c.virtual, undefined, TOOL_BUDGET), [c]);
  const why = new Map(suggestions.map((s) => [s.toolId, s.reason]));
  const set = async (pairs: { member: number; id: string }[], enabled: boolean) => {
    if (!pairs.length) return;
    setWorking(true);
    const byMember = new Map<number, string[]>();
    for (const p of pairs) byMember.set(p.member, [...(byMember.get(p.member) ?? []), p.id]);
    for (const [m, ids] of byMember) await window.overapi.invoke('systems:setEnabled', loaded[m].path, ids, enabled);
    await reload();
    setWorking(false);
  };

  const needle = q.trim().toLowerCase();
  const reasonOf = (r: Combined['rows'][number]) => why.get(`${r.member}|${r.tool.id}`);
  const visible = c.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (show === 'on' ? r.on : show === 'off' ? !r.on : show === 'suggested' ? !!reasonOf(r) : true))
    .filter(({ r }) => !needle || `${r.name} ${r.tool.path} ${r.tool.description}`.toLowerCase().includes(needle))
    .sort((a, b) => (sortBy === 'name' ? a.r.name.localeCompare(b.r.name) : sortBy === 'suggested' ? Number(!!reasonOf(b.r)) - Number(!!reasonOf(a.r)) || a.i - b.i : a.i - b.i))
    .map(({ r }) => r);

  const groups: { key: string; title: string; member?: number; rows: typeof visible }[] = (() => {
    const out = new Map<string, { key: string; title: string; member?: number; rows: typeof visible }>();
    const put = (key: string, title: string, r: (typeof visible)[number], member?: number) => {
      if (!out.has(key)) out.set(key, { key, title, member, rows: [] });
      out.get(key)!.rows.push(r);
    };
    for (const r of visible) {
      if (groupBy === 'api') put(String(r.member), loaded[r.member].project.title, r, r.member);
      else if (groupBy === 'area') put(`${r.member}:${groupOf(r.tool)}`, `${groupOf(r.tool)} · ${loaded[r.member].project.title}`, r, r.member);
      else if (groupBy === 'safety') put(r.tool.safety, SAFETY_TITLE[r.tool.safety], r);
      else put('all', 'All tools', r);
    }
    const list = [...out.values()];
    return groupBy === 'safety' ? list.sort((a, b) => SAFETY_ORDER[a.key as keyof typeof SAFETY_ORDER] - SAFETY_ORDER[b.key as keyof typeof SAFETY_ORDER]) : list;
  })();

  const seg = <T extends string>(value: T, setValue: (v: T) => void, opts: [T, string][]) => (
    <div className="inline-flex rounded-md border border-rule-strong bg-canvas p-0.5 text-[11.5px]">
      {opts.map(([v, label]) => (
        <button key={v} type="button" onClick={() => setValue(v)} className={`rounded px-2 py-0.5 ${value === v ? 'bg-wash-strong font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span>
            <b className={offeredN > TOOL_BUDGET ? 'text-warn' : 'text-ink'}>{offeredN}</b>{' '}
            <span className="text-ink-muted">of a budget of {TOOL_BUDGET} offered — past that, agents pick worse and pay for the list every turn.</span>
          </span>
          {suggestions.length > 0 && (
            <button
              className="btn h-7 shrink-0 text-[12px]"
              disabled={working}
              onClick={async () => {
                await set(
                  suggestions.map((s) => ({ member: c.memberOf(s.toolId), id: c.idOf(s.toolId) })),
                  false,
                );
                say(`Turned off ${suggestions.length} tools. Turn any back on here or in its API.`);
              }}
            >
              Turn off the {suggestions.length} suggested
            </button>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-wash-strong">
          <div className={`h-full rounded-full ${offeredN > TOOL_BUDGET ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.min(100, (offeredN / Math.max(TOOL_BUDGET, offeredN)) * 100)}%` }} />
        </div>
      </div>

      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 bg-canvas/95 px-1 py-2 backdrop-blur">
        <label className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          Show
          {seg(show, setShow, [
            ['all', `All ${c.rows.length}`],
            ['on', `Offered ${c.rows.filter((r) => r.on).length}`],
            ['off', `Off ${c.rows.filter((r) => !r.on).length}`],
            ['suggested', `Suggested off ${suggestions.length}`],
          ])}
        </label>
        <label className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          Group by
          {seg(groupBy, setGroupBy, [
            ['api', 'API'],
            ['area', 'Area'],
            ['safety', 'Safety'],
            ['none', 'None'],
          ])}
        </label>
        <label className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          Sort
          {seg(sortBy, setSortBy, [
            ['listed', 'As listed'],
            ['name', 'A–Z'],
            ['suggested', 'Suggested first'],
          ])}
        </label>
        <span className="flex-1" />
        <input className="field h-7 w-52 py-0 text-[12px]" placeholder="Filter by name, path, description" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {!visible.length && <p className="py-6 text-center text-[13px] text-ink-muted">Nothing here with these filters.</p>}
      {groups.map((g) => {
        const on = g.rows.filter((r) => r.on).length;
        return (
          <section key={g.key} className="overflow-hidden rounded-xl border border-rule bg-surface">
            <div className="flex items-center gap-2.5 border-b border-rule bg-wash px-3.5 py-2">
              {g.member !== undefined && <Monogram name={loaded[g.member].project.title} size={20} />}
              <span className="text-[13px] font-semibold">{g.title}</span>
              <span className="text-[12px] text-ink-faint">
                {on} of {g.rows.length} on
              </span>
              <span className="flex-1" />
              <button
                className="text-[11.5px] text-ink-muted hover:text-ink"
                disabled={working}
                onClick={() =>
                  void set(
                    g.rows.filter((r) => r.tool.enabled).map((r) => ({ member: r.member, id: r.tool.id })),
                    false,
                  )
                }
              >
                All off
              </button>
              <button
                className="text-[11.5px] text-ink-muted hover:text-ink"
                disabled={working}
                onClick={() =>
                  void set(
                    g.rows.filter((r) => !r.tool.enabled).map((r) => ({ member: r.member, id: r.tool.id })),
                    true,
                  )
                }
              >
                All on
              </button>
            </div>
            <ul className="divide-y divide-rule">
              {g.rows.map((r) => {
                const reason = reasonOf(r);
                return (
                  <li key={`${r.member}:${r.tool.id}`} className={`flex items-center gap-3 px-3.5 py-1.5 ${r.on ? '' : 'opacity-55'}`}>
                    <input
                      type="checkbox"
                      checked={r.tool.enabled}
                      disabled={working}
                      onChange={(e) => void set([{ member: r.member, id: r.tool.id }], e.target.checked)}
                      aria-label={`Offer ${r.name}`}
                    />
                    <span className="w-14 shrink-0">
                      <Method method={r.tool.method} />
                    </span>
                    <span className="w-[260px] shrink-0 truncate font-mono text-[12px]" title={`${r.tool.name} in ${loaded[r.member].project.title}\n${r.tool.method} ${r.tool.path}`}>
                      {r.name}
                    </span>
                    {r.tool.safety !== 'read' && <SafetyBadge safety={r.tool.safety} />}
                    {groupBy !== 'api' && groupBy !== 'area' && <span className="shrink-0 text-[11px] text-ink-faint">{loaded[r.member].project.title}</span>}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted" title={r.tool.description}>
                      {reason ? <span className="text-warn">Suggest off: {reason}</span> : r.tool.description}
                    </span>
                    {r.tool.enabled && !r.on && <span className="shrink-0 text-[11px] text-ink-faint">hidden here (read-only)</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/// Ids one service gives and another needs. Agents can't follow a chain
/// across servers by themselves, so each is written into the parameter's
/// description: where to get it.
function Chains({ loaded, c, across, reload }: { loaded: Member[]; c: Combined; across: ReturnType<typeof findLinks>; reload: () => Promise<void> }): JSX.Element {
  const { say } = useStore();
  const [working, setWorking] = useState(false);
  const items = across.map((l) => {
    const from = loaded[c.memberOf(l.from)];
    const to = loaded[c.memberOf(l.to)];
    const toTool = to.project.tools.find((t) => t.id === c.idOf(l.to));
    const prm = toTool?.params.find((x) => x.name === l.param);
    const text = `Get it from ${l.fromName} (${from.project.title}) — ${readablePath(l.path)}.`;
    const told = !!prm?.description?.includes(l.fromName);
    return { l, from, to, toId: c.idOf(l.to), text, told };
  });
  const tell = async (list: typeof items) => {
    setWorking(true);
    for (const it of list) await window.overapi.invoke('systems:hint', it.to.path, it.toId, it.l.param, it.text);
    await reload();
    setWorking(false);
    say(`Told agents where ${list.length} id${list.length === 1 ? ' comes' : 's come'} from.`);
  };
  const todo = items.filter((x) => !x.told);
  if (!items.length) return <p className="text-[13px] text-ink-muted">No ids flow from one of these APIs into another yet.</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[12.5px] text-ink-muted">
        <span className="flex-1">
          Served together, an agent can pass one API’s ids straight to another — if it knows where they come from. Each of these writes that into the parameter’s description.
        </span>
        {todo.length > 0 && (
          <button className="btn-primary h-8" disabled={working} onClick={() => void tell(todo)}>
            Tell agents about all {todo.length}
          </button>
        )}
      </div>
      <ul className="overflow-hidden rounded-xl border border-rule bg-surface">
        {items.map((it) => (
          <li key={`${it.l.to}:${it.l.param}`} className="flex items-center gap-3 border-b border-rule px-3.5 py-2 text-[12.5px] last:border-b-0">
            <span className="min-w-0 flex-1">
              <span className="font-mono">{it.l.fromName}</span>
              <span className="font-mono text-ink-faint"> → {readablePath(it.l.path)} → </span>
              <span className="font-mono">
                {it.l.toName}.<b>{it.l.param}</b>
              </span>
              <span className="ml-2 text-[11.5px] text-ink-faint">
                {it.from.project.title} → {it.to.project.title}
              </span>
            </span>
            {it.told ? (
              <span className="flex items-center gap-1 text-[11.5px] text-good">
                <Icon name="check" size={11} /> in its description
              </span>
            ) : (
              <button className="btn h-7 text-[12px]" disabled={working} onClick={() => void tell([it])}>
                Tell agents
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SEV: Record<Finding['severity'], string> = { critical: 'bg-bad/15 text-bad', high: 'bg-bad/10 text-bad', medium: 'bg-warn/15 text-warn', low: 'bg-wash-strong text-ink-muted' };

/// Every API's scan, the serious ones first. Fixing happens in the API.
function Security({ scans }: { scans: { m: Member; scan: ReturnType<typeof scanProject> }[] }): JSX.Element {
  const { open, setMcpTab } = useStore();
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const all = scans.flatMap(({ m, scan }) => scan.findings.map((f) => ({ m, f }))).sort((a, b) => rank[a.f.severity] - rank[b.f.severity]);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2.5">
        {scans.map(({ m, scan }) => (
          <div key={m.path} className="flex items-center gap-3 rounded-xl border border-rule bg-surface px-3.5 py-2.5">
            <Monogram name={m.project.title} size={22} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{m.project.title}</span>
            <span className={`display text-[18px] font-semibold tabular-nums ${scan.score >= 90 ? 'text-good' : scan.score >= 60 ? 'text-warn' : 'text-bad'}`}>{scan.score}</span>
          </div>
        ))}
      </div>
      {all.length === 0 ? (
        <p className="text-[13px] text-ink-muted">Nothing found in any of its APIs.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-rule bg-surface">
          {all.map(({ m, f }, i) => (
            <li key={`${m.path}:${f.id}:${i}`} className="flex items-start gap-3 border-b border-rule px-3.5 py-2.5 text-[12.5px] last:border-b-0">
              <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[10.5px] font-semibold uppercase ${SEV[f.severity]}`}>{f.severity}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{f.title}</span>
                <span className="block text-[12px] text-ink-muted">{f.fix}</span>
              </span>
              <button
                className="shrink-0 text-[11.5px] text-accent hover:underline"
                onClick={() => {
                  void open(m.path, 'mcp').then(() => setMcpTab('security'));
                }}
              >
                {m.project.title} →
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
