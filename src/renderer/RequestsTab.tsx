import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { RenewButton } from './Renew';
import { SeenInput } from './SeenInput';
import { PathChip, ValuePicker, keptAgo, useKept } from './ValuePicker';
import { Empty, EnvChip, EnvDot, Method, SafetyBadge, SAFETY_LABEL, Splitter, SubTabs, Toggle, useWidth } from './ui';
import {
  DEFAULT_RESPONSE_LIMIT,
  envKind,
  envVars,
  fillVars,
  groupOf,
  isLoginTool,
  toolId,
  varPrefix,
  type AuthSpec,
  type BeforeStep,
  type BodyMode,
  type Capture,
  type HttpMethod,
  type ParamDef,
  type ParamIn,
  type Safety,
  type ToolDef,
  type Project,
} from '@shared/project';
import { VALID_NAME } from '@shared/naming';
import { checkProject, TOOL_BUDGET } from '@shared/check';
import { formatPath, toCurl, varsUsed } from '@shared/capture';
import { SNIPPETS } from '@shared/snippets';
import { isLiteralValue as isLiteral, isSecretName, secretVarName } from '@shared/secretNames';
import { shapeOf } from '@shared/scenario';
import { applyLinks, findLinks, isIdLike, readablePath, type Link } from '@shared/chains';
import { addStep, emptyScenario, feedsFrom, paramsFor, wireInto, type Feed } from '@shared/wire';
import type { SeenSuggestions, TryResponse } from '@shared/ipc';
import { JsonView, parseMaybeJson } from './JsonView';
import { ResponseTable, findList, summarize, tableColumns } from './ResponseTable';
import { LatencyTrend, ResponseChart, chartSpec } from './ResponseChart';
import { Icon } from './icons';
import { KeyValues, SecretField } from './EnvsTab';

// ---- the list ---------------------------------------------------------------

const collapsedKey = (p: string) => `overapi:groups:${p}`;
const groupByKey = (p: string) => `overapi:groupby:${p}`;

type GroupBy = 'area' | 'method' | 'safety' | 'tool';

/// Ways to slice the list. Area is how the API is organised; Method is its
/// verbs; Safety is what an agent may do (POST /search is a read, POST
/// /…/delete is destructive) — the one to shape tools by; Tool is what
/// agents get versus what is yours alone.
const SIGN_IN_GROUP = 'Sign-in';

/// A request that signs in: an environment's login request, or one whose
/// path says so (POST …/login, /signin, /token, /sessions).
function isSignIn(t: ToolDef, p: Project): boolean {
  if (p.envs.some((e) => e.auth.type === 'login' && e.auth.toolId === t.id)) return true;
  return t.method === 'POST' && /(^|\/)(login|log-in|signin|sign-in|sign_in|authenticate|token|oauth\/token|sessions?)$/i.test(t.path);
}

const GROUPERS: Record<
  GroupBy,
  {
    label: string;
    title: string;
    key: (t: ToolDef) => string;
    order?: string[];
    hint?: Record<string, string>;
  }
> = {
  area: {
    label: 'Area',
    title: 'By tag, folder or the first word of the path',
    key: groupOf,
  },
  method: {
    label: 'Method',
    title: 'By HTTP verb',
    key: (t) => t.method,
    order: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    hint: {
      GET: 'fetches',
      POST: 'creates — some only read',
      PUT: 'replaces',
      PATCH: 'updates',
      DELETE: 'removes',
    },
  },
  safety: {
    label: 'Safety',
    title: 'By what an agent may do with it',
    key: (t) => t.safety,
    order: ['read', 'write', 'destructive'],
    hint: {
      read: 'offered everywhere',
      write: 'only where writes are allowed',
      destructive: 'also needs confirm',
    },
  },
  tool: {
    label: 'Tool',
    title: 'Tools agents get, and requests that are yours alone',
    key: (t) => (t.enabled ? 'tools' : 'requests only'),
    order: ['tools', 'requests only'],
    hint: {
      tools: 'agents can call these',
      'requests only': 'agents don’t see these',
    },
  },
};

