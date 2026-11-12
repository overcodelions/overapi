import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import type { TrustSummary } from '@shared/trust';

// A project that's new to overapi, or changed outside it (a clone, a git
// pull), can't use your secrets until you've seen where they'd go. A
// decision that comes first, so a dialog — once per project per session.
// The question is "this host, with these secrets?", so the host leads;
// amber is kept for what deserves a second look. "Not now" leaves a thin
// bar, so held-back requests are never a mystery, and Review reopens it.

/// Projects put off with "Not now" this session: they show the bar, not the dialog.
const putOff = new Set<string>();

export function TrustBanner(): JSX.Element | null {
  const { project, path, say } = useStore();
  const [status, setStatus] = useState<{ trusted: boolean; summary: TrustSummary } | null>(null);
  const [, redraw] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const dialog = useRef<HTMLElement>(null);
  const asking = !!project && !!path && !!status && !status.trusted && !putOff.has(path);
  const later = (p: string, off: boolean) => {
    if (off) putOff.add(p);
    else putOff.delete(p);
    redraw((n) => n + 1);
  };

  // Esc puts it off, like any sheet here; focus starts in the dialog.
  useEffect(() => {
    if (!asking || !path) return;
    dialog.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && later(path, true);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [asking, path]);

  useEffect(() => {
    if (!project || !path) return setStatus(null);
    // After an edit here the app saves (and approves) first; ask once that's landed.
    const t = setTimeout(() => void window.overapi.invoke('trust:status', path, project).then(setStatus), 900);
    return () => clearTimeout(t);
  }, [project, path]);

  if (!project || !path || !status || status.trusted) return null;

  if (putOff.has(path))
    return (
      // Edge to edge, like the Recording strip: a state of this whole API, not a card.
      <div>
        <div role="status" className="flex h-8 w-full items-center gap-2.5 border-b border-warn/25 bg-warn/[0.07] px-4 text-[12px]">
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 truncate text-ink-muted">{project.title} can’t use secrets yet — requests that sign in are held back.</span>
          <span className="flex-1" />
          <button type="button" className="shrink-0 font-medium text-accent hover:underline" onClick={() => later(path, false)}>
            Review
          </button>
        </div>
      </div>
    );

  const { envs, warnings } = status.summary;
  const allow = async () => {
    await window.overapi.invoke('trust:allow', path, project);
    setStatus({ ...status, trusted: true });
    say(`${project.title} can use its secrets now.`);
  };
  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const cols = 'grid grid-cols-[110px_minmax(0,1fr)_160px_120px] gap-3';

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-6 pt-[12vh] backdrop-blur-[3px]" onMouseDown={() => later(path, true)}>
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="rise w-full max-w-[720px] rounded-xl border border-rule-strong bg-surface-elevated px-5 py-[18px] text-[12.5px] shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] outline-none"
      >
        <h2 id="trust-title" className="text-[14px] font-semibold text-ink">
          Review {project.title} before it uses your secrets
        </h2>
        <p className="mt-1 leading-relaxed text-ink-muted">It’s new to overapi, or it changed outside the app. Nothing secret is sent — here or to agents — until you allow it.</p>

        <div role="table" aria-label="What each environment does" className="mt-3.5 border-t border-rule">
          <div role="row" className={`${cols} pb-1.5 pt-2.5 text-[11px] text-ink-faint`}>
            <span role="columnheader">Environment</span>
            <span role="columnheader">Sends to</span>
            <span role="columnheader">Signs in with</span>
            <span role="columnheader">Secrets</span>
          </div>
          {envs.map((e) => (
            <div key={e.name} role="rowgroup" className="border-t border-rule">
              <div role="row" className={`${cols} items-center py-2`}>
                <span role="cell" className="truncate text-ink-muted">
                  {e.name}
                </span>
                <span role="cell" className="truncate font-mono text-[13px] font-semibold text-ink" title={e.host}>
                  {e.host}
                </span>
                <span role="cell" className="truncate text-ink-muted" title={e.signIn}>
                  {e.signIn}
                </span>
                <span role="cell">
                  {e.borrowed ? (
                    <span className="text-ink-muted" title={`Uses ${e.borrowed}’s sign-in`}>
                      borrowed
                    </span>
                  ) : e.secrets.length ? (
                    <button type="button" className="text-accent hover:underline" aria-expanded={open.has(e.name)} onClick={() => toggle(e.name)}>
                      {open.has(e.name) ? 'Hide' : `${e.secrets.length} secret${e.secrets.length === 1 ? '' : 's'}`} {open.has(e.name) ? '▴' : '▾'}
                    </button>
                  ) : (
                    <span className="text-ink-faint">none</span>
                  )}
                </span>
              </div>
              {open.has(e.name) && (
                <div className="flex flex-wrap gap-1.5 pb-2.5 pl-[122px]">
                  {e.secrets.map((s) => (
                    <span key={s} className="rounded bg-wash-strong px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                      {s}
                    </span>
                  ))}
                  <span className="w-full text-[11px] text-ink-faint">Names only — the values stay in your keychain unless you allow it.</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {warnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2.5">
            <div className="text-[12px] font-semibold text-warn">Worth a second look</div>
            <ul className="mt-1.5 list-disc space-y-1 pl-[18px] leading-snug text-ink-muted">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-3.5 flex items-center gap-2.5">
          <button type="button" className="btn-primary h-8" onClick={() => void allow()}>
            Allow {project.title}
          </button>
          <button type="button" className="btn h-8" onClick={() => later(path, true)}>
            Not now
          </button>
          <span className="text-[11.5px] text-ink-faint">Only allow APIs you trust with these secrets.</span>
        </div>
      </section>
    </div>
  );
}
