import { useEffect, useRef, useState } from 'react';
import { useStore, type NewMode } from './store';
import { AiMark, Sheet } from './ui';
import { CurlHelp } from './RequestSheets';
import { LocalServers, serverName } from './LocalServers';
import { Icon } from './icons';
import type { LocalServer } from '@shared/ipc';

const MODES: { id: NewMode; label: string; ai?: boolean }[] = [
  { id: 'start', label: 'From scratch' },
  { id: 'curl', label: 'From a cURL' },
  { id: 'import', label: 'Import' },
  { id: 'docs', label: 'From documentation', ai: true },
];

export function NewApiSheet({ mode: initial, prefill }: { mode: NewMode; prefill?: string }): JSX.Element {
  const { openSheet } = useStore();
  const [mode, setMode] = useState<NewMode>(initial);
  // The pasted text belongs to the tab it was recognised for; switching
  // tabs by hand starts that tab empty.
  const fill = mode === initial ? prefill : undefined;
  return (
    <Sheet title="New API" wide onClose={() => openSheet(null)}>
      <div className="mb-4 flex gap-1 rounded-lg bg-wash p-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium ${mode === m.id ? 'bg-surface-elevated shadow-sm' : 'text-ink-muted hover:text-ink'}`}
          >
            {m.label} {m.ai && <AiMark />}
          </button>
        ))}
      </div>
      {mode === 'start' && <Start />}
      {mode === 'curl' && <FromCurl prefill={fill} />}
      {mode === 'import' && <Import prefill={fill} />}
      {mode === 'docs' && <Discover prefill={fill} />}
    </Sheet>
  );
}

async function opened(r: { ok: boolean; path?: string; error?: string; note?: string }, after?: () => Promise<void>): Promise<boolean> {
  const s = useStore.getState();
  if (r.ok && r.path) {
    await s.refreshProjects();
    await s.open(r.path, 'overview');
    if (after) await after();
    s.openSheet(null);
    s.say(r.note ?? 'Created. Agents only get read-only access until you allow writes.');
    return true;
  }
  if (r.error) s.say(r.error, true);
  return false;
}

function Start(): JSX.Element {
  const { info, settings } = useStore();
  const [title, setTitle] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [picked, setPicked] = useState<LocalServer | null>(null);
  const [reading, setReading] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type === 'discover:step' || e.type === 'discover:phase') setLog((l) => [...l.slice(-300), e.type === 'discover:phase' ? `▸ ${e.text}` : e.text]);
      }),
    [],
  );
  const tool = settings?.ai === 'codex' || (settings?.ai === 'auto' && !info?.ai.claude) ? 'codex' : 'claude';
  const hasAi = !!(info?.ai.claude || info?.ai.codex);

  const readCode = async () => {
    if (!picked?.dir) return;
    setReading(true);
    setLog([]);
    const r = await window.overapi.invoke('discover:run', { files: [], sourceDir: picked.dir, source: picked.source, baseUrl, title: title.trim() || picked.folder });
    if (!(await opened(r))) setReading(false);
  };

  if (reading && picked) return <Reading s={picked} tool={tool} log={log} />;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        // Straight on to the first request: a new API with nothing in it
        // is the one screen with no next step.
        if (await opened(await window.overapi.invoke('projects:create', { title: title || 'New API', baseUrl }))) useStore.getState().openSheet({ kind: 'request' });
      }}
    >
      <div className="grid grid-cols-[1fr_1.3fr] gap-3">
        <div>
          <label className="label">Name</label>
          <input className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme Orders" />
        </div>
        <div>
          <label className="label">Base URL</label>
          <input
            className="field font-mono"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setPicked(null);
            }}
            placeholder="http://localhost:4010/api/v1"
          />
        </div>
      </div>
      <LocalServers
        variant="list"
        selected={picked?.port}
        onPick={(url, s) => {
          setBaseUrl(url);
          setPicked(s);
          const was = picked ? [picked.folder, picked.process, picked.spec?.title, serverName(picked)] : [];
          if (!title.trim() || was.includes(title)) setTitle(serverName(s));
        }}
      />
      {picked && <Found s={picked} title={title} tool={tool} hasAi={hasAi} onReadCode={() => void readCode()} />}
      <div className="flex items-center gap-3 border-t border-rule pt-3">
        <p className="flex-1 text-[11px] leading-snug text-ink-faint">Starts as a “local” environment you can write to. Staging and production start read-only.</p>
        <button className={picked && !picked.spec ? 'btn' : 'btn-primary'}>{picked && !picked.spec ? 'Create it empty' : 'Create and add a request'}</button>
      </div>
    </form>
  );
}

