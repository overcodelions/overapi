import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { readablePath, type Link } from '@shared/chains';
import { looksLikeId } from '@shared/seen';
import type { SeenSuggestions } from '@shared/ipc';

// An argument another request gives — a group's id that "list groups"
// answers with — picked by what it is, not typed as an id. One control
// holds both decisions: which one, and whether to send that one every
// time or take it from the list each time (what an agent is told to do).

export const keptAgo = (at: string) => {
  const s = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/// What a `{{name}}` value stands for right now: kept from a response, or
/// set on the environment. Null when the value isn't a reference.
export function useKept(value: string) {
  const { runtime, project, env: envName } = useStore();
  const m = value.trim().match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
  if (!m) return null;
  const kept = runtime.find((r) => r.name === m[1]);
  const fromEnv = project?.envs.find((e) => e.name === envName)?.vars?.[m[1]];
  return {
    name: m[1],
    kept,
    fromEnv,
    envName,
    resolved: kept?.value ?? fromEnv,
  };
}

/// groupId → "group", order_line_id → "order line".
export function nounFor(param: string): string {
  const s = param
    .replace(/(_id|Id|_uuid|Uuid|_code|Code|_slug|Slug)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return s && s !== 'id' ? s : 'value';
}
export const pluralOf = (n: string) => (/[^aeiou]y$/.test(n) ? `${n.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(n) ? `${n}es` : `${n}s`);
const a = (n: string) => (/^[aeiou]/.test(n) ? 'an' : 'a');
export const shortId = (v: string) => (v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-5)}` : v);

/// The name an earlier response gave a value, if one did.
export function useSeenLabel(toolId: string, param: string, value: string | undefined): string | undefined {
  const { path, project, env } = useStore();
  const [label, setLabel] = useState<string>();
  useEffect(() => {
    setLabel(undefined);
    if (!value || !path || !project || !env) return;
    let live = true;
    void window.overapi.invoke('seen:suggest', path, project, toolId, param, env).then((r) => {
      const l = r.values.find((x) => String(x.v) === value)?.label;
      if (live) setLabel(l && !looksLikeId(l) ? l : undefined);
    });
    return () => {
      live = false;
    };
    // Labels don't change with edits to the project, only with the value.
  }, [value, toolId, param, env, path]);
  return label;
}

/// A path parameter in the URL bar, shown as what it is.
export function PathChip({ toolId, name, value }: { toolId: string; name: string; value: string }): JSX.Element {
  const k = useKept(value);
  const resolved = k ? k.resolved : value.trim() || undefined;
  const label = useSeenLabel(toolId, name, resolved);
  if (!resolved) return <span className="rounded bg-warn/15 px-1 text-warn">{`{${name}}`}</span>;
  return (
    <span className="mx-px rounded bg-good/15 px-1.5 py-px font-sans text-[11.5px] text-good" title={`${name} = ${resolved}`}>
      {label ?? shortId(resolved)}
    </span>
  );
}

const Chevron = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const FromList = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);
const Search = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export function ValuePicker({
  toolId,
  param,
  value,
  onValue,
  link,
  sourceTitle,
  onConnect,
  onOpenSource,
  autoFocus,
}: {
  toolId: string;
  param: string;
  value: string;
  onValue: (v: string) => void;
  /// The request that gives this value.
  link: Link;
  sourceTitle: string;
  /// Take it from that request every time.
  onConnect?: (l: Link) => void;
  onOpenSource?: (toolId: string) => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { path, project, env, say } = useStore();
  const kept = useKept(value);
  const fromList = !!kept;
  const current = fromList ? kept.resolved : value.trim() || undefined;
  const [data, setData] = useState<SeenSuggestions | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const noun = nounFor(param);
  const nouns = pluralOf(noun);

  const load = async () => {
    if (!path || !project || !env) return;
    setData(await window.overapi.invoke('seen:suggest', path, project, toolId, param, env));
  };
  useEffect(() => {
    setData(null);
    void load();
    // Reload for another request, argument or environment — not on every project edit.
  }, [toolId, param, env, path]);

  const values = (data?.values ?? []).map((x) => ({
    v: String(x.v),
    label: x.label && !looksLikeId(x.label) ? x.label : undefined,
  }));
  const match = current !== undefined ? values.find((x) => x.v === current) : undefined;
  const label = match?.label;
  const source = data?.sources.find((s) => s.toolId === link.from) ?? data?.sources[0];

  const fetchChoices = async () => {
    if (!source || !env) return;
    setLoading(true);
    const r = await window.overapi.invoke('seen:fill', source.path, source.toolId, env);
    setLoading(false);
    if (!r.ok) return say(r.error, true);
    await load();
  };

  const ql = q.trim().toLowerCase();
  const shown = values.filter((x) => !ql || x.v.toLowerCase().includes(ql) || x.label?.toLowerCase().includes(ql));
  const typed = q.trim() && !values.some((x) => x.v === q.trim()) ? q.trim() : null;
  const options = [...(typed ? [{ v: typed, label: undefined, typed: true }] : []), ...shown.slice(0, 60).map((x) => ({ ...x, typed: false }))];
  const close = () => {
    setOpen(false);
    setQ('');
  };
  const choose = (v: string) => {
    onValue(v);
    close();
    trigger.current?.focus();
  };
  const seg = (on: boolean) => `rounded-md px-2.5 py-1 font-medium ${on ? 'bg-surface-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`;

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        autoFocus={autoFocus}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${noun} for ${param}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === 'Backspace' || e.key === 'Delete') && value.trim()) {
            e.preventDefault();
            onValue('');
          }
        }}
        className={`field flex h-[30px] w-full items-center gap-2 py-0 text-left ${value.trim() ? 'pr-[52px]' : 'pr-8'} ${open ? 'border-accent/70' : 'hover:border-accent/50'} ${!current && !fromList ? 'border-dashed' : ''}`}
      >
        {fromList ? (
          <>
            <span className="shrink-0 text-accent">
              <FromList />
            </span>
            {current ? (
              label ? (
                <>
                  <span className="min-w-0 truncate text-[12.5px] text-ink">{label}</span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">{shortId(current)}</span>
                </>
              ) : (
                <span className="min-w-0 truncate font-mono text-[12px] text-ink">{current}</span>
              )
            ) : (
              <span className="min-w-0 truncate text-[12.5px] text-ink-muted">Taken from the list when you send</span>
            )}
          </>
        ) : current ? (
          <>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${match ? 'bg-good' : 'bg-ink-faint'}`} />
            {label ? (
              <>
                <span className="min-w-0 truncate text-[12.5px] text-ink">{label}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{shortId(current)}</span>
              </>
            ) : (
              <span className="min-w-0 truncate font-mono text-[12px] text-ink">{current}</span>
            )}
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
            <span className="text-[12.5px] text-ink-muted">
              Choose {a(noun)} {noun}
            </span>
          </>
        )}
      </button>
      <span className="pointer-events-none absolute right-1.5 top-[15px] flex h-5 w-5 -translate-y-1/2 items-center justify-center text-ink-faint">
        <Chevron />
      </span>
      {value.trim() && (
        <button
          type="button"
          aria-label={`Clear ${param}`}
          title="Clear — send nothing"
          className="absolute right-[26px] top-[15px] flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-faint hover:bg-wash-strong hover:text-ink"
          onClick={() => {
            onValue('');
            close();
            trigger.current?.focus();
          }}
        >
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}

      <div className="mt-1 flex min-w-0 items-center gap-1 whitespace-nowrap px-0.5 text-[11px] text-ink-faint">
        {!fromList && current && values.length > 0 && !match ? (
          <span className="truncate">
            Not one of the {values.length} {values.length === 1 ? noun : nouns} seen on {env}
          </span>
        ) : (
          <>
            <span className="shrink-0">{fromList ? 'Taken from' : 'From'}</span>
            <button
              type="button"
              className="min-w-0 truncate font-medium text-ink-muted hover:text-accent hover:underline"
              title={`${link.fromName} → ${readablePath(link.path)}\nClick to open it`}
              onClick={() => onOpenSource?.(link.from)}
            >
              {sourceTitle}
            </button>
            {fromList && kept?.kept && <span className="shrink-0">· {keptAgo(kept.kept.at)}</span>}
          </>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-[34px] z-30 overflow-hidden rounded-lg border border-rule-strong bg-surface-elevated shadow-xl">
          <div className="flex items-center gap-2 border-b border-rule px-2.5 py-2 text-ink-faint">
            <Search />
            <input
              autoFocus
              aria-label={`Find ${a(noun)} ${noun}, or paste an id`}
              placeholder={`Find ${a(noun)} ${noun}, or paste an id`}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, options.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && !e.metaKey && options[active]) {
                  e.preventDefault();
                  choose(options[active].v);
                }
              }}
            />
            {source && (
              <button
                type="button"
                className="shrink-0 rounded-md border border-rule px-2 py-0.5 text-[11px] text-ink-muted hover:border-accent/60 hover:text-ink disabled:opacity-60"
                disabled={loading}
                onClick={() => void fetchChoices()}
                title={`Runs ${source.toolName} on ${env} with its saved values`}
              >
                {loading ? 'Loading…' : values.length ? 'Refresh' : `Load ${nouns}`}
              </button>
            )}
          </div>
          <div className="px-3 pb-1 pt-2 text-[10.5px] text-ink-faint">
            {values.length
              ? ql
                ? `${shown.length} of ${values.length} ${nouns}`
                : `${values.length} ${values.length === 1 ? noun : nouns} seen on ${env}`
              : source
                ? `No ${nouns} seen on ${env} yet. Load them from ${sourceTitle}.`
                : `No ${nouns} seen on ${env} yet.`}
          </div>
          {options.length > 0 && (
            <ul role="listbox" aria-label={nouns} className="max-h-[220px] overflow-y-auto px-1 pb-1">
              {options.map((o, i) => {
                const on = !fromList && o.v === current;
                return (
                  <li key={`${o.typed ? 'typed:' : ''}${o.v}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(o.v)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] ${i === active ? 'bg-accent/12' : ''}`}
                    >
                      <span className="w-3 shrink-0 text-accent">{on ? '✓' : ''}</span>
                      {o.typed ? (
                        <span className="min-w-0 truncate text-ink-muted">
                          Use <span className="font-mono text-ink">{o.v}</span>
                        </span>
                      ) : o.label ? (
                        <span className="min-w-0 flex-1 truncate text-ink">{o.label}</span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{o.v}</span>
                      )}
                      {!o.typed && o.label && <span className="ml-auto shrink-0 pl-2 font-mono text-[10.5px] text-ink-faint">{shortId(o.v)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-rule bg-wash px-3 py-2.5">
            <div className="mb-1.5 text-[11px] text-ink-muted">Each time this request runs</div>
            <div role="radiogroup" aria-label="Each time this request runs" className="inline-flex gap-0.5 rounded-lg bg-wash-strong p-0.5 text-[11.5px]">
              <button type="button" role="radio" aria-checked={!fromList} className={seg(!fromList)} onClick={() => fromList && onValue(current ?? '')}>
                Send the one I picked
              </button>
              <button type="button" role="radio" aria-checked={fromList} className={seg(fromList)} onClick={() => !fromList && onConnect?.(link)}>
                Take it from the list
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              {fromList
                ? `Sends the first ${noun} ${sourceTitle} returns: the one kept from its last run, or it runs first. Agents are told the same.`
                : current
                  ? `Sends ${label ?? shortId(current)} every time, until you pick another.`
                  : `Pick one above, or take it from the list.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
