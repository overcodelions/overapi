import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Empty, EnvDot, Method, Splitter, SubTabs, useWidth } from './ui';
import { Icon } from './icons';
import { CallDetail, GraphPanel, LatencyPanel } from './RecorderView';
import { CoverageBar } from './Coverage';
import { argsFromCall, basePathOf, requestGraph, suggestSignIn, toolForCall } from '@shared/graph';
import { endpointStats, routeOf } from '@shared/metrics';
import { siteGuess } from '@shared/session';
import { originsOf, within, type BrowserVia, type RecordedCall, type RecordMode } from '@shared/recording';
import { varPrefix, type HttpMethod } from '@shared/project';
import { keepSecretsOut } from '@shared/secretNames';

/// An API's own traffic: record it from the API's environment, watch the
/// calls, and turn them into changes to THIS API — new routes, real
/// examples, a sign-in — instead of building a second one.
export function TrafficTab(): JSX.Element {
  const { project, path, env: envName, recorder, say, update, reload, openRecorder, info, setTab, refreshSecrets } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const mine = recorder.running && recorder.projectPath === path;
  const elsewhere = recorder.running && !mine;
  const [port, setPort] = useState(4545);
  const [calls, setCalls] = useState<RecordedCall[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [right, setRight] = useState<'coverage' | 'graph' | 'latency'>('coverage');
  // Where this API was recorded from, if it was: a website opens in the
  // browser again, at the same site — not at its server's address.
  const recordedSite = /recorded from (\S+) \(browser\)/.exec(p.source?.ref ?? '')?.[1];
  const remembered = (() => {
    try {
      return localStorage.getItem(`overapi:record-mode:${path}`) as RecordMode | null;
    } catch {
      return null;
    }
  })();
  const [mode, setModeState] = useState<RecordMode>(remembered ?? (env?.browserSession || recordedSite ? 'browser' : 'proxy'));
  const setMode = (m: RecordMode) => {
    setModeState(m);
    try {
      localStorage.setItem(`overapi:record-mode:${path}`, m);
    } catch {
      /* this session only */
    }
  };
  const [site, setSite] = useState(env?.browserSession?.site ?? recordedSite ?? siteGuess(env?.baseUrl));
  const [busy, setBusy] = useState(false);
  const [via, setVia] = useState<BrowserVia>(env?.browserSession?.via ?? 'overapi');
  const [callsW, setCallsW] = useWidth('traffic.calls', 340);
  const [sideW, setSideW] = useWidth('traffic.side', 340);
  useEffect(() => {
    setSite(env?.browserSession?.site ?? recordedSite ?? siteGuess(env?.baseUrl));
  }, [env?.name, env?.baseUrl, env?.browserSession?.site]);

  useEffect(() => {
    void window.overapi.invoke('recorder:state').then((s) => setCalls(s.projectPath === path ? s.calls : []));
    return window.overapi.onEvent((e) => {
      if (e.type === 'recorder:call') setCalls((c) => [...c.slice(-1999), e.call]);
      if (e.type === 'recorder:status' && e.running) setCalls([]);
    });
  }, [path]);

  // A browser reaches many hosts; this API is the ones under its base URL.
  const browsing = mine && recorder.mode === 'browser';
  const all = calls;
  const scoped = useMemo(() => within(all, env?.baseUrl), [all, env?.baseUrl]);
  const elsewhereHosts = useMemo(() => {
    const mineIds = new Set(scoped.map((c) => c.id));
    return originsOf(all.filter((c) => !mineIds.has(c.id)));
  }, [all, scoped]);
  const base = basePathOf(recorder.target && mine && !browsing ? recorder.target : env?.baseUrl);
  const edges = useMemo(() => requestGraph(scoped), [scoped]);
  const toolOf = (c: RecordedCall) => toolForCall(p, c, base);
  const unknown = scoped.filter((c) => !c.error && !toolOf(c));
  const newRoutes = [...new Set(unknown.map((c) => `${c.method} ${routeOf(c.path)}`))];
  const known = [...new Map(scoped.filter((c) => !c.error && c.status < 400).map((c) => [toolOf(c)?.id, c] as const)).entries()].filter(([id]) => id);
  /// The latest call's arguments as a request's example — keeping any
  /// argument wired to a chain, a variable or a secret ({{…}}, ${…}), which
  /// a fixed value would undo — and secrets (a password) out of it: they go
  /// to the keychain, the example keeps ${NAME}.
  const examplePlan = (t: (typeof p.tools)[number], c: RecordedCall) => {
    const fresh = argsFromCall(t, c, base);
    for (const [k, v] of Object.entries(t.example ?? {})) if (typeof v === 'string' && /^(\{\{.+\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(v)) fresh[k] = v;
    return keepSecretsOut(t, fresh, varPrefix(p.name));
  };
  const exampleFrom = (t: (typeof p.tools)[number], c: RecordedCall) => examplePlan(t, c).args;
  /// Saves what a call's secrets were in the keychain, then sets the examples.
  const applyCalls = async (hits: [string, RecordedCall][]) => {
    const plans = hits.map(([id, c]) => {
      const t = p.tools.find((x) => x.id === id)!;
      return [id, examplePlan(t, c)] as const;
    });
    for (const [, plan] of plans) for (const [name, value] of plan.secrets) await window.overapi.invoke('secrets:set', path!, name, value);
    update((x) => ({ ...x, tools: x.tools.map((t) => ({ ...t, example: plans.find(([id]) => id === t.id)?.[1].args ?? t.example })) }));
    if (plans.some(([, plan]) => plan.secrets.length)) await refreshSecrets();
    return plans.flatMap(([, plan]) => plan.secrets.map(([n]) => n));
  };
  // Only the ones whose saved example differs from what was just seen.
  const stale = known.filter(([id, c]) => {
    const t = p.tools.find((x) => x.id === id);
    return !!t && JSON.stringify(exampleFrom(t, c)) !== JSON.stringify(t.example ?? {});
  });
  const signIn = useMemo(() => (env && env.auth.type !== 'login' ? suggestSignIn(p, scoped, edges, base) : undefined), [p, scoped, edges, base, env]);
  const failing = endpointStats(scoped).filter((s) => s.errors === s.count && s.count > 0);
  const call = calls.find((c) => c.id === selected) ?? null;

  const start = async () => {
    if (!env?.baseUrl) return say(`${env?.name ?? 'This environment'} has no base URL to record.`, true);
    setBusy(true);
    if (mode === 'browser') {
      const r = await window.overapi.invoke('recorder:browse', site, path!, env.baseUrl, via);
      setBusy(false);
      if (r.ok)
        say(
          via === 'chrome'
            ? `Recording ${p.title} in ${info?.chrome ?? 'Chrome'}. Sign in and use the app; close its tab or press Stop when you're done.`
            : `Recording ${p.title} in overapi's browser. Sign in and use the app; close the window or press Stop when you're done.`,
        );
      else say(r.error, true);
      return;
    }
    const r = await window.overapi.invoke('recorder:start', env.baseUrl, port, path!);
    setBusy(false);
    if (r.ok) say(`Recording ${p.title}. Point your app at http://localhost:${r.port}.`);
    else say(r.error, true);
  };

  const adoptBrowserSignIn = async () => {
    if (!env || !recorder.site) return;
    const r = await window.overapi.invoke('browser:session', path!, p, env.name, recorder.site, recorder.via);
    if (!r.ok) return say(r.error, true);
    update((x) => ({
      ...x,
      envs: x.envs.map((e) =>
        e.name === env.name
          ? { ...e, auth: r.headers.Authorization ? { type: 'none' } : e.auth, headers: { ...(e.headers ?? {}), ...r.headers }, browserSession: { site: r.site, at: r.at, via: r.via } }
          : e,
      ),
    }));
    say(`${env.name} now signs in with your browser session (${r.found.join(', ')}) — kept in the keychain.`);
  };

  // Full width before and after starting: the same three columns either
  // way, with the start controls — or the recording strip — across the top.
  const startBar = elsewhere ? (
    <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-warn/10 px-4 py-2.5 text-[12px]">
      <span className="flex-1">
        The recorder is busy with <span className="font-mono">{recorder.target}</span>. One recording at a time.
      </span>
      <button className="btn" onClick={openRecorder}>
        Open it
      </button>
      <button className="btn" onClick={() => void window.overapi.invoke('recorder:stop')}>
        Stop it
      </button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5 text-[12px]">
      <div className="flex rounded-md border border-rule p-0.5" role="tablist" aria-label="How to record">
        {(
          [
            ['proxy', 'Local address', 'Your app, a script or curl calls a local address that forwards to the API'],
            ['browser', 'Browser', "Use the web app in overapi's own browser window — for apps with no public API"],
          ] as const
        ).map(([id, label, tip]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            title={tip}
            onClick={() => setMode(id)}
            className={`rounded px-2.5 py-1 text-[12px] ${mode === id ? 'bg-wash-strong font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'proxy' ? (
        <>
          <span className="ml-1 text-ink-muted">Listen on</span>
          <div className="field flex w-auto items-center gap-0 p-0">
            <span className="py-1 pl-2.5 font-mono text-[12px] text-ink-faint">localhost:</span>
            <input
              className="w-16 bg-transparent py-1 pr-2 font-mono text-[12px] outline-none"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 4545)}
              aria-label="Port"
            />
          </div>
          <Icon name="send" size={14} className="text-ink-faint" />
        </>
      ) : (
        <>
          <span className="ml-1 text-ink-muted">Open</span>
          <input
            className="field w-[300px] py-1 font-mono text-[12px]"
            value={site}
            placeholder="https://app.acme.example"
            onChange={(e) => setSite(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
            aria-label="Web app address"
          />
          {info?.chrome && (
            <select
              className="field w-auto py-1 text-[12px]"
              value={via}
              disabled={false}
              onChange={(e) => setVia(e.target.value as BrowserVia)}
              aria-label="Which browser"
              title="overapi’s window is simplest. Your Chrome brings extensions — a password manager — on a profile of overapi’s own."
            >
              <option value="overapi">in overapi’s window</option>
              <option value="chrome">in {info.chrome} (with extensions)</option>
            </select>
          )}
          <span className="text-ink-muted">and record calls to</span>
        </>
      )}
      <span className="flex items-center gap-1.5 font-medium">
        <EnvDot name={env?.name ?? ''} /> {env?.name}
      </span>
      <span className="truncate font-mono text-ink-faint">{env?.baseUrl || 'no base URL'}</span>
      <button className="btn-primary ml-1" disabled={!env?.baseUrl || busy || (mode === 'browser' && !site.trim())} onClick={() => void start()}>
        {mode === 'browser' ? 'Open and record' : 'Start recording'}
      </button>
      <span className="flex-1" />
      <span className="text-[11px] text-ink-faint">
        {mode === 'browser'
          ? via === 'chrome'
            ? `Opens ${info?.chrome} on overapi’s own profile — add your password manager there once and it stays.`
            : 'Sign in and use the app as usual. Its own calls are kept; pages, scripts and analytics are not.'
          : `Point your app, a script or curl at the local address — every call to ${p.title} shows up here.`}
      </span>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {!mine ? (
        startBar
      ) : (
        <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-bad/5 px-4 py-2 text-[12px]">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-bad" />
          </span>
          <b>Recording</b>
          {browsing ? (
            <>
              <span className="font-mono text-ink-muted">
                {recorder.via === 'chrome' ? 'chrome' : 'browser'} · {recorder.site?.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </span>
              <span className="text-ink-faint">· keeping calls to {env?.baseUrl.replace(/^https?:\/\//, '')}</span>
              <span className="flex-1" />
              <button className="btn" onClick={() => void window.overapi.invoke('recorder:showBrowser')}>
                Show browser
              </button>
            </>
          ) : (
            <>
              <span className="font-mono text-ink-muted">
                localhost:{recorder.port} → {recorder.target?.replace(/^https?:\/\//, '')}
              </span>
              <span className="text-ink-faint">· point the app at :{recorder.port}</span>
              <span className="flex-1" />
              <button
                className="btn"
                onClick={async () => {
                  await window.overapi.invoke('clipboard:write', `http://localhost:${recorder.port}`);
                  say('Copied.');
                }}
              >
                <Icon name="copy" size={12} /> Copy address
              </button>
            </>
          )}
          <button className="btn-primary !bg-bad" onClick={() => void window.overapi.invoke('recorder:stop')}>
            Stop
          </button>
        </div>
      )}
      {browsing && (
        <div className="border-b border-rule px-4 py-3">
          <CoverageBar calls={scoped} canExplore={recorder.via !== 'chrome'} note="Exploring works in overapi’s own window, not Chrome" />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex shrink-0 flex-col" style={{ width: callsW }}>
          <div className="flex items-center gap-2 border-b border-rule px-3 py-2 text-[11px] text-ink-faint">
            <span className="min-w-0 flex-1">
              {scoped.length} call{scoped.length === 1 ? '' : 's'} · {scoped.length - unknown.length} already requests here · {unknown.length} new
              {all.length > scoped.length && <span title={elsewhereHosts.map((o) => `${o.origin} · ${o.count}`).join('\n')}> · {all.length - scoped.length} to other hosts</span>}
            </span>
            <button
              className="btn !px-2 !py-0.5 text-[11px]"
              disabled={!all.length}
              title={mine ? 'Forget these calls and keep recording' : 'Forget these calls'}
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
              <Empty>
                {browsing
                  ? `Waiting for the app to call ${env?.baseUrl}…`
                  : mine
                    ? `Waiting for the first call on :${recorder.port}…`
                    : mode === 'browser'
                      ? `Open the web app, sign in and use it — calls to ${env?.baseUrl || p.title} show up here.`
                      : `Start recording, then use ${p.title} through localhost:${port}.`}
              </Empty>
            )}
            {scoped.map((c) => {
              const t = toolOf(c);
              return (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={`flex w-full items-center gap-2 border-b border-rule px-3 py-2 text-left ${c.id === selected ? 'bg-accent/10' : 'hover:bg-wash'}`}
                >
                  <Method method={c.method as HttpMethod} />
                  {c.replayOf && <span className="rounded bg-wash-strong px-1 text-[10px] text-ink-faint">replay</span>}
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{c.path}</span>
                  {t ? (
                    <span className="text-[11px] text-good" title={`Request: ${t.name}`}>
                      ✓
                    </span>
                  ) : (
                    <span className="rounded bg-accent/20 px-1.5 text-[10px] font-semibold text-accent">new</span>
                  )}
                  {c.error?.startsWith('Not sent') ? (
                    <span className="shrink-0 rounded bg-wash-strong px-1 text-[10px] font-medium text-ink-muted" title={c.error}>
                      not sent
                    </span>
                  ) : (
                    <span className={`w-8 text-right font-mono text-[11px] font-semibold ${c.error || c.status >= 400 ? 'text-bad' : 'text-good'}`}>{c.status}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <Splitter width={callsW} setWidth={setCallsW} initial={340} />
        <div className="min-w-0 flex-1">
          {call ? (
            <CallDetail
              key={call.id}
              call={call}
              edges={edges}
              calls={scoped}
              base={recorder.target && !browsing ? recorder.target : env?.baseUrl}
              onPick={setSelected}
              mark={
                toolOf(call) ? (
                  <CallMatch
                    name={toolOf(call)!.name}
                    project={p.title}
                    usable={!call.error && call.status < 400}
                    same={JSON.stringify(exampleFrom(toolOf(call)!, call)) === JSON.stringify(toolOf(call)!.example ?? {})}
                    secrets={examplePlan(toolOf(call)!, call).secrets.length}
                    onUse={async () => {
                      const kept = await applyCalls([[toolOf(call)!.id, call]]);
                      say(`${toolOf(call)!.name} sends these values now.${kept.length ? ` ${kept.join(', ')} kept in the keychain, not the project.` : ''}`);
                    }}
                  />
                ) : (
                  <p className="text-[11px] text-accent">Not a request in {p.title} yet — add it from Coverage.</p>
                )
              }
            />
          ) : (
            <Empty>Pick a call to see what went out and came back.</Empty>
          )}
        </div>
        <Splitter width={sideW} setWidth={setSideW} side="right" initial={340} />
        <div className="flex shrink-0 flex-col" style={{ width: sideW }}>
          <div className="px-2 pt-1">
            <SubTabs
              tabs={[
                { id: 'coverage', label: 'Coverage' },
                { id: 'graph', label: `Graph${edges.length ? ` ${edges.length}` : ''}` },
                { id: 'latency', label: 'Latency' },
              ]}
              value={right}
              onChange={setRight}
            />
          </div>
          {right === 'graph' && <GraphPanel calls={scoped} edges={edges} onPick={setSelected} target={recorder.target ?? ''} embedded />}
          {right === 'latency' && <LatencyPanel calls={scoped} onPick={setSelected} />}
          {right === 'coverage' && (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
              <p className="text-ink-muted">
                What this traffic means for <b className="text-ink">{p.title}</b>:
              </p>
              {all.length === 0 && <p className="text-ink-faint">Nothing recorded yet.</p>}
              {browsing && scoped.length === 0 && elsewhereHosts.length > 0 && (
                <div className="rounded-xl border border-warn/40 bg-warn/5 p-3">
                  <div className="font-semibold">Nothing to {env?.baseUrl.replace(/^https?:\/\//, '')} yet</div>
                  <p className="mt-1 text-ink-faint">The app is calling other hosts. If its API is one of these, make it {env?.name}’s base URL:</p>
                  <ul className="mt-1.5 space-y-1">
                    {elsewhereHosts.slice(0, 5).map((o) => (
                      <li key={o.origin} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{o.origin}</span>
                        <span className="text-[11px] text-ink-faint">{o.count}</span>
                        <button className="btn !px-2 !py-0.5 text-[11px]" onClick={() => update((x) => ({ ...x, envs: x.envs.map((e) => (e.name === env!.name ? { ...e, baseUrl: o.origin } : e)) }))}>
                          Use
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {browsing && scoped.length > 0 && !env?.browserSession && (
                <div className="rounded-xl border border-accent/40 bg-accent/5 p-3">
                  <div className="font-semibold">Sign in the way the browser does</div>
                  <p className="mt-1 text-ink-faint">
                    Keep this browser’s session (cookies, and any CSRF or token header the app sends) as {env?.name}’s sign-in, so requests and agents work as you. It’s kept in the keychain, expires
                    when the site says so, and is never published.
                  </p>
                  <button className="btn-primary mt-2.5" onClick={() => void adoptBrowserSignIn()}>
                    Use browser sign-in for {env?.name}
                  </button>
                </div>
              )}
              {newRoutes.length > 0 && (
                <div className="rounded-xl border border-accent/40 bg-accent/5 p-3">
                  <div className="font-semibold">
                    {newRoutes.length} new route{newRoutes.length === 1 ? '' : 's'}
                  </div>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink-muted">
                    {newRoutes.slice(0, 8).map((r) => (
                      <li key={r} className="truncate">
                        {r}
                      </li>
                    ))}
                  </ul>
                  <button
                    className="btn-primary mt-2.5"
                    onClick={async () => {
                      const r = await window.overapi.invoke('traffic:addNew', path!);
                      if (!r.ok) return say(r.error, true);
                      await reload();
                      say(
                        [
                          r.added ? `Added ${r.added} request${r.added === 1 ? '' : 's'} to ${p.title} — try them, then make them tools.` : `Nothing new to add to ${p.title}.`,
                          r.removed ? `Removed ${r.removed} misplaced cop${r.removed === 1 ? 'y' : 'ies'} from an earlier add.` : '',
                        ]
                          .filter(Boolean)
                          .join(' '),
                      );
                    }}
                  >
                    Add to {p.title}
                  </button>
                </div>
              )}
              {stale.length > 0 && (
                <div className="rounded-xl border border-rule p-3">
                  <div className="font-semibold">
                    Real values for {stale.length} request{stale.length === 1 ? '' : 's'}
                  </div>
                  <p className="mt-1 text-ink-faint">
                    The latest successful call’s arguments become each one’s saved example — ready to send, and offered to agents as an example of a real value (never secrets or chain variables). Arguments wired to a chain or variable stay as they are.
                  </p>
                  <button
                    className="btn mt-2.5"
                    onClick={async () => {
                      const n = stale.length;
                      const kept = await applyCalls(stale as [string, RecordedCall][]);
                      say(`Updated ${n} example${n === 1 ? '' : 's'} from real calls.${kept.length ? ` ${kept.join(', ')} kept in the keychain.` : ''}`);
                    }}
                  >
                    Update {stale.length} example{stale.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}
              {known.length > 0 && stale.length === 0 && <p className="flex items-center gap-1.5 text-[12px] text-good">✓ Examples match the latest calls.</p>}
              {known.length > 0 && (
                <div className="rounded-xl border border-rule p-3">
                  <div className="font-semibold">Save it as a test</div>
                  <p className="mt-1 text-ink-faint">
                    These {scoped.length} calls, in order, as a scenario to run again — ids passed along from each response, every answer checked for status and shape. Also a load test.
                  </p>
                  <button
                    className="btn mt-2.5"
                    onClick={async () => {
                      const name = `Recorded ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
                      const r = await window.overapi.invoke('scenario:fromRecording', path!, name);
                      if (!r.ok) return say(r.error, true);
                      update((x) => ({ ...x, scenarios: [...(x.scenarios ?? []), r.scenario] }));
                      say(`Saved ${r.scenario.steps.length} steps as a test.`);
                      setTab('tests');
                    }}
                  >
                    Save as a test
                  </button>
                </div>
              )}
              {signIn && (
                <div className="rounded-xl border border-rule p-3">
                  <div className="font-semibold">Looks like a sign-in</div>
                  <p className="mt-1 text-ink-faint">
                    {signIn.toolName} → <span className="font-mono">{signIn.auth.path}</span> → {signIn.auth.sendAs === 'bearer' ? 'Authorization' : signIn.auth.name} on {signIn.calls} call
                    {signIn.calls === 1 ? '' : 's'}.
                  </p>
                  <button
                    className="btn mt-2.5"
                    onClick={async () => {
                      update((x) => ({
                        ...x,
                        envs: x.envs.map((e) => (e.name === env!.name ? { ...e, auth: signIn.auth } : e)),
                        tools: x.tools.map((t) => (t.id === signIn.toolId ? { ...t, example: Object.keys(signIn.example).length ? signIn.example : t.example } : t)),
                      }));
                      for (const [name, value] of Object.entries(signIn.secrets)) await window.overapi.invoke('secrets:set', path!, name, value);
                      say(`${signIn.toolName} now signs in for ${env!.name}${Object.keys(signIn.secrets).length ? ' — its password is in the keychain' : ''}.`);
                    }}
                  >
                    Use as sign-in for {env?.name}
                  </button>
                </div>
              )}
              {failing.length > 0 && (
                <div className="rounded-xl border border-bad/30 p-3">
                  <div className="font-semibold text-bad">
                    {failing.length} route{failing.length === 1 ? '' : 's'} failing every time
                  </div>
                  <ul className="mt-1 space-y-1">
                    {failing.map((f) => (
                      <li key={f.key}>
                        <button className="w-full truncate text-left font-mono text-[11px] text-ink-muted hover:text-ink" onClick={() => setSelected(f.slowestId)}>
                          {f.key}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {scoped.length > 0 && !newRoutes.length && !signIn && !failing.length && <p className="text-good">Everything recorded is already in {p.title}, and nothing is failing.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/// Which request a call is, and — when its values differ from that
/// request's saved ones — a way to make them its defaults.
function CallMatch({ name, project, usable, same, secrets, onUse }: { name: string; project: string; usable: boolean; same: boolean; secrets: number; onUse: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
      <span>
        This is <b className="text-ink">{name}</b> in {project}.
      </span>
      {usable && same && <span className="text-good">Its saved values match this call.</span>}
      {usable && !same && (
        <button
          type="button"
          className="font-medium text-accent hover:underline disabled:opacity-50"
          disabled={busy}
          title={secrets ? 'Passwords and keys go to the keychain; the request keeps ${NAME}.' : undefined}
          onClick={async () => {
            setBusy(true);
            await onUse();
            setBusy(false);
          }}
        >
          Use these values for {name}
          {secrets ? ' (secrets to the keychain)' : ''}
        </button>
      )}
    </div>
  );
}
