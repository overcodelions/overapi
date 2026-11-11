import { useEffect, useRef, useState, type ReactNode } from 'react';
import { envKind, type HttpMethod, type Safety } from '@shared/project';

export const SAFETY_LABEL: Record<Safety, string> = { read: 'Read', write: 'Write', destructive: 'Destructive' };

export function SafetyBadge({ safety }: { safety: Safety }): JSX.Element {
  const cls = safety === 'read' ? 'bg-good/15 text-good' : safety === 'write' ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad';
  return <span className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{SAFETY_LABEL[safety]}</span>;
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-good',
  POST: 'text-accent',
  PUT: 'text-warn',
  PATCH: 'text-warn',
  DELETE: 'text-bad',
};

export function Method({ method, wide }: { method: HttpMethod; wide?: boolean }): JSX.Element {
  return <span className={`inline-block shrink-0 font-mono text-[10px] font-bold ${wide ? 'w-14' : 'w-11'} ${METHOD_COLOR[method] ?? 'text-ink-muted'}`}>{method}</span>;
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-accent' : 'bg-wash-strong ring-1 ring-inset ring-rule-strong'}`}
    >
      <span className={`absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex h-full items-center justify-center p-8 text-center text-ink-faint">{children}</div>;
}

const KIND_STYLE = {
  local: { dot: 'bg-sky-400', chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  test: { dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  production: { dot: 'bg-red-500', chip: 'bg-red-500/15 text-red-600 dark:text-red-300' },
  other: { dot: 'bg-violet-400', chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
} as const;

/// An environment's colour says what kind of place it is: blue local,
/// amber test, red production. The same everywhere it appears.
export function EnvDot({ name }: { name: string }): JSX.Element {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${KIND_STYLE[envKind(name)].dot}`} />;
}

export function EnvChip({ name, writes }: { name: string; writes?: boolean }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[envKind(name)].chip}`}>
      <EnvDot name={name} />
      {name}
      {writes === false && <span className="opacity-70">· read-only</span>}
    </span>
  );
}

/// A modal sheet. Escape and the backdrop close it.
export function Sheet({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }): JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-6 pt-[9vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div
        className={`rise flex max-h-[82vh] w-full flex-col overflow-hidden rounded-xl border border-rule-strong bg-surface-elevated shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] ${wide ? 'max-w-3xl' : 'max-w-xl'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
          <h2 className="display text-[16px] font-semibold">{title}</h2>
          <button className="icon-btn h-6 w-6" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-rule px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Card({ title, children, right, tone }: { title?: ReactNode; children: ReactNode; right?: ReactNode; tone?: 'muted' }): JSX.Element {
  return (
    <section className={`rounded-xl border border-rule ${tone === 'muted' ? 'bg-transparent' : 'bg-wash'}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }): JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-end gap-3 border-b border-rule px-3">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-0.5 pb-2 text-[12px] font-medium transition-colors ${value === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink'}`}
        >
          <TabLabel label={t.label} on={value === t.id} />
        </button>
      ))}
    </div>
  );
}

/// "Params 1" → Params with a small count badge beside it.
function TabLabel({ label, on }: { label: ReactNode; on: boolean }): JSX.Element {
  const m = typeof label === 'string' ? /^(.*\S)\s+(\d+(?:\/\d+)?)$/.exec(label) : null;
  if (!m) return <>{label}</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {m[1]}
      <span className={`min-w-[18px] rounded-full px-1.5 text-center text-[10px] font-semibold tabular-nums leading-[16px] ${on ? 'bg-accent/20 text-accent' : 'bg-wash-strong text-ink-muted'}`}>{m[2]}</span>
    </span>
  );
}

export function AiMark(): JSX.Element {
  return <span className="rounded bg-cyan-500/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">AI</span>;
}

