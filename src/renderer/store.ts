import { create } from 'zustand';
import type { BrowserVia, RecordMode } from '@shared/recording';
import type { AppInfo, HistoryEntry, RuntimeVar, ProjectRef, SecretSource, Settings, SystemRef } from '@shared/ipc';
import { secretNames, varPrefix, type Project, type ToolDef } from '@shared/project';
import { parseCurl, toolFromCurl } from '@shared/curl';
import { uniqueNames } from '@shared/naming';

/// The pages. overview/agent/publish are the old names for the MCP page's
/// three views; setTab still takes them, so links into them keep working.
export type Tab = 'requests' | 'envs' | 'traffic' | 'tests' | 'mcp' | 'overview' | 'agent' | 'publish';
export type McpTab = 'tools' | 'chains' | 'test' | 'security' | 'install';
const LEGACY: Record<string, McpTab> = { overview: 'tools', agent: 'test', publish: 'install' };
export type Sheet = null | { kind: 'new'; mode: NewMode; prefill?: string } | { kind: 'delete'; path: string; title: string } | { kind: 'settings' } | { kind: 'curl' } | { kind: 'request' } | { kind: 'publish' } | { kind: 'agentready' } | { kind: 'system'; members?: string[] };
export type NewMode = 'start' | 'import' | 'curl' | 'docs';

interface State {
  booted: boolean;
  /// The recorder page is showing (no API open while it is).
  recording: boolean;
  /// The recorder itself, wherever you are: running, where to, how many calls.
  recorder: { running: boolean; port?: number; target?: string; count: number; projectPath?: string; mode: RecordMode; site?: string; via?: BrowserVia };
  /// Re-reads the open API from its file (after main changed it).
  reload: () => Promise<void>;
  openRecorder: () => void;
  /// Forgets the calls recorded so far; the recording goes on.
  clearRecording: () => Promise<void>;
  bootError?: string;
  info?: AppInfo;
  settings?: Settings;
  projects: ProjectRef[];
  /// Groups of APIs that belong together (shared/system.ts).
  systems: SystemRef[];
  /// The system whose page is open, instead of an API.
  system?: string;
  path?: string;
  project?: Project;
  loadError?: string;
  tab: Tab;
  mcpTab: McpTab;
  toolId?: string;
  env?: string;
  save: 'saved' | 'pending' | 'error';
  saveError?: string;
  toast?: { text: string; bad?: boolean };
  secrets: Record<string, SecretSource>;
  history: HistoryEntry[];
  /// Values kept from responses this session ({{token}} after a login).
  runtime: RuntimeVar[];
  sheet: Sheet;

  boot: () => Promise<void>;
  refreshInfo: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshSystems: () => Promise<void>;
  openSystem: (path: string) => void;
  /// New title — and internal name; installs move with it.
  renameProject: (path: string, title: string) => Promise<boolean>;
  open: (path: string, tab?: Tab) => Promise<void>;
  close: () => void;
  update: (fn: (p: Project) => Project) => void;
  setTab: (tab: Tab) => void;
  setMcpTab: (t: McpTab) => void;
  selectTool: (id: string | undefined) => void;
  setEnv: (name: string) => void;
  refreshSecrets: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  setRuntime: (name: string, value: string | null) => Promise<void>;
  say: (text: string, bad?: boolean) => void;
  openSheet: (s: Sheet) => void;
  addTool: (tool: ToolDef) => void;
  addCurl: (text: string) => Promise<boolean>;
}

function landing(tab: Tab): { tab: Tab; mcpTab?: McpTab } {
  return LEGACY[tab] ? { tab: 'mcp', mcpTab: LEGACY[tab] } : { tab };
}

function withTimeout<T>(p: Promise<T>, what: string, ms = 8000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`No answer from the app for ${what} after ${ms / 1000} s.`)), ms))]);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let recorderSubscribed = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const envKey = (p: string) => `overapi:env:${p}`;
function rememberedEnv(p: string): string | undefined {
  try {
    return localStorage.getItem(envKey(p)) ?? undefined;
  } catch {
    return undefined;
  }
}