/// The last two folders of a path — enough to recognise it.
const shortDir = (dir: string) => `…/${dir.split('/').filter(Boolean).slice(-2).join('/')}`;

/// What overapi can do with the picked server: import its spec, or — when
/// none answers — read the service's own code, or fetch the spec with a
/// token it needs.
function Found({ s, title, tool, hasAi, onReadCode }: { s: LocalServer; title: string; tool: string; hasAi: boolean; onReadCode: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');

  if (s.spec)
    return (
      <div className="flex items-center gap-3 rounded-xl border border-good/30 bg-good/5 px-4 py-3 text-[12.5px]">
        <Icon name="check" size={16} className="text-good" />
        <span className="flex-1">
          <b className="font-medium">{s.spec.title}</b> <span className="text-ink-muted">serves its spec — {s.spec.tools} requests, documented.</span>
        </span>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (!(await opened(await window.overapi.invoke('projects:import', { url: s.spec!.url })))) setBusy(false);
          }}
        >
          {busy ? 'Importing…' : `Import ${s.spec.tools} requests`}
        </button>
      </div>
    );

  const withToken = async () => {
    setBusy(true);
    if (!(await opened(await window.overapi.invoke('local:importSpec', { port: s.port, auth: token, title: title.trim() || undefined })))) setBusy(false);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-rule">
      <div className="flex items-start gap-3 border-b border-rule bg-wash px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
          <Icon name={s.needsAuth ? 'lock' : 'search'} size={14} />
        </span>
        <div className="min-w-0 text-[12.5px]">
          <div className="font-medium">{s.needsAuth ? `${serverName(s)} needs sign-in` : `${serverName(s)} doesn’t serve a spec`}</div>
          <div className="mt-0.5 leading-snug text-ink-muted">
            {s.needsAuth ? `Every address answers ${s.status}, including where specs usually live` : 'Nothing at /v3/api-docs, /openapi.json or the other usual places'} — so overapi can’t list its endpoints yet.
          </div>
        </div>
      </div>
      <div className={`grid ${s.needsAuth ? 'grid-cols-2 divide-x divide-rule' : 'grid-cols-1'}`}>
        <div className="flex flex-col gap-2.5 p-4">
          <div className="flex items-center gap-2">
            <Icon name="file" size={14} className="text-accent" />
            <span className="text-[13px] font-semibold">Read its code</span>
            <AiMark />
            <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">Recommended</span>
          </div>
          {s.dir ? (
            <>
              <p className="text-[12px] leading-relaxed text-ink-muted">
                {hasAi ? <><b className="text-ink">{tool}</b> finds the routes, request and response classes and how it signs callers in. Read-only.</> : 'Needs your own claude or codex CLI — neither is installed.'}
              </p>
              <div className="flex items-center gap-1.5 rounded-md bg-wash px-2 py-1.5 font-mono text-[11px] text-ink-muted" title={s.dir}>
                <Icon name="folder" size={12} className="text-ink-faint" />
                <span className="truncate">{shortDir(s.dir)}</span>
                {s.source && <span className="ml-auto shrink-0 font-sans text-ink-faint">{s.source}</span>}
              </div>
              <button type="button" className="btn-primary mt-auto self-start" disabled={!hasAi || busy} onClick={onReadCode}>
                <Icon name="sparkle" size={13} /> Read its code
              </button>
            </>
          ) : (
            <p className="text-[12px] leading-relaxed text-ink-faint">It doesn’t run from a source folder overapi can see. Use From documentation, or record its traffic.</p>
          )}
        </div>
        {s.needsAuth && (
          <div className="flex flex-col gap-2.5 p-4">
            <div className="flex items-center gap-2">
              <Icon name="key" size={14} className="text-ink-muted" />
              <span className="text-[13px] font-semibold">Use a token</span>
            </div>
            <p className="text-[12px] leading-relaxed text-ink-muted">Paste a bearer token or Cookie header it accepts — copy one from your app in the browser’s Network tab. Fetches the exact spec, and becomes the sign-in.</p>
            <input className="field font-mono text-[12px]" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOi…  ·  SESSION=…" />
            <button type="button" className="btn mt-auto self-start" disabled={!token.trim() || busy} onClick={() => void withToken()}>
              {busy ? 'Fetching…' : 'Fetch the spec'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/// One step of the reader, readable: what it did, and the file's name with
/// its folder muted.
function StepLine({ text }: { text: string }): JSX.Element {
  if (text.startsWith('▸ ')) return <li className="pt-1 font-sans text-[12px] font-medium text-ink">{text.slice(2)}</li>;
  const m = text.match(/^(Reading|Listing|Searching for|Fetching)\s+(.*)$/);
  const verb = m?.[1] ?? '';
  const rest = m?.[2] ?? text;
  const file = verb === 'Reading' ? rest.split('/') : null;
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Icon name={verb === 'Reading' ? 'file' : verb.startsWith('Search') || verb === 'Listing' ? 'search' : 'chevron'} size={11} className="text-ink-faint" />
      <span className="min-w-0 truncate">
        {file ? (
          <>
            <span className="text-ink">{file.pop()}</span>
            <span className="ml-2 text-ink-faint">{file.slice(-3).join('/')}</span>
          </>
        ) : (
          <span className="text-ink-muted">{verb ? `${verb.toLowerCase()} ` : ''}{rest}</span>
        )}
      </span>
    </li>
  );
}

/// While the code is read: the whole sheet is the progress, with a way out.
function Reading({ s, tool, log }: { s: LocalServer; tool: string; log: string[] }): JSX.Element {
  const ref = useRef<HTMLUListElement>(null);
  const files = new Set(log.filter((l) => l.startsWith('Reading ')).map((l) => l.slice(8))).size;
  const searches = log.filter((l) => l.startsWith('Searching') || l.startsWith('Listing')).length;
  const [started] = useState(() => Date.now());
  const [lastAt, setLastAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setLastAt(Date.now());
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.length]);
  // Reading done, it writes the whole spec in one answer — no steps for a
  // while, which looks like a hang unless it says so.
  const quiet = log.length > 3 && now - lastAt > 15_000;
  const secs = Math.floor((now - started) / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const phase = quiet
    ? `Writing up the API from ${files} file${files === 1 ? '' : 's'} — the quiet part, usually a minute or two`
    : [...log].reverse().find((l) => l.startsWith('▸ '))?.slice(2);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Icon name="sparkle" size={16} />
          <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">
            {tool} is reading {serverName(s)}
          </div>
          <div className="truncate text-[12px] text-ink-muted">{phase ?? 'Starting…'}</div>
        </div>
        <span className="font-mono text-[12px] tabular-nums text-ink-faint">{clock}</span>
        <button type="button" className="btn" onClick={() => void window.overapi.invoke('discover:cancel')}>
          Stop
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Files read', files],
          ['Searches', searches],
          ['Source', s.source ?? s.process],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-lg border border-rule px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{k}</div>
            <div className="mt-0.5 text-[15px] font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <ul ref={ref} className="h-[260px] space-y-1 overflow-y-auto rounded-xl border border-rule bg-wash px-3.5 py-3 font-mono text-[11.5px]">
        {log.length ? log.map((l, i) => <StepLine key={i} text={l} />) : <li className="text-ink-faint">Starting {tool}…</li>}
        {quiet && (
          <li className="flex items-center gap-2 pt-1 font-sans text-[12px] text-accent">
            <Icon name="sparkle" size={11} className="animate-pulse" /> writing the spec…
          </li>
        )}
      </ul>
      <p className="text-[11.5px] leading-relaxed text-ink-faint">
        Read-only — {tool} can open and search files in <span className="font-mono">{s.dir ? shortDir(s.dir) : ''}</span>, nothing else. A big service takes a few minutes; the API opens when it’s done.
      </p>
    </div>
  );
}

function FromCurl({ prefill }: { prefill?: string }): JSX.Element {
  const { project, addCurl, openSheet } = useStore();
  const [title, setTitle] = useState('');
  const [text, setText] = useState(prefill ?? '');
  return (
    <div className="space-y-3">
      <CurlHelp />
      <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name for a new API (e.g. Acme Orders)" />
      <textarea className="field min-h-[150px] font-mono text-[12px]" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="curl 'https://…'" />
      <div className="flex justify-end gap-2">
        {project && (
          <button className="btn" disabled={!text.trim()} onClick={async () => (await addCurl(text)) && openSheet(null)}>
            Add to {project.title}
          </button>
        )}
        <button
          className="btn-primary"
          disabled={!text.trim()}
          onClick={async () => {
            let host = 'New API';
            try {
              host = new URL(text.match(/https?:\/\/[^\s'"]+/)?.[0] ?? '').hostname.split('.').find((x) => !/^(www|api)$/.test(x)) ?? host;
            } catch {
              // Named below.
            }
            const r = await window.overapi.invoke('projects:create', { title: title || host });
            await opened(r, async () => {
              await useStore.getState().addCurl(text);
              useStore.getState().update((p) => ({ ...p, source: { kind: 'curl', importedAt: new Date().toISOString() } }));
            });
          }}
        >
          Create new API
        </button>
      </div>
    </div>
  );
}

function Import({ prefill }: { prefill?: string }): JSX.Element {
  const isUrl = !!prefill && /^https?:\/\//i.test(prefill);
  const [url, setUrl] = useState(isUrl ? prefill! : '');
  const [pasted] = useState(!isUrl ? (prefill ?? '') : '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      {pasted && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
          <div className="mb-2 text-[12px] font-medium">You pasted a spec or capture ({pasted.length.toLocaleString()} characters).</div>
          <pre className="max-h-24 overflow-hidden whitespace-pre-wrap font-mono text-[11px] text-ink-faint">{pasted.slice(0, 400)}</pre>
          <button
            className="btn-primary mt-2"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await opened(await window.overapi.invoke('projects:import', { text: pasted }));
              setBusy(false);
            }}
          >
            {busy ? 'Importing…' : 'Import what I pasted'}
          </button>
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-ink-muted">
        An <b>OpenAPI 3</b> or <b>Swagger 2</b> spec (JSON or YAML), a <b>HAR</b> capture — in the browser’s Network tab, use the app, then “Save all as HAR” — or a <b>Postman v2</b>{' '}
        collection export. Everything is imported read-only; no captured token is kept.
      </p>
      <button
        className="btn-primary"
        disabled={busy}
        onClick={async () => {
          const file = await window.overapi.invoke('projects:pickImport');
          if (!file) return;
          setBusy(true);
          await opened(await window.overapi.invoke('projects:import', { file }));
          setBusy(false);
        }}
      >
        Choose a file…
      </button>
      <LocalServers
        mode="spec"
        onPick={async (specUrl) => {
          setBusy(true);
          await opened(await window.overapi.invoke('projects:import', { url: specUrl }));
          setBusy(false);
        }}
      />
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!url.trim()) return;
          setBusy(true);
          await opened(await window.overapi.invoke('projects:import', { url: url.trim() }));
          setBusy(false);
        }}
      >
        <input className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.acme.example/openapi.json" />
        <button className="btn shrink-0" disabled={busy || !url.trim()}>{busy ? 'Importing…' : 'Import URL'}</button>
      </form>
      <button
        className="text-[12px] text-ink-muted hover:text-ink"
        onClick={async () => {
          await opened(await window.overapi.invoke('projects:open'));
        }}
      >
        Or open an existing overapi.json…
      </button>
    </div>
  );
}

