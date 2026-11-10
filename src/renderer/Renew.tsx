import { useState } from 'react';
import { useStore } from './store';
import { Icon } from './icons';

/// Signs an environment in again, the way it signs in — opens the browser
/// for a browser session, runs the login request, or renews the API it
/// borrows its sign-in from. While a browser window is open, says so and
/// offers to finish from here.
export function RenewButton({ path, env, onDone, label = 'Sign in again', small }: { path: string; env: string; onDone?: () => void; label?: string; small?: boolean }): JSX.Element {
  const { say, reload, refreshSecrets } = useStore();
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setManual(null);
    const r = await window.overapi.invoke('auth:renew', path, env);
    setBusy(false);
    if (!r.ok) {
      if (r.manual) setManual(r.error);
      return say(r.error, true);
    }
    if (useStore.getState().path === r.renewed) await reload();
    await refreshSecrets();
    say(r.note);
    onDone?.();
  };
  const cls = small ? 'inline-flex h-6 items-center gap-1 rounded-md border border-rule px-2 text-[11px] hover:bg-wash-strong' : 'btn h-7 text-[12px]';
  if (busy)
    return (
      <span className="inline-flex items-center gap-2 text-[12px] text-ink-muted">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        Signing in — finish in the window that opened
        <button className={cls} onClick={() => void window.overapi.invoke('browser:signInDone')}>
          Done
        </button>
      </span>
    );
  return (
    <>
      <button className={cls} onClick={() => void run()} title="Signs in again the way this environment signs in: the browser, its login request, or the API it gets its sign-in from">
        <Icon name="key" size={small ? 11 : 12} /> {label}
      </button>
      {manual && <span className="text-[11.5px] text-ink-faint">{manual}</span>}
    </>
  );
}
