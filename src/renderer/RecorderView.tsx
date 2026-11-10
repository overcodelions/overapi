import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Empty, Method, Splitter, SubTabs, useWidth } from './ui';
import { Icon } from './icons';
import { JsonView } from './JsonView';
import { LocalServers } from './LocalServers';
import { CoverageBar } from './Coverage';
import { requestGraph, type GraphEdge } from '@shared/graph';
import { endpointStats, routeOf, summarize } from '@shared/metrics';
import { replayable, SNIPPETS } from '@shared/snippets';
import { likelyApi, originsOf, within, type BrowserVia, type RecordedCall, type RecordMode } from '@shared/recording';
import type { HttpMethod } from '@shared/project';

/// Listen here, go there: a local address that forwards to the real API
/// and records every exchange. Watch the calls arrive, see which call fed
/// which (the request graph), then build an API — and an MCP server — from
/// what actually happened.
export function RecorderView(): JSX.Element {
  const { say, refreshProjects, open, info } = useStore();
  const [target, setTarget] = useState('');
  const [port, setPort] = useState(4545);
  const [running, setRunning] = useState<{ port: number; target: string; mode: RecordMode; site?: string } | null>(null);
  const [mode, setMode] = useState<RecordMode>('proxy');
  const [via, setVia] = useState<BrowserVia>('overapi');
  const [site, setSite] = useState('');
  /// Browser recordings: which host is the API. Empty: the likeliest.
  const [apiHost, setApiHost] = useState('');
  const [calls, setCalls] = useState<RecordedCall[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [callsW, setCallsW] = useWidth('record.calls', 380);
  const [sideW, setSideW] = useWidth('record.side', 380);

  useEffect(() => {
    void window.overapi.invoke('recorder:state').then((s) => {
      setCalls(s.calls);
      if (s.target) setTarget(s.target);
      setMode(s.mode);
      if (s.via) setVia(s.via);
      if (s.site) setSite(s.site);
      if (s.running) setRunning({ port: s.port ?? port, target: s.target ?? '', mode: s.mode, site: s.site });
      if (s.port) setPort(s.port);
    });
    return window.overapi.onEvent((e) => {
      if (e.type === 'recorder:call') setCalls((c) => [...c.slice(-1999), e.call]);
      // Closing the browser window stops the recording.
      if (e.type === 'recorder:status' && !e.running) setRunning(null);
    });
  }, []);

  const browserCalls = calls.some((c) => c.url);
  const hosts = useMemo(() => originsOf(calls), [calls]);
  const api = apiHost || likelyApi(calls) || '';
  const scoped = useMemo(() => (browserCalls ? within(calls, api) : calls), [calls, api, browserCalls]);
  const edges = useMemo(() => requestGraph(scoped), [scoped]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? scoped.filter((c) => `${c.method} ${c.path} ${c.status}`.toLowerCase().includes(q)) : scoped;
  }, [scoped, filter]);
  const call = calls.find((c) => c.id === selected) ?? null;
  const local = running ? `http://localhost:${running.port}` : `http://localhost:${port}`;

  const start = async () => {
    setBusy(true);
    if (mode === 'browser') {
      const b = await window.overapi.invoke('recorder:browse', site.trim(), undefined, undefined, via);
      setBusy(false);
      if (!b.ok) return say(b.error, true);
      setCalls([]);
      setApiHost('');
      setRunning({ port, target: '', mode: 'browser', site: b.site });
      return say(via === 'chrome' ? `Recording in ${info?.chrome ?? 'Chrome'}. Sign in and use the app as usual; close its tab or press Stop when you’re done.` : 'Recording in overapi’s browser. Sign in and use the app as usual; close the window or press Stop when you’re done.');
    }
    const r = await window.overapi.invoke('recorder:start', target.trim(), port);
    setBusy(false);
    if (r.ok) {
      setRunning({ port: r.port, target: r.target, mode: 'proxy' });
      say(`Recording. Point your app at ${`http://localhost:${r.port}`} instead of ${r.target}.`);
    } else say(r.error, true);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule px-6 pb-4 pt-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="display text-[24px] font-semibold">Record traffic</h1>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-muted">
              {mode === 'browser'
                ? 'For a web app with no public API: overapi opens it in its own browser window. Sign in and use it normally — every call the page makes to its backend is kept, HTTPS included, with no certificate to install. Then build an API, and an MCP server, from what actually happened.'
                : 'Listen here, go there. overapi forwards every call to the real API untouched and keeps a copy. Point an app, a script, curl or a test suite at the local address and use it normally — then build an API, and an MCP server, from what actually happened.'}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
          <div className="mr-1 flex rounded-md border border-rule p-0.5" role="tablist" aria-label="How to record">
            {(
              [
                ['proxy', 'Local address'],
                ['browser', 'Browser'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={mode === id} disabled={!!running} onClick={() => setMode(id)} className={`rounded px-2.5 py-1 text-[12px] ${mode === id ? 'bg-wash-strong font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
          {mode === 'browser' ? (
            <>
              <span className="text-ink-muted">Open</span>
              <input
                className="field w-[420px] font-mono text-[12px]"
                placeholder="https://app.acme.example"
                value={site}
                disabled={!!running}
                onChange={(e) => setSite(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !running && site.trim() && void start()}
              />
              {info?.chrome && (
            <select className="field w-auto py-1 text-[12px]" value={via} disabled={!!running} onChange={(e) => setVia(e.target.value as BrowserVia)} aria-label="Which browser" title="overapi’s window is simplest. Your Chrome brings extensions — a password manager — on a profile of overapi’s own.">
              <option value="overapi">in overapi’s window</option>
              <option value="chrome">in {info.chrome} (with extensions)</option>
            </select>
          )}
            </>
          ) : (
          <>
          <span className="text-ink-muted">Listen on</span>
          <div className="field flex w-auto items-center gap-0 p-0">
            <span className="py-1.5 pl-2.5 font-mono text-[12px] text-ink-faint">http://localhost:</span>
            <input
              className="w-16 bg-transparent py-1.5 pr-2 font-mono text-[12px] outline-none"
              type="number"
              value={port}
              disabled={!!running}
              onChange={(e) => setPort(Number(e.target.value) || 4545)}
              aria-label="Port"
            />
          </div>
          <Icon name="send" size={14} className="text-ink-faint" />
          <span className="text-ink-muted">forward to</span>
          <input
            className="field w-[420px] font-mono text-[12px]"
            placeholder="https://api.acme.example/v1"
            value={target}
            disabled={!!running}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !running && target.trim() && void start()}
          />
          </>
          )}
          {running ? (
            <button
              className="btn"
              onClick={async () => {
                await window.overapi.invoke('recorder:stop');
                setRunning(null);
              }}
            >
              Stop
            </button>
          ) : (
            <button className="btn-primary" disabled={busy || !(mode === 'browser' ? site : target).trim()} onClick={() => void start()}>
              {mode === 'browser' ? 'Open and record' : 'Start recording'}
            </button>
          )}
        </div>
        {!running && mode === 'proxy' && (
          <LocalServers
            onPick={(url, s) => {
              setTarget(url);
              // Listening on the server's own port would collide.
              if (s.port === port) setPort(port === 4545 ? 4546 : 4545);
            }}
          />
        )}
        {running?.mode === 'browser' && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-good/10 px-3 py-2 text-[12px]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
            </span>
            <span className="flex-1">
              Recording in {via === 'chrome' ? info?.chrome ?? 'Chrome' : 'overapi’s browser'} — <span className="font-mono">{running.site}</span>. Sign in and use the app; its calls appear below.
            </span>
            <button className="btn" onClick={() => void window.overapi.invoke('recorder:showBrowser')}>
              Show browser
            </button>
          </div>
        )}
        {browserCalls && hosts.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-ink-muted">The API is</span>
            <select className="field w-auto py-1 font-mono text-[12px]" value={api} onChange={(e) => setApiHost(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.origin} value={h.origin}>
                  {h.origin} · {h.count} call{h.count === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <span className="text-ink-faint">— the host the app calls for its data. Calls to the others are left out.</span>
          </div>
        )}
        {(running?.mode === 'browser' || browserCalls) && (
          <div className="mt-3">
            <CoverageBar calls={scoped} canExplore={running?.mode === 'browser' && via !== 'chrome'} note={via === 'chrome' ? 'Exploring works in overapi’s own window, not Chrome' : 'Start recording in the browser first'} />
          </div>
        )}
        {running?.mode === 'proxy' && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-good/10 px-3 py-2 text-[12px]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
            </span>
            <span className="flex-1">
              Recording — use <b className="font-mono">{local}</b> wherever you’d use <span className="font-mono">{running.target}</span>. Try{' '}
              <span className="font-mono">curl {local}/…</span>
            </span>
            <button
              className="btn"
              onClick={async () => {
                await window.overapi.invoke('clipboard:write', local);
                say('Copied.');
              }}
            >
              <Icon name="copy" size={12} /> Copy address
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Calls */}
        <div className="flex shrink-0 flex-col" style={{ width: callsW }}>
          <div className="flex items-center gap-2 border-b border-rule p-3">
            <div className="relative flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input className="field py-1 pl-7" placeholder="Filter calls" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <span className="text-[11px] tabular-nums text-ink-faint">{scoped.length}</span>
            <button
              className="btn"
              disabled={!calls.length}
              onClick={async () => {
                await useStore.getState().clearRecording();
                setCalls([]);
                setSelected(null);
              }}
            >
              Clear
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {scoped.length === 0 && (
              <Empty>{running ? (running.mode === 'browser' ? 'Waiting for the app’s first call — sign in and click around…' : 'Waiting for the first call…') : mode === 'browser' ? 'Open the web app, sign in and use it.' : 'Start recording, then use the API through the local address.'}</Empty>
            )}
            {shown.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={`flex w-full items-center gap-2 border-b border-rule px-3 py-2 text-left ${c.id === selected ? 'bg-accent/10' : 'hover:bg-wash'}`}
              >
                <Method method={c.method as HttpMethod} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{c.path}</span>
                {c.replayOf && <span className="rounded bg-wash-strong px-1 text-[10px] text-ink-faint">replay</span>}
                <span className={`font-mono text-[11px] font-semibold ${c.error || c.status >= 400 ? 'text-bad' : 'text-good'}`}>{c.status}</span>
                <span className="w-12 text-right text-[10px] tabular-nums text-ink-faint">{c.ms} ms</span>
              </button>
            ))}
          </div>
        </div>

        <Splitter width={callsW} setWidth={setCallsW} initial={380} />
        {/* Detail */}
        <div className="min-w-0 flex-1">{call ? <CallDetail key={call.id} call={call} edges={edges} calls={calls} base={running?.target ?? target} onPick={setSelected} /> : <Empty>Pick a call to see exactly what went out and what came back.</Empty>}</div>

        {/* Graph + build */}
        <Splitter width={sideW} setWidth={setSideW} side="right" initial={380} />
        <div className="flex shrink-0 flex-col" style={{ width: sideW }}>
          <GraphPanel calls={scoped} edges={edges} onPick={setSelected} target={browserCalls ? api : (running?.target ?? target)} onBuilt={async (path, note) => {
            await refreshProjects();
            await open(path, 'requests');
            say(note);
          }} />
        </div>
      </div>
    </div>
  );
}

export function CallDetail({ call, edges, calls, mark, base, onPick }: { call: RecordedCall; edges: GraphEdge[]; calls: RecordedCall[]; mark?: React.ReactNode; base?: string; onPick?: (id: string) => void }): JSX.Element {
  const [tab, setTab] = useState<'request' | 'response'>('response');
  const [menu, setMenu] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const say = useStore((s) => s.say);
  const original = call.replayOf ? calls.find((c) => c.id === call.replayOf) : undefined;
  const copy = async (label: string, text: string) => {
    setMenu(false);
    await window.overapi.invoke('clipboard:write', text);
    say(`Copied as ${label} — with the real cookies and tokens, so keep it to yourself.`);
  };
  const replay = async () => {
    setReplaying(true);
    const r = await window.overapi.invoke('recorder:replay', call.id, base);
    setReplaying(false);
    if (!r.ok) return say(r.error, true);
    onPick?.(r.call.id);
    const before = call.status;
    say(r.call.error ? r.call.error : `Sent again: ${r.call.status}${r.call.status === before ? ', same as before' : ` (was ${before})`} in ${r.call.ms} ms.`, !!r.call.error);
  };
  const inbound = edges.filter((e) => e.to === call.id);
  const outbound = edges.filter((e) => e.from === call.id);
  const name = (id: string) => {
    const c = calls.find((x) => x.id === id);
    return c ? `${c.method} ${c.path.split('?')[0]}` : '?';
  };
  const headers = tab === 'request' ? call.requestHeaders : call.responseHeaders;
  const body = tab === 'request' ? call.requestBody : call.responseBody;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-rule px-4 py-3">
        <Method method={call.method as HttpMethod} wide />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={call.url}>{call.url ?? call.path}</span>
        <span className={`rounded px-2 py-0.5 font-mono text-[12px] font-semibold ${call.error || call.status >= 400 ? 'bg-bad/15 text-bad' : 'bg-good/15 text-good'}`}>
          {call.status} {call.statusText}
        </span>
        <span className="text-[11px] text-ink-faint">{call.ms} ms</span>
        <button className="btn" disabled={replaying} title="Send it again, exactly as recorded — same cookies and headers" onClick={() => void replay()}>
          <Icon name="send" size={12} /> {replaying ? 'Sending…' : 'Replay'}
        </button>
        <div className="relative">
          <button className="btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            <Icon name="copy" size={12} /> Copy as
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-rule bg-surface py-1 shadow-lg">
                {SNIPPETS.map((s) => (
                  <button key={s.id} className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-wash" onClick={() => void copy(s.label, s.make(replayable(call, base)))}>
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {(inbound.length > 0 || outbound.length > 0) && (
        <div className="space-y-1 border-b border-rule px-4 py-2 text-[11px] text-ink-muted">
          {inbound.map((e, i) => (
            <div key={`i${i}`}>
              ← <span className="font-mono">{e.fromPath}</span> from <span className="font-mono">{name(e.from)}</span> went into {e.where}
              {e.auth && <span className="ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent">credential</span>}
            </div>
          ))}
          {outbound.slice(0, 5).map((e, i) => (
            <div key={`o${i}`}>
              → <span className="font-mono">{e.fromPath}</span> used by <span className="font-mono">{name(e.to)}</span> ({e.where})
            </div>
          ))}
        </div>
      )}
      <div className="px-2">
        <SubTabs
          tabs={[
            { id: 'request', label: 'Request' },
            { id: 'response', label: 'Response' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        {mark}
        {original && (
          <p className="text-[11px] text-ink-faint">
            A replay of{' '}
            <button className="underline hover:text-ink" onClick={() => onPick?.(original.id)}>
              the call at {new Date(original.at).toLocaleTimeString()}
            </button>{' '}
            — it answered {original.status} then, {call.status} now.
          </p>
        )}
        {call.error && <div className="rounded-lg bg-bad/10 p-3 text-[12px] text-bad">{call.error}</div>}
        {/* An error leads with what the server said, not with headers. */}
        {!call.error && call.status >= 400 && tab === 'response' && errorMessage(call.responseBody) && (
          <div className="rounded-lg bg-bad/10 px-3 py-2.5 text-[13px] text-bad">
            <b>{call.status}</b> — {errorMessage(call.responseBody)}
          </div>
        )}
        {body ? <JsonView text={body} /> : <p className="text-[12px] text-ink-faint">No body.</p>}
        <details className="rounded-lg border border-rule bg-wash">
          <summary className="cursor-pointer px-3 py-2 text-[11px] text-ink-muted">Headers · {Object.keys(headers).length}</summary>
        <div className="border-t border-rule p-3 font-mono text-[11px] leading-relaxed">
          {Object.entries(headers).map(([k, v]) => (
            <div key={k} className="break-all">
              <span className="text-sky-700 dark:text-sky-300">{k}</span>
              <span className="text-ink-faint">: </span>
              <span className="text-ink-muted">{/^(authorization|cookie|set-cookie|x-api-key)$|csrf|xsrf|token/i.test(k) ? `${v.slice(0, 12)}•••` : v}</span>
            </div>
          ))}
          {!Object.keys(headers).length && <span className="text-ink-faint">no headers</span>}
        </div>
        </details>
      </div>
    </div>
  );
}

export function GraphPanel({ calls, edges, onPick, target, onBuilt, embedded }: { calls: RecordedCall[]; edges: GraphEdge[]; onPick: (id: string) => void; target: string; onBuilt?: (path: string, note: string) => void; embedded?: boolean }): JSX.Element {
  const [title, setTitle] = useState('');
  const [signIn, setSignIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const byId = new Map(calls.map((c) => [c.id, c]));
  const short = (id: string) => {
    const c = byId.get(id);
    return c ? `${c.method} ${c.path.split('?')[0]}` : '?';
  };
  // One card per link — this route's value into that kind of slot — however
  // many calls and routes it fed: a login seen 40 times is one sign-in.
  const route = (id: string) => {
    const c = byId.get(id);
    return c ? `${c.method} ${routeOf(c.path)}` : '?';
  };
  const grouped = new Map<string, Link>();
  for (const e of edges) {
    const slot = e.auth ? e.where : e.where.replace(/^(query|body|header):.*$/, '$1');
    const k = `${route(e.from)}|${e.fromPath}|${slot}`;
    const g = grouped.get(k) ?? { e, n: 0, from: route(e.from), targets: new Map() };
    g.n++;
    const t = route(e.to);
    g.targets.set(t, { id: e.to, n: (g.targets.get(t)?.n ?? 0) + 1 });
    grouped.set(k, g);
  }
  const byUse = (x: Link, y: Link) => y.n - x.n;
  const authLinks = [...grouped.values()].filter((l) => l.e.auth).sort(byUse);
  const dataLinks = [...grouped.values()].filter((l) => !l.e.auth).sort(byUse);
  const distinct = new Set(calls.map((c) => `${c.method} ${c.path.split('?')[0].replace(/\/[^/]*\d[^/]*/g, '/{…}')}`)).size;

  const [view, setView] = useState<'graph' | 'latency'>('graph');
  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pt-1">
        <SubTabs
          tabs={[
            { id: 'graph', label: `Request graph${grouped.size ? ` ${grouped.size}` : ''}` },
            { id: 'latency', label: 'Latency' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === 'latency' ? (
        <LatencyPanel calls={calls} onPick={onPick} />
      ) : (
      <>
      <p className="px-4 pt-3 text-[11px] text-ink-faint">Values that came out of one response and went into a later request.</p>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {edges.length === 0 && <p className="text-[12px] text-ink-faint">{calls.length ? 'No links yet — calls that reuse an id or a token show up here.' : 'Nothing recorded yet.'}</p>}

        {authLinks.length > 0 && !embedded && (
          <div className="space-y-2">
            <div className="label">Looks like a sign-in</div>
            {authLinks.map((l, i) => (
              <LinkCard key={i} link={l} onPick={onPick} tone="auth" />
            ))}
            <label className="flex items-start gap-2 rounded-lg bg-wash p-3 text-[12px]">
              <input type="checkbox" className="mt-0.5" checked={signIn} onChange={(e) => setSignIn(e.target.checked)} />
              <span>
                <b>Use it as the API’s sign-in</b> — overapi runs it before calls that need the token, and again on a 401. Any password it sent goes to the keychain. Off: it
                stays an ordinary request.
              </span>
            </label>
          </div>
        )}

        {dataLinks.length > 0 && (
          <div className="space-y-2">
            <div className="label">Then — values passed along</div>
            {dataLinks.map((l, i) => (
              <LinkCard key={i} link={l} onPick={onPick} />
            ))}
          </div>
        )}
      </div>
      </>
      )}
      {!embedded && (
      <div className="space-y-2 border-t border-rule p-4">
        <input className="field" placeholder="Name for the API (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button
          className="btn-primary w-full"
          disabled={busy || !calls.some((c) => !c.error)}
          onClick={async () => {
            setBusy(true);
            const r = await window.overapi.invoke('recorder:build', { title: title.trim() || undefined, signIn, target });
            setBusy(false);
            if (r.ok) onBuilt?.(r.path, r.note ?? 'Built.');
            else if (r.error) useStore.getState().say(r.error, true);
          }}
        >
          {busy ? 'Building…' : `Build API from ${calls.filter((c) => !c.error).length} calls (${distinct} kinds)`}
        </button>
        <p className="text-[11px] leading-snug text-ink-faint">
          Same importer as a HAR capture: ids become path params, values you sent become arguments, links become kept values. No token is kept. Everything starts read-only.
        </p>
      </div>
      )}
    </div>
  );
}

interface Link {
  e: GraphEdge;
  /// Times the value travelled.
  n: number;
  from: string;
  /// The routes it went into: route -> a call to show, and how often.
  targets: Map<string, { id: string; n: number }>;
}

function LinkCard({ link, onPick, tone }: { link: Link; onPick: (id: string) => void; tone?: 'auth' }): JSX.Element {
  const { e, n, from, targets } = link;
  const list = [...targets.entries()].sort((a, b) => b[1].n - a[1].n);
  const into = tone === 'auth' ? e.where.replace('header:', '') : e.where.replace(/^(query|body|header):/, '$1 ');
  return (
    <div className={`rounded-lg border p-3 text-[12px] ${tone === 'auth' ? 'border-accent/40 bg-accent/5' : 'border-rule'}`}>
      <button className="block max-w-full truncate font-mono text-[11px] hover:underline" title={from} onClick={() => onPick(e.from)}>
        {from}
      </button>
      <div className="my-1 flex flex-wrap items-center gap-1.5 text-ink-muted">
        <span>→</span>
        <span className="rounded bg-wash-strong px-1.5 font-mono text-[11px]">{e.fromPath}</span>
        <span>
          → {into} · {n} call{n === 1 ? '' : 's'}
          {list.length > 1 ? ` across ${list.length} routes` : ''}
        </span>
      </div>
      {list.length === 1 ? (
        <button className="block max-w-full truncate font-mono text-[11px] text-ink-faint hover:text-ink" title={list[0][0]} onClick={() => onPick(list[0][1].id)}>
          → {list[0][0]}
        </button>
      ) : (
        <details>
          <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink">Show the {list.length} routes</summary>
          <ul className="mt-1 space-y-0.5">
            {list.map(([r, t]) => (
              <li key={r} className="flex items-center gap-2">
                <button className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-muted hover:text-ink" title={r} onClick={() => onPick(t.id)}>
                  {r}
                </button>
                <span className="text-[10px] tabular-nums text-ink-faint">×{t.n}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${n} ms`;
}

function size(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/// How fast and how reliable each endpoint was, across what was recorded —
/// slowest first. p50 is the typical call, p95 the slow tail an agent will
/// sometimes wait through.
export function LatencyPanel({ calls, onPick }: { calls: RecordedCall[]; onPick: (id: string) => void }): JSX.Element {
  const sum = useMemo(() => summarize(calls), [calls]);
  const stats = useMemo(() => endpointStats(calls), [calls]);
  const worst = Math.max(1, ...stats.map((s) => s.p95));
  if (!calls.length) return <p className="p-4 text-[12px] text-ink-faint">Nothing recorded yet.</p>;
  const errPct = Math.round((sum.errors / sum.count) * 100);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-4 gap-2 border-b border-rule p-4">
        {[
          ['calls', String(sum.count), ''],
          ['p50', ms(sum.p50), ''],
          ['p95', ms(sum.p95), sum.p95 >= 2000 ? 'text-warn' : ''],
          ['errors', `${errPct}%`, sum.errors ? 'text-bad' : 'text-good'],
        ].map(([label, value, tone]) => (
          <div key={label}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</div>
            <div className={`text-[16px] font-semibold tabular-nums ${tone}`}>{value}</div>
          </div>
        ))}
      </div>
      <p className="px-4 pt-3 text-[11px] text-ink-faint">Per endpoint, slowest first. Ids are folded, so /orders/1042 and /orders/1043 count as one. Click one to open its slowest call.</p>
      <ul className="p-2">
        {stats.map((s) => (
          <li key={s.key}>
            <button className="w-full rounded-md px-2 py-2 text-left hover:bg-wash" onClick={() => onPick(s.slowestId)} title={`Open the slowest ${s.key} (${ms(s.max)})`}>
              <div className="flex items-center gap-2">
                <Method method={s.method as HttpMethod} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{s.route}</span>
                <span className="text-[10px] tabular-nums text-ink-faint">×{s.count}</span>
              </div>
              <div className="mt-1.5 h-1 rounded bg-wash-strong" aria-hidden>
                <div className={`h-1 rounded ${s.p95 >= 2000 ? 'bg-warn' : 'bg-accent/70'}`} style={{ width: `${Math.max(3, (s.p95 / worst) * 100)}%` }} />
              </div>
              <div className="mt-1 flex gap-3 text-[10px] tabular-nums text-ink-faint">
                <span>p50 {ms(s.p50)}</span>
                <span className={s.p95 >= 2000 ? 'text-warn' : ''}>p95 {ms(s.p95)}</span>
                <span>max {ms(s.max)}</span>
                <span>{size(s.bytes)}</span>
                {s.errors > 0 && <span className="text-bad">{Math.round((s.errors / s.count) * 100)}% errors</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/// The message a failed response gives, from the fields APIs usually use.
export function errorMessage(body?: string): string | undefined {
  if (!body) return undefined;
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    const pick = (o: Record<string, unknown>) => ['message', 'error_description', 'detail', 'error', 'title', 'msg'].map((k) => o[k]).find((x) => typeof x === 'string') as string | undefined;
    return pick(v) ?? (v.error && typeof v.error === 'object' ? pick(v.error as Record<string, unknown>) : undefined);
  } catch {
    return body.length < 200 && !/^\s*</.test(body) ? body.trim() : undefined;
  }
}