function Discover({ prefill }: { prefill?: string }): JSX.Element {
  const { info, settings, openSheet } = useStore();
  const isUrl = !!prefill && /^https?:\/\//i.test(prefill);
  const [files, setFiles] = useState<string[]>([]);
  const [url, setUrl] = useState(isUrl ? prefill! : '');
  const [pasted, setPasted] = useState(!isUrl ? (prefill ?? '') : '');
  const [notes, setNotes] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type === 'discover:step' || e.type === 'discover:phase') setLog((l) => [...l.slice(-200), e.type === 'discover:phase' ? `▸ ${e.text}` : e.text]);
      }),
    [],
  );
  const ai = info?.ai;
  const tool = settings?.ai === 'codex' || (settings?.ai === 'auto' && !ai?.claude) ? 'codex' : 'claude';
  if (!ai?.claude && !ai?.codex) {
    return (
      <p className="text-[12px] leading-relaxed text-ink-muted">
        Discovery uses your own <b>claude</b> or <b>codex</b> CLI — no API key, nothing sent anywhere they would not send it. Neither is installed. Install one, sign in, then
        reopen this.
      </p>
    );
  }

  const run = async () => {
    setBusy(true);
    setLog([]);
    const r = await window.overapi.invoke('discover:run', { files, url: url.trim() || undefined, pasted: pasted.trim() || undefined, notes, baseUrl: baseUrl.trim() || undefined, title });
    setBusy(false);
    await opened(r);
  };

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-ink-muted">
        Hand over whatever describes the API — reference PDFs, Markdown or HTML pages, a docs URL, or text pasted from a wiki. <b>{tool}</b> reads it with file-reading tools only
        (no shell, no web, no MCP) and drafts every endpoint it finds. If one of the files is already a spec or a Postman collection, it imports directly.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-3">
          <div>
            <label className="label">Files</label>
            <button className="btn" disabled={busy} onClick={async () => setFiles([...new Set([...files, ...(await window.overapi.invoke('discover:pickFiles'))])])}>
              Add files…
            </button>
            {files.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {files.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-mono" title={f}>{f.split('/').pop()}</span>
                    <button className="text-ink-faint hover:text-bad" onClick={() => setFiles(files.filter((x) => x !== f))}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <label className="label">Docs URL</label>
            <input className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.acme.example/api" />
          </div>
          <div>
            <label className="label">Or paste</label>
            <textarea className="field min-h-[70px] text-[12px]" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Endpoint docs copied from a wiki…" />
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Name</label>
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="From the docs, if left empty" />
          </div>
          <div>
            <label className="label">Base URL (if the docs don’t say)</label>
            <input className="field font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://erp.acme.example/api" />
          </div>
          <div>
            <label className="label">Notes for the model</label>
            <textarea className="field min-h-[70px] text-[12px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Only the order endpoints matter. Version 2, not 1." />
          </div>
        </div>
      </div>
      {(busy || log.length > 0) && (
        <pre className="max-h-40 overflow-y-auto rounded-lg bg-wash p-3 font-mono text-[11px] leading-relaxed text-ink-muted">{log.join('\n') || 'Starting…'}</pre>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-ink-faint">Using {tool}{settings?.aiModel ? ` (${settings.aiModel})` : ''} — change in Settings. Long references take a few minutes.</span>
        <div className="flex gap-2">
          {busy && <button className="btn" onClick={() => void window.overapi.invoke('discover:cancel')}>Stop</button>}
          {!busy && <button className="btn" onClick={() => openSheet(null)}>Cancel</button>}
          <button className="btn-primary" disabled={busy || (!files.length && !url.trim() && !pasted.trim())} onClick={() => void run()}>
            {busy ? 'Reading…' : 'Draft the API'}
          </button>
        </div>
      </div>
    </div>
  );
}
