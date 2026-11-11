import { useEffect, useState } from 'react';

// The auto-updater's side of the window (see src/main/updater.ts). It keeps
// its own subscription to the update:* events: nothing else cares about them.
//
// The download runs quietly; once it's done this offers a restart. The
// install waits for the next quit either way, so "Later" only hides the
// prompt — the update still applies.
type UpdateState = { phase: 'idle' } | { phase: 'downloading'; percent: number } | { phase: 'ready'; version: string };

export function UpdatePrompt(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type === 'update:available') {
          setDismissed(false);
          setState({ phase: 'downloading', percent: 0 });
        } else if (e.type === 'update:progress') {
          setState({ phase: 'downloading', percent: e.percent });
        } else if (e.type === 'update:downloaded') {
          setDismissed(false);
          setState({ phase: 'ready', version: e.version });
        }
      }),
    [],
  );

  if (state.phase === 'idle' || dismissed) return null;

  return (
    <div className="rise fixed bottom-5 right-5 z-50 flex w-[280px] flex-col gap-2 rounded-lg border border-rule-strong bg-surface-elevated px-3.5 py-2.5 text-[12px] text-ink shadow-2xl">
      {state.phase === 'downloading' ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-muted">Downloading an update…</span>
            <span className="tabular-nums">{state.percent}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-rule">
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${state.percent}%` }} />
          </div>
        </>
      ) : (
        <>
          <div>
            overapi <span className="font-medium">{state.version}</span> is ready to install.
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-md bg-accent px-3 py-1 font-medium text-white hover:opacity-90" onClick={() => void window.overapi.invoke('update:install')}>
              Restart now
            </button>
            <button className="rounded-md px-2 py-1 text-ink-muted hover:text-ink" onClick={() => setDismissed(true)}>
              Later
            </button>
          </div>
        </>
      )}
    </div>
  );
}
