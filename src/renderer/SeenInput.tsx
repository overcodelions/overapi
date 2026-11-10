import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { Icon } from './icons';
import type { SeenSuggestions } from '@shared/ipc';

/// A parameter's box that offers what earlier responses held: the partners
/// a list answered with, by name — from the request that gives this value
/// (a chain, across the workspace), or any field of the same name. Nothing
/// seen yet: offers to run that request.
export function SeenInput({ toolId, param, value, onValue, placeholder, autoFocus }: { toolId: string; param: string; value: string; onValue: (v: string) => void; placeholder: string; autoFocus?: boolean }): JSX.Element {
  const { path, project, env, say } = useStore();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SeenSuggestions | null>(null);
  const [active, setActive] = useState(0);
  const [filling, setFilling] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = async () => {
    if (!path || !project || !env) return;
    setData(await window.overapi.invoke('seen:suggest', path, project, toolId, param, env));
  };
  useEffect(() => setData(null), [toolId, env]);

  const q = value.trim().toLowerCase();
  const exact = data?.values.some((x) => String(x.v) === value);
  const list = (data?.values ?? []).filter((x) => !q || exact || String(x.v).toLowerCase().includes(q) || x.label?.toLowerCase().includes(q));
  const show = open && !!data && (list.length > 0 || data.sources.length > 0);

  const pick = (v: string | number) => {
    onValue(String(v));
    setOpen(false);
  };
  const fill = async (s: SeenSuggestions['sources'][number]) => {
    setFilling(s.toolId);
    const r = await window.overapi.invoke('seen:fill', s.path, s.toolId, env!);
    setFilling(null);
    if (!r.ok) return say(r.error, true);
    await load();
    setOpen(true);
  };

  return (
    <div className="relative">
      <input
        autoFocus={autoFocus}
        className="field py-1 font-mono text-[12px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValue(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          clearTimeout(closeTimer.current);
          setOpen(true);
          setActive(0);
          void load();
        }}
        onBlur={() => (closeTimer.current = setTimeout(() => setOpen(false), 150))}
        onKeyDown={(e) => {
          if (!show || !list.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && !e.metaKey) {
            e.preventDefault();
            pick(list[active].v);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {show && (
        <div
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-rule-strong bg-surface-elevated shadow-xl"
          onMouseDown={(e) => {
            // Keep the box focused while picking.
            e.preventDefault();
          }}
        >
          {list.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 border-b border-rule px-2.5 py-1.5 text-[10.5px] text-ink-faint">
                <Icon name="history" size={10} /> Seen in earlier responses on {env}
              </div>
              <ul className="max-h-[240px] overflow-y-auto py-1">
                {list.slice(0, 40).map((x, i) => (
                  <li key={String(x.v)}>
                    <button
                      className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] ${i === active ? 'bg-accent/12' : 'hover:bg-wash'}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(x.v)}
                    >
                      {x.label ? <span className="min-w-0 max-w-[45%] shrink-0 truncate text-ink">{x.label}</span> : null}
                      <span className={`min-w-0 truncate font-mono text-[11.5px] ${x.label ? 'text-ink-faint' : 'text-ink'}`}>{String(x.v)}</span>
                      <span className="ml-auto shrink-0 truncate pl-2 text-[10.5px] text-ink-faint">{x.from}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {data!.sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-rule px-2.5 py-2 text-[11.5px] text-ink-muted first:border-t-0">
              <span>{list.length ? 'Refresh from' : `Nothing seen for ${param} yet — run`}</span>
              {data!.sources.slice(0, 3).map((s) => (
                <button
                  key={`${s.path}:${s.toolId}`}
                  className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 font-mono text-[11px] text-ink hover:border-accent/60"
                  disabled={!!filling}
                  onClick={() => void fill(s)}
                  title={`Runs ${s.toolName} (${s.api}) on ${env} with its saved values`}
                >
                  {filling === s.toolId ? 'running…' : s.toolName}
                  {s.path !== path && <span className="font-sans text-ink-faint">· {s.api}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
