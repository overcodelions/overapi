import { useMemo, useState } from 'react';
import { useStore } from './store';
import { Method, SafetyBadge, Toggle } from './ui';
import { Icon } from './icons';
import { checkProject, TOOL_BUDGET } from '@shared/check';
import { groupOf, offered, type ToolDef } from '@shared/project';
import { VALID_NAME } from '@shared/naming';
import { isWeak, suggestOff, toolTokens } from '@shared/curate';

type Filter = 'all' | 'on' | 'off' | 'weak' | 'writes';

/// The MCP server's tool list, to curate: what's on, what each says, what
/// it costs — grouped, searchable, editable in place — with the agent brief
/// and what readiness says to fix beside it.
export function ToolsTab(): JSX.Element {
  const { project, path, env: envName, secrets, update, say, selectTool, setTab, openSheet } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const on = p.tools.filter((t) => t.enabled);
  const tokens = on.reduce((n, t) => n + toolTokens(t), 0);
  const issues = useMemo(() => checkProject(p, Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v]))).issues, [p, secrets]);
  const suggestions = useMemo(() => (suggesting ? suggestOff(p, env) : []), [suggesting, p, env]);
  const [skip, setSkip] = useState<Set<string>>(new Set());

  const setTool = (id: string, fn: (t: ToolDef) => ToolDef) => update((x) => ({ ...x, tools: x.tools.map((t) => (t.id === id ? fn(t) : t)) }));
  const setMany = (ids: string[], enabled: boolean) => update((x) => ({ ...x, tools: x.tools.map((t) => (ids.includes(t.id) ? { ...t, enabled } : t)) }));

  const shown = p.tools.filter((t) => {
    const text = `${t.name} ${t.path} ${t.description}`.toLowerCase();
    if (q.trim() && !text.includes(q.trim().toLowerCase())) return false;
    if (filter === 'on') return t.enabled;
    if (filter === 'off') return !t.enabled;
    if (filter === 'weak') return isWeak(t);
    if (filter === 'writes') return t.safety !== 'read';
    return true;
  });
  const groups = useMemo(() => {
    const m = new Map<string, ToolDef[]>();
    for (const t of shown) m.set(groupOf(t), [...(m.get(groupOf(t)) ?? []), t]);
    return [...m.entries()];
  }, [shown]);
  const counts: Record<Filter, number> = {
    all: p.tools.length,
    on: on.length,
    off: p.tools.length - on.length,
    weak: p.tools.filter(isWeak).length,
    writes: p.tools.filter((t) => t.safety !== 'read').length,
  };
  const over = on.length > TOOL_BUDGET;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Budget and tools to find. */}
        <div className="space-y-3 border-b border-rule px-7 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[260px] flex-1">
              <div className="flex items-baseline gap-2 text-[13px]">
                <b className={over ? 'text-warn' : ''}>{on.length} on</b>
                <span className="text-ink-faint">
                  · budget {TOOL_BUDGET} · ≈{tokens.toLocaleString()} tokens every agent turn
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-wash-strong" role="img" aria-label={`${on.length} tools on, budget ${TOOL_BUDGET}`}>
                <div className={`h-1.5 rounded-full ${over ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.min(100, (on.length / Math.max(TOOL_BUDGET, on.length)) * 100)}%` }} />
              </div>
            </div>
            {over && (
              <button className="btn" onClick={() => setSuggesting((s) => !s)}>
                <Icon name="sparkle" size={13} /> {suggesting ? 'Hide suggestions' : `Suggest ${on.length - TOOL_BUDGET} to turn off`}
              </button>
            )}
            <button className="btn" onClick={() => openSheet({ kind: 'agentready' })} title="Descriptions, names and what to hide — written by your claude or codex">
              <Icon name="sparkle" size={13} /> Make it agent-ready
            </button>
          </div>

          {suggesting && (
            <div className="rounded-xl border border-warn/40 bg-warn/[0.06] p-3 text-[12px]">
              <div className="mb-2 flex items-center gap-2">
                <b>Turn these off</b>
                <span className="text-ink-muted">— {suggestions.length ? `${suggestions.length} of them gets you to ${TOOL_BUDGET}` : 'nothing obvious to suggest; turn off the ones nobody will ask for'}</span>
                <span className="flex-1" />
                {suggestions.length > 0 && (
                  <button
                    className="btn-primary !py-1"
                    onClick={() => {
                      const ids = suggestions.filter((s) => !skip.has(s.toolId)).map((s) => s.toolId);
                      setMany(ids, false);
                      setSuggesting(false);
                      say(`Turned off ${ids.length} tools — they’re still requests you can send.`);
                    }}
                  >
                    Turn off {suggestions.filter((s) => !skip.has(s.toolId)).length}
                  </button>
                )}
              </div>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {suggestions.map((s) => (
                  <li key={s.toolId} className="flex items-center gap-2">
                    <input type="checkbox" checked={!skip.has(s.toolId)} onChange={(e) => setSkip((x) => { const n = new Set(x); e.target.checked ? n.delete(s.toolId) : n.add(s.toolId); return n; })} />
                    <span className="w-56 truncate font-mono">{s.name}</span>
                    <span className="text-ink-muted">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-64">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input className="field py-1 pl-8 text-[12px]" placeholder="Find a tool" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {(
              [
                ['all', 'All'],
                ['on', 'On'],
                ['off', 'Off'],
                ['weak', 'Weak description'],
                ['writes', 'Changes data'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)} aria-pressed={filter === id} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${filter === id ? 'border-transparent bg-wash-strong text-ink' : id === 'weak' && counts.weak ? 'border-warn/40 text-warn' : 'border-rule text-ink-muted hover:text-ink'}`}>
                {label} <span className="tabular-nums opacity-70">{counts[id]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-4">
          <div className="space-y-3">
            {groups.map(([g, list]) => {
              const isShut = shut.has(g);
              const onHere = list.filter((t) => t.enabled).length;
              return (
                <section key={g} className="overflow-hidden rounded-xl border border-rule bg-canvas">
                  <div className="flex items-center gap-2.5 bg-surface px-3.5 py-2">
                    <button className="flex items-center gap-2" onClick={() => setShut((s) => { const n = new Set(s); isShut ? n.delete(g) : n.add(g); return n; })} aria-expanded={!isShut}>
                      <Icon name="chevron" size={11} className={`text-ink-faint transition-transform ${isShut ? '' : 'rotate-90'}`} />
                      <span className="text-[12px] font-semibold uppercase tracking-[0.06em]">{g}</span>
                    </button>
                    <span className="text-[11px] text-ink-faint">
                      {onHere} of {list.length} on
                    </span>
                    <span className="flex-1" />
                    <Toggle on={onHere === list.length} onChange={(v) => setMany(list.map((t) => t.id), v)} label={onHere === list.length ? 'All on' : 'Turn all on'} />
                  </div>
                  {!isShut &&
                    list.map((t) => {
                      const hidden = t.enabled && env && !offered(t, env);
                      const weak = isWeak(t);
                      return (
                        <div key={t.id} className="border-t border-rule">
                          <div className={`flex items-center gap-3 px-3.5 py-2 ${t.enabled ? '' : 'opacity-55'}`}>
                            <Toggle on={t.enabled} onChange={(v) => setTool(t.id, (x) => ({ ...x, enabled: v }))} />
                            <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setOpen(open === t.id ? null : t.id)}>
                              <span className="w-[230px] shrink-0 truncate font-mono text-[12.5px]">{t.name}</span>
                              {weak && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="A weak description — agents pick tools by it" />}
                              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${weak ? 'text-ink-faint' : 'text-ink-muted'}`}>{weak ? 'No useful description yet' : t.description}</span>
                            </button>
                            {t.safety !== 'read' && <SafetyBadge safety={t.safety} />}
                            {hidden && <span className="text-[10.5px] text-ink-faint" title={`${env.name} is read-only for agents`}>hidden on {env.name}</span>}
                            <span className="w-14 shrink-0 text-right text-[10.5px] tabular-nums text-ink-faint">{toolTokens(t)} tok</span>
                          </div>
                          {open === t.id && (
                            <ToolEditor
                              tool={t}
                              set={(fn) => setTool(t.id, fn)}
                              taken={p.tools.some((x) => x.id !== t.id)}
                              names={new Set(p.tools.filter((x) => x.id !== t.id).map((x) => x.name))}
                              openRequest={() => {
                                selectTool(t.id);
                                setTab('requests');
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                </section>
              );
            })}
            {!groups.length && <p className="text-[13px] text-ink-faint">No tools match.</p>}
          </div>
          <div className="mt-6 flex justify-end">
            <button className="text-[12px] text-ink-faint hover:text-bad" onClick={() => openSheet({ kind: 'delete', path: path!, title: p.title })}>
              Delete this API…
            </button>
          </div>
        </div>
      </div>

      <aside className="w-[340px] shrink-0 space-y-4 overflow-y-auto border-l border-rule bg-surface px-5 py-4">
        <section>
          <h3 className="text-[13px] font-semibold">Agent brief</h3>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">Read once when an agent connects: what this API covers, which tool gives the ids others need, conventions.</p>
          <textarea
            className="field mt-2 min-h-[120px] text-[12px] leading-relaxed"
            placeholder={'Seasons are years (2025 = 2025/26). Find team ids with list_season_teams…'}
            value={p.instructions ?? ''}
            onChange={(e) => update((x) => ({ ...x, instructions: e.target.value || undefined }))}
          />
          {!p.instructions && <p className="mt-1 text-[11px] text-warn">Empty — Make it agent-ready writes one.</p>}
        </section>

        <section>
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold">To fix</h3>
            <span className="text-[11px] text-ink-faint">{issues.length}</span>
          </div>
          {!issues.length && <p className="mt-1 text-[12px] text-good">Nothing — agents have what they need.</p>}
          <ul className="mt-2 space-y-1.5">
            {issues.slice(0, 30).map((i, k) => (
              <li key={k}>
                <button
                  className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[12px] leading-snug hover:bg-wash"
                  onClick={() => {
                    if (!i.toolId) return;
                    setFilter('all');
                    setQ('');
                    setOpen(i.toolId);
                  }}
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${i.level === 'error' ? 'bg-bad' : i.level === 'warn' ? 'bg-warn' : 'bg-ink-faint'}`} />
                  <span className="text-ink-muted">{i.message}</span>
                </button>
              </li>
            ))}
            {issues.length > 30 && <li className="px-1.5 text-[11px] text-ink-faint">and {issues.length - 30} more</li>}
          </ul>
        </section>
      </aside>
    </div>
  );
}

/// One tool opened in place: its name, what it's for, what each argument means.
function ToolEditor({ tool, set, names, openRequest }: { tool: ToolDef; set: (fn: (t: ToolDef) => ToolDef) => void; taken: boolean; names: Set<string>; openRequest: () => void }): JSX.Element {
  const [name, setName] = useState(tool.name);
  const bad = !VALID_NAME.test(name) ? 'Letters, numbers, _ and - only, up to 64.' : names.has(name) ? 'Another tool has that name.' : '';
  return (
    <div className="space-y-3 bg-wash px-3.5 py-3 pl-[60px] text-[12px]">
      <div className="flex flex-wrap items-center gap-3">
        <Method method={tool.method} />
        <span className="font-mono text-[11px] text-ink-faint">{tool.path}</span>
        <span className="flex-1" />
        <button className="text-accent hover:underline" onClick={openRequest}>
          Open the request →
        </button>
      </div>
      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
        <label className="pt-1.5 text-ink-muted" htmlFor={`n-${tool.id}`}>
          Name
        </label>
        <div>
          <input
            id={`n-${tool.id}`}
            className="field max-w-sm py-1 font-mono text-[12px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !bad && name !== tool.name && set((t) => ({ ...t, name }))}
          />
          {bad && <p className="mt-0.5 text-bad">{bad}</p>}
        </div>
        <label className="pt-1.5 text-ink-muted" htmlFor={`d-${tool.id}`}>
          What it’s for
        </label>
        <textarea id={`d-${tool.id}`} className="field min-h-[56px] text-[12px]" value={tool.description} onChange={(e) => set((t) => ({ ...t, description: e.target.value }))} placeholder="What it returns, and when an agent should use it." />
        {tool.params.map((prm) => (
          <div key={prm.name} className="contents">
            <span className="truncate pt-1.5 font-mono text-[11.5px] text-ink-muted" title={prm.name}>
              {prm.name}
            </span>
            <input
              className="field py-1 text-[12px]"
              value={prm.description ?? ''}
              placeholder={`What ${prm.name} is, its format, where to get it`}
              onChange={(e) => set((t) => ({ ...t, params: t.params.map((x) => (x.name === prm.name ? { ...x, description: e.target.value || undefined } : x)) }))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