/// The workbench: the requests, grouped; the request being edited; its
/// response — one screen, like any API client.
export function RequestsTab(): JSX.Element {
  const { project, path, toolId: selected, selectTool, update, openSheet, env: listEnv } = useStore();
  const [listW, setListW] = useWidth('requests.list', 320);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(collapsedKey(path!)) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const p = project!;

  const activeEnv = project!.envs.find((e) => e.name === listEnv) ?? project!.envs[0];
  const tools = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return p.tools;
    return p.tools.filter((t) => `${t.name} ${t.path} ${t.method} ${t.description} ${groupOf(t)}`.toLowerCase().includes(q));
  }, [p.tools, filter]);
  // A kept value dropped on a request: into the parameter whose name fits,
  // or the person picks one.
  const [ask, setAsk] = useState<{
    toolId: string;
    name: string;
    options: string[];
  } | null>(null);
  const wire = (toolId: string, param: string, name: string) => {
    const target = p.tools.find((t) => t.id === toolId);
    useStore.getState().update((x) => ({
      ...x,
      tools: x.tools.map((t) => (t.id === toolId ? wireInto(t, param, name) : t)),
    }));
    useStore.getState().say(`${target?.name ?? 'It'} now takes ${param} from {{${name}}} when it's sent.`);
    setAsk(null);
  };
  const dropVar = (target: ToolDef, e: React.DragEvent) => {
    const name = e.dataTransfer.getData('text/x-overapi-var');
    if (!name) return;
    e.preventDefault();
    const producer = p.tools.find((t) => t.id === e.dataTransfer.getData('text/x-overapi-from'));
    const options = paramsFor(target, name, producer);
    if (!options.length) return useStore.getState().say(`${target.name} takes no arguments to put {{${name}}} in.`, true);
    const fitting = options.filter((o) => o.fits);
    if (fitting.length === 1) wire(target.id, fitting[0].param, name);
    else setAsk({ toolId: target.id, name, options: options.map((o) => o.param) });
  };
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try {
      return (localStorage.getItem(groupByKey(path!)) as GroupBy | null) ?? 'area';
    } catch {
      return 'area';
    }
  });
  const chooseGroupBy = (g: GroupBy) => {
    setGroupBy(g);
    try {
      localStorage.setItem(groupByKey(path!), g);
    } catch {
      // This session only.
    }
  };
  const groups = useMemo(() => {
    // Signing in comes first, whatever the grouping: it's what everything
    // else depends on, and the first thing to try.
    const signIn = tools.filter((t) => isSignIn(t, p));
    const m = new Map<string, ToolDef[]>();
    for (const t of tools) {
      if (signIn.includes(t)) continue;
      const k = GROUPERS[groupBy].key(t);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    const order = GROUPERS[groupBy].order;
    const rest = [...m.entries()].sort((a, b) => (order ? order.indexOf(a[0]) - order.indexOf(b[0]) : 0));
    return signIn.length ? ([[SIGN_IN_GROUP, signIn], ...rest] as [string, ToolDef[]][]) : rest;
  }, [tools, groupBy, p]);
  const on = p.tools.filter((t) => t.enabled).length;
  const allTools = on === p.tools.length;
  const tool = p.tools.find((t) => t.id === selected) ?? p.tools[0];

  const toggleGroup = (g: string) => {
    const next = new Set(collapsed);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey(path!), JSON.stringify([...next]));
    } catch {
      // Remembered for this session only.
    }
  };
  const renameGroup = (from: string, to: string) => {
    const name = to.trim();
    setRenaming(null);
    if (!name || name === from) return;
    update((x) => ({
      ...x,
      tools: x.tools.map((t) => (groupOf(t) === from ? { ...t, group: name } : t)),
    }));
  };

  return (
    <div className="flex h-full">
      <div className="flex shrink-0 flex-col bg-surface" style={{ width: listW }}>
        <div className="space-y-2 border-b border-rule p-3">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input className="field py-1 pl-7" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button className="btn shrink-0" title="New request" onClick={() => openSheet({ kind: 'request' })}>
              <Icon name="plus" size={13} />
            </button>
            <button className="btn shrink-0" title="Paste a cURL" onClick={() => openSheet({ kind: 'curl' })}>
              cURL
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-faint">Group by</span>
            <div role="group" aria-label="Group by" className="flex gap-0.5 rounded-lg bg-wash-strong p-0.5">
              {(Object.keys(GROUPERS) as GroupBy[]).map((g) => (
                <button
                  key={g}
                  aria-pressed={groupBy === g}
                  onClick={() => chooseGroupBy(g)}
                  title={GROUPERS[g].title}
                  className={`h-[22px] rounded-md px-2 text-[11px] font-medium ${groupBy === g ? 'bg-surface-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
                >
                  {GROUPERS[g].label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span>{p.tools.length} requests</span>
            <span>·</span>
            <span
              className={`inline-flex items-center gap-1 ${on > TOOL_BUDGET ? 'font-semibold text-warn' : ''}`}
              title="Requests agents can call as tools — choose in each request’s Tool tab, or all at once on Overview"
            >
              <Icon name="bot" size={11} className="text-accent" />
              {on} tool{on === 1 ? '' : 's'}
              {on > TOOL_BUDGET ? ` — over ${TOOL_BUDGET}` : ''}
            </span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {groups.map(([g, list]) => {
            const shut = collapsed.has(g) && !filter.trim();
            return (
              <div key={g}>
                <div className="group/g sticky top-0 z-[1] flex items-center gap-1.5 bg-surface px-3 pb-1 pt-3">
                  <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => toggleGroup(g)}>
                    <Icon name="chevron" size={11} className={`text-ink-faint transition-transform ${shut ? '' : 'rotate-90'}`} />
                    {renaming === g ? (
                      <input
                        autoFocus
                        className="field py-0.5 text-[11px]"
                        defaultValue={g}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => renameGroup(g, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameGroup(g, (e.target as HTMLInputElement).value);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">{g}</span>
                    )}
                    <span className="text-[11px] tabular-nums text-ink-faint">{list.length}</span>
                    {GROUPERS[groupBy].hint?.[g] && <span className="truncate text-[10px] normal-case text-ink-faint">· {GROUPERS[groupBy].hint![g]}</span>}
                  </button>
                  {groupBy === 'area' && g !== SIGN_IN_GROUP && (
                    <button className="text-[10px] text-ink-faint opacity-0 hover:text-ink group-hover/g:opacity-100" onClick={() => setRenaming(g)}>
                      Rename
                    </button>
                  )}
                </div>
                {!shut &&
                  list.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => selectTool(t.id)}
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes('text/x-overapi-var')) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'link';
                        }
                      }}
                      onDrop={(e) => dropVar(t, e)}
                      className={`group mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${t.id === tool?.id ? 'bg-accent/15' : 'hover:bg-wash'}`}
                    >
                      <Method method={t.method} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`truncate text-[12.5px] ${t.id === tool?.id ? 'font-medium text-ink' : 'text-ink-muted group-hover:text-ink'}`} title={`${t.name}\n${t.method} ${t.path}`}>
                            {titleOf(t)}
                          </span>
                          {t.safety !== 'read' && <SafetyBadge safety={t.safety} />}
                        </div>
                        <div className="truncate font-mono text-[10px] text-ink-faint" title={`${t.method} ${t.path}`}>
                          {t.name}
                        </div>
                      </div>
                      {activeEnv && isLoginTool(t, activeEnv) ? (
                        <span
                          title="Signs in for the other requests — agents never see it"
                          className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-accent"
                        >
                          sign-in
                        </span>
                      ) : (
                        // Marks say something only when some requests aren't tools:
                        // then the ones that are get the mark.
                        t.enabled &&
                        !allTools && (
                          <span title="A tool — agents can call this" className="shrink-0 text-accent/80">
                            <Icon name="bot" size={13} />
                          </span>
                        )
                      )}
                    </div>
                  ))}
              </div>
            );
          })}
          {p.tools.length === 0 && (
            <div className="space-y-2 p-4 text-[12px] text-ink-muted">
              <p>No requests yet.</p>
              <button className="btn-primary" onClick={() => openSheet({ kind: 'request' })}>
                New request
              </button>
            </div>
          )}
          {p.tools.length > 0 && tools.length === 0 && <div className="p-4 text-[12px] text-ink-faint">Nothing matches.</div>}
        </div>
      </div>
      <Splitter width={listW} setWidth={setListW} initial={300} />
      {tool ? <Workbench key={tool.id} tool={tool} /> : <Empty>Add a request to start.</Empty>}
      {ask &&
        (() => {
          const target = p.tools.find((t) => t.id === ask.toolId);
          return (
            <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-rule bg-surface px-4 py-3 text-[12px] shadow-xl">
              <span>
                Put <span className="font-mono text-accent">{`{{${ask.name}}}`}</span> into <b>{target?.name}</b>’s
              </span>
              {ask.options.map((o) => (
                <button key={o} className="btn !px-2 !py-0.5 font-mono text-[11px]" onClick={() => wire(ask.toolId, o, ask.name)}>
                  {o}
                </button>
              ))}
              <button className="text-ink-faint hover:text-ink" onClick={() => setAsk(null)}>
                Cancel
              </button>
            </div>
          );
        })()}
    </div>
  );
}

// ---- helpers ----------------------------------------------------------------

type Values = Record<string, string>;

function toText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
}

/// Form text to what an agent would send: numbers as numbers, JSON parsed.
/// A {{variable}} stays text; it is filled in when the request goes out.
function coerce(param: ParamDef, raw: string): unknown {
  if (raw.includes('{{')) return raw;
  const t = Array.isArray(param.schema.type) ? param.schema.type[0] : param.schema.type;
  if ((t === 'integer' || t === 'number') && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  if (t === 'boolean') return raw === 'true';
  if (t === 'object' || t === 'array' || !t || param.name === 'body') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/// A first description for a request that just became a tool.
function draftDescription(t: ToolDef, body: string): string {
  const head = `${t.method === 'GET' ? 'Fetch' : t.method === 'DELETE' ? 'Delete' : 'Call'} ${t.path}.`;
  const parsed = parseMaybeJson(body);
  if (!parsed.ok) return head;
  const v = parsed.value;
  const target = Array.isArray(v) ? v[0] : v;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return head;
  const keys = Object.keys(target as Record<string, unknown>).slice(0, 12);
  return keys.length ? `${head} ${Array.isArray(v) ? 'Returns a list of objects with' : 'Returns'} ${keys.join(', ')}.` : head;
}

function sizeText(bytes?: number): string {
  if (bytes === undefined) return '';
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/// A variable name from a JSON path: items[0].access_token -> access_token.
function suggestName(segs: (string | number)[]): string {
  const last = [...segs].reverse().find((s) => typeof s === 'string') as string | undefined;
  return (last ?? 'value').replace(/[^A-Za-z0-9_]/g, '_');
}

// ---- the workbench ---------------------------------------------------------

type LeftTab = 'params' | 'body' | 'headers' | 'auth' | 'flow' | 'tool';
type RightTab = 'body' | 'headers' | 'timeline' | 'history';

function Workbench({ tool }: { tool: ToolDef }): JSX.Element {
  const [resW, setResW] = useWidth('requests.response', 560, 320);
  const { project, path, env: envName, update, selectTool, say, refreshHistory, refreshRuntime, setRuntime, runtime, history, secrets, setTab } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [asAgent, setAsAgent] = useState(false);
  /// Values this request needs that nothing has set yet (shown instead of sending).
  const [needs, setNeeds] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  /// The request that gives a needed value also needs arguments nobody has given it yet.
  const [askFor, setAskFor] = useState<{
    name: string;
    toolId: string;
    values: Record<string, string>;
  } | null>(null);
  const [view, setView] = useState<'table' | 'json' | 'chart'>('table');
  const [left, setLeft] = useState<LeftTab>('params');
  const [right, setRight] = useState<RightTab>('body');
  useEffect(() => {
    if (left === 'body' && ['GET', 'HEAD', 'DELETE'].includes(tool.method) && tool.bodyMode === 'none') setLeft('params');
  }, [left, tool.method, tool.bodyMode]);
  const [values, setValues] = useState<Values>(() => Object.fromEntries(Object.entries(tool.example ?? {}).map(([k, v]) => [k, toText(v)])));
  const [result, setResult] = useState<TryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  /// The path shows its parameters by what they are until you click into it.
  const [pathEdit, setPathEdit] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);
  const chips = !pathEdit && /\{[^}]+\}/.test(tool.path);
  const [keeping, setKeeping] = useState<{
    capture: Capture;
    value: string;
  } | null>(null);

  const set = (fn: (t: ToolDef) => ToolDef) =>
    update((x) => ({
      ...x,
      tools: x.tools.map((t) => (t.id === tool.id ? fn(t) : t)),
    }));
  const writes = tool.safety !== 'read';
  const auth = tool.auth ?? env?.auth;
  const missingSecret = auth ? envVars({ name: '', baseUrl: '', auth, allowWrites: false }).some((n) => !secrets[n]) : false;
  // Specs often declare one sign-in for a whole API that most calls don't
  // need. Unset is only worth a warning once the server has refused.
  const refused = result?.status === 401 || result?.status === 403;
  const rt = Object.fromEntries(runtime.map((r) => [r.name, r.value]));
  useEffect(() => setArmed(false), [envName]);

  const args = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const prm of tool.params) {
      const raw = values[prm.name];
      if (raw === undefined || raw === '') continue;
      out[prm.name] = coerce(prm, raw);
    }
    return out;
  };

  const send = async (force = false) => {
    if (!env) {
      say('Add an environment with a base URL first.', true);
      setTab('envs');
      return;
    }
    // A {{value}} nothing has set yet would go out as the literal text and
    // fail — say where it comes from instead, and offer to get it first.
    if (!force) {
      const now = Object.fromEntries(useStore.getState().runtime.map((r) => [r.name, r.value]));
      const missing = [...new Set([...JSON.stringify(args()).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].filter((n) => now[n] === undefined && env.vars?.[n] === undefined);
      if (missing.length) {
        setNeeds(missing);
        return;
      }
    }
    setNeeds(null);
    if (writes && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    const a = args();
    // What was sent last is kept as the example: ready to send again, and
    // an agent reading it sees real values.
    set((t) => ({ ...t, example: a }));
    const r = await window.overapi.invoke('tool:try', {
      path: path!,
      project: p,
      env: env.name,
      toolId: tool.id,
      args: a,
    });
    setResult(r);
    setRight('body');
    setBusy(false);
    // What it answers teaches overapi its shape — and so its chains.
    if (r.ok) {
      try {
        const json = JSON.parse(r.full ?? r.body ?? '');
        set((t) => ({ ...t, returns: shapeOf(json) }));
      } catch {
        /* not JSON */
      }
    }
    void refreshHistory();
    if (r.captured && Object.keys(r.captured).length) void refreshRuntime();
  };
  // ⌘↵ (Ctrl+↵) sends, from anywhere on the page.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void sendRef.current();
      } else if (e.key.toLowerCase() === 'l' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        const el = document.getElementById('overapi-path') as HTMLInputElement | null;
        el?.focus();
        el?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Changing the method or path changes the id; keep path params in step.
  const reroute = (method: HttpMethod, newPath: string) => {
    const id = toolId(method, newPath);
    if (id === tool.id) return;
    if (p.tools.some((t) => t.id === id)) {
      say(`Another request is already ${id}.`, true);
      return;
    }
    const names = [...newPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((n) => !/^\{/.test(n));
    update((x) => ({
      ...x,
      tools: x.tools.map((t) =>
        t.id !== tool.id
          ? t
          : {
              ...t,
              id,
              method,
              path: newPath,
              params: [
                ...names.map(
                  (n) =>
                    t.params.find((q) => q.in === 'path' && q.name === n) ?? {
                      name: n,
                      in: 'path' as const,
                      required: true,
                      schema: { type: 'string' },
                    },
                ),
                ...t.params.filter((q) => q.in !== 'path'),
              ],
            },
      ),
    }));
    selectTool(id);
  };

  const keep = (c: Capture, value: string) => {
    set((t) => ({
      ...t,
      captures: [...(t.captures ?? []).filter((x) => x.var !== c.var), c],
    }));
    void setRuntime(c.var, value);
    setKeeping(null);
    say(`Kept as {{${c.var}}}. Use it in any URL, header or argument; it refreshes each time this request runs.`);
  };

  const issues = checkProject({ ...p, tools: [tool] }).issues.filter((i) => i.toolId === tool.id);
  const mine = history.filter((h) => h.toolId === tool.id);
  const used = varsUsed(tool);
  const producers = (name: string) => p.tools.filter((t) => t.captures?.some((c) => c.var === name)).map((t) => t.name);
  /// Runs the request that keeps `name` (with its saved values), then sends this one.
  /// Runs the request that keeps `name`, then sends this one. Its saved
  /// values come first; a required argument it never had takes its default
  /// or first allowed value, else it's asked for here (and remembered).
  const runFirst = async (name: string, given: Record<string, unknown> = {}) => {
    const src = p.tools.find((t) => t.captures?.some((c) => c.var === name));
    if (!src || !env) return;
    const a: Record<string, unknown> = { ...(src.example ?? {}), ...given };
    const blank = (v: unknown) => v === undefined || v === null || v === '';
    for (const prm of src.params.filter((x) => x.required || x.in === 'path')) {
      if (!blank(a[prm.name])) continue;
      if (prm.schema.default !== undefined) a[prm.name] = prm.schema.default;
      else if (prm.schema.enum?.length) a[prm.name] = prm.schema.enum[0];
    }
    const still = src.params.filter((x) => (x.required || x.in === 'path') && blank(a[x.name]));
    if (still.length) {
      setAskFor({
        name,
        toolId: src.id,
        values: Object.fromEntries(still.map((x) => [x.name, ''])),
      });
      return;
    }
    setAskFor(null);
    // What was given is kept on it, so next time it just runs.
    if (Object.keys(given).length)
      update((x) => ({
        ...x,
        tools: x.tools.map((t) => (t.id === src.id ? { ...t, example: a } : t)),
      }));
    setFetching(src.name);
    const r = await window.overapi.invoke('tool:try', {
      path: path!,
      project: p,
      env: env.name,
      toolId: src.id,
      args: a,
    });
    await refreshRuntime();
    void refreshHistory();
    setFetching(null);
    if (!r.ok) return say(`${src.name} didn't work: ${r.error ?? `${r.status ?? ''} ${r.statusText ?? ''}`} — open it to see why.`.replace(/\s+/g, ' '), true);
    if (!r.captured || !(name in r.captured)) return say(`${src.name} worked but its answer had no ${name} to keep — check where it's kept in its Flow.`, true);
    say(`Got ${name} = ${String(r.captured[name]).slice(0, 40)} from ${src.name} — sending now.`);
    // Let the new value reach the page, then send.
    await new Promise((res) => setTimeout(res, 30));
    void sendRef.current();
  };
  const resHeaders = Object.entries(result?.headers ?? {});
  // The response read once: a list shows as a table, and is summed up in the status line.
  const parsed = useMemo(() => {
    const r = parseMaybeJson(result?.full ?? result?.body ?? '');
    return r.ok ? r.value : undefined;
  }, [result]);
  // What it was sorted by is what the table shows first (_sort=goals:desc → goals).
  const sortedBy = tool.params
    .filter((x) => /^_?(sort|sort_?by|order|order_?by)$/i.test(x.name))
    .flatMap((x) => String(values[x.name] ?? '').split(/[,\s]+/))
    .map((x) => x.split(':')[0].replace(/^[-+]/, ''))
    .filter(Boolean);
  // A table only when there's something to show in one; else JSON.
  const listFound = findList(parsed);
  const hasList = !!listFound && (!listFound.rows.length || tableColumns(listFound.rows, sortedBy).length > 0);
  // A chart only when the list has the shape of one (a label and a number, or a date and a number).
  const canChart = !!listFound && !!chartSpec(listFound.rows, sortedBy);
  const summary = parsed !== undefined ? summarize(parsed, tool.name) : null;
  // What the address will carry: the query params that have a value.
  const query = tool.params
    .filter((x) => x.in === 'query' && (values[x.name] ?? '').trim() !== '')
    .map((x) => {
      const raw = values[x.name];
      let shown = raw;
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) shown = v.join(',');
      } catch {
        // Plain text.
      }
      return `${x.name}=${shown}`;
    })
    .reduce((acc, kv, i) => `${acc}${i ? '&' : '?'}${kv}`, '');

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* The request line, across both panes: the URL gets the room. */}
      <div className="flex h-[53px] shrink-0 items-center gap-2 border-b border-rule px-3">
        <select className="field w-[92px] font-mono text-[12px] font-bold" value={tool.method} onChange={(e) => reroute(e.target.value as HttpMethod, tool.path)}>
          {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as HttpMethod[]).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <div className="field flex min-w-0 items-center gap-0 overflow-hidden p-0">
          {env && (
            <span
              className="flex shrink-0 items-center gap-1.5 self-stretch border-r border-rule-strong/70 bg-wash-strong px-2.5 text-[12px] font-semibold"
              title="Environment — switch it in the title bar"
            >
              <EnvDot name={env.name} />
              {env.name}
            </span>
          )}
          <span className="max-w-[45%] shrink-0 truncate py-1.5 pl-2.5 font-mono text-[12px] text-ink-faint" title={env ? fillVars(env.baseUrl, env, rt) : ''}>
            {env ? fillVars(env.baseUrl, env, rt) || '(no base URL)' : ''}
          </span>
          {chips && (
            <button
              type="button"
              className={`min-w-0 truncate py-1.5 text-left font-mono text-[12px] ${query ? 'shrink-0 pr-0' : 'flex-1 pr-2'}`}
              title="Click to edit the path"
              onClick={() => pathRef.current?.focus()}
            >
              {tool.path
                .split(/(\{[^}]+\})/)
                .map((part, k) => (/^\{[^}]+\}$/.test(part) ? <PathChip key={k} toolId={tool.id} name={part.slice(1, -1)} value={values[part.slice(1, -1)] ?? ''} /> : <span key={k}>{part}</span>))}
            </button>
          )}
          <input
            ref={pathRef}
            key={tool.path}
            id="overapi-path"
            className={chips ? 'pointer-events-none w-0 min-w-0 p-0 opacity-0' : `min-w-[60px] bg-transparent py-1.5 font-mono text-[12px] outline-none ${query ? 'shrink-0 pr-0' : 'flex-1 pr-2'}`}
            style={query && !chips ? { width: `${Math.max(tool.path.length, 4)}ch` } : undefined}
            onFocus={() => setPathEdit(true)}
            defaultValue={tool.path}
            title="The path. Paste a whole URL with a query and its values fill the params."
            onBlur={(e) => {
              setPathEdit(false);
              if (e.target.value !== tool.path) reroute(tool.method, e.target.value.startsWith('/') ? e.target.value : `/${e.target.value}`);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text').trim();
              if (!text.includes('?') && !/^https?:\/\//.test(text)) return;
              e.preventDefault();
              let u: URL;
              try {
                u = new URL(text, 'http://paste.invalid');
              } catch {
                return;
              }
              let at = u.pathname;
              try {
                const base = new URL(fillVars(env?.baseUrl ?? '', env!, rt)).pathname.replace(/\/$/, '');
                if (/^https?:/.test(text) && base && at.startsWith(base)) at = at.slice(base.length) || '/';
              } catch {
                // No base URL: keep the path as pasted.
              }
              (e.target as HTMLInputElement).value = at;
              // Its query becomes the params' values; names the request
              // doesn't list yet are added to it.
              const found: Record<string, string> = {};
              u.searchParams.forEach((v, k) => (found[k] = found[k] ? `${found[k]},${v}` : v));
              const unknown = Object.keys(found).filter((k) => !tool.params.some((x) => x.name === k));
              if (unknown.length)
                set((t) => ({
                  ...t,
                  params: [
                    ...t.params,
                    ...unknown.map((name) => ({
                      name,
                      in: 'query' as const,
                      required: false,
                      schema: { type: 'string' },
                    })),
                  ],
                }));
              setValues((v) => ({ ...v, ...found }));
              if (Object.keys(found).length)
                say(`Filled ${Object.keys(found).length} param${Object.keys(found).length === 1 ? '' : 's'} from the URL${unknown.length ? ` (${unknown.length} new)` : ''}.`);
            }}
          />
          {query && (
            <span className="min-w-0 flex-1 truncate py-1.5 pr-2 font-mono text-[12px]" title={query}>
              {query.split(/(?=[?&])/).map((part, k) => {
                const [key, ...v] = part.slice(1).split('=');
                return (
                  <span key={k}>
                    <span className="text-accent">
                      {part[0]}
                      {key}=
                    </span>
                    <span className="text-ink">{v.join('=')}</span>
                  </span>
                );
              })}
            </span>
          )}
        </div>
        <button className={armed || (env && envKind(env.name) === 'production') ? 'btn-primary shrink-0 !bg-bad' : 'btn-primary shrink-0'} disabled={busy || !env?.baseUrl} onClick={() => void send()}>
          {busy ? 'Sending…' : armed ? `Really send to ${env?.name}` : `Send to ${env?.name ?? '…'}`}
          {!busy && !armed && <span className="ml-1.5 text-[10.5px] font-normal opacity-70">⌘↵</span>}
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Request */}
        <div className="flex min-w-0 flex-1 flex-col">
          <SubTabs
            tabs={[
              {
                id: 'params',
                label: `Params${(() => {
                  const all = tool.params.filter((x) => x.in !== 'body');
                  const on = all.filter((x) => x.in === 'path' || x.required || (values[x.name] ?? '') !== '').length;
                  return all.length ? ` ${on}/${all.length}` : '';
                })()}`,
              },
              ...(['GET', 'HEAD', 'DELETE'].includes(tool.method) && tool.bodyMode === 'none'
                ? []
                : [
                    {
                      id: 'body' as LeftTab,
                      label: `Body${tool.bodyMode !== 'none' ? ` ${tool.params.filter((x) => x.in === 'body').length}` : ''}`,
                    },
                  ]),
              {
                id: 'headers',
                label: `Headers${Object.keys(tool.headers ?? {}).length ? ` ${Object.keys(tool.headers ?? {}).length}` : ''}`,
              },
              {
                id: 'auth',
                label: (
                  <>
                    <span className={tool.auth || (missingSecret && refused) ? '' : 'opacity-60'}>Auth</span>
                    {tool.auth ? ' ·' : ''}
                    {missingSecret && refused && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" />}
                  </>
                ),
              },
              {
                id: 'flow',
                label: tool.captures?.length || tool.before?.length ? `Flow ${(tool.captures?.length ?? 0) + (tool.before?.length ?? 0)}` : <span className="opacity-60">Flow</span>,
              },
              {
                id: 'tool',
                label: <>Tool {issues.some((i) => i.level !== 'info') && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" />}</>,
              },
            ]}
            value={left}
            onChange={setLeft}
          />
          {env && !env.baseUrl && (
            <div className="flex flex-wrap items-center gap-2 bg-warn/10 px-3 py-2 text-[12px] text-warn">
              <span className="flex-1">
                <b>{env.name} has no base URL yet</b> — requests can’t go anywhere.
              </span>
              {p.envs
                .filter((e) => e.baseUrl && e.name !== env.name)
                .slice(0, 1)
                .map((o) => (
                  <button
                    key={o.name}
                    className="btn"
                    onClick={() =>
                      update((x) => ({
                        ...x,
                        envs: x.envs.map((e) => (e.name === env.name ? { ...e, baseUrl: o.baseUrl } : e)),
                      }))
                    }
                  >
                    Use {o.name}’s URL
                  </button>
                ))}
              <button className="btn" onClick={() => setTab('envs')}>
                Set base URL…
              </button>
            </div>
          )}
          {armed && (
            <div className="flex items-center justify-between bg-bad/10 px-3 py-1.5 text-[12px] text-bad">
              This {SAFETY_LABEL[tool.safety].toLowerCase()} request changes data on {env?.name}. Click again to send it.
              <button className="text-ink-muted" onClick={() => setArmed(false)}>
                Cancel
              </button>
            </div>
          )}
          {used.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2 text-[11px]">
              <span className="text-ink-faint">Uses</span>
              {used.map((n) => {
                const v = rt[n] ?? env?.vars?.[n];
                const from = producers(n);
                return (
                  <button
                    key={n}
                    type="button"
                    disabled={!!v || !from.length || !!fetching}
                    onClick={() => void runFirst(n)}
                    title={
                      v
                        ? `= ${v} — ${runtime.find((r) => r.name === n)?.from ? `kept from ${runtime.find((r) => r.name === n)?.from}` : 'from the environment'}`
                        : from.length
                          ? `Click to run ${from[0]} now and keep it`
                          : 'Not set — add it to the environment, or keep it from a response'
                    }
                    className={`rounded-full px-2 py-0.5 font-mono ${v ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'} ${!v && from.length ? 'hover:bg-warn/25' : ''}`}
                  >
                    {`{{${n}}}`} {v ? `= ${v.length > 14 ? `${v.slice(0, 12)}…` : v}` : from.length ? (fetching === from[0] ? `running ${from[0]}…` : `← run ${from[0]} first`) : 'not set'}
                  </button>
                );
              })}
            </div>
          )}
          {askFor &&
            (() => {
              const src = p.tools.find((t) => t.id === askFor.toolId);
              if (!src) return null;
              return (
                <div className="mx-3 mt-3 rounded-lg border border-accent/40 bg-accent/[0.06] px-3.5 py-3 text-[12.5px]">
                  <p className="leading-relaxed">
                    To get <b className="font-mono">{`{{${askFor.name}}}`}</b>, <b>{src.name}</b> runs first — and it needs {Object.keys(askFor.values).length === 1 ? 'a value' : 'values'} it has
                    never been sent with. They’ll be kept on it for next time.
                  </p>
                  <div className="mt-2.5 space-y-2">
                    {Object.keys(askFor.values).map((k) => {
                      const prm = src.params.find((x) => x.name === k);
                      return (
                        <div key={k} className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
                          <span className="truncate font-mono text-[12px]" title={prm?.description}>
                            {k}
                          </span>
                          <SeenInput
                            toolId={src.id}
                            param={k}
                            value={askFor.values[k]}
                            onValue={(v) =>
                              setAskFor({
                                ...askFor,
                                values: { ...askFor.values, [k]: v },
                              })
                            }
                            placeholder={prm?.description?.slice(0, 60) || 'value'}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-primary h-8"
                      disabled={!!fetching || Object.values(askFor.values).some((v) => !v.trim())}
                      onClick={() => {
                        const given = Object.fromEntries(
                          Object.entries(askFor.values).map(([k, v]) => {
                            const prm = src.params.find((x) => x.name === k);
                            return [k, prm ? coerce(prm, v) : v];
                          }),
                        );
                        void runFirst(askFor.name, given);
                      }}
                    >
                      {fetching ? `Running ${fetching}…` : `Run ${src.name}, then send`}
                    </button>
                    <button type="button" className="btn h-8" onClick={() => setAskFor(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
          {needs && !askFor && (
            <div className="mx-3 mt-3 rounded-lg border border-warn/40 bg-warn/[0.07] px-3.5 py-3 text-[12.5px]">
              {needs.map((n) => {
                const from = producers(n);
                return (
                  <p key={n} className="leading-relaxed">
                    <b className="font-mono">{`{{${n}}}`}</b> has no value yet
                    {from.length ? (
                      <>
                        {' '}
                        — it comes from <b>{from[0]}</b>. Sending now would put the text <span className="font-mono">{`{{${n}}}`}</span> in the request.
                      </>
                    ) : (
                      ' — nothing in this API keeps it. Type a value in its param, or add it to the environment.'
                    )}
                  </p>
                );
              })}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {needs.some((n) => producers(n).length) && (
                  <button type="button" className="btn-primary h-8" disabled={!!fetching} onClick={() => void runFirst(needs.find((n) => producers(n).length)!)}>
                    {fetching ? `Running ${fetching}…` : `Run ${producers(needs.find((n) => producers(n).length)!)[0]} first, then send`}
                  </button>
                )}
                <button
                  type="button"
                  className="btn h-8"
                  onClick={() => {
                    setNeeds(null);
                    setLeft('params');
                  }}
                >
                  I’ll pick a value
                </button>
                <button type="button" className="text-[12px] text-ink-muted hover:text-ink" onClick={() => void send(true)}>
                  Send anyway
                </button>
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {left === 'params' && (
              <>
                <ParamTable tool={tool} kinds={['path', 'query', 'header']} values={values} setValues={setValues} set={set} recent={mine} onAllHistory={() => setRight('history')} />
              </>
            )}
            {left === 'body' && <BodyEditor tool={tool} values={values} setValues={setValues} set={set} />}
            {left === 'headers' && <HeadersEditor tool={tool} set={set} />}
            {left === 'auth' && <AuthEditor tool={tool} set={set} />}
            {left === 'flow' && <FlowEditor tool={tool} set={set} producers={producers} />}
            {left === 'tool' && <AsTool tool={tool} set={set} issues={issues.map((i) => i.message)} />}
            {missingSecret && refused && left !== 'tool' && left !== 'auth' && (
              <p className="mt-3 text-[11px] text-warn">
                The server refused ({result?.status}) and this request’s sign-in isn’t set.{' '}
                <button className="underline" onClick={() => setLeft('auth')}>
                  Set it in Auth
                </button>
              </p>
            )}
          </div>
        </div>

        {/* Response */}
        <Splitter width={resW} setWidth={setResW} side="right" initial={560} />
        <div className="flex min-w-[320px] shrink-0 flex-col" style={{ width: resW }}>
          {result && !result.error && (
            <div className="flex h-10 shrink-0 items-center gap-3 border-b border-rule px-3 text-[12px]">
              <span className={`rounded px-2 py-0.5 font-mono font-semibold ${result.ok ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad'}`}>
                {result.status} {result.statusText}
              </span>
              {summary && <span className="font-medium text-ink">{summary}</span>}
              <span className={(result.durationMs ?? 0) > 1000 ? 'text-warn' : 'text-ink-faint'} title={(result.durationMs ?? 0) > 1000 ? 'Slow — agents wait for this too' : undefined}>
                {(result.durationMs ?? 0) < 1000 ? `${result.durationMs ?? 0} ms` : `${((result.durationMs ?? 0) / 1000).toFixed(1)} s`}
              </span>
              <span className="text-ink-faint">{sizeText(result.bytes)}</span>
              {result.truncated && (
                <span className="text-warn" title="Agents get the same cut. Raise the limit under Tool, or narrow the request.">
                  cut for agents
                </span>
              )}
              <span className="flex-1" />
              {result.request && <CopyAs request={result.request} />}
              <AddToTest tool={tool} body={result.full ?? result.body} />
            </div>
          )}
          <SubTabs
            tabs={[
              { id: 'body', label: 'Body' },
              {
                id: 'headers',
                label: `Headers${resHeaders.length ? ` ${resHeaders.length}` : ''}`,
              },
              { id: 'timeline', label: 'Timeline' },
              {
                id: 'history',
                label: `History${mine.length ? ` ${mine.length}` : ''}`,
              },
            ]}
            value={right}
            onChange={setRight}
          />
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {result && (result.status === 401 || result.status === 403) && env && (env.browserSession || env.auth.type === 'login' || env.auth.type === 'via') ? (
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
                <span className="min-w-0 flex-1">{result.hint ?? `Refused (${result.status}) — the sign-in for ${env.name} may have run out.`}</span>
                <RenewButton path={path!} env={env.name} onDone={() => void send()} label="Sign in again and resend" />
              </div>
            ) : (
              result?.hint && <p className="mb-3 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">{result.hint}</p>
            )}
            {right === 'body' &&
              (!result ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                    <Icon name="send" size={20} />
                  </span>
                  <div className="text-[14px] font-medium">Send it to see what comes back</div>
                  <div className="max-w-xs text-[12px] leading-relaxed text-ink-muted">The response shows here exactly as an agent will get it — then keep values from it, or make it a tool.</div>
                  <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                    <kbd className="rounded border border-rule-strong bg-surface px-1.5 py-0.5 font-mono text-[11px]">⌘</kbd>
                    <kbd className="rounded border border-rule-strong bg-surface px-1.5 py-0.5 font-mono text-[11px]">↵</kbd>
                    <span>to send</span>
                  </div>
                </div>
              ) : result.error ? (
                <div className="selectable rounded-lg bg-bad/10 p-3 text-[12px] text-bad">{result.error}</div>
              ) : (
                <div className="space-y-3">
                  {!tool.enabled && result.ok && (
                    <div className="flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5 text-[12px]">
                      <Icon name="sparkle" size={16} className="shrink-0 text-accent" />
                      <span className="flex-1">
                        <b>This request works.</b> Make it a tool and agents can call it — overapi drafts the description from this response.
                      </span>
                      <button
                        className="btn-primary shrink-0"
                        onClick={() => {
                          set((t) => ({
                            ...t,
                            enabled: true,
                            description: t.description.trim() ? t.description : draftDescription(t, result.body ?? ''),
                          }));
                          setLeft('tool');
                        }}
                      >
                        Make it a tool
                      </button>
                    </div>
                  )}
                  {result.request && <SentLine req={result.request} />}
                  {result.captured && Object.keys(result.captured).length > 0 && (
                    <div className="flex items-center gap-2 rounded-lg bg-good/10 px-3 py-2 text-[12px] text-good">
                      <Icon name="check" size={13} />
                      Kept{' '}
                      {Object.keys(result.captured)
                        .map((n) => `{{${n}}}`)
                        .join(', ')}{' '}
                      for the requests after this one.
                    </div>
                  )}
                  {keeping && (
                    <form
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-[12px]"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(keeping.capture.var)) keep(keeping.capture, keeping.value);
                      }}
                    >
                      <span>
                        Keep <span className="font-mono">{keeping.capture.path}</span> as
                      </span>
                      <span className="font-mono text-ink-faint">{'{{'}</span>
                      <input
                        autoFocus
                        className="field w-40 py-0.5 font-mono text-[12px]"
                        value={keeping.capture.var}
                        onChange={(e) =>
                          setKeeping({
                            ...keeping,
                            capture: {
                              ...keeping.capture,
                              var: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '_'),
                            },
                          })
                        }
                      />
                      <span className="font-mono text-ink-faint">{'}}'}</span>
                      <button className="btn-primary">Keep</button>
                      <button type="button" className="text-ink-muted" onClick={() => setKeeping(null)}>
                        Cancel
                      </button>
                    </form>
                  )}
                  {result.truncated && result.full && (
                    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px]">
                      <span className="flex-1 text-ink-muted">
                        {asAgent ? (
                          <>Showing what an agent gets: the first {(result.body ?? '').split('\n…')[0].length.toLocaleString()} characters, then a note that it was cut.</>
                        ) : (
                          <>The whole response, {sizeText(result.bytes)}. Agents get only the first part — raise the limit under Tool, or narrow the request.</>
                        )}
                      </span>
                      <button className="btn !px-2 !py-0.5 text-[11px]" onClick={() => setAsAgent((x) => !x)}>
                        {asAgent ? 'Show the whole response' : 'Show what the agent gets'}
                      </button>
                    </div>
                  )}
                  {(hasList || canChart) && !asAgent && (
                    <div className="mb-2 flex items-center gap-2">
                      <div className="inline-flex rounded-md border border-rule-strong bg-canvas p-0.5 text-[11.5px]">
                        {([...(hasList ? (['table'] as const) : []), ...(canChart ? (['chart'] as const) : []), 'json'] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setView(v)}
                            className={`rounded px-2.5 py-0.5 ${view === v ? 'bg-wash-strong font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
                          >
                            {v === 'table' ? 'Table' : v === 'chart' ? 'Chart' : 'JSON'}
                          </button>
                        ))}
                      </div>
                      {view === 'table' && <span className="text-[11px] text-ink-faint">Click a row for all of it · switch to JSON to keep a value</span>}
                    </div>
                  )}
                  {canChart && !asAgent && view === 'chart' ? (
                    <ResponseChart json={parsed} prefer={sortedBy} />
                  ) : hasList && !asAgent && view === 'table' ? (
                    <ResponseTable json={parsed} prefer={sortedBy} />
                  ) : (
                    <JsonView
                      text={(asAgent ? result.body : (result.full ?? result.body)) ?? ''}
                      onKeep={(segs, v) =>
                        setKeeping({
                          capture: {
                            var: suggestName(segs),
                            from: 'body',
                            path: formatPath(segs),
                          },
                          value: typeof v === 'object' ? JSON.stringify(v) : String(v),
                        })
                      }
                    />
                  )}
                </div>
              ))}
            {right === 'headers' &&
              (resHeaders.length ? (
                <table className="w-full text-[12px]">
                  <tbody>
                    {resHeaders.map(([k, v]) => (
                      <tr key={k} className="group border-b border-rule last:border-b-0">
                        <td className="w-[38%] py-1.5 pr-3 align-top font-mono text-sky-700 dark:text-sky-300">{k}</td>
                        <td className="selectable break-all py-1.5 font-mono text-ink-muted">{v}</td>
                        <td className="w-14 py-1.5 text-right align-top">
                          <button
                            className="rounded border border-accent/40 px-1 text-[10px] text-accent opacity-0 hover:bg-accent/10 group-hover:opacity-100"
                            title="Keep this header's value for later requests"
                            onClick={() => {
                              setKeeping({
                                capture: {
                                  var: k.replace(/[^A-Za-z0-9_]/g, '_'),
                                  from: 'header',
                                  path: k,
                                },
                                value: v,
                              });
                              setRight('body');
                            }}
                          >
                            {'{{ }}'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>Send the request to see the response headers.</Empty>
              ))}
            {right === 'timeline' &&
              (result?.request ? (
                <div className="space-y-3 font-mono text-[11px] leading-relaxed">
                  <div>
                    <div className="mb-1 font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">→ Request</div>
                    <div className="selectable rounded-lg border border-rule bg-wash p-3">
                      <div className="font-semibold text-ink">
                        {result.request.method} {result.request.url}
                      </div>
                      {Object.entries(result.request.headers).map(([k, v]) => (
                        <div key={k} className="break-all">
                          <span className="text-sky-700 dark:text-sky-300">{k}</span>
                          <span className="text-ink-faint">: </span>
                          <span className="text-ink-muted">{v}</span>
                        </div>
                      ))}
                    </div>
                    {result.request.body && (
                      <div className="mt-2 font-sans">
                        <JsonView text={result.request.body} compact />
                      </div>
                    )}
                  </div>
                  {!result.error && (
                    <div>
                      <div className="mb-1 font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                        ← Response · {result.durationMs} ms · {sizeText(result.bytes)}
                      </div>
                      <div className="selectable rounded-lg border border-rule bg-wash p-3">
                        <div className={`font-semibold ${result.ok ? 'text-good' : 'text-bad'}`}>
                          {result.status} {result.statusText}
                        </div>
                        {resHeaders.map(([k, v]) => (
                          <div key={k} className="break-all">
                            <span className="text-sky-700 dark:text-sky-300">{k}</span>
                            <span className="text-ink-faint">: </span>
                            <span className="text-ink-muted">{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="font-sans text-[11px] text-ink-faint">Secrets are shown as •••.</p>
                </div>
              ) : (
                <Empty>Send the request to see exactly what went out and what came back.</Empty>
              ))}
            {right === 'history' &&
              (mine.length === 0 ? (
                <Empty>No calls yet.</Empty>
              ) : (
                <>
                  <LatencyTrend entries={mine} />
                  <ul className="space-y-0.5">
                    {collapseRuns(mine).map(({ h, n }) => (
                      <li key={h.id}>
                        <button
                          className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-wash-strong"
                          title="Use these values"
                          onClick={() => {
                            setValues(Object.fromEntries(Object.entries(h.args).map(([k, v]) => [k, toText(v)])));
                            setLeft('params');
                          }}
                        >
                          <span className={`w-9 shrink-0 font-mono font-semibold ${h.ok ? 'text-good' : 'text-bad'}`}>{h.status ?? 'ERR'}</span>
                          <EnvChip name={h.env} />
                          <span className="min-w-0 flex-1">
                            <ArgChips args={h.args} max={4} />
                          </span>
                          {n > 1 && <span className="shrink-0 rounded-full bg-wash-strong px-1.5 text-[10.5px] font-semibold tabular-nums text-ink-muted">×{n}</span>}
                          <span className="shrink-0 text-[10.5px] text-ink-faint group-hover:hidden">{ago(h.at)}</span>
                          <span className="hidden shrink-0 text-[10.5px] text-accent group-hover:inline">Use these →</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- request editors ---------------------------------------------------------

function HeadersEditor({ tool, set }: { tool: ToolDef; set: (fn: (t: ToolDef) => ToolDef) => void }): JSX.Element {
  const { project, env: envName, setTab } = useStore();
  const env = project!.envs.find((e) => e.name === envName) ?? project!.envs[0];
  const inherited = Object.entries(env?.headers ?? {});
  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-ink-muted">
        Headers this request always sends. Agents never see or set them. Use <span className="font-mono">{'{{name}}'}</span> for a variable and <span className="font-mono">{'${SECRET}'}</span> for a
        secret from the keychain. Headers an agent should choose belong in Params.
      </p>
      <KeyValues
        values={tool.headers ?? {}}
        onChange={(headers) =>
          set((t) => ({
            ...t,
            headers: Object.keys(headers).length ? headers : undefined,
          }))
        }
        keyPlaceholder="X-Request-Source"
        valuePlaceholder="{{tenant}}"
      />
      <div>
        <div className="label">From the {env?.name ?? ''} environment</div>
        {inherited.length === 0 ? (
          <p className="text-[12px] text-ink-faint">None.</p>
        ) : (
          inherited.map(([k, v]) => (
            <div key={k} className="flex gap-2 py-1 font-mono text-[12px] text-ink-faint">
              <span className="w-48 truncate">{k}</span>
              <span className="truncate">{v}</span>
            </div>
          ))
        )}
        <button className="mt-1 text-[11px] text-accent hover:underline" onClick={() => setTab('envs')}>
          Edit environment headers
        </button>
        <p className="mt-2 text-[11px] text-ink-faint">Sent too: accept, user-agent, content-type for a body, and the sign-in from Auth.</p>
      </div>
    </div>
  );
}

function AuthEditor({ tool, set }: { tool: ToolDef; set: (fn: (t: ToolDef) => ToolDef) => void }): JSX.Element {
  const { project, path, env: envName, secrets } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const own = tool.auth;
  const prefix = varPrefix(p.name);
  const setAuth = (a: AuthSpec | undefined) => set((t) => ({ ...t, auth: a }));
  const describe = (a?: AuthSpec) =>
    !a || a.type === 'none'
      ? 'no sign-in'
      : a.type === 'bearer'
        ? `a bearer token (${a.tokenVar})`
        : a.type === 'apiKey'
          ? `an API key in the ${a.in} ${a.name} (${a.valueVar})`
          : a.type === 'login'
            ? `a sign-in request first (${p.tools.find((t) => t.id === a.toolId)?.name ?? 'missing'}) — see Flow`
            : a.type === 'via'
              ? `${a.api}’s sign-in`
              : a.type === 'oauth2'
                ? `OAuth 2 (${a.grant === 'client_credentials' ? 'client credentials' : 'signed in in the browser'})`
                : a.type === 'command'
                  ? `a token from a command (${a.commandVar})`
                  : `user and password (${a.userVar}, ${a.passVar})`;
  const kinds: [string, string][] = [
    ['inherit', 'From environment'],
    ['none', 'None'],
    ['bearer', 'Bearer token'],
    ['apiKey', 'API key'],
    ['basic', 'User + password'],
  ];
  const current = own ? own.type : 'inherit';
  const active = own ?? env?.auth;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {kinds.map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              if (k === current) return;
              if (k === 'inherit') setAuth(undefined);
              if (k === 'none') setAuth({ type: 'none' });
              if (k === 'bearer') setAuth({ type: 'bearer', tokenVar: `${prefix}_TOKEN` });
              if (k === 'apiKey')
                setAuth({
                  type: 'apiKey',
                  in: 'header',
                  name: 'X-API-Key',
                  valueVar: `${prefix}_API_KEY`,
                });
              if (k === 'basic')
                setAuth({
                  type: 'basic',
                  userVar: `${prefix}_USER`,
                  passVar: `${prefix}_PASSWORD`,
                });
            }}
            className={`rounded-md border px-3 py-1.5 text-[12px] ${current === k ? 'border-accent bg-accent/10 font-semibold' : 'border-rule-strong/70 hover:bg-wash-strong'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {active &&
        active.type !== 'none' &&
        envVars({
          name: '',
          baseUrl: '',
          auth: active,
          allowWrites: false,
        }).some((n) => !secrets[n]) && (
          <p className="rounded-lg bg-wash p-3 text-[12px] leading-relaxed text-ink-muted">
            Not set yet, so requests go without it. That’s fine for calls that don’t need it — many APIs declare one sign-in for everything. Set it if the server answers 401 or 403.
          </p>
        )}
      {!own && (
        <p className="text-[12px] text-ink-muted">
          Uses <b className="text-ink">{env?.name}</b>’s sign-in: {describe(env?.auth)}. Change it in Environments, or pick one above for this request only — say, a login request that sends no token.
        </p>
      )}
      {active?.type === 'bearer' && (
        <>
          <SecretField label="Token" varName={active.tokenVar} onVar={(v) => own?.type === 'bearer' && setAuth({ ...own, tokenVar: v })} source={secrets[active.tokenVar]} path={path!} />
          <p className="text-[11px] text-ink-faint">
            Token from a login response instead? Keep it in that request’s Chain as e.g. <span className="font-mono">{'{{token}}'}</span>, set this to None and add a header{' '}
            <span className="font-mono">Authorization: Bearer {'{{token}}'}</span>.
          </p>
        </>
      )}
      {active?.type === 'apiKey' && (
        <>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="w-24 text-ink-muted">Sent as</span>
            <select className="field w-28" disabled={!own} value={active.in} onChange={(e) => own?.type === 'apiKey' && setAuth({ ...own, in: e.target.value as 'header' | 'query' })}>
              <option value="header">header</option>
              <option value="query">query</option>
            </select>
            <input className="field w-56 font-mono" disabled={!own} value={active.name} onChange={(e) => own?.type === 'apiKey' && setAuth({ ...own, name: e.target.value })} />
          </div>
          <SecretField label="Key" varName={active.valueVar} onVar={(v) => own?.type === 'apiKey' && setAuth({ ...own, valueVar: v })} source={secrets[active.valueVar]} path={path!} />
        </>
      )}
      {active?.type === 'basic' && (
        <>
          <SecretField label="User" varName={active.userVar} onVar={(v) => own?.type === 'basic' && setAuth({ ...own, userVar: v })} source={secrets[active.userVar]} path={path!} />
          <SecretField label="Password" varName={active.passVar} onVar={(v) => own?.type === 'basic' && setAuth({ ...own, passVar: v })} source={secrets[active.passVar]} path={path!} />
        </>
      )}
    </div>
  );
}

/// `kept` and `next`: green, the colour of a kept value on this screen — what
/// this request keeps, and the requests that take it.
function Step({
  n,
  title,
  tone,
  children,
  right,
}: {
  n: string;
  title: React.ReactNode;
  tone?: 'accent' | 'muted' | 'dashed' | 'kept' | 'next';
  children?: React.ReactNode;
  right?: React.ReactNode;
}): JSX.Element {
  const box =
    tone === 'accent'
      ? 'border-accent/60 bg-accent/5'
      : tone === 'kept'
        ? 'border-good/30 bg-good/[0.04]'
        : tone === 'next'
          ? 'border-dashed border-good/30'
          : tone === 'dashed'
            ? 'border-dashed border-rule-strong'
            : tone === 'muted'
              ? 'border-rule bg-transparent'
              : 'border-rule bg-wash';
  const dot = tone === 'accent' ? 'bg-accent text-white' : tone === 'kept' ? 'bg-good text-white' : tone === 'next' ? 'bg-good/15 text-good' : 'bg-wash-strong text-ink-muted';
  return (
    <section className={`rounded-xl border px-4 py-3 ${box}`}>
      <div className="flex items-center gap-2.5">
        <span className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${dot}`}>{n}</span>
        <h3 className="flex-1 text-[13px] font-semibold">{title}</h3>
        {right}
      </div>
      {children && <div className="ml-8 mt-2.5 space-y-2 text-[12px]">{children}</div>}
    </section>
  );
}

/// The line between steps; green once a kept value travels along it.
function Link({ dashed, kept }: { dashed?: boolean; kept?: boolean }): JSX.Element {
  return <div className={`ml-[26px] h-5 border-l-2 ${dashed ? 'border-dashed' : ''} ${kept ? 'border-good/50' : 'border-rule-strong'}`} aria-hidden />;
}

/// What happens around a request, top to bottom: sign in first (only when
/// needed), the request itself, what it keeps, who uses that next. All of
/// it runs on its own — on Send, and when an agent calls the tool.
function FlowEditor({ tool, set, producers }: { tool: ToolDef; set: (fn: (t: ToolDef) => ToolDef) => void; producers: (n: string) => string[] }): JSX.Element {
  const { project, path, env: envName, runtime, setRuntime, setTab, say, selectTool, update } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const auth = tool.auth ?? env?.auth;
  const isLogin = !!env && isLoginTool(tool, env);
  const login = auth?.type === 'login' && !isLogin ? p.tools.find((t) => t.id === auth.toolId) : undefined;
  // Suggested, never assumed: a request that looks like a login, while the
  // environment has no sign-in of its own.
  const suggestion =
    !login && !isLogin && env && env.auth.type !== 'login'
      ? p.tools.find((t) => t.id !== tool.id && /log_?in|sign_?in|auth|token|session/i.test(`${t.name} ${t.path}`) && !/logout|sign_?out/i.test(t.name))
      : undefined;
  const [status, setStatus] = useState<{
    signedIn: boolean;
    at?: string;
    tail?: string;
  } | null>(null);
  const refresh = () => {
    if (env) void window.overapi.invoke('auth:status', path!, env.name).then(setStatus);
  };
  useEffect(refresh, [envName, path]);
  const caps = tool.captures ?? [];
  const value = (n: string) => runtime.find((r) => r.name === n)?.value;
  const setCap = (i: number, patch: Partial<Capture>) =>
    set((t) => ({
      ...t,
      captures: (t.captures ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  const used = varsUsed(tool);
  const next = p.tools.filter((t) => t.id !== tool.id && caps.some((c) => varsUsed(t).includes(c.var)));
  const feeds = feedsFrom(p, tool);
  // "Could feed", one group per kept value: the value once, its targets under it.
  const feedGroups = [...new Set(feeds.map((f) => f.var))].map((v) => ({ v, list: feeds.filter((f) => f.var === v) }));
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const nothingFirst = !isLogin && !login && !suggestion && !(tool.before ?? []).length;
  const addFirst = () => {
    const first = p.tools.find((t) => t.id !== tool.id);
    if (first) set((t) => ({ ...t, before: [...(t.before ?? []), { toolId: first.id, when: 'always' }] }));
  };
  const wireAll = (list: Feed[]) => {
    update((x) => ({
      ...x,
      tools: x.tools.map((t) => list.filter((f) => f.toolId === t.id).reduce((acc, f) => wireInto(acc, f.param, f.var), t)),
    }));
    say(list.length === 1 ? `${list[0].toolName} now takes ${list[0].param} from {{${list[0].var}}} when it's sent.` : `Wired ${list.length} parameters to kept values.`);
  };

  return (
    <div>
      <p className="mb-4 text-[12px] leading-relaxed text-ink-muted">
        What happens around this request, top to bottom. It all runs on its own — when you press Send, and when an agent calls the tool. An agent only ever sees{' '}
        <span className="font-mono">{tool.name}</span>.
      </p>

      {nothingFirst ? (
        <div className="flex items-center gap-2.5 px-4 py-1 text-[12px]">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-wash-strong text-[11px] font-bold text-ink-faint">1</span>
          <span className="text-ink-faint">Nothing runs first.</span>
          <button className="text-accent hover:underline" onClick={addFirst} title="Run another request before this one — with the values saved on it">
            + Run another request first
          </button>
        </div>
      ) : (
        <Step n="1" title="First" tone={login || (tool.before ?? []).length ? undefined : 'muted'}>
          {isLogin ? (
            <p className="text-ink-muted">
              This <b className="text-ink">is</b> the sign-in request for <b className="text-ink">{env?.name}</b>. Agents never see it; overapi runs it before other requests when there’s no token, and
              again after a 401. Save the credentials in its Params or Body — <span className="font-mono">{'${ACME_PASSWORD}'}</span> for a secret.
            </p>
          ) : login ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Sign in</span>
                <span className="text-ink-muted">— run</span>
                <button className="inline-flex items-center gap-2 rounded-md border border-rule-strong bg-surface-elevated/60 px-2.5 py-1" onClick={() => selectTool(login.id)}>
                  <Method method={login.method} /> {login.name}
                </button>
                <span className="text-ink-muted">when there’s no token, again on 401</span>
                <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${status?.signedIn ? 'bg-good/15 text-good' : 'bg-wash-strong text-ink-faint'}`}>
                  {status?.signedIn ? `signed in ${status.at ? new Date(status.at).toLocaleTimeString() : ''}` : 'not signed in yet'}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await window.overapi.invoke('auth:signIn', path!, p, env!.name);
                    if (r.ok) say(`Signed in — token ends ••••${r.tail}.`);
                    else say(r.error, true);
                    refresh();
                  }}
                >
                  Sign in now
                </button>
                <button className="btn" onClick={() => setTab('envs')}>
                  Change in Environments
                </button>
              </div>
            </>
          ) : suggestion ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
              <span className="flex-1 text-ink-muted">
                <b className="text-ink">{suggestion.name}</b> looks like a sign-in. Use it to sign in automatically before requests that need it?
              </span>
              <button
                className="btn"
                onClick={() => {
                  update((x) => ({
                    ...x,
                    envs: x.envs.map((e) =>
                      e.name === env!.name
                        ? {
                            ...e,
                            auth: {
                              type: 'login',
                              toolId: suggestion.id,
                              from: 'body',
                              path: 'token',
                              sendAs: 'bearer',
                            },
                          }
                        : e,
                    ),
                  }));
                  setTab('envs');
                  say(`${suggestion.name} is now the sign-in for ${env!.name}. Check where the token is in its response.`);
                }}
              >
                Use as sign-in
              </button>
            </div>
          ) : null}

          {(tool.before ?? []).map((b, i) => {
            const setB = (patchB: Partial<BeforeStep>) =>
              set((t) => ({
                ...t,
                before: (t.before ?? []).map((x, j) => (j === i ? { ...x, ...patchB } : x)),
              }));
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Run</span>
                <select className="field w-56 py-1 text-[12px]" value={b.toolId} onChange={(e) => setB({ toolId: e.target.value })}>
                  {p.tools
                    .filter((t) => t.id !== tool.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.method} {t.name}
                      </option>
                    ))}
                </select>
                <select className="field w-44 py-1 text-[12px]" value={b.when} onChange={(e) => setB({ when: e.target.value as BeforeStep['when'] })}>
                  <option value="always">every time</option>
                  <option value="missing">only if a value is missing</option>
                </select>
                {b.when === 'missing' && (
                  <>
                    <span className="font-mono text-ink-faint">{'{{'}</span>
                    <input
                      className="field w-32 py-1 font-mono text-[12px]"
                      value={b.var ?? ''}
                      placeholder="order_id"
                      onChange={(e) =>
                        setB({
                          var: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '_') || undefined,
                        })
                      }
                    />
                    <span className="font-mono text-ink-faint">{'}}'}</span>
                  </>
                )}
                <button
                  className="text-[14px] text-ink-faint hover:text-bad"
                  title="Don’t run it first"
                  onClick={() =>
                    set((t) => ({
                      ...t,
                      before: (t.before ?? []).filter((_, j) => j !== i),
                    }))
                  }
                >
                  ×
                </button>
              </div>
            );
          })}
          {!isLogin && (
            <button className="text-accent hover:underline" onClick={addFirst}>
              + Run another request first
            </button>
          )}
        </Step>
      )}
      <Link />

      <Step
        n="2"
        title={
          <>
            This request — <span className="font-mono">{tool.name}</span>
          </>
        }
        tone="accent"
        right={
          <span className="font-mono text-[11px] text-ink-faint">
            {tool.method} {tool.path}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-ink-faint">uses</span>
          {login && <span className="rounded-full bg-good/15 px-2 py-0.5 font-mono text-good">the sign-in token</span>}
          {used.map((n) => {
            const v = value(n) ?? env?.vars?.[n];
            const from = producers(n);
            return (
              <span key={n} className={`rounded-full px-2 py-0.5 font-mono ${v ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`} title={v ? `= ${v}` : undefined}>
                {`{{${n}}}`} {v ? '✓' : from.length ? `← ${from[0]} first` : 'not set'}
              </span>
            );
          })}
          {tool.params.length > 0 && (
            <span className="rounded-full bg-wash-strong px-2 py-0.5 font-mono text-ink-muted">
              {tool.params
                .map((x) => x.name)
                .slice(0, 4)
                .join(', ')}
              {tool.params.length > 4 ? '…' : ''} — from the agent
            </span>
          )}
          {!login && used.length === 0 && tool.params.length === 0 && <span className="text-ink-faint">nothing else</span>}
        </div>
      </Step>
      <Link kept={caps.length > 0} />

      <Step n="3" title="Then keep, for later requests" tone={caps.length ? 'kept' : undefined}>
        {caps.length === 0 && (
          <p className="text-ink-faint">
            Nothing yet. Send it, then hover a value in the response and click <span className="rounded border border-accent/40 px-1 text-[10px] text-accent">{'{{ }}'}</span>.
          </p>
        )}
        {caps.map((c, i) => {
          const paths = c.from === 'body' ? shapePaths(tool.returns) : [];
          const missing = paths.length > 0 && !paths.includes(c.path.replace(/\[\d+\]/g, '[0]'));
          const better = missing ? (bestPath(tool.returns, lastKey(c.path)) ?? bestPath(tool.returns, 'id')) : undefined;
          const list = c.from === 'body' && /\[0\]/.test(c.path) ? c.path.split('[0]')[0] : null;
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-ink-faint">{'{{'}</span>
                <input
                  className="field w-36 py-1 font-mono text-[12px]"
                  value={c.var}
                  onChange={(e) =>
                    setCap(i, {
                      var: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '_'),
                    })
                  }
                />
                <span className="font-mono text-ink-faint">{'}}'} ←</span>
                <select className="field w-24 py-1 text-[12px]" value={c.from} onChange={(e) => setCap(i, { from: e.target.value as Capture['from'] })}>
                  <option value="body">body</option>
                  <option value="header">header</option>
                </select>
                <input
                  className="field flex-1 py-1 font-mono text-[12px]"
                  value={c.path}
                  placeholder={c.from === 'body' ? 'data.token' : 'x-session-id'}
                  onChange={(e) => setCap(i, { path: e.target.value })}
                />
                <span className={`max-w-[120px] truncate font-mono text-[11px] ${value(c.var) ? 'text-good' : 'text-ink-faint'}`} title={value(c.var)}>
                  {value(c.var) ?? 'not yet'}
                </span>
                <button
                  className="text-[14px] text-ink-faint hover:text-bad"
                  title="Stop keeping it"
                  onClick={() =>
                    set((t) => ({
                      ...t,
                      captures: (t.captures ?? []).filter((_, j) => j !== i),
                    }))
                  }
                >
                  ×
                </button>
              </div>
              {missing ? (
                <div className="ml-6 flex flex-wrap items-center gap-2 text-[11.5px] text-warn">
                  <span>
                    The response has no <span className="font-mono">{c.path}</span>
                    {better ? (
                      <>
                        {' '}
                        — it’s at <span className="font-mono">{better}</span>
                        {/\[0\]/.test(better) ? `, the first in ${better.split('[0]')[0]}` : ''}.
                      </>
                    ) : (
                      '.'
                    )}
                  </span>
                  {better && (
                    <button className="rounded border border-warn/40 px-1.5 py-0.5 text-[11px] hover:bg-warn/10" onClick={() => setCap(i, { path: better })}>
                      Use {better}
                    </button>
                  )}
                </div>
              ) : list ? (
                <div className="ml-6 text-[11.5px] text-ink-faint">
                  Keeps the first in <span className="font-mono">{list}</span> on each send. To use a different one, pick it in the request that uses{' '}
                  <span className="font-mono">{`{{${c.var}}}`}</span> — earlier answers are offered there by name.
                </div>
              ) : null}
            </div>
          );
        })}
        <button
          className="text-accent hover:underline"
          onClick={() =>
            set((t) => {
              const at = bestPath(t.returns, 'id') ?? 'id';
              return {
                ...t,
                captures: [...(t.captures ?? []), { var: 'id', from: 'body', path: at }],
              };
            })
          }
        >
          + Keep a value by path
        </button>
      </Step>
      <Link dashed kept={caps.length > 0 && (next.length > 0 || feeds.length > 0)} />

      <Step n="→" title="Used next by" tone={caps.length ? 'next' : 'dashed'}>
        {next.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {next.map((t) => (
              <button key={t.id} className="inline-flex items-center gap-2 rounded-md border border-rule-strong px-2.5 py-1 hover:bg-wash-strong" onClick={() => selectTool(t.id)}>
                <Method method={t.method} /> {t.name}
              </button>
            ))}
          </div>
        )}
        {next.length === 0 && !feeds.length && (
          <p className="text-ink-faint">
            {caps.length
              ? `No request uses ${caps.map((c) => `{{${c.var}}}`).join(', ')} yet — drag one onto a request in the list, or put it in a URL, header or param.`
              : 'Keep a value and other requests can use it.'}
          </p>
        )}
        {caps.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink-faint">Drag onto a request in the list:</span>
            {caps.map((c) => (
              <span
                key={c.var}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-overapi-var', c.var);
                  e.dataTransfer.setData('text/x-overapi-from', tool.id);
                  e.dataTransfer.effectAllowed = 'link';
                }}
                className="cursor-grab rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent active:cursor-grabbing"
                title="Drag onto a request in the list to use it there"
              >
                ⠿ {`{{${c.var}}}`}
              </span>
            ))}
          </div>
        )}
        {feeds.length > 0 && (
          <div className="mt-3 rounded-lg border border-rule">
            <div className="flex items-center gap-2 border-b border-rule px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Could feed · names match</span>
              <span className="flex-1" />
              <button className="text-[11px] text-accent hover:underline" onClick={() => wireAll(feeds)}>
                Use all {feeds.length}
              </button>
            </div>
            {feedGroups.map(({ v, list }) => {
              const open = openGroups.has(v);
              const shown = open ? list : list.slice(0, 4);
              return (
                <div key={v} className="border-t border-rule first:border-t-0">
                  <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                    <span className="font-mono text-[11.5px] text-good">{`{{${v}}}`}</span>
                    <span className="text-[11px] text-ink-faint">
                      could fill {list.length} request{list.length === 1 ? '' : 's'}
                    </span>
                    <span className="flex-1" />
                    {feedGroups.length > 1 && (
                      <button className="text-[11px] text-accent hover:underline" onClick={() => wireAll(list)}>
                        Use all {list.length}
                      </button>
                    )}
                  </div>
                  {shown.map((f) => {
                    const t = p.tools.find((x) => x.id === f.toolId)!;
                    return (
                      <div key={`${f.toolId}-${f.param}`} className="flex items-center gap-2 py-1 pl-6 pr-3 hover:bg-wash">
                        <Method method={t.method} />
                        <button className="min-w-0 truncate hover:underline" onClick={() => selectTool(t.id)}>
                          {f.toolName}
                        </button>
                        <span className="font-mono text-[11px] text-ink-faint">{f.param}</span>
                        <span className="flex-1" />
                        <button className="btn !px-2 !py-0.5 text-[11px]" onClick={() => wireAll([f])}>
                          Use
                        </button>
                      </div>
                    );
                  })}
                  {list.length > 4 && (
                    <button
                      className="mb-1.5 ml-6 text-[11px] text-ink-faint hover:text-ink"
                      onClick={() =>
                        setOpenGroups((g) => {
                          const n = new Set(g);
                          if (open) n.delete(v);
                          else n.add(v);
                          return n;
                        })
                      }
                    >
                      {open ? 'Show fewer' : `Show ${list.length - 4} more`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Step>

      {runtime.length > 0 && (
        <div className="mt-6">
          <div className="label">Kept this session</div>
          {runtime.map((r) => (
            <div key={r.name} className="flex items-center gap-2 py-1 text-[12px]">
              <span className="w-36 truncate font-mono">{`{{${r.name}}}`}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-muted" title={r.value}>
                {r.value}
              </span>
              <span className="text-[11px] text-ink-faint">{r.from}</span>
              <button className="text-[11px] text-ink-faint hover:text-bad" onClick={() => void setRuntime(r.name, null)}>
                Clear
              </button>
            </div>
          ))}
          <p className="mt-1 text-[11px] text-ink-faint">Kept in memory only — gone when overapi quits.</p>
        </div>
      )}
    </div>
  );
}

/// Every leaf of a response shape, lists as [0] — the paths a value can be
/// kept from.
function shapePaths(sh: import('@shared/scenario').Shape | undefined, at = '', out: string[] = []): string[] {
  if (!sh || out.length > 400) return out;
  if (sh.t === 'array') return shapePaths(sh.of, `${at}[0]`, out);
  if (sh.t === 'object') {
    for (const [k, v] of Object.entries(sh.keys)) shapePaths(v, at ? `${at}.${k}` : k, out);
    return out;
  }
  if (at) out.push(at);
  return out;
}
const lastKey = (p: string) =>
  p
    .split('.')
    .pop()!
    .replace(/\[\d+\]$/, '');
/// Where a value called `key` most likely is: at the top, else the first
/// item of the shallowest list.
function bestPath(sh: import('@shared/scenario').Shape | undefined, key: string): string | undefined {
  const all = shapePaths(sh).filter((x) => lastKey(x) === key);
  return all.sort((a, b) => a.split('.').length - b.split('.').length)[0];
}

/// A call's arguments as short chips: `searchText test`, `includeHidden ✓`.
function ArgChips({ args, max = 6 }: { args: Record<string, unknown>; max?: number }): JSX.Element {
  const entries = Object.entries(args).filter(([, v]) => v !== '' && v !== undefined && v !== null);
  if (!entries.length) return <span className="text-ink-faint">no arguments</span>;
  const shown = (v: unknown) => (v === true ? '✓' : v === false ? '✗' : Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : typeof v === 'object' ? '{…}' : String(v));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {entries.slice(0, max).map(([k, v]) => (
        <span key={k} className="inline-flex max-w-[220px] items-center gap-1 rounded bg-wash-strong px-1.5 py-px font-mono text-[11px]">
          <span className="text-ink-muted">{k}</span>
          <span className={`truncate ${v === false ? 'text-ink-faint' : 'text-ink'}`}>{shown(v)}</span>
        </span>
      ))}
      {entries.length > max && <span className="text-[11px] text-ink-faint">+{entries.length - max}</span>}
    </span>
  );
}

const ago = (at: string) => {
  const s = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
};

/// The same call made again and again reads as one line: ×3.
function collapseRuns<T extends { status?: number; env: string; args: Record<string, unknown> }>(list: T[]): { h: T; n: number }[] {
  const out: { h: T; n: number }[] = [];
  for (const h of list) {
    const last = out[out.length - 1];
    if (last && last.h.status === h.status && last.h.env === h.env && JSON.stringify(last.h.args) === JSON.stringify(h.args)) last.n++;
    else out.push({ h, n: 1 });
  }
  return out;
}

/// A request's name as people read it: the spec's summary when short,
/// else its tool name in words — list_order_lines → "Order lines".
export function titleOf(t: ToolDef): string {
  const sum = t.origin?.summary?.trim();
  if (sum && sum.length <= 60 && sum !== t.name) return sum;
  const words = t.name.replace(/_\d+$/, '').split('_');
  const verb = words[0];
  const rest = words.slice(1).join(' ');
  const text = verb === 'list' && rest ? rest : verb === 'get' && rest ? `One ${rest}` : words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/// One colour per group, the same above (its card) and below (its chips),
/// so where a param lands is plain.
const TONE: Record<string, { card: string; label: string; dot: string; chip: string }> = {
  Needed: {
    card: 'border-amber-500/30 bg-amber-500/[0.06]',
    label: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
    chip: 'border-amber-500/50 hover:bg-amber-500/10',
  },
  'Filter by': {
    card: 'border-sky-500/30 bg-sky-500/[0.06]',
    label: 'text-sky-700 dark:text-sky-300',
    dot: 'bg-sky-500',
    chip: 'border-sky-500/50 hover:bg-sky-500/10',
  },
  Switches: {
    card: 'border-teal-500/30 bg-teal-500/[0.06]',
    label: 'text-teal-700 dark:text-teal-300',
    dot: 'bg-teal-500',
    chip: 'border-teal-500/50 hover:bg-teal-500/10',
  },
  Paging: {
    card: 'border-violet-500/30 bg-violet-500/[0.06]',
    label: 'text-violet-700 dark:text-violet-300',
    dot: 'bg-violet-500',
    chip: 'border-violet-500/50 hover:bg-violet-500/10',
  },
};

const PAGING = /^(page|page_?number|page_?size|per_?page|size|limit|offset|cursor|sort|sort_?by|order|order_?by|direction|start|count)$/i;

/// What a parameter holds, in a word — it picks the control.
function kindOf(prm: ParamDef): 'choice' | 'yes/no' | 'list' | 'number' | 'object' | 'id' | 'text' | 'file' {
  const t = Array.isArray(prm.schema.type) ? prm.schema.type[0] : prm.schema.type;
  if (prm.schema.format === 'binary' || t === 'file') return 'file';
  if (prm.schema.enum?.length) return 'choice';
  if (t === 'boolean') return 'yes/no';
  if (t === 'array') {
    const it = (prm.schema.items as { type?: string } | undefined)?.type;
    return it === 'object' ? 'object' : 'list';
  }
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'object' || prm.name === 'body') return 'object';
  return isIdLike(prm.name) ? 'id' : 'text';
}

/// The params as a query, not a form: what this request sends first, one
/// line each; everything else it takes as chips to add.
function ParamTable({
  tool,
  kinds,
  values,
  setValues,
  set,
  recent,
  onAllHistory,
}: {
  tool: ToolDef;
  kinds: ParamIn[];
  values: Values;
  setValues: (fn: (v: Values) => Values) => void;
  set: (fn: (t: ToolDef) => ToolDef) => void;
  /// Calls made before — the ones that worked are offered as samples.
  recent?: import('@shared/ipc').HistoryEntry[];
  onAllHistory?: () => void;
}): JSX.Element {
  const [pastOpen, setPastOpen] = useState(false);
  const [adding, setAdding] = useState<{ name: string; in: ParamIn } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { project, update, selectTool, say } = useStore();
  // Where each argument can come from: the request that answers with it.
  const forArgs = kinds.includes('path') || kinds.includes('query');
  const links = useMemo(() => (project && forArgs ? findLinks(project).filter((l) => l.to === tool.id) : []), [project, forArgs, tool.id]);
  const titleFor = (l?: Link) => {
    const t = l && project?.tools.find((x) => x.id === l.from);
    return t ? titleOf(t) : l?.fromName;
  };
  const connect = (l: Link) => {
    update((x) => applyLinks(x, [l]));
    setValues((v) => ({ ...v, [l.param]: `{{${l.param}}}` }));
    say(`${l.param} now comes from ${titleFor(l)}: the first one it returns. Agents are told the same.`);
  };
  const rows = tool.params.map((prm, i) => ({ prm, i })).filter(({ prm }) => kinds.includes(prm.in));
  const setParam = (i: number, patch: Partial<ParamDef>) =>
    set((t) => ({
      ...t,
      params: t.params.map((x, j) => (j === i ? { ...x, ...patch } : x)),
    }));
  const isOn = (prm: ParamDef) => prm.in === 'path' || prm.required || (values[prm.name] ?? '') !== '' || added.has(prm.name);
  const sending = rows.filter(({ prm }) => isOn(prm));
  const rest = rows.filter(({ prm }) => !isOn(prm) && (!q.trim() || prm.name.toLowerCase().includes(q.trim().toLowerCase())));
  /// The same groups above and below, so a param lands where you'd look.
  const groupsOf = (list: typeof rows): [string, typeof rows][] => [
    ['Needed', list.filter(({ prm }) => prm.in === 'path' || prm.required)],
    ['Filter by', list.filter(({ prm }) => prm.in !== 'path' && !prm.required && kindOf(prm) !== 'yes/no' && !PAGING.test(prm.name))],
    ['Switches', list.filter(({ prm }) => prm.in !== 'path' && !prm.required && kindOf(prm) === 'yes/no')],
    ['Paging', list.filter(({ prm }) => prm.in !== 'path' && !prm.required && kindOf(prm) !== 'yes/no' && PAGING.test(prm.name))],
  ];
  const groups = groupsOf(rest).slice(1);
  const noun = kinds.includes('body') ? 'field' : 'param';
  const add = (name: string) => {
    setAdded((s) => new Set(s).add(name));
    setFresh(name);
  };
  const drop = (name: string) => {
    setValues((v) => {
      const n = { ...v };
      delete n[name];
      return n;
    });
    setAdded((s) => {
      const n = new Set(s);
      n.delete(name);
      return n;
    });
  };

  // Distinct calls that worked, newest first, with how often each was made.
  const samples = (() => {
    const seen = new Map<string, { args: Record<string, unknown>; n: number; at: string; env: string }>();
    for (const h of recent ?? []) {
      if (!h.ok || !Object.keys(h.args).length) continue;
      // The same params with other values is the same call tweaked: keep the newest.
      const key = Object.keys(h.args).sort().join('|');
      const s = seen.get(key);
      if (s) s.n++;
      else seen.set(key, { args: h.args, n: 1, at: h.at, env: h.env });
    }
    const current = JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')));
    return [...seen.values()].filter((x) => JSON.stringify(Object.fromEntries(Object.entries(x.args).map(([k, v]) => [k, toText(v)]))) !== current).slice(0, 3);
  })();

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center gap-2.5">
          <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink">Sending</h3>
          <span className="min-w-0 truncate text-[12px] text-ink-faint" title={sending.length ? 'what goes on this request — the same an agent fills in' : undefined}>{sending.length ? 'what goes on this request — the same an agent fills in' : `nothing yet — every ${noun} here is optional`}</span>
          <span className="flex-1" />
          {samples.length > 0 && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setPastOpen((o) => !o)}
                onBlur={() => setTimeout(() => setPastOpen(false), 150)}
                aria-expanded={pastOpen}
                className={`inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] font-medium ${pastOpen ? 'border-accent bg-accent/10 text-ink' : 'border-rule-strong text-ink-muted hover:text-ink'}`}
              >
                <Icon name="history" size={12} /> Load a past call <span className="text-ink-faint">{samples.length}</span>
              </button>
              {pastOpen && (
                <div
                  className="absolute right-0 top-full z-30 mt-1 w-[440px] overflow-hidden rounded-lg border border-rule-strong bg-surface-elevated shadow-xl"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <div className="border-b border-rule px-3 py-2 text-[11px] text-ink-faint">Calls that worked — replaces what you’re sending</div>
                  {samples.map((x) => (
                    <button
                      key={JSON.stringify(x.args)}
                      type="button"
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/10"
                      onClick={() => {
                        setValues(() => Object.fromEntries(Object.entries(x.args).map(([k, v]) => [k, toText(v)])));
                        setPastOpen(false);
                      }}
                    >
                      <span className="shrink-0 font-mono text-[11.5px] font-semibold text-good">200</span>
                      <span className="min-w-0 flex-1">
                        <ArgChips args={x.args} max={4} />
                      </span>
                      <span className="shrink-0 text-[10.5px] text-ink-faint">
                        {x.n > 1 ? `${x.n}× · ` : ''}
                        {ago(x.at)}
                      </span>
                    </button>
                  ))}
                  {onAllHistory && (
                    <button
                      type="button"
                      className="w-full border-t border-rule px-3 py-2 text-left text-[11.5px] text-accent hover:bg-wash"
                      onClick={() => {
                        setPastOpen(false);
                        onAllHistory();
                      }}
                    >
                      All {recent?.length ?? 0} in History →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {sending.length > 0 && (
          <div className="space-y-2">
            {groupsOf(sending)
              .filter(([, list]) => list.length)
              .map(([label, list]) => {
                // Colour says something's missing; a Needed group that's all set goes quiet.
                const done = label === 'Needed' && list.every(({ prm }) => (values[prm.name] ?? '').trim());
                return (
                  <div key={label} className={`rounded-lg border ${done ? 'border-good/15 bg-good/[0.03]' : TONE[label].card}`}>
                    <div className={`flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] ${done ? 'text-ink-faint' : TONE[label].label}`}>
                      {done ? (
                        <svg
                          aria-hidden="true"
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-good"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : (
                        <span className={`h-1.5 w-1.5 rounded-full ${TONE[label].dot}`} />
                      )}
                      {label}
                      <span className="font-normal normal-case tracking-normal opacity-70">{list.length}</span>
                    </div>
                    {list.map(({ prm, i }) => (
                      <ParamRow
                        key={`${prm.in}:${prm.name}`}
                        toolId={tool.id}
                        prm={prm}
                        autoFocus={fresh === prm.name}
                        value={values[prm.name] ?? ''}
                        onValue={(v) => setValues((s) => ({ ...s, [prm.name]: v }))}
                        onChange={(patch) => setParam(i, patch)}
                        source={links.find((l) => l.param === prm.name)}
                        sourceTitle={titleFor(links.find((l) => l.param === prm.name))}
                        onConnect={connect}
                        onOpenSource={selectTool}
                        onUnsend={prm.in === 'path' || prm.required ? undefined : () => drop(prm.name)}
                        onDelete={
                          prm.in === 'path'
                            ? undefined
                            : () => {
                                drop(prm.name);
                                set((t) => ({
                                  ...t,
                                  params: t.params.filter((_, j) => j !== i),
                                }));
                              }
                        }
                      />
                    ))}
                  </div>
                );
              })}
          </div>
        )}
      </section>

      {(rows.length > sending.length || q) && (
        <section>
          <div className="mb-2 flex items-center gap-2.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink">Add</h3>
            <span className="text-[12px] text-ink-faint">{rows.length - sending.length} more it takes — click one to send it</span>
            <span className="flex-1" />
            {rows.length - sending.length > 8 && (
              <input className="field h-7 w-44 py-0 text-[12px]" placeholder={`Find a ${noun}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Find a ${noun}`} />
            )}
          </div>
          <div className="space-y-2">
            {groups
              .filter(([, list]) => list.length)
              .map(([label, list]) => (
                <div key={label} className="flex flex-wrap items-center gap-1.5">
                  <span className={`flex w-[72px] shrink-0 items-center gap-1.5 text-[11.5px] font-medium ${TONE[label].label}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${TONE[label].dot}`} />
                    {label}
                  </span>
                  {list.map(({ prm }) => (
                    <button
                      key={prm.name}
                      type="button"
                      title={prm.description ?? prm.schema.description ?? `${kindOf(prm)} · ${prm.in}`}
                      onClick={() => add(prm.name)}
                      className={`rounded-full border border-dashed bg-surface px-2.5 py-1 font-mono text-[11.5px] text-ink ${TONE[label].chip}`}
                    >
                      + {prm.name}
                    </button>
                  ))}
                </div>
              ))}
            {q && !rest.length && <p className="text-[12px] text-ink-faint">Nothing matches.</p>}
          </div>
        </section>
      )}

      {adding ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = adding.name.trim();
            if (!name || tool.params.some((x) => x.name === name)) return;
            set((t) => ({
              ...t,
              params: [
                ...t.params,
                {
                  name,
                  in: adding.in,
                  required: false,
                  schema: { type: 'string' },
                },
              ],
            }));
            add(name);
            setAdding(null);
          }}
        >
          <input className="field font-mono" autoFocus placeholder="name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          {!kinds.includes('body') && (
            <select className="field w-28" value={adding.in} onChange={(e) => setAdding({ ...adding, in: e.target.value as ParamIn })}>
              <option value="query">query</option>
              <option value="header">header</option>
            </select>
          )}
          <button className="btn shrink-0">Add</button>
          <button type="button" className="text-[12px] text-ink-muted" onClick={() => setAdding(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          className="text-[12px] text-ink-muted hover:text-accent"
          onClick={() =>
            setAdding({
              name: '',
              in: kinds.includes('body') ? 'body' : 'query',
            })
          }
        >
          + A {noun} this request doesn’t list yet
        </button>
      )}
    </div>
  );
}

/// A secret typed into a request: sent from there, it's saved in the project
/// file for anyone with it to read. One click moves it to the keychain and
/// leaves `${NAME}` in its place.
function KeepSecret({ name, value, onValue }: { name: string; value: string; onValue: (v: string) => void }): JSX.Element {
  const { project, path, say, refreshSecrets } = useStore();
  const varName = secretVarName(varPrefix(project!.name), name);
  const keep = async () => {
    const r = await window.overapi.invoke('secrets:set', path!, varName, value);
    if (!r.ok) return say(r.error ?? 'Not saved.', true);
    onValue(`\${${varName}}`);
    await refreshSecrets();
    say(`Kept in the keychain as ${varName}. The request sends it; the project only names it.`);
  };
  return (
    <div className="flex items-center gap-2 px-1 text-[11.5px]">
      <span className="min-w-0 flex-1 text-warn">Plain text: once sent, it’s saved in overapi.json for anyone with the project to read.</span>
      <button type="button" className="shrink-0 font-medium text-accent hover:underline" onClick={() => void keep()}>
        Keep it in the keychain
      </button>
    </div>
  );
}

/// The request as sent, as code to run elsewhere: cURL in one click, or
/// fetch, Python or HTTPie. Secrets stay •••.
function CopyAs({ request }: { request: NonNullable<TryResponse['request']> }): JSX.Element {
  const { say } = useStore();
  const [open, setOpen] = useState(false);
  const copy = async (id: (typeof SNIPPETS)[number]['id']) => {
    const s = SNIPPETS.find((x) => x.id === id)!;
    await window.overapi.invoke('clipboard:write', id === 'curl' && !request.parts ? toCurl(request) : s.make(request));
    say(`Copied as ${s.label} — secrets are •••.`);
    setOpen(false);
  };
  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="inline-flex">
        <button className="btn rounded-r-none" title="Copy this request as a curl command (secrets shown as •••)" onClick={() => void copy('curl')}>
          <Icon name="copy" size={12} /> cURL
        </button>
        <button className="btn rounded-l-none border-l-0 px-1.5" aria-label="Copy as other code" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-rule-strong bg-surface-elevated py-1 shadow-xl">
          <div className="px-3 pb-1 pt-0.5 text-[10.5px] text-ink-faint">Copy as</div>
          {SNIPPETS.map((s) => (
            <button key={s.id} type="button" className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-wash" onClick={() => void copy(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// A file to upload: picked here, sent as `@/path` (read when sent). Agents
/// send the content instead — see core/http.ts.
function FilePick({ value, onValue, autoFocus }: { value: string; onValue: (v: string) => void; autoFocus?: boolean }): JSX.Element {
  const file = value.startsWith('@') ? value.slice(1) : '';
  const pick = async () => {
    const f = await window.overapi.invoke('dialog:pickFile', 'File to upload');
    if (f) onValue(`@${f}`);
  };
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" autoFocus={autoFocus} className="btn h-[30px] shrink-0" onClick={() => void pick()}>
        {file ? 'Change…' : 'Choose file…'}
      </button>
      {file ? (
        <span className="min-w-0 truncate font-mono text-[12px] text-ink" title={file}>
          {file.split('/').pop()}
          <span className="ml-1.5 text-ink-faint">
            {file
              .split('/')
              .slice(0, -1)
              .join('/')
              .replace(/^\/Users\/[^/]+/, '~')}
          </span>
        </span>
      ) : value ? (
        <span className="min-w-0 truncate text-[12px] text-ink-muted">content given ({value.length} characters)</span>
      ) : (
        <span className="text-[12px] text-ink-faint">no file</span>
      )}
      {value && (
        <button type="button" className="ml-auto shrink-0 text-[11px] text-ink-faint hover:text-ink" onClick={() => onValue('')}>
          Clear
        </button>
      )}
    </div>
  );
}

/// any · true · false, or a few named choices — one click each.
function Segmented({ options, value, onValue }: { options: { v: string; label: string }[]; value: string; onValue: (v: string) => void }): JSX.Element {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg border border-rule-strong bg-canvas p-0.5 text-[12px]">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onValue(o.v)}
          className={`rounded-md px-3 py-1 font-mono ${value === o.v ? 'bg-wash-strong font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/// A list as chips: type and ↵ (or a comma), paste many at once. Kept as
/// a JSON array, which is what the request sends. A list of ids offers the
/// ones seen in earlier responses, by name.
function Chips({ value, onValue, autoFocus, toolId, param }: { value: string; onValue: (v: string) => void; autoFocus?: boolean; toolId?: string; param?: string }): JSX.Element {
  const { path, project, env } = useStore();
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<SeenSuggestions | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const items: string[] = (() => {
    if (!value.trim()) return [];
    try {
      const v = JSON.parse(value);
      return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [String(v)];
    } catch {
      return value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }
  })();
  const save = (list: string[]) => onValue(list.length ? JSON.stringify(list) : '');
  const push = (text: string) => {
    const more = text
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (more.length) save([...items, ...more.filter((m) => !items.includes(m))]);
    setDraft('');
  };
  const load = async () => {
    if (!toolId || !param || !path || !project || !env) return;
    const r = await window.overapi.invoke('seen:suggest', path, project, toolId, param, env);
    setSeen(r);
    setLabels((l) => ({
      ...l,
      ...Object.fromEntries(r.values.filter((x) => x.label).map((x) => [String(x.v), x.label!])),
    }));
  };
  const q = draft.trim().toLowerCase();
  const offers = (seen?.values ?? []).filter((x) => !items.includes(String(x.v)) && (!q || String(x.v).toLowerCase().includes(q) || x.label?.toLowerCase().includes(q))).slice(0, 30);
  return (
    <div className="relative">
      <div className="flex min-h-[30px] flex-wrap items-center gap-1.5 rounded-md border border-rule-strong bg-canvas px-1.5 py-1 focus-within:border-accent/60">
        {items.map((x) => (
          <span key={x} className="inline-flex max-w-[260px] items-center gap-1 rounded bg-wash-strong px-2 py-0.5 text-[11.5px]" title={x}>
            {labels[x] ? <span className="truncate">{labels[x]}</span> : <span className="truncate font-mono">{x}</span>}
            <button type="button" className="text-ink-faint hover:text-bad" aria-label={`Remove ${labels[x] ?? x}`} onClick={() => save(items.filter((y) => y !== x))}>
              ×
            </button>
          </span>
        ))}
        <input
          autoFocus={autoFocus}
          className="min-w-[90px] flex-1 bg-transparent px-1 font-mono text-[12px] outline-none placeholder:text-ink-faint"
          placeholder={items.length ? '' : 'type, paste, ↵'}
          value={draft}
          onFocus={() => {
            setOpen(true);
            void load();
          }}
          onChange={(e) => (e.target.value.endsWith(',') ? push(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && (draft.trim() || offers.length)) {
              e.preventDefault();
              if (draft.trim() && !offers.some((o) => o.label?.toLowerCase() === q)) push(draft);
              else if (offers[0]) {
                save([...items, String(offers[0].v)]);
                setDraft('');
              }
            } else if (e.key === 'Backspace' && !draft && items.length) save(items.slice(0, -1));
            else if (e.key === 'Escape') setOpen(false);
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[,\n]/.test(t)) {
              e.preventDefault();
              push(t);
            }
          }}
          onBlur={() => {
            setTimeout(() => setOpen(false), 150);
            if (draft.trim() && !offers.length) push(draft);
          }}
        />
      </div>
      {open && offers.length > 0 && (
        <ul
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[220px] overflow-y-auto rounded-lg border border-rule-strong bg-surface-elevated py-1 shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
        >
          <li className="px-2.5 pb-1 pt-0.5 text-[10.5px] text-ink-faint">Seen in earlier responses on {env} — click to add</li>
          {offers.map((x) => (
            <li key={String(x.v)}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] hover:bg-wash"
                onClick={() => {
                  save([...items, String(x.v)]);
                  setDraft('');
                }}
              >
                {x.label && <span className="max-w-[45%] shrink-0 truncate">{x.label}</span>}
                <span className={`min-w-0 truncate font-mono text-[11.5px] ${x.label ? 'text-ink-faint' : ''}`}>{String(x.v)}</span>
                <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-ink-faint">{x.from}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/// An object (or a list of them) whose fields are known: a box per field,
/// kept as JSON. A list gets one row per item and "+ another".
function ObjectFields({ props, many, value, onValue }: { props: Record<string, import('@shared/project').JsonSchema>; many: boolean; value: string; onValue: (v: string) => void }): JSX.Element {
  const keys = Object.keys(props).slice(0, 8);
  const parsed: Record<string, unknown>[] = (() => {
    try {
      const v = JSON.parse(value || (many ? '[]' : '{}'));
      return many ? (Array.isArray(v) ? v : []) : [v && typeof v === 'object' ? v : {}];
    } catch {
      return many ? [] : [{}];
    }
  })();
  const rowsOf = parsed.length ? parsed : [{}];
  const write = (list: Record<string, unknown>[]) => {
    const clean = list.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined))).filter((o) => Object.keys(o).length);
    onValue(many ? (clean.length ? JSON.stringify(clean) : '') : clean[0] ? JSON.stringify(clean[0]) : '');
  };
  const typed = (k: string, raw: string): unknown => {
    const t = props[k]?.type;
    if ((t === 'integer' || t === 'number') && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
    if (t === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
    return raw;
  };
  return (
    <div className="space-y-1.5">
      {rowsOf.map((row, r) => (
        <div key={r} className="flex flex-wrap items-center gap-1.5 rounded-md border border-rule-strong bg-canvas p-1.5">
          {keys.map((k) => (
            <label key={k} className="flex min-w-[150px] flex-1 items-center gap-1.5 rounded bg-wash px-2 py-1" title={props[k]?.description}>
              <span className="shrink-0 font-mono text-[11px] text-accent">{k}</span>
              <input
                className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
                value={row[k] === undefined ? '' : typeof row[k] === 'string' ? (row[k] as string) : JSON.stringify(row[k])}
                placeholder={(props[k]?.enum as unknown[] | undefined)?.slice(0, 3).join(' | ') ?? String(props[k]?.type ?? '')}
                onChange={(e) => write(rowsOf.map((o, j) => (j === r ? { ...o, [k]: typed(k, e.target.value) } : o)))}
              />
            </label>
          ))}
          {many && rowsOf.length > 1 && (
            <button type="button" className="px-1 text-ink-faint hover:text-bad" aria-label="Remove this one" onClick={() => write(rowsOf.filter((_, j) => j !== r))}>
              ×
            </button>
          )}
        </div>
      ))}
      {many && (
        <button type="button" className="text-[11.5px] text-ink-muted hover:text-accent" onClick={() => onValue(JSON.stringify([...rowsOf, {}]))}>
          + another
        </button>
      )}
    </div>
  );
}

/// A number with − and + (and ↑↓).
function Stepper({ value, onValue, autoFocus }: { value: string; onValue: (v: string) => void; autoFocus?: boolean }): JSX.Element {
  const n = Number(value);
  const step = (d: number) => onValue(String((value.trim() === '' || Number.isNaN(n) ? 0 : n) + d));
  return (
    <div className="inline-flex h-[30px] items-stretch overflow-hidden rounded-md border border-rule-strong bg-canvas font-mono text-[12.5px] focus-within:border-accent/60">
      <button type="button" className="px-2.5 text-ink-faint hover:bg-wash hover:text-ink" aria-label="One less" onClick={() => step(-1)}>
        −
      </button>
      <input
        autoFocus={autoFocus}
        className="w-20 border-x border-rule bg-transparent text-center outline-none"
        value={value}
        inputMode="numeric"
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(-1);
          }
        }}
      />
      <button type="button" className="px-2.5 text-ink-faint hover:bg-wash hover:text-ink" aria-label="One more" onClick={() => step(1)}>
        +
      </button>
    </div>
  );
}

/// One line of what's sent: the name, the right control for its kind, and
/// — while you're in it — what it means and its settings.
/// What a {{variable}} in a param stands for right now, and where it came
/// from — so a value found by an earlier request is visible, not magic.
function KeptValue({ value }: { value: string }): JSX.Element | null {
  const k = useKept(value);
  if (!k || k.resolved === undefined) return null;
  const { kept, fromEnv, envName } = k;
  const ago = keptAgo;
  return (
    <div className="flex items-center gap-1.5 px-1 text-[11.5px]">
      <span className="text-good">=</span>
      <span className="max-w-[260px] truncate font-mono text-good" title={kept?.value ?? fromEnv}>
        {kept?.value ?? fromEnv}
      </span>
      <span className="text-ink-faint">· {kept ? `from ${kept.from ?? 'an earlier response'} · ${ago(kept.at)}` : `from the ${envName} environment`}</span>
    </div>
  );
}

function ParamRow({
  toolId,
  prm,
  value,
  onValue,
  onChange,
  onUnsend,
  onDelete,
  autoFocus,
  source,
  sourceTitle,
  onConnect,
  onOpenSource,
}: {
  toolId?: string;
  prm: ParamDef;
  value: string;
  onValue: (v: string) => void;
  onChange: (p: Partial<ParamDef>) => void;
  onUnsend?: () => void;
  onDelete?: () => void;
  autoFocus?: boolean;
  /// The request that gives this value, if one does.
  source?: Link;
  sourceTitle?: string;
  onConnect?: (l: Link) => void;
  onOpenSource?: (toolId: string) => void;
}): JSX.Element {
  const t = Array.isArray(prm.schema.type) ? prm.schema.type[0] : prm.schema.type;
  const kind = kindOf(prm);
  const optional = prm.in !== 'path' && !prm.required;
  const linked = !!source && !!toolId && (kind === 'id' || kind === 'text');
  const secretLike = isSecretName(prm.name) && (kind === 'id' || kind === 'text');
  const about = prm.description ?? prm.schema.description;
  const [open, setOpen] = useState(false);
  const control = (() => {
    if (kind === 'choice') {
      const opts = (prm.schema.enum ?? []).map((v) => ({
        v: String(v),
        label: String(v),
      }));
      if (opts.length <= 5) return <Segmented options={[...(optional ? [{ v: '', label: 'any' }] : []), ...opts]} value={value} onValue={onValue} />;
      return (
        <select autoFocus={autoFocus} className="field py-1 text-[12px]" value={value} onChange={(e) => onValue(e.target.value)}>
          <option value="">{optional ? 'any' : 'pick one'}</option>
          {opts.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'yes/no')
      return <Segmented options={[...(optional ? [{ v: '', label: 'any' }] : []), { v: 'true', label: 'true' }, { v: 'false', label: 'false' }]} value={value} onValue={onValue} />;
    if (kind === 'list') return <Chips value={value} onValue={onValue} autoFocus={autoFocus} toolId={toolId} param={prm.name} />;
    if (kind === 'number') return <Stepper value={value} onValue={onValue} autoFocus={autoFocus} />;
    if (kind === 'file') return <FilePick value={value} onValue={onValue} autoFocus={autoFocus} />;
    if (kind === 'object')
      return <textarea autoFocus={autoFocus} className="field min-h-[54px] py-1 font-mono text-[11.5px]" value={value} onChange={(e) => onValue(e.target.value)} placeholder="JSON" />;
    return toolId ? (
      <SeenInput
        toolId={toolId}
        param={prm.name}
        value={value}
        onValue={onValue}
        placeholder={secretLike ? 'value or ${SECRET}' : prm.required || prm.in === 'path' ? 'value or {{variable}}' : 'value'}
        autoFocus={autoFocus}
        secret={secretLike}
      />
    ) : (
      <input autoFocus={autoFocus} className="field py-1 font-mono text-[12px]" value={value} onChange={(e) => onValue(e.target.value)} placeholder="value or {{variable}}" />
    );
  })();
  return (
    <div
      className={`group grid grid-cols-[minmax(130px,180px)_minmax(0,1fr)_44px] items-start gap-x-3 border-b border-rule px-3 py-[7px] last:rounded-b-lg last:border-b-0 focus-within:bg-accent/[0.035] ${open ? 'bg-accent/[0.04]' : ''}`}
    >
      <div className="min-w-0 pt-[5px]">
        <button
          type="button"
          className="truncate font-mono text-[12.5px] text-ink hover:underline hover:decoration-dotted"
          title={about ? `${about}\n\nClick for details` : 'Details'}
          onClick={() => setOpen((o) => !o)}
        >
          {(prm.in === 'path' || prm.required) && !value.trim() && <span className="mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-warn" title="Needs a value" />}
          {prm.name}
        </button>
        <span className="ml-1.5 text-[10.5px] text-ink-faint">
          {kind}
          {prm.in === 'path' ? ' · in path' : prm.in === 'header' ? ' · header' : ''}
          {prm.required && prm.in !== 'path' ? ' · required' : ''}
        </span>
      </div>
      <div className="min-w-0 max-w-[620px] space-y-1.5">
        {linked ? (
          <ValuePicker
            toolId={toolId!}
            param={prm.name}
            value={value}
            onValue={onValue}
            link={source!}
            sourceTitle={sourceTitle ?? source!.fromName}
            onConnect={onConnect}
            onOpenSource={onOpenSource}
            autoFocus={autoFocus}
          />
        ) : (
          <>
            {control}
            {secretLike && isLiteral(value) && <KeepSecret name={prm.name} value={value} onValue={onValue} />}
            <KeptValue value={value} />
          </>
        )}
        {open && (
          <div className="space-y-1 pb-0.5">
            <input
              className="w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[11.5px] text-ink-muted outline-none placeholder:text-ink-faint/70 hover:border-rule focus:border-rule focus:bg-surface"
              placeholder="+ What it means — agents read this"
              value={prm.description ?? ''}
              onChange={(e) => onChange({ description: e.target.value || undefined })}
              aria-label={`What ${prm.name} means, for agents`}
            />
            <div className="flex flex-wrap items-center gap-x-2 px-1.5 text-[10.5px] text-ink-faint">
              <select
                className="bg-transparent outline-none hover:text-ink"
                value={kind === 'file' ? 'file' : (t ?? '')}
                onChange={(e) =>
                  onChange({
                    // A file is a binary string, as OpenAPI writes it.
                    schema:
                      e.target.value === 'file'
                        ? { ...prm.schema, type: 'string', format: 'binary' }
                        : { ...prm.schema, type: e.target.value || undefined, format: prm.schema.format === 'binary' ? undefined : prm.schema.format },
                  })
                }
                aria-label="Type"
              >
                {['string', 'integer', 'number', 'boolean', 'array', 'object', ...(prm.in === 'body' ? ['file'] : [])].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
                <option value="">any</option>
              </select>
              <span>·</span>
              <span>{prm.in}</span>
              {prm.in !== 'path' && (
                <>
                  <span>·</span>
                  <button type="button" className={prm.required ? 'text-accent hover:underline' : 'hover:text-ink hover:underline'} onClick={() => onChange({ required: !prm.required })}>
                    {prm.required ? 'required' : 'optional'}
                  </button>
                </>
              )}
              {onDelete && (
                <>
                  <span className="flex-1" />
                  <button type="button" className="hover:text-bad hover:underline" onClick={onDelete} title="Take it out of this request's definition — agents won't see it either">
                    Delete {prm.name}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-1 pt-[3px]">
        <button
          type="button"
          className={`flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-wash-strong hover:text-ink ${open ? 'text-ink' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
          title={open ? 'Hide details' : 'What it means, type, required…'}
          aria-label={`Details of ${prm.name}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="chevron" size={11} className={open ? 'rotate-90' : ''} />
        </button>
        {onUnsend ? (
          <button
            className="flex h-5 w-5 items-center justify-center rounded text-[15px] leading-none text-ink-faint hover:bg-wash-strong hover:text-ink"
            title="Stop sending it"
            aria-label={`Stop sending ${prm.name}`}
            onClick={onUnsend}
          >
            ×
          </button>
        ) : (
          <span className="w-5" />
        )}
      </div>
    </div>
  );
}

function BodyEditor({ tool, values, setValues, set }: { tool: ToolDef; values: Values; setValues: (fn: (v: Values) => Values) => void; set: (fn: (t: ToolDef) => ToolDef) => void }): JSX.Element {
  const modes: { id: BodyMode; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'json-fields', label: 'JSON fields' },
    { id: 'json-whole', label: 'Raw JSON' },
    { id: 'form', label: 'Form' },
    { id: 'multipart', label: 'Multipart' },
    { id: 'graphql', label: 'GraphQL' },
  ];
  const changeMode = (m: BodyMode) =>
    set((t) => {
      let params = t.params;
      if (m === 'none') params = params.filter((p) => p.in !== 'body');
      if (m === 'json-whole')
        params = [
          ...params.filter((p) => p.in !== 'body'),
          {
            name: 'body',
            in: 'body',
            required: true,
            description: 'The JSON request body.',
            schema: {},
          },
        ];
      if ((m === 'json-fields' || m === 'form' || m === 'multipart' || m === 'graphql') && t.bodyMode === 'json-whole') params = params.filter((p) => p.in !== 'body');
      // GraphQL goes as a POST with a query; its body fields are the variables.
      if (m === 'graphql') return { ...t, bodyMode: m, params, method: 'POST', graphql: t.graphql ?? { query: 'query {\n  \n}' } };
      return { ...t, bodyMode: m, params };
    });
  if (tool.bodyMode === 'soap' && tool.soap) {
    const s = tool.soap;
    return (
      <div>
        <div className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-wash px-3 py-2.5 text-[12px]">
          <span className="text-ink-faint">SOAP {s.version}</span>
          <span>
            operation <b className="font-mono">{s.operation}</b>
          </span>
          {s.action && (
            <>
              <span className="text-ink-faint">SOAPAction</span>
              <span className="truncate font-mono">{s.action}</span>
            </>
          )}
          <span className="text-ink-faint">Namespace</span>
          <span className="truncate font-mono">{s.namespace || '(none)'}</span>
        </div>
        <p className="mb-2 text-[11px] text-ink-faint">
          Each field is an element of the operation; overapi builds the envelope (and the WS-Security header, if the environment signs in that way). Agents send and get JSON.
        </p>
        <ParamTable tool={tool} kinds={['body']} values={values} setValues={setValues} set={set} />
      </div>
    );
  }
  return (
    <div>
      <div className="mb-3 flex gap-1">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => changeMode(m.id)}
            className={`rounded-md px-2.5 py-1 text-[12px] ${tool.bodyMode === m.id ? 'bg-accent/15 font-semibold text-ink' : 'text-ink-muted hover:bg-wash-strong'}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {tool.bodyMode === 'none' ? (
        <p className="text-[12px] text-ink-faint">This request sends no body.</p>
      ) : (
        <>
          {tool.bodyMode === 'graphql' && (
            <div className="mb-3 space-y-1.5">
              <label className="label" htmlFor="gql-query">
                Query
              </label>
              <textarea
                id="gql-query"
                spellCheck={false}
                className="field min-h-[160px] py-2 font-mono text-[12px] leading-relaxed"
                value={tool.graphql?.query ?? ''}
                onChange={(e) => set((t) => ({ ...t, graphql: { ...t.graphql, query: e.target.value } }))}
              />
              <input
                className="field w-64 font-mono text-[12px]"
                placeholder="operation name (optional)"
                value={tool.graphql?.operationName ?? ''}
                onChange={(e) => set((t) => ({ ...t, graphql: { query: t.graphql?.query ?? '', operationName: e.target.value || undefined } }))}
                aria-label="Operation name"
              />
            </div>
          )}
          <p className="mb-2 text-[11px] text-ink-faint">
            {tool.bodyMode === 'json-fields'
              ? 'Each field is its own argument for the agent; they are sent together as one JSON object.'
              : tool.bodyMode === 'form'
                ? 'Each field is its own argument; sent form-encoded.'
                : tool.bodyMode === 'multipart'
                  ? 'Each field is its own argument; sent as multipart/form-data. A field of type file uploads a file — agents send its content, never a path.'
                  : tool.bodyMode === 'graphql'
                    ? 'Each field below is a variable of the query ($name), and an argument for the agent.'
                    : 'The agent passes the whole JSON body as one argument.'}
          </p>
          <ParamTable tool={tool} kinds={['body']} values={values} setValues={setValues} set={set} />
        </>
      )}
    </div>
  );
}

function AsTool({ tool, set, issues }: { tool: ToolDef; set: (fn: (t: ToolDef) => ToolDef) => void; issues: string[] }): JSX.Element {
  const { project } = useStore();
  const nameOk = VALID_NAME.test(tool.name);
  const clash = project!.tools.some((t) => t.id !== tool.id && t.enabled && t.name === tool.name);
  const groups = [...new Set(project!.tools.map(groupOf))];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-wash px-3 py-2">
        <Toggle on={tool.enabled} onChange={(v) => set((t) => ({ ...t, enabled: v }))} label="Offered to agents" />
        <span className="flex-1 text-[12px]">{tool.enabled ? 'A tool — agents can call it' : 'A request only — agents don’t see it'}</span>
        <button className="btn" onClick={() => useStore.getState().setTab('agent')} title="See this tool exactly as an agent receives it">
          See it as an agent →
        </button>
      </div>
      <div className="grid grid-cols-[1fr_170px_170px] gap-3">
        <div>
          <label className="label">Tool name</label>
          <input className={`field font-mono ${nameOk && !clash ? '' : 'border-bad'}`} value={tool.name} onChange={(e) => set((t) => ({ ...t, name: e.target.value }))} />
          {!nameOk && <div className="mt-1 text-[11px] text-bad">Letters, digits, _ and - only; 64 at most.</div>}
          {clash && <div className="mt-1 text-[11px] text-bad">Another tool has this name.</div>}
        </div>
        <div>
          <label className="label">Safety</label>
          <select className="field" value={tool.safety} onChange={(e) => set((t) => ({ ...t, safety: e.target.value as Safety }))}>
            {(['read', 'write', 'destructive'] as Safety[]).map((s) => (
              <option key={s} value={s}>
                {SAFETY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Group</label>
          <input className="field" list="overapi-groups" value={tool.group ?? groupOf(tool)} onChange={(e) => set((t) => ({ ...t, group: e.target.value || undefined }))} />
          <datalist id="overapi-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      </div>
      <p className="-mt-2 text-[11px] text-ink-faint">
        {tool.safety === 'read'
          ? 'Offered in every environment.'
          : tool.safety === 'write'
            ? 'Offered only where the environment allows writes.'
            : 'Offered only where writes are allowed, and every call must pass confirm: true. Clients that ask before destructive tools will ask.'}
      </p>
      <div>
        <label className="label">Description — how the agent decides to call it</label>
        <textarea
          className="field min-h-[120px] leading-relaxed"
          value={tool.description}
          onChange={(e) => set((t) => ({ ...t, description: e.target.value }))}
          placeholder="What it does, what it returns, and when to use it rather than a similar request."
        />
        <div className="mt-1 text-right text-[11px] text-ink-faint">{tool.description.length} characters</div>
      </div>
      <div className="w-48">
        <label className="label">Response limit (characters)</label>
        <input
          className="field"
          type="number"
          min={500}
          step={1000}
          value={tool.responseLimit ?? DEFAULT_RESPONSE_LIMIT}
          onChange={(e) =>
            set((t) => ({
              ...t,
              responseLimit: Number(e.target.value) || undefined,
            }))
          }
        />
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-warn/10 p-3 text-[12px]">
          {issues.map((m) => (
            <li key={m}>• {m}</li>
          ))}
        </ul>
      )}
      {tool.origin?.tags?.includes('drafted from docs') && (
        <p className="rounded-lg bg-cyan-500/10 p-3 text-[12px] text-cyan-800 dark:text-cyan-200">
          Drafted by a model from documentation. Send it once to confirm the path, arguments and response are real.
        </p>
      )}
    </div>
  );
}

/// Adds this request — with the values it was just sent with, and the
/// shape of what came back — as the next step of a test, wiring its
/// arguments to earlier steps where the names fit.
function AddToTest({ tool, body }: { tool: ToolDef; body?: string }): JSX.Element {
  const { project, env, update, say } = useStore();
  const [open, setOpen] = useState(false);
  const scenarios = project!.scenarios ?? [];
  const add = (scenarioId: string | null) => {
    setOpen(false);
    let response: unknown;
    try {
      response = body ? JSON.parse(body) : undefined;
    } catch {
      response = undefined;
    }
    const sc = scenarios.find((s) => s.id === scenarioId) ?? emptyScenario(`${tool.name} flow`, env);
    const { scenario, wired } = addStep(project!, sc, tool, { response });
    update((x) => ({
      ...x,
      scenarios: scenarioId ? (x.scenarios ?? []).map((s) => (s.id === scenarioId ? scenario : s)) : [...(x.scenarios ?? []), scenario],
    }));
    say(`Added ${tool.name} as step ${scenario.steps.length} of “${scenario.name}”${wired.length ? ` — ${wired.join(', ')}` : ''}.`);
  };
  return (
    <div className="relative">
      <button className="btn" title="Add this request as the next step of a test" onClick={() => setOpen((o) => !o)}>
        <Icon name="check" size={12} /> Add to test
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-lg border border-rule bg-surface py-1 text-[12px] shadow-lg">
            {scenarios.map((s) => (
              <button key={s.id} className="block w-full truncate px-3 py-1.5 text-left hover:bg-wash" onClick={() => add(s.id)}>
                {s.name} <span className="text-ink-faint">· {s.steps.length} steps</span>
              </button>
            ))}
            <button className="block w-full border-t border-rule px-3 py-1.5 text-left text-accent hover:bg-wash" onClick={() => add(null)}>
              + New test starting here
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/// What actually went out — the real address with every {{value}} filled
/// in — at the top of the response, folded to one line.
function SentLine({
  req,
}: {
  req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
}): JSX.Element {
  const say = useStore((s) => s.say);
  const heads = Object.entries(req.headers);
  return (
    <details className="group rounded-lg border border-rule bg-wash text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5">
        <Icon name="chevron" size={11} className="shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
        <span className="text-[11px] text-ink-faint">Sent</span>
        <Method method={req.method as HttpMethod} />
        <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px]" title={req.url}>
          {req.url}
        </span>
        <button
          className="shrink-0 text-[11px] text-ink-faint hover:text-ink"
          title="Copy the address"
          onClick={async (e) => {
            e.preventDefault();
            await window.overapi.invoke('clipboard:write', req.url);
            say('Copied the address.');
          }}
        >
          <Icon name="copy" size={12} />
        </button>
      </summary>
      <div className="space-y-2 border-t border-rule px-3 py-2">
        <div className="font-mono text-[11px] leading-relaxed">
          {heads.map(([k, v]) => (
            <div key={k} className="break-all">
              <span className="text-sky-700 dark:text-sky-300">{k}</span>
              <span className="text-ink-faint">: </span>
              <span className="text-ink-muted">{v}</span>
            </div>
          ))}
          {!heads.length && <span className="text-ink-faint">no headers</span>}
        </div>
        {req.body && (
          <div>
            <div className="label">Body</div>
            <JsonView text={req.body} compact />
          </div>
        )}
      </div>
    </details>
  );
}
