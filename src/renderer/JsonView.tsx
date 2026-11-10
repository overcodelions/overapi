import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { useStore } from './store';

/// Every JSON in the app goes through here: pretty, coloured, foldable,
/// searchable. Text that isn't JSON is shown as it is, so a call site never
/// has to guess first.
///
/// An agent's tool result is "HTTP 200 OK\n\n{…}" — the status line is
/// split off and shown above the tree (splitStatus).

type Path = string;

export function parseMaybeJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim();
  if (!t || !/^[[{"]|^-?\d|^(true|false|null)$/.test(t)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

export function splitStatus(text: string): { status?: string; body: string } {
  const m = text.match(/^(HTTP \d{3}[^\n]*)\n\n?([\s\S]*)$/);
  return m ? { status: m[1], body: m[2] } : { body: text };
}

const isObj = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === 'object' && v !== null;
const childKey = (path: Path, k: string | number) => `${path}/${String(k)}`;

/// Paths that match the query, and every ancestor of one, so a filtered
/// tree still reads from the root.
function matches(value: unknown, q: string): { keep: Set<Path>; hits: number; whole: Set<Path> } {
  const keep = new Set<Path>();
  const whole = new Set<Path>();
  let hits = 0;
  const walk = (v: unknown, path: Path, key: string | null, ancestors: Path[]): boolean => {
    let hit = false;
    if (key !== null && key.toLowerCase().includes(q)) {
      hit = true;
      // A key matched: keep everything under it — that's what was asked for.
      whole.add(path);
    }
    if (!isObj(v)) {
      if (String(v).toLowerCase().includes(q)) hit = true;
    } else {
      for (const [k, c] of Object.entries(v)) if (walk(c, childKey(path, k), Array.isArray(v) ? null : k, [...ancestors, path])) hit = true;
    }
    if (hit) {
      if (!isObj(v) || (key !== null && key.toLowerCase().includes(q))) hits++;
      keep.add(path);
      for (const a of ancestors) keep.add(a);
    }
    return hit;
  };
  walk(value, '', null, []);
  return { keep, hits, whole };
}

function Highlight({ text, q }: { text: string; q: string }): JSX.Element {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, i)) {
    parts.push(text.slice(i, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-accent/35 text-inherit">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

function Scalar({ v, q }: { v: unknown; q: string }): JSX.Element {
  if (v === null) return <span className="text-ink-faint">null</span>;
  if (typeof v === 'string')
    return (
      <span className="text-emerald-700 dark:text-emerald-300">
        "<Highlight text={v} q={q} />"
      </span>
    );
  if (typeof v === 'number') return <span className="text-amber-700 dark:text-amber-300"><Highlight text={String(v)} q={q} /></span>;
  if (typeof v === 'boolean') return <span className="text-violet-700 dark:text-violet-300"><Highlight text={String(v)} q={q} /></span>;
  return <span>{String(v)}</span>;
}

const PAGE = 100;

/// `onKeep`: when given, every value gets a {{ }} button that hands its
/// path and value back — how a response value becomes a variable.
export function JsonView({
  text,
  value,
  maxHeight,
  compact,
  onKeep,
}: {
  text?: string;
  value?: unknown;
  maxHeight?: string;
  compact?: boolean;
  onKeep?: (segs: (string | number)[], value: unknown) => void;
}): JSX.Element {
  const parsed = useMemo(() => (value !== undefined ? ({ ok: true, value } as const) : parseMaybeJson(text ?? '')), [text, value]);
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);
  // Folded paths. Starts with everything below depth 3 folded.
  const [folded, setFolded] = useState<Set<Path> | null>(null);
  const [shown, setShown] = useState<Record<Path, number>>({});
  const say = useStore((s) => s.say);
  const q = query.trim().toLowerCase();

  const initialFolded = useMemo(() => {
    const out = new Set<Path>();
    if (!parsed.ok) return out;
    const walk = (v: unknown, path: Path, depth: number) => {
      if (!isObj(v)) return;
      if (depth >= 3) out.add(path);
      for (const [k, c] of Object.entries(v)) walk(c, childKey(path, k), depth + 1);
    };
    walk(parsed.value, '', 0);
    return out;
  }, [parsed]);
  const fold = folded ?? initialFolded;
  const filter = useMemo(() => (parsed.ok && q ? matches(parsed.value, q) : null), [parsed, q]);

  if (!parsed.ok) {
    return <pre className="selectable whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{text || '(empty)'}</pre>;
  }

  const pretty = JSON.stringify(parsed.value, null, 2);
  const toggle = (p: Path) => {
    const next = new Set(fold);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setFolded(next);
  };
  const setAll = (open: boolean) => {
    if (open) return setFolded(new Set());
    const all = new Set<Path>();
    const walk = (v: unknown, path: Path) => {
      if (!isObj(v)) return;
      if (path) all.add(path);
      for (const [k, c] of Object.entries(v)) walk(c, childKey(path, k));
    };
    walk(parsed.value, '');
    setFolded(all);
  };

  const Node = ({ v, path, k, last, inWhole, segs }: { v: unknown; path: Path; k?: string | number; last: boolean; inWhole: boolean; segs: (string | number)[] }): JSX.Element | null => {
    const whole = inWhole || !!filter?.whole.has(path);
    if (filter && !whole && !filter.keep.has(path)) return null;
    const label =
      k === undefined ? null : typeof k === 'number' ? (
        <span className="text-ink-faint">{k}: </span>
      ) : (
        <span className="text-sky-700 dark:text-sky-300">
          "<Highlight text={k} q={q} />"<span className="text-ink-faint">: </span>
        </span>
      );
    const comma = last ? '' : <span className="text-ink-faint">,</span>;
    if (!isObj(v)) {
      return (
        <div className="group/row pl-4">
          {label}
          <Scalar v={v} q={q} />
          {comma}
          {onKeep && segs.length > 0 && (
            <button
              onClick={() => onKeep(segs, v)}
              title="Keep this value as a variable for later requests"
              className="ml-2 rounded border border-accent/40 px-1 font-sans text-[10px] text-accent opacity-0 transition-opacity hover:bg-accent/10 group-hover/row:opacity-100"
            >
              {'{{ }}'}
            </button>
          )}
        </div>
      );
    }
    const arr = Array.isArray(v);
    const entries = Object.entries(v);
    const [open, close] = arr ? ['[', ']'] : ['{', '}'];
    // A filter overrides folding: what matched is always shown.
    const isFolded = !filter && fold.has(path);
    const limit = shown[path] ?? PAGE;
    const visible = entries.slice(0, limit);
    return (
      <div className={path ? 'pl-4' : ''}>
        <span className="group">
          {entries.length > 0 && (
            <button onClick={() => toggle(path)} className="-ml-4 inline-flex w-4 justify-center text-ink-faint hover:text-ink" aria-label={isFolded ? 'Expand' : 'Collapse'}>
              <Icon name="chevron" size={10} className={isFolded ? '' : 'rotate-90'} />
            </button>
          )}
          {label}
          <span className="text-ink-muted">{open}</span>
          {isFolded && (
            <button onClick={() => toggle(path)} className="mx-1 rounded bg-wash-strong px-1.5 text-[10px] text-ink-faint hover:text-ink">
              {entries.length} {arr ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}
            </button>
          )}
        </span>
        {!isFolded && (
          <>
            {visible.map(([ck, cv], i) => (
              <Node key={ck} v={cv} path={childKey(path, ck)} k={arr ? i : ck} last={i === entries.length - 1} inWhole={whole} segs={[...segs, arr ? i : ck]} />
            ))}
            {entries.length > limit && (
              <div className="pl-4">
                <button className="text-[11px] text-accent hover:underline" onClick={() => setShown({ ...shown, [path]: limit + PAGE })}>
                  Show {Math.min(PAGE, entries.length - limit)} more of {entries.length - limit}
                </button>
              </div>
            )}
          </>
        )}
        <span className="text-ink-muted">{close}</span>
        {comma}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className={`flex items-center gap-2 ${compact ? 'mb-1.5' : 'mb-2'}`}>
        <div className="relative flex-1">
          <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            className="field py-1 pl-7 text-[12px]"
            placeholder="Filter keys and values"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </div>
        {filter && <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{filter.hits} match{filter.hits === 1 ? '' : 'es'}</span>}
        {!raw && !filter && (
          <>
            <button className="btn shrink-0 px-2" title="Expand all" onClick={() => setAll(true)}>
              Expand
            </button>
            <button className="btn shrink-0 px-2" title="Collapse all" onClick={() => setAll(false)}>
              Collapse
            </button>
          </>
        )}
        <button className={`btn shrink-0 px-2 ${raw ? 'border-accent/60' : ''}`} onClick={() => setRaw(!raw)} title="Show the text as received">
          Raw
        </button>
        <button
          className="btn shrink-0 px-2"
          title="Copy pretty JSON"
          onClick={async () => {
            await window.overapi.invoke('clipboard:write', pretty);
            say('Copied.');
          }}
        >
          <Icon name="copy" size={12} />
        </button>
      </div>
      <div className="selectable overflow-auto rounded-lg border border-rule bg-wash p-3 font-mono text-[12px] leading-[1.6]" style={maxHeight ? { maxHeight } : undefined}>
        {raw ? (
          <pre className="whitespace-pre-wrap break-all">{text ?? JSON.stringify(parsed.value)}</pre>
        ) : filter && filter.hits === 0 ? (
          <div className="font-sans text-[12px] text-ink-faint">Nothing matches “{query}”.</div>
        ) : (
          <div className="pl-4">
            <Node v={parsed.value} path="" last inWhole={false} segs={[]} />
          </div>
        )}
      </div>
    </div>
  );
}

/// A tool result or response body: the HTTP status line, then the body
/// as JSON when it is JSON.
export function BodyView({ text, maxHeight }: { text: string; maxHeight?: string }): JSX.Element {
  const { status, body } = splitStatus(text);
  return (
    <div>
      {status && <div className="mb-2 font-mono text-[12px] font-semibold text-ink-muted">{status}</div>}
      <JsonView text={body} maxHeight={maxHeight} />
    </div>
  );
}