export const useStore = create<State>((set, get) => ({
  booted: false,
  recording: false,
  recorder: { running: false, count: 0, mode: 'proxy' },
  openRecorder: () => set({ recording: true, system: undefined }),
  clearRecording: async () => {
    await window.overapi.invoke('recorder:clear');
    set((s) => ({ recorder: { ...s.recorder, count: 0 } }));
  },
  projects: [],
  systems: [],
  tab: 'requests',
  mcpTab: 'tools',
  save: 'saved',
  secrets: {},
  history: [],
  runtime: [],
  sheet: null,

  // The splash stays up until this has run, and for a beat at least, so
  // it reads as an opening rather than a flicker.
  boot: async () => {
    const started = Date.now();
    try {
      const [info, settings, projects] = await Promise.all([
        withTimeout(window.overapi.invoke('app:info'), 'app:info'),
        withTimeout(window.overapi.invoke('settings:get'), 'settings:get'),
        withTimeout(window.overapi.invoke('projects:list'), 'projects:list'),
      ]);
      set({ info, settings, projects });
      void get().refreshSystems();
      // The recorder keeps running while you work elsewhere; keep its state
      // here so the sidebar can say so on every page.
      void window.overapi.invoke('recorder:state').then((r) => set({ recorder: { running: r.running, port: r.port, target: r.target, count: r.calls.length, projectPath: r.projectPath, mode: r.mode, site: r.site, via: r.via } }));
      // Once: startup can run twice in development, and a second listener
      // would count every call twice.
      if (!recorderSubscribed) {
      recorderSubscribed = true;
      window.overapi.onEvent((e) => {
        if (e.type === 'recorder:call') set((s) => ({ recorder: { ...s.recorder, count: s.recorder.count + 1 } }));
        if (e.type === 'recorder:status') set((s) => ({ recorder: { running: e.running, port: e.port ?? s.recorder.port, target: e.running ? e.target : (e.target ?? s.recorder.target), count: e.running ? 0 : s.recorder.count, projectPath: e.projectPath, mode: e.mode ?? s.recorder.mode, site: e.site ?? (e.running ? undefined : s.recorder.site), via: e.via ?? s.recorder.via } }));
      });
      }
      const first = projects.find((p) => !p.missing);
      if (first) await withTimeout(get().open(first.path), 'opening the last API').catch(() => undefined);
    } catch (e) {
      // Never leave the window on its splash: say what failed. The usual
      // cause in development is a main process older than this window.
      set({ bootError: (e as Error).message });
    }
    const wait = 700 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    set({ booted: true });
  },

  reload: async () => {
    const { path } = get();
    if (!path) return;
    const loaded = await window.overapi.invoke('projects:load', path);
    if (loaded.ok) set({ project: loaded.project });
  },
  refreshInfo: async () => set({ info: await window.overapi.invoke('app:info') }),
  saveSettings: async (patch) => set({ settings: await window.overapi.invoke('settings:set', patch) }),
  refreshProjects: async () => set({ projects: await window.overapi.invoke('projects:list') }),
  refreshSystems: async () => set({ systems: await window.overapi.invoke('systems:list') }),
  openSystem: (path) => set({ system: path, recording: false, path: undefined, project: undefined, loadError: undefined }),
  renameProject: async (p, title) => {
    const t = title.trim();
    if (!t) return false;
    const r = await window.overapi.invoke('projects:rename', p, t);
    if (!r.ok) {
      get().say(r.error, true);
      return false;
    }
    await get().refreshProjects();
    const { path, project } = get();
    if (path === p && project) set({ project: { ...project, title: t, name: r.name } });
    get().say(`Renamed to ${t}${r.moved.length ? ` — Claude Code now has it as ${r.moved.join(', ')}` : ''}${r.overgo ? '. Publish to overgo again to rename it there' : ''}.`);
    return true;
  },

  open: async (path, tab) => {
    const loaded = await window.overapi.invoke('projects:load', path);
    if (!loaded.ok) {
      set({ path, project: undefined, loadError: loaded.error });
      return;
    }
    const p = loaded.project;
    set({ recording: false, system: undefined });
    const remembered = rememberedEnv(path);
    set({
      path,
      project: p,
      loadError: undefined,
      toolId: p.tools[0]?.id,
      env: p.envs.some((e) => e.name === remembered) ? remembered : p.envs[0]?.name,
      save: 'saved',
      saveError: undefined,
      // Every API opens on Requests — the workbench; MCP server is one click.
      ...landing(tab && tab !== 'overview' ? tab : 'requests'),
      history: [],
    });
    void get().refreshSecrets();
    void get().refreshHistory();
    void get().refreshRuntime();
    if (loaded.note) get().say(loaded.note);
  },

  close: () => set({ path: undefined, project: undefined, loadError: undefined }),

  // Every edit saves itself shortly after: no Save button to forget, and a
  // running `serve` picks the change up within seconds.
  update: (fn) => {
    const { project, path, env } = get();
    if (!project || !path) return;
    const next = fn(project);
    const envStill = next.envs.some((e) => e.name === env) ? env : next.envs[0]?.name;
    set({ project: next, save: 'pending', env: envStill });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const r = await window.overapi.invoke('projects:save', path, get().project!);
      set(r.ok ? { save: 'saved', saveError: undefined } : { save: 'error', saveError: r.error });
      if (r.ok) void get().refreshProjects();
    }, 400);
  },

  setTab: (tab) => {
    set(landing(tab));
    void get().refreshSecrets();
    if (tab === 'mcp' || tab in LEGACY) void get().refreshInfo();
  },
  setMcpTab: (mcpTab) => {
    set({ tab: 'mcp', mcpTab });
    if (mcpTab === 'install') void get().refreshInfo();
  },
  selectTool: (toolId) => set({ toolId }),
  setEnv: (name) => {
    const { path, project, env: was } = get();
    set({ env: name });
    // Say where things go now — a switch should never be silent.
    const e = project?.envs.find((x) => x.name === name);
    if (e && name !== was) {
      get().say(`Now sending to ${name}${!e.baseUrl ? ' — no base URL yet' : /prod|live/i.test(name) ? ' — real data' : ''}${e.allowWrites ? '' : ' · read-only for agents'}.`, !e.baseUrl);
    }
    try {
      if (path) localStorage.setItem(envKey(path), name);
    } catch {
      // Private window or storage blocked: the choice lasts this session.
    }
  },

  refreshSecrets: async () => {
    const { project, path } = get();
    if (!project || !path) return;
    const names = secretNames(project);
    set({ secrets: await window.overapi.invoke('secrets:status', path, names) });
  },
  refreshRuntime: async () => {
    const { path } = get();
    if (path) set({ runtime: await window.overapi.invoke('runtime:list', path) });
  },
  setRuntime: async (name, value) => {
    const { path } = get();
    if (path) set({ runtime: await window.overapi.invoke('runtime:set', path, name, value) });
  },
  refreshHistory: async () => {
    const { path } = get();
    if (path) set({ history: await window.overapi.invoke('history:list', path) });
  },

  say: (text, bad) => {
    set({ toast: { text, bad } });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: undefined }), bad ? 7000 : 2800);
  },

  openSheet: (sheet) => set({ sheet }),

  addTool: (tool) => {
    const { project } = get();
    if (!project) return;
    if (project.tools.some((t) => t.id === tool.id)) {
      get().say(`${tool.id} is already in this API.`, true);
      set({ toolId: tool.id, tab: 'requests' });
      return;
    }
    const names = uniqueNames([...project.tools.map((t) => t.name), tool.name]);
    const added = { ...tool, name: names[names.length - 1] };
    get().update((p) => ({ ...p, tools: [...p.tools, added] }));
    set({ toolId: added.id, tab: 'requests' });
  },

  /// A pasted curl into the open project: the request, and — when the
  /// project has no base URL or auth yet — those too. A credential in the
  /// command goes to the keychain, never into the file.
  addCurl: async (text) => {
    const { project, path, env, say } = get();
    if (!project || !path) return false;
    let parsed;
    try {
      parsed = parseCurl(text);
    } catch (e) {
      say((e as Error).message, true);
      return false;
    }
    const active = project.envs.find((e) => e.name === env) ?? project.envs[0];
    const prefix = varPrefix(project.name);
    const r = toolFromCurl(parsed, { base: active?.baseUrl || undefined, varPrefix: prefix });
    get().update((p) => {
      let envs = p.envs.length ? p.envs : [{ name: 'local', baseUrl: '', auth: { type: 'none' as const }, allowWrites: true }];
      envs = envs.map((e) => {
        if (active && e.name !== active.name && p.envs.length) return e.auth.type === 'none' && r.auth.type !== 'none' ? { ...e, auth: r.auth } : e;
        return { ...e, baseUrl: e.baseUrl || r.baseUrl, auth: e.auth.type === 'none' ? r.auth : e.auth };
      });
      return { ...p, envs };
    });
    // A request first, a tool once it has worked (Make it a tool).
    get().addTool({ ...r.tool, enabled: false });
    const authNow = (get().project!.envs.find((e) => e.name === (active?.name ?? 'local')) ?? get().project!.envs[0]).auth;
    const varName = authNow.type === 'bearer' ? authNow.tokenVar : authNow.type === 'apiKey' ? authNow.valueVar : undefined;
    if (r.secret?.value && varName) {
      const saved = await window.overapi.invoke('secrets:set', path, varName, r.secret.value);
      say(saved.ok ? `Added ${r.tool.method} ${r.tool.path}. The credential in it went to the keychain as ${varName}.` : `Added ${r.tool.method} ${r.tool.path}. ${saved.error}`, !saved.ok);
      void get().refreshSecrets();
    } else say(`Added ${r.tool.method} ${r.tool.path}.`);
    return true;
  },
}));
