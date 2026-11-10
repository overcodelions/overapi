import { PublishSheet } from './PublishSheet';
import { envKind } from '@shared/project';
import { AgentReadySheet } from './AgentReadySheet';
import { useEffect, useState } from 'react';
import { useStore, type Tab } from './store';
import { RequestsTab } from './RequestsTab';
import { EnvsTab } from './EnvsTab';
import { McpTab } from './McpTab';
import { RecorderView } from './RecorderView';
import { TrafficTab } from './TrafficTab';
import { TestsTab } from './TestsTab';
import { DeleteApiSheet } from './DeleteApiSheet';
import { NewApiSheet } from './NewApiSheet';
import { SettingsSheet } from './SettingsSheet';
import { CurlSheet, NewRequestSheet } from './RequestSheets';
import { AiMark, EnvBand, EnvDot, InlineRename, Splitter, useWidth } from './ui';
import { Icon, Monogram, type IconName } from './icons';
import { checkProject } from '@shared/check';
import { pasteIntent } from './pasteIntent';
import { SystemSheet, SystemView } from './SystemView';
import type { ProjectRef } from '@shared/ipc';

export function App(): JSX.Element {
  const { boot, booted, bootError, project, loadError, toast, sheet, recording, system } = useStore();
  useEffect(() => {
    void boot();
  }, [boot]);

  // ⌘V outside a text field: a cURL, a spec, a docs URL — open New API on
  // the right tab with it already in. In a field, paste is just paste.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || useStore.getState().sheet)) return;
      const intent = pasteIntent(e.clipboardData?.getData('text') ?? '');
      if (!intent) return;
      e.preventDefault();
      useStore.getState().openSheet({ kind: 'new', mode: intent.mode, prefill: intent.prefill });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  if (!booted) return <Splash />;
  if (bootError) return <BootError message={bootError} />;

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col bg-canvas">{recording ? <RecorderView /> : system ? <SystemView /> : project ? <ProjectBody /> : loadError ? <LoadError /> : <Welcome />}</main>
      </div>
      {sheet?.kind === 'new' && <NewApiSheet key={`${sheet.mode}:${sheet.prefill ?? ''}`} mode={sheet.mode} prefill={sheet.prefill} />}
      {sheet?.kind === 'settings' && <SettingsSheet />}
      {sheet?.kind === 'system' && <SystemSheet members={sheet.members} />}
      {sheet?.kind === 'delete' && <DeleteApiSheet path={sheet.path} title={sheet.title} />}
      {sheet?.kind === 'curl' && <CurlSheet />}
      {sheet?.kind === 'request' && <NewRequestSheet />}
      {sheet?.kind === 'publish' && <PublishSheet />}
      {sheet?.kind === 'agentready' && <AgentReadySheet />}
      {toast && (
        <div
          className={`rise fixed bottom-5 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-center gap-2 rounded-lg border px-3.5 py-2 text-[12px] shadow-2xl ${
            toast.bad ? 'border-bad/40 bg-surface-elevated text-bad' : 'border-rule-strong bg-surface-elevated text-ink'
          }`}
        >
          <Icon name={toast.bad ? 'alert' : 'check'} size={14} className={toast.bad ? 'text-bad' : 'text-good'} />
          {toast.text}
        </div>
      )}
    </div>
  );
}

/// The same mark and motion as the HTML splash in index.html, so the hand-
/// over to React is seamless.
function Splash(): JSX.Element {
  return (
    <div className="drag fixed inset-0 flex flex-col items-center justify-center gap-4">
      <Mark size={56} />
      <div className="display text-[17px] font-semibold">overapi</div>
      <div className="-mt-3 text-[11px] text-ink-faint">APIs as tools for agents</div>
      <div className="relative h-0.5 w-24 overflow-hidden rounded bg-wash-strong">
        <div className="absolute inset-y-0 w-2/5 animate-[slide_1.2s_cubic-bezier(.65,0,.35,1)_infinite] bg-accent/80" />
      </div>
    </div>
  );
}

function BootError({ message }: { message: string }): JSX.Element {
  return (
    <div className="drag fixed inset-0 flex items-center justify-center p-10">
      <div className="no-drag max-w-md rounded-xl border border-rule-strong bg-surface-elevated p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <Mark size={28} />
          <h1 className="display text-[18px] font-semibold">overapi couldn’t start</h1>
        </div>
        <p className="selectable mt-3 text-[13px] text-ink-muted">{message}</p>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
          In development this almost always means the app’s main process is older than this window — stop <span className="font-mono">npm run dev</span> and start it again (from now on it restarts
          itself when main changes).
        </p>
        <button className="btn-primary mt-4" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    </div>
  );
}