const BAND = {
  local: { stripe: 'bg-sky-400', band: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', what: 'your machine or a dev server' },
  test: { stripe: 'bg-amber-400', band: 'bg-amber-500/10 text-amber-800 dark:text-amber-300', what: 'a shared test system' },
  production: { stripe: 'bg-red-500', band: 'bg-red-500/15 text-red-700 dark:text-red-300', what: 'real data — requests here are real' },
  other: { stripe: 'bg-violet-400', band: 'bg-violet-500/10 text-violet-700 dark:text-violet-300', what: '' },
} as const;

/// The production warning: a red stripe and one line saying requests here
/// are real. Shown for production only.
export function EnvBand({ name, baseUrl, writes, onSetUrl }: { name: string; baseUrl: string; writes: boolean; onSetUrl: () => void }): JSX.Element | null {
  const k = envKind(name);
  // Only production gets a band: it is the one place a mistake costs
  // something. Everywhere else the title-bar switch and the URL chip say
  // enough, and a band on every page would just be noise.
  if (k !== 'production') return null;
  const b = BAND[k];
  return (
    <div>
      <div className={`h-[3px] ${b.stripe}`} aria-hidden />
      <div className={`flex items-center gap-2 px-5 py-1.5 text-[12px] ${b.band}`}>
        <span className={`h-2 w-2 rounded-full ${b.stripe}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {k === 'production' ? <b className="uppercase tracking-wide">production</b> : <b>{name}</b>}
          {b.what ? ` · ${b.what}` : ''} · agents {writes ? 'can write here' : 'are read-only here'}
          {!baseUrl && ' · no base URL yet'}
        </span>
        {!baseUrl && (
          <button className="rounded border border-current/30 px-2 py-0.5 text-[11px] font-medium hover:bg-black/5 dark:hover:bg-white/5" onClick={onSetUrl}>
            Set base URL
          </button>
        )}
      </div>
    </div>
  );
}

/// A column's width the person can drag, remembered per column on this Mac.
export function useWidth(key: string, initial: number, min = 220): [number, (w: number) => void] {
  const k = `overapi.width.${key}`;
  const [w, setW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(k));
      return v >= min ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = (n: number) => {
    const v = Math.round(Math.min(Math.max(n, min), Math.max(320, window.innerWidth - 520)));
    setW(v);
    try {
      localStorage.setItem(k, String(v));
    } catch {
      /* not kept */
    }
  };
  return [w, set];
}

/// The border between two columns, draggable. `side`: which side the sized
/// column is on. Double-click puts it back.
export function Splitter({ width, setWidth, side = 'left', initial }: { width: number; setWidth: (w: number) => void; side?: 'left' | 'right'; initial?: number }): JSX.Element {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      className="group relative w-px shrink-0 cursor-col-resize bg-rule"
      onDoubleClick={() => setWidth(initial ?? (side === 'left' ? 340 : 380))}
      onMouseDown={(e) => {
        e.preventDefault();
        start.current = { x: e.clientX, w: width };
        setDragging(true);
        const move = (ev: MouseEvent) => {
          if (!start.current) return;
          const dx = ev.clientX - start.current.x;
          setWidth(start.current.w + (side === 'left' ? dx : -dx));
        };
        const up = () => {
          start.current = null;
          setDragging(false);
          document.body.style.cursor = '';
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        document.body.style.cursor = 'col-resize';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    >
      <span className={`absolute inset-y-0 -left-[3px] w-[7px] ${dragging ? 'bg-accent/40' : 'group-hover:bg-accent/25'}`} />
    </div>
  );
}

/// A name you can click to rename: text until clicked (or double-clicked),
/// an input until Enter or leaving it; Escape puts it back.
export function InlineRename({ value, onRename, className = '', title = 'Rename', trigger = 'click' }: { value: string; onRename: (v: string) => void; className?: string; title?: string; trigger?: 'click' | 'external' }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing && trigger === 'click')
    return (
      <button type="button" className={`truncate text-left hover:underline hover:decoration-dotted ${className}`} title={title} onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
        {value}
      </button>
    );
  if (!editing) return <span className={`truncate ${className}`}>{value}</span>;
  const done = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) onRename(draft.trim());
    else setDraft(value);
  };
  return (
    <input
      autoFocus
      className={`min-w-0 rounded bg-wash-strong px-1 outline-none ring-1 ring-accent/50 ${className}`}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      aria-label="New name"
    />
  );
}

/// "Try as an agent" as a tab that asks to be clicked: an accent pill with
/// a soft glow, and a pulsing dot until it has been tried once.
export function TryAgentTab({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  const [tried, setTried] = useState(() => {
    try {
      return localStorage.getItem('overapi:tried-agent') === 'yes';
    } catch {
      return true;
    }
  });
  return (
    <button
      type="button"
      onClick={() => {
        onClick();
        if (!tried) {
          setTried(true);
          try {
            localStorage.setItem('overapi:tried-agent', 'yes');
          } catch {
            /* not kept */
          }
        }
      }}
      aria-current={on ? 'page' : undefined}
      className={`relative mb-1.5 ml-1 inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold transition-all ${
        on
          ? 'bg-accent text-white shadow-[0_0_18px_-2px_rgb(var(--c-accent)/0.7)]'
          : 'border border-accent/50 bg-accent/10 text-accent shadow-[0_0_14px_-3px_rgb(var(--c-accent)/0.55)] hover:bg-accent/20 hover:shadow-[0_0_20px_-2px_rgb(var(--c-accent)/0.7)]'
      }`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
      </svg>
      Try as an agent
      {!tried && !on && (
        <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
      )}
    </button>
  );
}
