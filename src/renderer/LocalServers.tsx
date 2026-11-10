import { useEffect, useState } from 'react';
import type { LocalServer } from '@shared/ipc';
import { Icon } from './icons';

/// What is serving HTTP on this Mac, as one-click picks instead of an
/// address to remember. A spec found on one is marked — Import takes it
/// directly, and the recorder and New API use its base path.
export const serverName = (s: LocalServer) => s.spec?.title ?? s.folder ?? (s.needsAuth ? undefined : s.title) ?? s.process;

export function LocalServers({ onPick, mode = 'address', selected, variant = 'chips' }: { onPick: (url: string, s: LocalServer) => void; mode?: 'address' | 'spec'; selected?: number; variant?: 'chips' | 'list' }): JSX.Element | null {
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    setServers(await window.overapi.invoke('local:scan'));
    setBusy(false);
  };
  useEffect(() => void scan(), []);

  const shown = (servers ?? []).filter((s) => (mode === 'spec' ? !!s.spec : true));
  const urlFor = (s: LocalServer) => (mode === 'spec' && s.spec ? s.spec.url : s.spec?.baseUrl?.replace('127.0.0.1', 'localhost') ?? `http://localhost:${s.port}`);
  if (variant === 'list') return <ServerList servers={servers} busy={busy} scan={() => void scan()} selected={selected} onPick={(s) => onPick(urlFor(s), s)} />;
  return (
    <div className="mt-2">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-faint">
        <span>{mode === 'spec' ? 'Specs served on this Mac' : 'Running on this Mac'}</span>
        <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => void scan()} disabled={busy} title="Look again">
          <Icon name="history" size={11} /> {busy ? 'looking…' : 'rescan'}
        </button>
      </div>
      {servers && shown.length === 0 && (
        <p className="text-[11px] text-ink-faint">{mode === 'spec' ? 'No local server serves a spec at the usual paths.' : 'Nothing answering HTTP right now — start your dev server and rescan.'}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {shown.map((s) => {
          const url = mode === 'spec' && s.spec ? s.spec.url : s.spec?.baseUrl?.replace('127.0.0.1', 'localhost') ?? `http://localhost:${s.port}`;
          return (
            <button
              key={s.port}
              type="button"
              onClick={() => onPick(url, s)}
              title={`${url}${s.spec ? ` — spec with ${s.spec.tools} requests` : ''}`}
              className={`group inline-flex max-w-[360px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] hover:border-accent/60 ${selected === s.port ? 'border-accent bg-accent/10' : 'border-rule-strong/70 bg-surface-elevated/60'}`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${s.spec ? 'bg-good' : s.kind === 'json' ? 'bg-accent' : 'bg-ink-faint/50'}`} aria-hidden />
              <span className="font-mono font-semibold">:{s.port}</span>
              <span className="min-w-0 truncate text-ink-muted">
                {s.process}
                {s.folder ? ` · ${s.folder}` : ''}
                {s.title && !s.needsAuth ? ` — ${s.title}` : s.needsAuth ? ' — needs sign-in' : s.kind === 'json' ? ' — JSON' : s.kind === 'html' ? ' — web page' : ''}
              </span>
              {s.spec && <span className="shrink-0 rounded bg-good/15 px-1.5 text-[10px] font-semibold uppercase text-good">spec</span>}
              {s.needsAuth && <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-ink-faint" title="Asks for sign-in"><Icon name="lock" size={9} /> {s.status}</span>}
              {s.status >= 400 && !s.spec && !s.needsAuth && <span className="shrink-0 text-[10px] text-ink-faint">{s.status}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/// The servers as one scannable list: name first, what it is, and whether
/// overapi can read it — a spec (import), a sign-in (locked), or plain.
function ServerList({ servers, busy, scan, selected, onPick }: { servers: LocalServer[] | null; busy: boolean; scan: () => void; selected?: number; onPick: (s: LocalServer) => void }): JSX.Element {
  const [q, setQ] = useState('');
  const all = servers ?? [];
  const shown = q.trim() ? all.filter((s) => `${s.port} ${serverName(s)} ${s.process} ${s.folder ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())) : all;
  return (
    <div className="overflow-hidden rounded-xl border border-rule">
      <div className="flex items-center gap-2 border-b border-rule bg-wash px-3 py-1.5">
        <Icon name="laptop" size={13} className="text-ink-faint" />
        <span className="text-[11.5px] font-medium text-ink-muted">Running on this Mac</span>
        {servers && <span className="text-[11px] text-ink-faint">{all.length}</span>}
        <span className="flex-1" />
        {all.length > 6 && (
          <input className="h-6 w-36 rounded-md border border-rule bg-surface px-2 text-[11.5px] outline-none focus:border-accent/60" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        )}
        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink" onClick={scan} disabled={busy} title="Look again">
          <Icon name="history" size={11} /> {busy ? 'looking…' : 'rescan'}
        </button>
      </div>
      <div className="max-h-[216px] overflow-y-auto">
        {!servers && <p className="px-3 py-3 text-[12px] text-ink-faint">Looking for local servers…</p>}
        {servers && !shown.length && <p className="px-3 py-3 text-[12px] text-ink-faint">{all.length ? 'Nothing matches.' : 'Nothing answering HTTP right now — start your dev server and rescan.'}</p>}
        {shown.map((s) => {
          const on = selected === s.port;
          return (
            <button
              key={s.port}
              type="button"
              onClick={() => onPick(s)}
              className={`flex w-full items-center gap-3 border-t border-rule px-3 py-[7px] text-left text-[12.5px] first:border-t-0 ${on ? 'bg-accent/10 shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : 'hover:bg-wash'}`}
            >
              <span className="w-12 shrink-0 font-mono text-[12px] font-semibold tabular-nums text-ink-muted">:{s.port}</span>
              <span className="min-w-0 flex-1 truncate">
                <span className={on ? 'font-medium text-ink' : 'text-ink'}>{serverName(s)}</span>
                <span className="ml-2 text-[11.5px] text-ink-faint">{s.source ?? s.process}</span>
              </span>
              {s.spec ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-good/15 px-2 py-0.5 text-[10.5px] font-medium text-good">
                  <Icon name="check" size={10} /> spec · {s.spec.tools}
                </span>
              ) : s.needsAuth ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
                  <Icon name="lock" size={10} /> sign-in
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-ink-faint">{s.kind === 'json' ? 'JSON' : s.kind === 'html' ? 'web page' : 'HTTP'}{s.status >= 400 ? ` · ${s.status}` : ''}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