export function Mark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path d="M20 8 Q 10 8 10 18 L 10 26 Q 10 32 4 32 Q 10 32 10 38 L 10 46 Q 10 56 20 56" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M44 8 Q 54 8 54 18 L 54 26 Q 54 32 60 32 Q 54 32 54 38 L 54 46 Q 54 56 44 56" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22" cy="32" r="4.5" className="fill-accent" />
      <circle cx="32" cy="32" r="4.5" className="fill-accent" />
      <circle cx="42" cy="32" r="4.5" className="fill-accent" />
    </svg>
  );
}

/// Two jobs, two groups: the API (using it — an API client) and the MCP
/// server (what you make from it). The MCP server's own views sit in the
/// bar, not in a second row on its page.
/// The API page last open — where the API side of the switch returns to.

const API_TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'requests', label: 'Requests', icon: 'requests' },
  { id: 'envs', label: 'Environments', icon: 'envs' },
  { id: 'traffic', label: 'Record', icon: 'pulse' },
  { id: 'tests', label: 'Tests', icon: 'check' },
];

/// One bar across the window, as in overcli: the traffic lights' inset,
/// where you are, the page switcher, and the things that are always true of
/// the open API — environment, readiness, saved.
function TitleBar(): JSX.Element {
  const { project, path, tab, setTab, mcpTab, setMcpTab, save, saveError, secrets, env, setEnv, openSheet, recorder } = useStore();
  const mcp = tab === 'mcp';
  const p = project;
  const vars = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v]));
  const score = p ? checkProject(p, vars).score : 0;
  return (
    <header className="drag relative flex h-[38px] shrink-0 items-center border-b border-rule bg-surface pl-[84px] pr-2">
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <Mark size={15} />
        <span className="display font-semibold text-ink">overapi</span>
        {p && (
          <>
            <span className="text-ink-faint">/</span>
            <InlineRename value={p.title} className="text-ink-muted" title="Rename this API" onRename={(t) => void useStore.getState().renameProject(path!, t)} />
          </>
        )}
      </div>

      {p && (
        // One row that never changes shape: the API's pages, then the MCP
        // server made from it — a destination, with how ready it is on it.
        <nav aria-label="Pages" className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5">
          {API_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${tab === t.id ? 'bg-wash-strong text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              <Icon name={t.icon} size={13} className="hidden xl:block" />
              {t.label}
              {t.id === 'traffic' && recorder.running && recorder.projectPath === path && (
                <span className="ml-0.5 inline-flex items-center gap-1 text-[10px] text-bad">
                  <span className="h-1.5 w-1.5 rounded-full bg-bad" /> {recorder.count}
                </span>
              )}
            </button>
          ))}
          <span className="mx-1.5 h-4 w-px bg-rule-strong" aria-hidden />
          <button
            onClick={() => setTab('mcp')}
            aria-current={mcp ? 'page' : undefined}
            title={`The MCP server agents get from this API — ready for agents: ${score}/100`}
            className={`flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${mcp ? 'bg-accent/15 text-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            <Icon name="bot" size={13} className={mcp ? 'text-accent' : ''} />
            MCP server
            <span className={`ml-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${score >= 90 ? 'bg-good/15 text-good' : score >= 60 ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad'}`}>{score}</span>
          </button>
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {p && (
          <>
            {/* Every edit saves itself; only say so while it is happening
                or when it failed. */}
            {save !== 'saved' && (
              <span className={`mr-1 text-[11px] ${save === 'error' ? 'text-bad' : 'text-ink-faint'}`} title={saveError}>
                {save === 'pending' ? 'Saving…' : 'Not saved'}
              </span>
            )}
            {p.envs.length > 0 && p.envs.length <= 4 && (
              <div
                role="group"
                aria-label="Environment"
                className="flex items-center gap-0.5 rounded-full border border-rule-strong bg-wash-strong p-0.5 pl-2.5"
                title="Where requests go — and which server agents get"
              >
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Env</span>
                {p.envs.map((e) => {
                  const on = e.name === env;
                  return (
                    <button
                      key={e.name}
                      aria-pressed={on}
                      onClick={() => setEnv(e.name)}
                      title={on ? `Requests go to ${e.baseUrl || 'no base URL yet'}` : `Switch to ${e.name}`}
                      className={`flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors ${on ? `${envFill(e.name)} font-semibold shadow-sm ring-1 ring-inset` : 'text-ink-muted hover:text-ink'}`}
                    >
                      <EnvDot name={e.name} />
                      {e.name}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
        <button className="icon-btn" title="Settings" onClick={() => openSheet({ kind: 'settings' })}>
          <Icon name="settings" size={15} />
        </button>
      </div>
    </header>
  );
}

function Sidebar(): JSX.Element {
  const [sideW, setSideW] = useWidth('sidebar', 232, 180);
  const { projects, systems, system: systemOpen, openSystem, path, open, openSheet, openRecorder, recording: recordingOn, recorder } = useStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const grouped = new Set(systems.flatMap((sy) => sy.members));
  const rest = projects.filter((p) => !grouped.has(p.path));
  const recOrigin = (() => {
    try {
      return recorder.running && recorder.target ? new URL(recorder.target).origin : '';
    } catch {
      return '';
    }
  })();
  const row = (p: ProjectRef, nested = false) => {
            const here = p.path === path;
            return (
              <div
                key={p.path}
                role="button"
                tabIndex={0}
                onClick={() => void open(p.path)}
                onKeyDown={(e) => e.key === 'Enter' && void open(p.path)}
                title={p.path}
                className={`group relative mb-px flex w-full cursor-pointer items-center gap-2.5 rounded-md py-1.5 pr-2 text-left transition-colors ${nested ? 'pl-5' : 'pl-2'} ${here ? 'bg-wash-strong' : 'hover:bg-wash'}`}
              >
                {nested && <span className="absolute left-[9px] top-0 bottom-0 w-px bg-rule-strong/60" />}
                {here && <span className="absolute -left-2 top-1.5 bottom-1.5 w-[3px] rounded-r bg-accent" />}
                <Monogram name={p.title} />
                {recOrigin && (recorder.projectPath === p.path || (!recorder.projectPath && p.origins?.includes(recOrigin))) && (
                  <span className="absolute left-[30px] top-1.5 flex h-2 w-2" title="Being recorded — traffic to this API is going through the recorder">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-bad ring-2 ring-surface" />
                  </span>
                )}
                <span
                  className="min-w-0 flex-1"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenaming(p.path);
                  }}
                >
                  {renaming === p.path ? (
                    <input
                      autoFocus
                      defaultValue={p.title}
                      className="block w-full rounded bg-wash-strong px-1 text-[13px] outline-none ring-1 ring-accent/50"
                      aria-label="New name"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setRenaming(null);
                        if (v && v !== p.title) void useStore.getState().renameProject(p.path, v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <span
                      className={`block truncate text-[13px] ${here ? 'font-medium text-ink' : 'text-ink-muted group-hover:text-ink'} ${p.missing ? 'line-through' : ''}`}
                      title="Double-click to rename"
                    >
                      {p.title}
                    </span>
                  )}
                  {recorder.running && recorder.projectPath === p.path ? (
                    <span className="block text-[11px] text-bad">
                      recording · {recorder.count} call
                      {recorder.count === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="block text-[11px] text-ink-faint">{p.missing ? 'file not found' : `${p.tools} request${p.tools === 1 ? '' : 's'}`}</span>
                  )}
                </span>
                <button
                  className="icon-btn h-6 w-6 shrink-0 opacity-0 hover:text-ink group-hover:opacity-100"
                  title={`Rename ${p.title}`}
                  aria-label={`Rename ${p.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming(p.path);
                  }}
                >
                  ✎
                </button>
                <button
                  className="icon-btn h-6 w-6 shrink-0 opacity-30 hover:text-bad group-hover:opacity-100"
                  title={`Delete ${p.title}`}
                  aria-label={`Delete ${p.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSheet({ kind: 'delete', path: p.path, title: p.title });
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
  };
  return (
    <>
      <aside className="flex shrink-0 flex-col bg-surface" style={{ width: sideW }}>
        <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">APIs</span>
          <span className="flex items-center">
            {projects.length > 1 && (
              <button className="icon-btn h-6 w-6" title="New workspace — APIs that belong together, signed in by one of them" onClick={() => openSheet({ kind: 'system' })}>
                <Icon name="folder" size={13} />
              </button>
            )}
            <button className="icon-btn h-6 w-6" title="New API" onClick={() => openSheet({ kind: 'new', mode: 'start' })}>
              <Icon name="plus" size={14} />
            </button>
          </span>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2">
          {projects.length === 0 && <div className="px-2 py-2 text-[12px] text-ink-faint">Nothing yet — start one below.</div>}
          {systems.map((sy) => {
            const shut = closed.has(sy.path);
            const on = sy.path === systemOpen;
            const inIt = projects.filter((p) => sy.members.includes(p.path));
            return (
              <div key={sy.path} className="mb-1.5">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => openSystem(sy.path)}
                  onKeyDown={(e) => e.key === 'Enter' && openSystem(sy.path)}
                  title={`${sy.title} — ${inIt.length} APIs${sy.signedInBy ? `, signed in by ${sy.signedInBy}` : ''}`}
                  className={`group relative mb-px flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${on ? 'bg-wash-strong' : 'hover:bg-wash'}`}
                >
                  {on && <span className="absolute -left-2 top-1.5 bottom-1.5 w-[3px] rounded-r bg-accent" />}
                  <button
                    className="icon-btn -ml-1 h-5 w-5 shrink-0"
                    aria-label={shut ? 'Show its APIs' : 'Hide its APIs'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setClosed((c) => {
                        const n = new Set(c);
                        shut ? n.delete(sy.path) : n.add(sy.path);
                        return n;
                      });
                    }}
                  >
                    <Icon name="chevron" size={11} className={`transition-transform ${shut ? '' : 'rotate-90'}`} />
                  </button>
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                    <Icon name="folder" size={12} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] font-medium ${on ? 'text-ink' : 'text-ink-muted group-hover:text-ink'}`}>{sy.title}</span>
                    <span className="block text-[11px] text-ink-faint">
                      workspace · {inIt.length} APIs
                    </span>
                  </span>
                </div>
                {!shut && inIt.map((p) => row(p, true))}
              </div>
            );
          })}
          {systems.length > 0 && rest.length > 0 && <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Other APIs</div>}
          {rest.map((p) => row(p))}
        </nav>
        <div className="space-y-1.5 border-t border-rule p-2">
          <button
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${recordingOn ? 'bg-wash-strong text-ink' : recorder.running ? 'bg-bad/10 text-ink' : 'text-ink-muted hover:bg-wash hover:text-ink'}`}
            onClick={() => openRecorder()}
            title={
              recorder.running
                ? recorder.mode === 'browser'
                  ? `Recording in overapi's browser: ${recorder.site}`
                  : `Recording: http://localhost:${recorder.port} → ${recorder.target}`
                : "Record an API's traffic — through a local address, or a web app in overapi's browser — and build from it"
            }
          >
            <span className="relative flex h-2 w-2 shrink-0">
              {recorder.running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad opacity-60" />}
              <span className="relative inline-flex h-2 w-2 rounded-full bg-bad/80" />
            </span>
            {recorder.running ? (
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  Recording · {recorder.count} call
                  {recorder.count === 1 ? '' : 's'}
                </span>
                <span className="block truncate font-mono text-[10px] text-ink-faint">
                  {recorder.mode === 'browser'
                    ? `${recorder.via === 'chrome' ? 'chrome' : 'browser'} · ${recorder.site?.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
                    : `:${recorder.port} → ${recorder.target?.replace(/^https?:\/\//, '')}`}
                </span>
              </span>
            ) : (
              'Record traffic'
            )}
          </button>
          <button className="btn h-8 w-full" onClick={() => openSheet({ kind: 'new', mode: 'start' })}>
            <Icon name="plus" size={14} /> New API
          </button>
        </div>
      </aside>
      <Splitter width={sideW} setWidth={setSideW} initial={232} />
    </>
  );
}

function Welcome(): JSX.Element {
  const { openSheet, info } = useStore();
  const ai = info?.ai.claude || info?.ai.codex;
  const ways: {
    mode: 'start' | 'import' | 'curl' | 'docs';
    title: string;
    text: string;
    icon: IconName;
    ai?: boolean;
  }[] = [
    {
      mode: 'start',
      icon: 'plus',
      title: 'Start from scratch',
      text: 'A base URL and your first request — like any API client.',
    },
    {
      mode: 'curl',
      icon: 'terminal',
      title: 'Paste a cURL',
      text: '“Copy as cURL” from the browser’s network tab, or the line in the wiki.',
    },
    {
      mode: 'import',
      icon: 'file',
      title: 'Import a spec or capture',
      text: 'OpenAPI, Swagger, a HAR from the network tab, or a Postman collection.',
    },
    {
      mode: 'docs',
      icon: 'sparkle',
      title: 'Discover from documentation',
      text: 'PDFs, pages or a docs URL. Your own claude or codex drafts the API.',
      ai: true,
    },
  ];
  return (
    <div className="h-full overflow-y-auto">
      <div className="rise mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-9 px-10 py-12">
        <div>
          <Mark size={40} />
          <h1 className="display mt-5 text-[34px] font-semibold leading-[1.1]">Make any API easy for agents.</h1>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-muted">
            An API client that lives on your machine — no account, no cloud — where every request you save can become a tool. Build it, try it, shape it, then publish it to Claude Code, Codex, overcli
            or your org’s overgo.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {ways.map((w) => (
            <button
              key={w.mode}
              disabled={w.ai && !ai}
              onClick={() => openSheet({ kind: 'new', mode: w.mode })}
              className="group flex gap-3 rounded-xl border border-rule bg-wash p-4 text-left transition-all hover:border-accent/40 hover:bg-wash-strong disabled:opacity-50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon name={w.icon} size={16} />
              </span>
              <span>
                <span className="flex items-center gap-2 text-[13px] font-semibold">
                  {w.title} {w.ai && <AiMark />}
                </span>
                <span className="mt-1 block text-[12px] leading-relaxed text-ink-muted">{w.ai && !ai ? 'Needs the claude or codex CLI installed and signed in.' : w.text}</span>
              </span>
            </button>
          ))}
        </div>
        <Steps />
        <p className="text-[12px] text-ink-faint">
          Tip: copy a cURL, a spec URL or a docs page and press <kbd className="rounded border border-rule-strong px-1 font-mono text-[11px]">⌘V</kbd> anywhere.
        </p>
      </div>
    </div>
  );
}

/// The four steps, as a strip — on the welcome screen as a map, on a
/// project's Overview as a checklist.
export function Steps({ done }: { done?: [boolean, boolean, boolean, boolean] }): JSX.Element {
  const steps = [
    ['Build', 'Requests from scratch, a cURL, a spec or the docs'],
    ['Try', 'Send them against local, staging or production'],
    ['Shape', 'Names, descriptions, what’s safe, what’s on'],
    ['Publish', 'To your Mac’s agents, or your org’s overgo'],
  ];
  return (
    <ol className="grid grid-cols-4 gap-4">
      {steps.map(([t, d], i) => (
        <li key={t} className="flex gap-2.5">
          <span
            className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
              done?.[i] ? 'bg-good/20 text-good' : 'border border-rule-strong text-ink-faint'
            }`}
          >
            {done?.[i] ? <Icon name="check" size={12} /> : i + 1}
          </span>
          <div>
            <div className="text-[12px] font-semibold">{t}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-faint">{d}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function LoadError(): JSX.Element {
  const { loadError, path, refreshProjects, close } = useStore();
  return (
    <div className="mx-auto max-w-lg px-8 py-16">
      <h2 className="display text-[18px] font-semibold">This API won’t open.</h2>
      <p className="selectable mt-2 text-ink-muted">{loadError}</p>
      <button
        className="btn mt-4"
        onClick={async () => {
          await window.overapi.invoke('projects:forget', path!);
          close();
          await refreshProjects();
        }}
      >
        Remove from the list
      </button>
    </div>
  );
}

function ProjectBody(): JSX.Element {
  const { tab, project, env: envName, setTab } = useStore();
  const env = project?.envs.find((e) => e.name === envName) ?? project?.envs[0];
  return (
    <>
      {env && <EnvBand name={env.name} baseUrl={env.baseUrl} writes={env.allowWrites} onSetUrl={() => setTab('envs')} />}
      <section key={tab} className="min-h-0 flex-1 overflow-hidden">
        {tab === 'requests' && <RequestsTab />}
        {tab === 'envs' && <EnvsTab />}
        {tab === 'traffic' && <TrafficTab />}
        {tab === 'tests' && <TestsTab />}
        {tab === 'mcp' && <McpTab />}
      </section>
    </>
  );
}

/// The active environment, filled with its kind's colour — blue local,
/// amber test, red production, violet anything else — so it's obvious.
function envFill(name: string): string {
  const k = envKind(name);
  return k === 'local'
    ? 'bg-sky-500/25 text-sky-900 ring-sky-500/50 dark:text-sky-100'
    : k === 'test'
      ? 'bg-amber-500/25 text-amber-900 ring-amber-500/50 dark:text-amber-100'
      : k === 'production'
        ? 'bg-red-500/25 text-red-900 ring-red-500/50 dark:text-red-100'
        : 'bg-violet-500/25 text-violet-900 ring-violet-500/50 dark:text-violet-100';
}
