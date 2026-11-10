import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Empty } from './ui';
import { AskPanel } from './AskPanel';
import { groupOf } from '@shared/project';
import { fits } from '@shared/wire';
import { Icon } from './icons';
import { BodyView, JsonView } from './JsonView';
import type { McpCallDto, McpConnectRequest, McpInfoDto, McpToolDto } from '@shared/ipc';

type Source = 'self' | 'stdio' | 'http';
interface Recent {
  kind: 'stdio' | 'http';
  command?: string;
  args?: string;
  url?: string;
  env?: string;
}

const RECENT_KEY = 'overapi:mcp:recent';
function loadRecent(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[];
  } catch {
    return [];
  }
}
function saveRecent(r: Recent): void {
  try {
    const all = [r, ...loadRecent().filter((x) => JSON.stringify(x) !== JSON.stringify(r))].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: recents are a convenience.
  }
}

/// "KEY=value" lines into an env object. Values are sent to the server
/// process only; they are not saved (recents keep the names, not values).
function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/// The agent's side of the wire: connect as an MCP client to this API's
/// own server — or any other — and see and call exactly what an agent can.
export function AgentTab(): JSX.Element {
  const { project, path, env: activeEnv } = useStore();
  const p = project!;
  const [source, setSource] = useState<Source>('self');
  const [env, setEnv] = useState(activeEnv ?? p.envs[0]?.name ?? '');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envLines, setEnvLines] = useState('');
  const [url, setUrl] = useState('');
  const [headerLines, setHeaderLines] = useState('');
  const [info, setInfo] = useState<McpInfoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'ask' | 'call'>('ask');
  const [recent, setRecent] = useState<Recent[]>(loadRecent);

  const connect = useCallback(async (req: McpConnectRequest) => {
    setBusy(true);
    setError(null);
    const r = await window.overapi.invoke('mcp:connect', req);
    setBusy(false);
    if (r.ok) {
      setInfo(r.info);
      setSelected((s) => (s && r.info.tools.some((t) => t.name === s) ? s : (r.info.tools[0]?.name ?? null)));
    } else {
      setInfo(null);
      setError(r.error);
    }
  }, []);

  // This API connects by itself, and again when the environment changes.
  useEffect(() => {
    if (source === 'self' && env) void connect({ kind: 'self', path: path!, env });
  }, [source, env, path, connect]);

  // The server says its tools changed (an edit, writes allowed): list again.
  useEffect(
    () =>
      window.overapi.onEvent(async (e) => {
        if (e.type !== 'mcp:toolsChanged') return;
        const r = await window.overapi.invoke('mcp:refresh');
        if (r.ok) setInfo(r.info);
      }),
    [],
  );
  useEffect(() => () => void window.overapi.invoke('mcp:disconnect'), []);

  const connectOther = () => {
    if (source === 'stdio') {
      const argv = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((a) => a.replace(/^["']|["']$/g, '')) ?? [];
      saveRecent({ kind: 'stdio', command, args, env: Object.keys(parseEnvLines(envLines)).join(',') });
      void connect({ kind: 'stdio', command: command.trim(), args: argv, env: parseEnvLines(envLines) });
    } else {
      saveRecent({ kind: 'http', url });
      const headers: Record<string, string> = {};
      for (const line of headerLines.split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      void connect({ kind: 'http', url: url.trim(), headers });
    }
    setRecent(loadRecent());
  };

  const tool = info?.tools.find((t) => t.name === selected) ?? null;
  const [filter, setFilter] = useState('');
  const [prefill, setPrefill] = useState<Record<string, string>>({});
  // This API's own tools carry an area; another server's are one list.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (info?.tools ?? []).filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q));
    const m = new Map<string, McpToolDto[]>();
    for (const t of list) {
      const def = source === 'self' ? p.tools.find((x) => x.name === t.name) : undefined;
      const g = def ? groupOf(def) : 'tools';
      m.set(g, [...(m.get(g) ?? []), t]);
    }
    return [...m.entries()];
  }, [info, filter, source, p.tools]);

  const otherForm = source !== 'self' && (
    <div className="space-y-2 border-b border-rule p-3">
      <div className="flex gap-1 rounded-lg bg-wash-strong p-0.5">
        {(
          [
            ['stdio', 'A command'],
            ['http', 'A URL'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} onClick={() => setSource(id)} className={`flex-1 rounded-md py-1 text-[12px] font-medium ${source === id ? 'bg-surface-elevated shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      {source === 'stdio' ? (
        <>
          <input className="field font-mono text-[12px]" placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} />
          <input className="field font-mono text-[12px]" placeholder="-y @acme/orders-mcp" value={args} onChange={(e) => setArgs(e.target.value)} />
          <textarea className="field min-h-[44px] font-mono text-[11px]" placeholder={'ENV=value (one per line, not saved)'} value={envLines} onChange={(e) => setEnvLines(e.target.value)} />
          <button className="btn-primary w-full" disabled={busy || !command.trim()} onClick={connectOther}>
            <Icon name="plug" size={13} /> {busy ? 'Starting…' : 'Connect'}
          </button>
        </>
      ) : (
        <>
          <input className="field font-mono text-[12px]" placeholder="https://mcp.acme.example/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <textarea className="field min-h-[44px] font-mono text-[11px]" placeholder={'Authorization: Bearer … (not saved)'} value={headerLines} onChange={(e) => setHeaderLines(e.target.value)} />
          <button className="btn-primary w-full" disabled={busy || !url.trim()} onClick={connectOther}>
            <Icon name="plug" size={13} /> {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      )}
      {recent.filter((r) => r.kind === source).length > 0 && (
        <div>
          <div className="label">Recent</div>
          {recent
            .filter((r) => r.kind === source)
            .map((r, i) => (
              <button
                key={i}
                className="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] text-ink-muted hover:bg-wash-strong"
                onClick={() => {
                  if (r.kind === 'stdio') {
                    setCommand(r.command ?? '');
                    setArgs(r.args ?? '');
                    setEnvLines((r.env ?? '').split(',').filter(Boolean).map((k) => `${k}=`).join('\n'));
                  } else setUrl(r.url ?? '');
                }}
              >
                {r.kind === 'stdio' ? `${r.command} ${r.args}` : r.url}
              </button>
            ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Who you are and what you're talking to, in one line. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-2 text-[12px] text-ink-muted">
        {source === 'self' && (
          <div role="tablist" aria-label="How to try it" className="mr-2 flex rounded-lg bg-wash-strong p-0.5">
            {(
              [
                ['ask', 'Ask a question'],
                ['call', 'Call a tool'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className={`rounded-md px-3 py-1 text-[12px] font-medium ${view === id ? 'bg-surface-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        <Icon name="bot" size={14} className="text-accent" />
        <span>You’re the agent · connected to</span>
        {source === 'self' ? (
          <>
            <b className="font-medium text-ink">this API</b>
            <span>on</span>
            <select className="field w-auto py-0.5 text-[12px]" value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
              {p.envs.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                  {e.allowWrites ? '' : ' · read-only'}
                </option>
              ))}
            </select>
            <span>over MCP — the real protocol, exactly what Claude Code would get.</span>
            <span className="flex-1" />
            <button
              className="text-accent hover:underline"
              onClick={() => {
                setSource('stdio');
                setInfo(null);
                setError(null);
                void window.overapi.invoke('mcp:disconnect');
              }}
            >
              Connect to another server
            </button>
          </>
        ) : (
          <>
            <b className="font-medium text-ink">{info ? `${info.name} ${info.version}` : 'another MCP server'}</b>
            <span className="flex-1" />
            <button className="text-accent hover:underline" onClick={() => setSource('self')}>
              Back to this API
            </button>
          </>
        )}
      </div>
      {source === 'self' && view === 'ask' ? (
        <div className="min-h-0 flex-1">
          <AskPanel env={env} />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[330px] shrink-0 flex-col border-r border-rule">
          {otherForm}
          {info && (
            <div className="flex items-center gap-2 px-3.5 pb-1 pt-3">
              <div className="relative flex-1">
                <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
                <input className="field py-1 pl-8 text-[12px]" placeholder="Find a tool" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <span className="whitespace-nowrap text-[11px] text-ink-faint" title="What the tool list costs an agent on every turn — roughly 4 characters a token">
                {info.tools.length} · ≈{info.approxTokens.toLocaleString()} tok
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {busy && !info && <div className="p-4 text-[12px] text-ink-faint">Connecting…</div>}
            {error && <div className="selectable m-3 whitespace-pre-wrap rounded-lg bg-bad/10 p-3 text-[12px] text-bad">{error}</div>}
            {info?.tools.length === 0 && <div className="p-4 text-[12px] text-ink-faint">The server offers no tools{source === 'self' ? ' here — check what is on, and whether this environment allows writes.' : '.'}</div>}
            {groups.map(([g, list]) => (
              <div key={g}>
                <div className="px-3.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {g} · {list.length}
                </div>
                {list.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => {
                      setPrefill({});
                      setSelected(t.name);
                    }}
                    className={`flex w-full flex-col gap-0.5 px-3.5 py-1.5 text-left ${t.name === selected ? 'bg-accent/10 shadow-[inset_2px_0_0] shadow-accent' : 'hover:bg-wash'}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px]">{t.name}</span>
                      <Hints t={t} />
                      {weak(t.description) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="A weak description — agents pick tools by it" />}
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-faint">{tokens(t)}</span>
                    </span>
                    <span className="truncate text-[11.5px] text-ink-muted">{t.description || 'No description'}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {tool && info ? (
            <ToolPane
              key={`${info.name}:${tool.name}:${JSON.stringify(prefill)}`}
              tool={tool}
              instructions={info.instructions}
              initial={prefill}
              self={source === 'self'}
              next={(name, values) => {
                setPrefill(values);
                setSelected(name);
              }}
              tools={info.tools}
            />
          ) : info ? (
            <InstructionsOnly text={info.instructions} />
          ) : (
            <Empty>
              <span className="max-w-sm">{source === 'self' ? 'Connecting to this API as an agent would…' : 'Connect to any MCP server — to compare it with yours, or to use it. A command runs on this Mac with your permissions.'}</span>
            </Empty>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/// A description that says how a tool was found, not what it's for.
const weak = (d?: string) => !d || /inferred from \d+ captured|seen \d+ times? in the capture|captured call/i.test(d) || d.trim().length < 12;
/// What one tool costs in the list an agent gets every turn (≈4 characters a token).
const tokens = (t: McpToolDto) => `${Math.max(1, Math.round(JSON.stringify(t).length / 4))} tok`;

function Hints({ t }: { t: McpToolDto }): JSX.Element | null {
  const a = t.annotations ?? {};
  // Reads are the norm; only tools that change data get a badge.
  if (a.destructiveHint) return <span className="shrink-0 rounded border border-bad/40 px-1 text-[9px] font-semibold uppercase text-bad">destructive</span>;
  if (a.readOnlyHint === false) return <span className="shrink-0 rounded border border-warn/40 px-1 text-[9px] font-semibold uppercase text-warn">changes data</span>;
  return null;
}

function InstructionsOnly({ text }: { text?: string }): JSX.Element {
  return (
    <div className="p-6">
      <div className="label">Instructions the agent receives on connect</div>
      <pre className="selectable whitespace-pre-wrap rounded-lg border border-rule bg-wash p-3 text-[12px] leading-relaxed">{text || '(none)'}</pre>
    </div>
  );
}

type Prop = Record<string, unknown> & { type?: string | string[]; enum?: unknown[]; description?: string };

function typeOf(p: Prop): string {
  return (Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type) ?? 'json';
}

/// The first JSON object in a tool result's text ("HTTP 200\n\n{…}").
function resultJson(text: string): Record<string, unknown> | undefined {
  const at = text.search(/[{[]/);
  if (at < 0) return undefined;
  try {
    const v = JSON.parse(text.slice(at));
    return v && typeof v === 'object' ? (Array.isArray(v) ? (v[0] as Record<string, unknown>) : (v as Record<string, unknown>)) : undefined;
  } catch {
    return undefined;
  }
}

function ToolPane({ tool, instructions, initial, self, next, tools }: { tool: McpToolDto; instructions?: string; initial: Record<string, string>; self: boolean; next: (name: string, values: Record<string, string>) => void; tools: McpToolDto[] }): JSX.Element {
  const { project, selectTool, setTab } = useStore();
  const props = (tool.inputSchema.properties ?? {}) as Record<string, Prop>;
  const required = new Set(tool.inputSchema.required ?? []);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [view, setView] = useState<'none' | 'schema' | 'instructions'>('none');
  const [result, setResult] = useState<McpCallDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const say = useStore((s) => s.say);
  const def = self ? project?.tools.find((t) => t.name === tool.name) : undefined;

  const args = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(values)) {
      if (raw === '') continue;
      const t = typeOf(props[k] ?? {});
      if (t === 'integer' || t === 'number') out[k] = Number.isNaN(Number(raw)) ? raw : Number(raw);
      else if (t === 'boolean') out[k] = raw === 'true';
      else if (t === 'string') out[k] = raw;
      else {
        try {
          out[k] = JSON.parse(raw);
        } catch {
          out[k] = raw;
        }
      }
    }
    return out;
  }, [values, props]);

  const call = async () => {
    setBusy(true);
    setError(null);
    const r = await window.overapi.invoke('mcp:call', tool.name, args);
    setBusy(false);
    try {
      if (self) localStorage.setItem(`overapi:tried:${useStore.getState().path}`, 'yes');
    } catch {
      /* the guide just won't tick */
    }
    if (r.ok) setResult(r.result);
    else {
      setResult(null);
      setError(r.error);
    }
  };

  const destructive = tool.annotations?.destructiveHint;
  const request = JSON.stringify({ method: 'tools/call', params: { name: tool.name, arguments: args } }, null, 2);
  const text = result?.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') ?? '';
  const status = /^HTTP (\d{3})/.exec(text)?.[1];
  // What an agent would likely do next: a field of this answer that another
  // tool takes as an argument.
  const suggestion = useMemo(() => {
    const obj = text ? resultJson(text) : undefined;
    if (!obj || result?.isError) return undefined;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      for (const t of tools) {
        if (t.name === tool.name) continue;
        const param = Object.keys(t.inputSchema.properties ?? {}).find((p) => fits(k, p));
        if (param) return { tool: t.name, key: k, param, value: String(v) };
      }
    }
    return undefined;
  }, [text, result, tools, tool.name]);

  return (
    <div className="grid h-full grid-cols-2">
      <section className="flex min-h-0 flex-col overflow-y-auto border-r border-rule px-5 py-4" aria-label="Call">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-mono text-[16px] font-semibold">{tool.name}</h2>
          <Hints t={tool} />
          <span className="text-[11px] text-ink-faint">
            {def ? `${def.method} ${def.path} · ` : ''}
            {tokens(tool)}
          </span>
        </div>
        <div className="label mt-4">What the agent reads</div>
        <p className="selectable text-[13px] leading-relaxed text-ink">{tool.description || <i className="text-ink-faint">No description — the agent only has the name.</i>}</p>
        {weak(tool.description) && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px]">
            <span className="flex-1 text-warn">{tool.description ? 'Written from traffic — it says how the tool was found, not what it’s for. Agents pick tools by this.' : 'No description — agents have only the name to go on.'}</span>
            {def && (
              <button
                className="btn !px-2.5 !py-0.5 text-[12px]"
                onClick={() => {
                  selectTool(def.id);
                  setTab('requests');
                }}
              >
                Rewrite
              </button>
            )}
          </div>
        )}

        <div className="label mt-5">Arguments</div>
        {Object.keys(props).length === 0 && <p className="text-[12px] text-ink-faint">Takes no arguments.</p>}
        <div className="space-y-2.5">
          {Object.entries(props).map(([name, prop]) => {
            const t = typeOf(prop);
            const v = values[name] ?? '';
            const set = (x: string) => setValues((s) => ({ ...s, [name]: x }));
            return (
              <label key={name} className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-3">
                <span className="flex flex-col pt-1">
                  <span className="font-mono text-[12px]">{name}</span>
                  <span className="text-[10.5px] text-ink-faint">
                    {t} · {required.has(name) ? <span className="text-accent">required</span> : 'optional'}
                  </span>
                </span>
                <span className="min-w-0 space-y-1">
                  {prop.enum ? (
                    <select className="field py-1" value={v} onChange={(e) => set(e.target.value)}>
                      <option value="">—</option>
                      {prop.enum.map((x) => (
                        <option key={String(x)} value={String(x)}>{String(x)}</option>
                      ))}
                    </select>
                  ) : t === 'boolean' ? (
                    <select className="field py-1" value={v} onChange={(e) => set(e.target.value)}>
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : t === 'string' || t === 'integer' || t === 'number' ? (
                    <input className="field py-1 font-mono text-[12px]" value={v} onChange={(e) => set(e.target.value)} />
                  ) : (
                    <textarea className="field min-h-[64px] font-mono text-[12px]" placeholder="JSON" value={v} onChange={(e) => set(e.target.value)} />
                  )}
                  {prop.description && <span className="block text-[11px] leading-snug text-ink-faint">{prop.description}</span>}
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button className={destructive ? 'btn-primary !bg-bad' : 'btn-primary'} disabled={busy} onClick={() => void call()}>
            <Icon name="send" size={13} /> {busy ? 'Calling…' : `Call ${tool.name}`}
          </button>
          <button
            className="text-[12px] text-accent hover:underline"
            onClick={async () => {
              await window.overapi.invoke('clipboard:write', request);
              say('Copied the tools/call request.');
            }}
          >
            Copy the call as JSON
          </button>
          <span className="flex-1" />
          <button className={`text-[12px] ${view === 'schema' ? 'text-ink' : 'text-ink-faint hover:text-ink'}`} onClick={() => setView(view === 'schema' ? 'none' : 'schema')}>
            Schema
          </button>
          <button className={`text-[12px] ${view === 'instructions' ? 'text-ink' : 'text-ink-faint hover:text-ink'}`} onClick={() => setView(view === 'instructions' ? 'none' : 'instructions')}>
            Agent brief
          </button>
        </div>
        {destructive && <p className="mt-2 text-[11px] text-bad">Destructive: this really runs against the server. The agent would have to pass confirm: true too.</p>}
        {view === 'schema' && (
          <div className="mt-4">
            <JsonView value={tool} />
          </div>
        )}
        {view === 'instructions' && <pre className="selectable mt-4 whitespace-pre-wrap rounded-lg border border-rule bg-wash p-3 text-[12px] leading-relaxed">{instructions || '(the server sends no instructions)'}</pre>}
      </section>

      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Result">
        <div className="flex flex-wrap items-center gap-2.5 px-5 pb-2 pt-4 text-[12px]">
          <span className="label !mb-0">What came back</span>
          {result && (
            <>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${result.isError ? 'bg-bad/15 text-bad' : 'bg-good/15 text-good'}`}>{status ?? (result.isError ? 'error' : 'ok')}</span>
              <span className="text-[11px] text-ink-faint">
                {result.ms} ms · {(text.length / 1024).toFixed(1)} KB · ≈{Math.round(text.length / 4).toLocaleString()} tokens
              </span>
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">
          {error && <div className="selectable whitespace-pre-wrap rounded-lg bg-bad/10 p-3 text-[12px] text-bad">{error}</div>}
          {result?.content.map((c, i) => (
            <div key={i} className="mb-3">
              {c.type === 'text' ? <BodyView text={c.text ?? ''} /> : <pre className="selectable whitespace-pre-wrap break-all font-mono text-[11px] text-ink-muted">{JSON.stringify(c, null, 2).slice(0, 4000)}</pre>}
            </div>
          ))}
          {result?.structured !== undefined && (
            <div>
              <div className="label">structuredContent</div>
              <JsonView value={result.structured} />
            </div>
          )}
          {!result && !error && <Empty>Fill in the arguments and call the tool — this side shows exactly what the agent reads back.</Empty>}
        </div>
        {suggestion && (
          <div className="flex flex-wrap items-center gap-3 border-t border-rule px-5 py-3 text-[12px] text-ink-muted">
            <span className="flex-1">
              An agent would likely call <span className="font-mono text-ink">{suggestion.tool}</span> next with <span className="font-mono text-accent">{suggestion.key}</span>.
            </span>
            <button className="btn !px-2.5 !py-0.5 text-[12px]" onClick={() => next(suggestion.tool, { [suggestion.param]: suggestion.value })}>
              Call {suggestion.tool}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
