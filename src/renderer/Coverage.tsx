import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Icon } from './icons';
import { coverageOf } from '@shared/coverage';
import type { RecordedCall } from '@shared/recording';
import type { ExploreStatusDto } from '@shared/ipc';

const OK_KEY = 'overapi:explore-ok';

/// What the recording has found so far, in plain words, what's missing,
/// and "Explore for me" — overapi clicking around the site itself.
export function CoverageBar({ calls, canExplore, note }: { calls: RecordedCall[]; canExplore: boolean; note?: string }): JSX.Element {
  const say = useStore((s) => s.say);
  const [tick, setTick] = useState(0);
  const cov = useMemo(() => coverageOf(calls), [calls, tick]);
  const [status, setStatus] = useState<ExploreStatusDto | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    const off = window.overapi.onEvent((e) => {
      if (e.type === 'explore:status') setStatus(e.status);
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  const running = !!status?.running;

  const start = async () => {
    try {
      localStorage.setItem(OK_KEY, 'yes');
    } catch {
      /* asked again next time */
    }
    setAsking(false);
    const r = await window.overapi.invoke('explore:start');
    if (!r.ok) return say(r.error, true);
    say(`Explored ${r.status.pages} page${r.status.pages === 1 ? '' : 's'} and found ${r.status.found} new request${r.status.found === 1 ? '' : 's'} — ${r.status.reason}.`);
  };
  const ask = () => {
    let ok = false;
    try {
      ok = localStorage.getItem(OK_KEY) === 'yes';
    } catch {
      /* ask */
    }
    if (ok) void start();
    else setAsking(true);
  };

  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[13px]">
          Found <b>{cov.requests}</b> request{cov.requests === 1 ? '' : 's'} · <b>{cov.chains}</b> chain{cov.chains === 1 ? '' : 's'}
          {cov.recent > 0 && <span className="text-good"> · {cov.recent} new in the last minute</span>}
        </span>
        <span className="flex-1" />
        {running ? (
          <button className="btn" onClick={() => void window.overapi.invoke('explore:stop')}>
            Stop exploring
          </button>
        ) : (
          <button className="btn-primary" disabled={!canExplore} title={canExplore ? 'overapi clicks around the site for you — reading only — to find what you missed' : note} onClick={ask}>
            <Icon name="sparkle" size={13} /> Explore for me
          </button>
        )}
      </div>

      {asking && (
        <div className="mt-3 space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
          <p className="leading-relaxed">
            overapi will click around this site on its own, one page at a time, for up to 5 minutes or 40 pages. <b>It only reads</b>: it never submits a form, never presses
            anything like buy, delete, send, save or sign in/out, and never leaves the site. Use it on your own systems or sites that are happy to be browsed automatically.
          </p>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => void start()}>
              Explore
            </button>
            <button className="btn" onClick={() => setAsking(false)}>
              Not now
            </button>
          </div>
        </div>
      )}

      {running && status && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            <span>
              Exploring page {status.pages} of {status.maxPages} · <b className="text-good">{status.found} new</b>
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-wash-strong">
              <span className="block h-1.5 rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, (status.pages / status.maxPages) * 100)}%` }} />
            </span>
          </div>
          {status.current && <div className="truncate font-mono text-[11px] text-ink-faint">{status.current}</div>}
        </div>
      )}
      {!running && status?.reason && (
        <p className="mt-2 text-ink-muted">
          Explored {status.pages} page{status.pages === 1 ? '' : 's'}, {status.found} new — stopped because {status.reason}.
        </p>
      )}

      {cov.things.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {cov.things.slice(0, 14).map((t) => (
            <span key={t.noun} className={`rounded-md border px-2 py-0.5 ${t.list && t.detail ? 'border-good/40' : 'border-rule'}`} title={`${t.list ? 'A list' : 'No list yet'} · ${t.detail ? 'one by id' : 'no single one yet'}${t.more ? ` · ${t.more} more` : ''}`}>
              <span className="font-medium">{t.noun}s</span>
              <span className={`ml-1.5 ${t.list ? 'text-good' : 'text-ink-faint'}`}>list {t.list ? '✓' : '–'}</span>
              <span className={`ml-1.5 ${t.detail ? 'text-good' : 'text-ink-faint'}`}>one {t.detail ? '✓' : '–'}</span>
              {t.more > 0 && <span className="ml-1.5 text-ink-faint">+{t.more}</span>}
            </span>
          ))}
        </div>
      )}
      {cov.gaps.length > 0 && (
        <p className="mt-2 text-ink-muted">
          <span className="font-medium text-ink">Next: </span>
          {cov.gaps.slice(0, 3).join(' · ')}
        </p>
      )}
      {!cov.requests && <p className="mt-2 text-ink-faint">Use the site — or press Explore for me — and what it asks its server for shows up here.</p>}
    </div>
  );
}
