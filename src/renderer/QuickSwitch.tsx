import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { Icon, Monogram } from './icons';
import { Method } from './ui';
import { titleOf } from './RequestsTab';

type Item =
  | { kind: 'tool'; id: string; title: string; sub: string; method: string; hay: string }
  | { kind: 'api'; path: string; title: string; sub: string; hay: string }
  | { kind: 'workspace'; path: string; title: string; sub: string; hay: string };

/// Every letter of the query, in order: "lol" finds list_order_lines.
function score(hay: string, q: string): number {
  if (!q) return 1;
  const h = hay.toLowerCase();
  const i = h.indexOf(q);
  if (i >= 0) return 100 - i;
  let at = 0;
  for (const c of q) {
    at = h.indexOf(c, at);
    if (at < 0) return 0;
    at++;
  }
  return 10;
}

/// ⌘K: jump to any request in this API, or to another API or workspace.
export function QuickSwitch(): JSX.Element | null {
  const { project, projects, systems, path, selectTool, setTab, open: openApi, openSystem } = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQ('');
        setActive(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = useMemo(() => {
    const all: Item[] = [
      ...(project?.tools ?? []).map((t): Item => ({ kind: 'tool', id: t.id, title: titleOf(t), sub: `${t.name} · ${t.path}`, method: t.method, hay: `${titleOf(t)} ${t.name} ${t.path}` })),
      ...systems.map((s): Item => ({ kind: 'workspace', path: s.path, title: s.title, sub: `workspace · ${s.members.length} APIs`, hay: `${s.title} workspace` })),
      ...projects.filter((p) => p.path !== path && !p.missing).map((p): Item => ({ kind: 'api', path: p.path, title: p.title, sub: `API · ${p.tools} requests`, hay: `${p.title} ${p.name}` })),
    ];
    const needle = q.trim().toLowerCase();
    return all
      .map((it) => ({ it, s: score(it.hay, needle) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.it);
  }, [project, projects, systems, path, q]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const go = (it: Item) => {
    setOpen(false);
    if (it.kind === 'tool') {
      setTab('requests');
      selectTool(it.id);
    } else if (it.kind === 'api') void openApi(it.path);
    else openSystem(it.path);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh] backdrop-blur-[2px]" onMouseDown={() => setOpen(false)}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-rule-strong bg-surface-elevated shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-rule px-4">
          <Icon name="search" size={15} className="text-ink-faint" />
          <input
            autoFocus
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint"
            placeholder={project ? `Jump to a request in ${project.title}, or another API…` : 'Jump to an API…'}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && items[active]) go(items[active]);
              else if (e.key === 'Escape') setOpen(false);
            }}
          />
          <kbd className="rounded border border-rule px-1.5 text-[10px] text-ink-faint">esc</kbd>
        </div>
        <ul ref={list} className="max-h-[52vh] overflow-y-auto py-1.5">
          {items.length === 0 && <li className="px-4 py-3 text-[12.5px] text-ink-faint">Nothing matches “{q}”.</li>}
          {items.map((it, i) => (
            <li key={it.kind === 'tool' ? it.id : it.path} data-i={i}>
              <button className={`flex w-full items-center gap-3 px-4 py-2 text-left ${i === active ? 'bg-accent/15' : 'hover:bg-wash'}`} onMouseEnter={() => setActive(i)} onClick={() => go(it)}>
                {it.kind === 'tool' ? (
                  <span className="w-12 shrink-0">
                    <Method method={it.method as never} />
                  </span>
                ) : it.kind === 'workspace' ? (
                  <span className="flex w-12 shrink-0 items-center">
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-accent/15 text-accent">
                      <Icon name="folder" size={12} />
                    </span>
                  </span>
                ) : (
                  <span className="w-12 shrink-0">
                    <Monogram name={it.title} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{it.title}</span>
                  <span className="block truncate font-mono text-[10.5px] text-ink-faint">{it.sub}</span>
                </span>
                {i === active && <span className="shrink-0 text-[11px] text-ink-faint">↵</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-4 border-t border-rule px-4 py-2 text-[10.5px] text-ink-faint">
          <span>↑↓ to move · ↵ to open</span>
          <span>⌘L edit the URL · ⌘↵ send</span>
        </div>
      </div>
    </div>
  );
}
