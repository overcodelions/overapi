// Electron main. Two lives:
//
//   * `Overapi serve <overapi.json> --env x` — no window; the same MCP
//     server the CLI runs, plus secrets saved in the app's keychain, so a
//     client can be pointed at the installed app without Node or a .env.
//   * Otherwise the app: a window, and the IPC the renderer invokes.
//
// The real work is in src/core, which never imports electron. This file is
// plumbing: dialogs, files, the keychain, the clipboard.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IPCInvokeMap, MainEvent, ProjectRef, SecretSource } from '../shared/ipc';
import type { ServeCommand } from '../shared/install';
import { emptyProject, slug, varPrefix, type EnvDef, type Project } from '../shared/project';
import { isSystemFile, SYSTEM_FILE, type SystemDef, type SystemRef } from '../shared/system';
import { extractSeen, seenKey, seenPath, type SeenValue } from '../shared/seen';
import { findLinks } from '../shared/chains';
import type { SeenSuggestions } from '../shared/ipc';
import { nameForOrigin } from '../core/import/har';

const serveAt = process.argv.indexOf('serve');
const SERVE = serveAt > 0 && process.argv.slice(serveAt + 1).some((a) => a.endsWith('.json'));

app.setName('Overapi');

if (SERVE) {
  // stdout belongs to JSON-RPC from here on.
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  app.dock?.hide();
  void app.whenReady().then(async () => {
    const [{ run }, { keychainSource }] = await Promise.all([import('../cli/index'), import('./secrets')]);
    await run(process.argv.slice(serveAt), serveCommand(), keychainSource);
  });
} else {
  startApp();
}

/// How a client should start a server: the packaged app binary itself, or
/// in development, Node and the built CLI script.
function serveCommand(): ServeCommand {
  if (app.isPackaged) return { command: process.execPath, prefix: [] };
  let node = 'node';
  try {
    node = execFileSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim() || 'node';
  } catch {
    // Whatever the client's PATH finds.
  }
  return { command: node, prefix: [path.resolve(__dirname, '..', 'cli', 'index.js')] };
}

/// The app's own images, in build/ — beside dist/ when unpacked, inside the
/// app when packaged; getAppPath() is the root either way.
const asset = (file: string) => path.join(app.getAppPath(), 'build', file);

function startApp(): void {
  const DEV_URL = process.env.VITE_DEV_SERVER_URL;
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null;
  /// Rebuilds the menu bar menu: overapi's state at a glance — above all,
  /// whether it is recording — and the few things worth doing from there.
  let trayState: { running: boolean; mode?: 'proxy' | 'browser'; port?: number; target?: string; count: number; stop: () => Promise<void>; show?: () => void } = { running: false, count: 0, stop: async () => undefined };
  const updateTray = (patchState: Partial<typeof trayState> = {}) => {
    trayState = { ...trayState, ...patchState };
    if (!tray) return;
    const s = trayState;
    tray.setTitle(s.running ? ` ● ${s.count}` : '');
    const where = s.mode === 'browser' ? `browser · ${String(s.target).replace(/^https?:\/\//, '').replace(/\/$/, '')}` : `localhost:${s.port} → ${String(s.target).replace(/^https?:\/\//, '')}`;
    tray.setToolTip(s.running ? `overapi — recording ${where}` : 'overapi');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'overapi', enabled: false },
        { type: 'separator' },
        s.running
          ? { label: `Recording · ${s.count} call${s.count === 1 ? '' : 's'}`, enabled: false }
          : { label: 'Not recording', enabled: false },
        ...(s.running
          ? [
              { label: `  ${where}`, enabled: false },
              s.mode === 'browser'
                ? { label: 'Show the browser window', click: () => s.show?.() }
                : { label: 'Copy local address', click: () => clipboard.writeText(`http://localhost:${s.port}`) },
              { label: 'Stop recording', click: () => void s.stop() },
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Open overapi',
          click: () => {
            if (!win) createWindow();
            win?.show();
            win?.focus();
          },
        },
        { label: 'Quit overapi', role: 'quit' },
      ]),
    );
  };
  const emit = (e: MainEvent) => win?.webContents.send('main:event', e);

  function handle<K extends keyof IPCInvokeMap>(channel: K, fn: (...args: Parameters<IPCInvokeMap[K]>) => ReturnType<IPCInvokeMap[K]> | Promise<ReturnType<IPCInvokeMap[K]>>): void {
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as Parameters<IPCInvokeMap[K]>)));
  }

  async function registerIpc(): Promise<void> {
    const core = await import('../core/index');
    const st = await import('./appState');
    const secrets = await import('./secrets');
    const { detectTools } = await import('../core/ai');
    const { discover, cancelDiscovery } = await import('./discovery');
    const overcli = await import('./overcli');

    const applyTheme = () => {
      nativeTheme.themeSource = st.getSettings().theme;
    };
    applyTheme();

    /// New projects get a folder of their own under the projects folder, so
    /// a .env beside one holds that API's secrets only and the folder can
    /// become a repo.
    const homeFor = (name: string) => {
      const root = st.getSettings().projectsDir;
      let dir = path.join(root, slug(name) || 'api');
      for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${slug(name) || 'api'}-${i}`);
      return path.join(dir, 'overapi.json');
    };
    const create = (project: Project) => {
      const file = homeFor(project.name);
      core.writeProject(file, project);
      fs.writeFileSync(path.join(path.dirname(file), '.gitignore'), '.env\n');
      st.rememberProject(file);
      return file;
    };
    const vars = (p: string) => {
      const kc = secrets.keychainSource(p);
      const local = core.varSource(p);
      return (name: string) => kc(name) ?? local(name);
    };

    // Probing the CLIs spawns two processes; a slow shell or a wedged CLI
    // must never hold the window on its splash. Start it now, answer with
    // what is known after a moment, and the next app:info has the rest.
    let aiCache: { claude: boolean; codex: boolean } | null = null;
    const aiProbe = detectTools().then((r) => (aiCache = r));
    const aiNow = async () =>
      aiCache ?? (await Promise.race([aiProbe, new Promise<{ claude: boolean; codex: boolean }>((r) => setTimeout(() => r({ claude: false, codex: false }), 1500))]));
    handle('app:info', async () => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      serve: serveCommand(),
      keychain: secrets.keychainAvailable(),
      overcliInbox: overcli.overcliApisDir(),
      overcliTakesApis: overcli.overcliTakesApis(),
      ai: await aiNow(),
      chrome: (await import('./chromeRecorder')).findChrome()?.name,
    }));
    handle('settings:get', () => st.getSettings());
    handle('settings:set', (patch) => {
      const s = st.setSettings(patch);
      applyTheme();
      if (patch.ai) void detectTools().then((r) => (aiCache = r));
      return s;
    });
    handle('settings:pickDir', async () => {
      const r = await dialog.showOpenDialog(win!, { title: 'Where new APIs are saved', properties: ['openDirectory', 'createDirectory'], defaultPath: st.getSettings().projectsDir });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });

    handle('projects:list', () =>
      st.listProjects().map((p): ProjectRef => {
        try {
          const proj = core.readProject(p);
          const origins = proj.envs
            .map((e) => {
              try {
                return new URL(e.baseUrl).origin;
              } catch {
                return '';
              }
            })
            .filter(Boolean);
          return { path: p, title: proj.title || proj.name, name: proj.name, tools: proj.tools.length, origins };
        } catch {
          return { path: p, title: path.basename(path.dirname(p)), name: '', tools: 0, missing: true };
        }
      }),
    );

    // ---- systems: APIs that belong together ---------------------------------
    const readSystem = (file: string): SystemRef => {
      const def = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (!isSystemFile(def)) throw new Error(`${path.basename(file)} isn’t an overapi workspace.`);
      const dir = path.dirname(file);
      return { path: file, title: def.title, name: def.name, description: def.description, instructions: def.instructions, signedInBy: def.signedInBy, members: def.members.map((m) => path.resolve(dir, m)) };
    };
    const writeSystem = (sys: SystemRef) => {
      const dir = path.dirname(sys.path);
      const def: SystemDef = {
        overapiSystem: 1,
        name: sys.name,
        title: sys.title,
        ...(sys.description ? { description: sys.description } : {}),
        members: [...new Set(sys.members)].map((m) => path.relative(dir, m) || m),
        ...(sys.signedInBy ? { signedInBy: sys.signedInBy } : {}),
        ...(sys.instructions ? { instructions: sys.instructions } : {}),
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sys.path, JSON.stringify(def, null, 2) + '\n');
    };
    handle('systems:list', () =>
      st.listSystems().flatMap((f) => {
        try {
          return [readSystem(f)];
        } catch {
          return [];
        }
      }),
    );
    handle('systems:load', (f) => {
      try {
        const system = readSystem(f);
        const members = system.members.map((m) => {
          try {
            return { path: m, project: core.readProject(m) };
          } catch (e) {
            return { path: m, error: (e as Error).message };
          }
        });
        return { ok: true, system, members };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('systems:create', ({ title, members, signedInBy }) => {
      try {
        const name = slug(title) || 'system';
        const root = st.getSettings().projectsDir;
        let dir = path.join(root, name);
        for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${name}-${i}`);
        const file = path.join(dir, SYSTEM_FILE);
        writeSystem({ path: file, title: title.trim() || 'System', name, members, signedInBy });
        st.rememberSystem(file);
        return { ok: true, path: file };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('systems:save', (f, sys) => {
      try {
        writeSystem({ ...sys, path: f });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    // Ungrouping: the system file goes, its APIs stay as they are.
    handle('systems:remove', (f) => {
      st.forgetSystem(f);
      try {
        if (path.basename(f) === SYSTEM_FILE) fs.rmSync(f);
        fs.rmdirSync(path.dirname(f));
      } catch {
        // A folder with other things in it stays.
      }
    });
    /// One member's environment, edited from the system: its base URL or
    /// sign-in. An environment it doesn't have yet is added — read-only
    /// unless it's local, like any new one.
    handle('systems:editMember', (p, edit) => {
      try {
        const project = core.readProject(p);
        const at = project.envs.findIndex((e) => e.name === edit.env);
        const base = project.envs[0];
        const env: EnvDef =
          at >= 0
            ? project.envs[at]
            : { name: edit.env, baseUrl: '', auth: base?.auth.type === 'via' ? base.auth : { type: 'none' }, allowWrites: edit.env === 'local', ...(base?.headers ? { headers: Object.fromEntries(Object.entries(base.headers).filter(([, v]) => !/\$\{/.test(v))) } : {}) };
        const next: EnvDef = { ...env, ...(edit.baseUrl !== undefined ? { baseUrl: edit.baseUrl.trim().replace(/\/+$/, '') } : {}), ...(edit.auth ? { auth: edit.auth } : {}) };
        const from = edit.copySignIn ? project.envs.find((e) => e.name === edit.copySignIn) : undefined;
        if (from) {
          next.auth = from.auth;
          next.headers = { ...(next.headers ?? {}), ...(from.headers ?? {}) };
          if (from.browserSession) next.browserSession = from.browserSession;
          else delete next.browserSession;
        }
        project.envs = at >= 0 ? project.envs.map((e, i) => (i === at ? next : e)) : [...project.envs, next];
        core.writeProject(p, project);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('systems:install', async (f, envName) => {
      const bin = claudeBin();
      if (!bin) return { ok: false, error: 'The claude CLI isn’t installed (or isn’t on your PATH). Install Claude Code first.' };
      let sys: SystemRef;
      try {
        sys = readSystem(f);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const name = envName === 'default' ? sys.name : `${sys.name}-${envName}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const cmd = serveCommand();
      await runClaude(bin, ['mcp', 'remove', name, '--scope', 'user']);
      const r = await runClaude(bin, ['mcp', 'add', name, '--scope', 'user', '--', cmd.command, ...cmd.prefix, 'serve', f, '--env', envName]);
      if (!r.ok) return { ok: false, error: r.out.split('\n').slice(-3).join(' ') || 'claude mcp add failed.' };
      st.markInstalled(f, { at: new Date().toISOString(), env: envName, name });
      return { ok: true, name };
    });
    handle('systems:installs', (f) => st.installedFor(f));
    handle('systems:setEnabled', (p, toolIds, enabled) => {
      try {
        const project = core.readProject(p);
        project.tools = project.tools.map((t) => (toolIds.includes(t.id) ? { ...t, enabled } : t));
        core.writeProject(p, project);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('systems:hint', (p, toolId, param, text) => {
      try {
        const project = core.readProject(p);
        project.tools = project.tools.map((t) =>
          t.id !== toolId
            ? t
            : { ...t, params: t.params.map((x) => (x.name !== param ? x : { ...x, description: x.description?.includes(text) ? x.description : [x.description?.trim(), text].filter(Boolean).join(' ') })) },
        );
        core.writeProject(p, project);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });

    handle('projects:create', ({ title, baseUrl }) => {
      try {
        const project = emptyProject(title.trim() || 'New API');
        project.source = { kind: 'manual', importedAt: new Date().toISOString() };
        project.envs = [{ name: 'local', baseUrl: (baseUrl ?? '').trim().replace(/\/+$/, ''), auth: { type: 'none' }, allowWrites: true }];
        return { ok: true, path: create(project) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });

    handle('projects:pickImport', async () => {
      const pick = await dialog.showOpenDialog(win!, {
        title: 'Import an API',
        message: 'An OpenAPI or Swagger spec, a HAR capture, or a Postman collection',
        properties: ['openFile'],
        filters: [
          { name: 'API description', extensions: ['json', 'yaml', 'yml', 'har'] },
          { name: 'Any file', extensions: ['*'] },
        ],
      });
      return pick.canceled ? null : (pick.filePaths[0] ?? null);
    });

    handle('projects:import', async ({ url, text, file }) => {
      let source = text;
      let ref = 'pasted';
      try {
        if (url) {
          // A spec, or a page that links to several (one per area).
          const r = await core.importFromUrl(url);
          return { ok: true, path: create(r.project), note: r.note };
        } else if (file) {
          ref = path.basename(file);
          source = fs.readFileSync(file, 'utf8');
        }
        if (!source) return { ok: false };
        const project = core.importText(source, ref);
        return { ok: true, path: create(project) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });

    handle('projects:open', async () => {
      const pick = await dialog.showOpenDialog(win!, { title: 'Open an overapi project', properties: ['openFile'], filters: [{ name: 'overapi.json', extensions: ['json'] }] });
      if (pick.canceled || !pick.filePaths[0]) return { ok: false };
      try {
        core.readProject(pick.filePaths[0]);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      st.rememberProject(pick.filePaths[0]);
      return { ok: true, path: pick.filePaths[0] };
    });

    handle('projects:load', async (p) => {
      try {
        const { dropShadows, tidyNames } = await import('../shared/merge');
        const cleaned = dropShadows(core.readProject(p));
        const tidy = tidyNames(cleaned.project);
        cleaned.project = tidy.project;
        if (tidy.renamed.length && !cleaned.removed.length && !cleaned.repaired.length) {
          core.writeProject(p, cleaned.project);
          const r = tidy.renamed;
          return { ok: true, project: cleaned.project, note: `Renamed ${r.length} request${r.length === 1 ? '' : 's'} so the names say how they differ: ${r.slice(0, 3).map(([a, b]) => `${a} → ${b}`).join(', ')}${r.length > 3 ? '…' : ''}.` };
        }
        if (cleaned.removed.length || cleaned.repaired.length) {
          core.writeProject(p, cleaned.project);
          const n = cleaned.removed.length;
          const m = cleaned.repaired.length;
          const parts = [
            n ? `removed ${n} duplicate request${n === 1 ? '' : 's'}` : '',
            m ? `put the missing /api back on ${m} other${m === 1 ? '' : 's'} (${cleaned.repaired.slice(0, 3).join(', ')}${m > 3 ? '…' : ''})` : '',
          ].filter(Boolean);
          return { ok: true, project: cleaned.project, note: `Fixed what an earlier “Add” got wrong: ${parts.join(', and ')}. All were off.` };
        }
        return { ok: true, project: cleaned.project };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('projects:save', (p, project: Project) => {
      try {
        core.writeProject(p, project);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('projects:forget', (p) => st.forgetProject(p));
    handle('projects:reveal', (p) => shell.showItemInFolder(p));
    handle('projects:export', async (p) => {
      const r = await dialog.showSaveDialog(win!, { title: 'Export the project', defaultPath: path.basename(path.dirname(p)) + '.overapi.json' });
      if (r.canceled || !r.filePath) return { ok: false };
      try {
        fs.copyFileSync(p, r.filePath);
        return { ok: true, to: r.filePath };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });

    handle('secrets:status', (p, names) => {
      const local = core.varSource(p, {});
      const fromEnv = core.varSource(undefined);
      return Object.fromEntries(
        names.map((n): [string, SecretSource] => [n, secrets.getSecret(p, n) ? 'keychain' : fromEnv(n) ? 'env' : local(n) ? 'dotenv' : null]),
      );
    });
    handle('secrets:set', (p, name, value) => secrets.setSecret(p, name, value));

    // Values kept from responses, per project, for this run of the app:
    // the person's session, like a browser's. Not saved — a kept token
    // should not outlive the app.
    const runtimes = new Map<string, Map<string, import('../shared/ipc').RuntimeVar>>();
    const runtimeOf = (p: string) => {
      let m = runtimes.get(p);
      if (!m) runtimes.set(p, (m = new Map()));
      return m;
    };
    const runtimeValues = (p: string) => Object.fromEntries([...runtimeOf(p).values()].map((v) => [v.name, v.value]));
    // Internal values (a sign-in's token, "__login:<env>") are kept like any
    // other but not listed: they are not the person's variables.
    const runtimeList = (p: string) => [...runtimeOf(p).values()].filter((v) => !v.name.startsWith('__')).sort((a, b) => a.name.localeCompare(b.name));
    /// Copies back what a call changed in its working copy of the values.
    const syncRuntime = (p: string, rt: Record<string, string>, from: string) => {
      const m = runtimeOf(p);
      const at = new Date().toISOString();
      for (const [name, value] of Object.entries(rt)) {
        if (m.get(name)?.value !== value) m.set(name, { name, value, from: name.startsWith('__') ? 'sign-in' : from, at });
      }
    };
    /// Another API by name, for "signed in by another API": where it was
    /// picked from, else any API overapi knows by that name. Its session
    /// is the app's session for it — sign in once, there or here — and is
    /// written back by `flush` after the call.
    const peers = () => {
      const touched = new Map<string, Record<string, string>>();
      const peer = (api: string, at?: string): import('../core/flow').Peer | undefined => {
        for (const p of [at, ...st.listProjects().filter((x) => x !== at)]) {
          if (!p) continue;
          try {
            const project = core.readProject(p);
            if (project.name !== api) continue;
            let rt = touched.get(p);
            if (!rt) touched.set(p, (rt = runtimeValues(p)));
            return { project, vars: vars(p), runtime: rt };
          } catch {
            // Gone or broken: look further.
          }
        }
        return undefined;
      };
      return { peer, flush: () => touched.forEach((rt, p) => syncRuntime(p, rt, 'sign-in')) };
    };
    handle('auth:testVia', async (p, project, envName) => {
      const env = project.envs.find((e) => e.name === envName);
      const auth = env?.auth;
      if (!env || auth?.type !== 'via') return { ok: false, error: 'This environment isn’t signed in by another API.' };
      const { peer, flush } = peers();
      try {
        const b = await core.borrowSignIn(auth, env.name, { vars: vars(p), runtime: runtimeValues(p), peer, timeoutMs: st.getSettings().timeoutSec * 1000 });
        flush();
        const sent = [...Object.keys(b.headers), ...Object.keys(b.query).map((q) => `?${q}`)];
        if (!sent.length) return { ok: false, error: `${b.from} has no sign-in set for ${envName} — it sends nothing. Set one up there under Environments.` };
        return { ok: true, from: b.from, sends: sent };
      } catch (e) {
        flush();
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('auth:status', (p, envName) => {
      const v = runtimeOf(p).get(core.loginKey(envName));
      return v ? { signedIn: true, at: v.at, tail: v.value.slice(-4) } : { signedIn: false };
    });
    handle('auth:signIn', async (p, project, envName) => {
      const env = project.envs.find((e) => e.name === envName);
      const auth = env?.auth;
      if (!env || auth?.type !== 'login') return { ok: false, error: 'This environment doesn’t sign in with a request.' };
      const rt = runtimeValues(p);
      try {
        const { token } = await core.signIn(project, env, auth, { vars: vars(p), runtime: rt, timeoutMs: st.getSettings().timeoutSec * 1000 });
        syncRuntime(p, rt, 'sign-in');
        return { ok: true, tail: token.slice(-4) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('runtime:list', (p) => runtimeList(p));
    handle('runtime:set', (p, name, value) => {
      if (value === null) runtimeOf(p).delete(name);
      else if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) runtimeOf(p).set(name, { name, value, from: 'set by hand', at: new Date().toISOString() });
      return runtimeList(p);
    });

    handle('tool:try', async (req) => {
      const env = req.project.envs.find((e) => e.name === req.env);
      const tool = req.project.tools.find((t) => t.id === req.toolId);
      if (!env || !tool) return { ok: false, error: 'That request or environment is gone. Pick again.' };
      const entry = { id: randomUUID(), at: new Date().toISOString(), toolId: tool.id, toolName: tool.name, env: env.name, args: req.args, method: tool.method };
      try {
        // The same path an agent's call takes: signs in first when the API
        // needs it, retries once on a 401, keeps what the request keeps.
        const rt = runtimeValues(req.path);
        const { peer, flush } = peers();
        const { result: r, kept: captured, signedIn, hint } = await core
          .callTool(req.project, tool, env, req.args, {
            vars: vars(req.path),
            runtime: rt,
            peer,
            timeoutMs: st.getSettings().timeoutSec * 1000,
          })
          .finally(flush);
        st.addHistory(req.path, { ...entry, ok: r.ok, status: r.status, ms: r.durationMs, url: r.request.url });
        if (r.ok && r.json !== undefined) st.recordSeen(req.path, env.name, tool.id, extractSeen(r.json));
        syncRuntime(req.path, rt, tool.name);
        return {
          ok: r.ok,
          status: r.status,
          statusText: r.statusText,
          durationMs: r.durationMs,
          body: r.body,
          truncated: r.truncated,
          full: r.full,
          contentType: r.contentType,
          headers: r.headers,
          bytes: r.bytes,
          captured,
          signedIn,
          hint,
          request: r.request,
        };
      } catch (e) {
        st.addHistory(req.path, { ...entry, ok: false, error: (e as Error).message });
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('seen:suggest', (p, project, toolId, param, envName) => {
      // This API, then the rest of its workspace: ids flow between them.
      const members: { path: string; project: Project }[] = [{ path: p, project }];
      for (const f of st.listSystems()) {
        try {
          const sys = readSystem(f);
          if (!sys.members.includes(p)) continue;
          for (const m of sys.members) if (!members.some((x) => x.path === m)) members.push({ path: m, project: core.readProject(m) });
        } catch {
          // Skip what can't be read.
        }
      }
      const virtual: Project = { ...project, envs: [], tools: members.flatMap((m, i) => m.project.tools.map((t) => ({ ...t, id: `${i}|${t.id}` }))) };
      const links = findLinks(virtual).filter((l) => l.to === `0|${toolId}` && l.param === param);
      const out: SeenSuggestions = { values: [], sources: [] };
      const push = (v: SeenValue, from: string) => {
        if (out.values.length < 60 && !out.values.some((x) => x.v === v.v)) out.values.push({ ...v, from });
      };
      for (const l of links) {
        const [i, ...rest] = l.from.split('|');
        const m = members[Number(i)];
        const fromId = rest.join('|');
        const name = m.project.tools.find((t) => t.id === fromId)?.name ?? fromId;
        const api = Number(i) === 0 ? '' : m.project.title;
        for (const v of st.seenFor(m.path)[envName]?.[fromId]?.[seenPath(l.path)] ?? []) push(v, api ? `${name} · ${api}` : name);
        if (!out.sources.some((x) => x.path === m.path && x.toolId === fromId)) out.sources.push({ path: m.path, toolId: fromId, toolName: name, api: m.project.title });
      }
      // No chain: any field of the same name this API has answered with.
      // A list (ids, groupIds) takes its one-item name, and may take its
      // own request's answers — "filter these groups by id".
      if (!out.values.length) {
        const one = param.replace(/(?<=[a-z])s$/i, '').replace(/^(.*)ies$/i, '$1y');
        const list = one !== param;
        const stored = Object.entries(st.seenFor(p)[envName] ?? {}).sort(([a], [b]) => (a === toolId ? -1 : b === toolId ? 1 : 0));
        for (const [tid, paths] of stored) {
          if (tid === toolId && !list) continue;
          const name = project.tools.find((t) => t.id === tid)?.name ?? tid;
          for (const [sp, vals] of Object.entries(paths)) if (seenKey(sp) === param || (list && seenKey(sp) === one)) for (const v of vals) push(v, name);
        }
      }
      return out;
    });
    handle('seen:fill', async (p, toolId, envName) => {
      try {
        const project = core.readProject(p);
        const tool = project.tools.find((t) => t.id === toolId);
        const env = project.envs.find((e) => e.name === envName) ?? (project.envs.length === 1 ? project.envs[0] : undefined);
        if (!tool || !env) return { ok: false, error: `${project.title} has no ${envName} environment, or that request is gone.` };
        const rt = runtimeValues(p);
        const { peer, flush } = peers();
        const { result: r } = await core.callTool(project, tool, env, tool.example ?? {}, { vars: vars(p), runtime: rt, peer, timeoutMs: st.getSettings().timeoutSec * 1000 }).finally(flush);
        syncRuntime(p, rt, tool.name);
        st.addHistory(p, { id: randomUUID(), at: new Date().toISOString(), toolId: tool.id, toolName: tool.name, env: env.name, args: tool.example ?? {}, method: tool.method, ok: r.ok, status: r.status, ms: r.durationMs, url: r.request.url });
        if (r.ok && r.json !== undefined) st.recordSeen(p, env.name, tool.id, extractSeen(r.json));
        return r.ok ? { ok: true, status: r.status } : { ok: false, error: `${tool.name} answered ${r.status} ${r.statusText}.` };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('history:list', (p) => st.history(p));
    handle('history:clear', (p) => st.clearHistory(p));

    handle('discover:pickFiles', async () => {
      const pick = await dialog.showOpenDialog(win!, {
        title: 'Documentation to read',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documentation', extensions: ['md', 'markdown', 'txt', 'html', 'htm', 'pdf', 'rst', 'adoc', 'json', 'yaml', 'yml', 'xml', 'wsdl'] }],
      });
      return pick.canceled ? [] : pick.filePaths;
    });
    handle('discover:run', async (req) => {
      const s = st.getSettings();
      try {
        const project = await discover(req, {
          prefer: s.ai,
          model: s.aiModel,
          onStep: (text) => emit({ type: 'discover:step', text }),
          onPhase: (text) => emit({ type: 'discover:phase', text }),
        });
        const file = create(project);
        return { ok: true, path: file, note: `${project.tools.length} endpoints drafted. Check each description before turning writes on.` };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('discover:cancel', () => cancelDiscovery());

    // Make it agent-ready: the AI writes the documentation (core/document.ts).
    let documenting: import('../core/ai').AiRun | null = null;
    handle('ai:document', async (project, envName, samples) => {
      const { documentPrompt, parseDocReply } = await import('../core/document');
      const { runClaudeReader, runCodex } = await import('../core/ai');
      const tools = await aiNow();
      const pref = st.getSettings().ai;
      const tool = pref === 'codex' || (pref === 'auto' && !tools.claude) ? 'codex' : 'claude';
      if (!tools[tool]) return { ok: false, error: 'Neither claude nor codex is installed on this Mac. Install one (Settings shows which overapi found), then try again.' };
      const env = project.envs.find((e) => e.name === envName);
      const prompt = documentPrompt(project, env, { samples });
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'overapi-doc-'));
      emit({ type: 'doc:step', text: `Asking ${tool} to document ${project.tools.length} tools…` });
      try {
        documenting =
          tool === 'claude'
            ? runClaudeReader(prompt, { cwd: dir, model: st.getSettings().aiModel || undefined, timeoutMs: 10 * 60_000, onStep: (t) => emit({ type: 'doc:step', text: t }) })
            : runCodex(prompt, { timeoutMs: 10 * 60_000 });
        const r = await documenting.result;
        if (!r.ok) return { ok: false, error: r.error ?? `${tool} didn't finish.` };
        emit({ type: 'doc:step', text: 'Checking the answer against the API…' });
        return { ok: true, doc: parseDocReply(r.output, project), tool };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        documenting = null;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    handle('ai:cancel', () => documenting?.cancel());

    // Ask: a question, answered by claude through this API's own MCP server.
    /// Questions being answered, by run: each panel follows only its own.
    const asking = new Map<string, { stop: () => void }>();
    handle('agent:ask', async (p, envName, question, runId) => {
      const bin = claudeBin();
      if (!bin) return { ok: false, error: 'Asking needs the claude CLI (Claude Code). Install it, or use “Call a tool” to try tools by hand.' };
      if (asking.size >= 3) return { ok: false, error: 'Three questions are already being answered — stop one first.' };
      const { startAskServer, runAsk } = await import('./ask');
      let title: string;
      let srv: Awaited<ReturnType<typeof startAskServer>>;
      try {
        if (path.basename(p) === SYSTEM_FILE) {
          // A workspace: every member, as the one server Claude Code would get.
          const sysNow = () => {
            const sys = readSystem(p);
            return { name: sys.name, title: sys.title, description: sys.description, instructions: sys.instructions, members: sys.members.flatMap((m) => { try { return [{ path: m, project: core.readProject(m), vars: vars(m) }]; } catch { return []; } }) };
          };
          const first = sysNow();
          if (!first.members.length) return { ok: false, error: 'None of this workspace’s APIs can be read.' };
          title = first.title;
          srv = await startAskServer({ project: () => first.members[0].project, system: sysNow, envName, vars: vars(p), log: () => undefined, peer: peers().peer });
        } else {
          title = core.readProject(p).title;
          srv = await startAskServer({ project: () => core.readProject(p), envName, vars: vars(p), log: () => undefined, peer: peers().peer });
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const run = runAsk({ bin, question, title, url: srv.url, token: srv.token, model: st.getSettings().aiModel || undefined, onEvent: (event) => emit({ type: 'ask:event', runId, event }) });
      asking.set(runId, run);
      void run.done.finally(() => {
        asking.delete(runId);
        srv.close();
      });
      return { ok: true };
    });
    handle('agent:stop', (runId) => {
      for (const [id, run] of asking) if (!runId || id === runId) run.stop();
    });

    handle('overgo:publish', (p, project, env) => {
      const e = project.envs.find((x) => x.name === env);
      if (e) {
        const { scanProject, forEnv } = require('../shared/scan') as typeof import('../shared/scan');
        const scan = forEnv(scanProject(project, varPrefix(project.name)), e);
        if (scan.blocking.length) {
          return { ok: false, error: `The security scan found ${scan.blocking.length} serious issue${scan.blocking.length === 1 ? '' : 's'} on ${env}: ${scan.blocking.slice(0, 2).map((f) => f.title).join('; ')}. Fix ${scan.blocking.length === 1 ? 'it' : 'them'} (MCP server → Security), or accept with a reason, then publish.` };
        }
      }
      if (e?.auth.type === 'via') {
        return { ok: false, error: `${env} is signed in by ${e.auth.api}, which overgo doesn’t have. Publish an environment with its own API token or sign-in request instead.` };
      }
      if (e?.browserSession) {
        return { ok: false, error: `${env} signs in with your own browser session, so publishing it would let everyone act as you. Publish an environment that uses an API token or a sign-in request instead.` };
      }
      const r = overcli.sendToOvercli(project, env);
      if (r.ok) st.markPublished(p, { at: new Date().toISOString(), env, id: r.id });
      return r;
    });
    handle('overgo:published', (p) => st.publishedFor(p));

    // One MCP client session at a time — the "As an agent" page's.
    const { McpSession } = await import('../core/mcpClient');
    let session: Awaited<ReturnType<typeof McpSession.connect>> | null = null;
    const infoResult = async () => {
      if (!session) return { ok: false as const, error: 'Not connected.' };
      try {
        return { ok: true as const, info: (await session.info()) as unknown as import('../shared/ipc').McpInfoDto };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
    };
    handle('mcp:connect', async (req) => {
      await session?.close();
      session = null;
      try {
        const onToolsChanged = () => emit({ type: 'mcp:toolsChanged' });
        if (req.kind === 'self') {
          // This project's own server, exactly as `serve` builds it — read
          // live from the file, secrets from the keychain first.
          // Seeded with the values the person kept, so a token from a login
          // sent in Requests works here too.
          const server = core.createServer({ project: core.liveProject(req.path), envName: req.env, vars: vars(req.path), watchMs: 1500, runtime: runtimeValues(req.path), peer: peers().peer });
          session = await McpSession.connect({ kind: 'self', server, label: req.env }, { onToolsChanged });
        } else {
          session = await McpSession.connect(req, { onToolsChanged });
        }
      } catch (e) {
        session = null;
        return { ok: false, error: (e as Error).message };
      }
      return infoResult();
    });
    handle('mcp:refresh', () => infoResult());
    handle('mcp:call', async (name, args) => {
      if (!session) return { ok: false, error: 'Not connected.' };
      try {
        return { ok: true, result: await session.call(name, args) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('mcp:disconnect', async () => {
      await session?.close();
      session = null;
    });
    app.on('before-quit', () => void session?.close());

    // One click instead of a pasted command. Runs claude directly (no shell),
    // found the way a terminal would find it, since an app opened from the
    // Dock does not inherit the terminal's PATH. No secret goes into
    // Claude's config: the server reads them itself (keychain when it is
    // the packaged app, the .env beside the project otherwise).
    // Claude Code's list of MCP servers (and so overcli's), changed by
    // running claude directly — no shell — found the way a terminal would,
    // since an app opened from the Dock does not inherit the terminal's PATH.
    // No secret goes into Claude's config: the server reads them itself.
    const claudeBin = (): string | null => {
      try {
        return execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || null;
      } catch {
        return null;
      }
    };
    const runClaude = (bin: string, args: string[]) =>
      new Promise<{ ok: boolean; out: string }>((resolve) =>
        execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })),
      );
    const claudeAdd = async (p: string, envName: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> => {
      const { serverName, serveArgs } = await import('../shared/install');
      let project: Project;
      try {
        project = core.readProject(p);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const env = project.envs.find((e) => e.name === envName);
      if (!env) return { ok: false, error: `No environment ${envName}.` };
      const bin = claudeBin();
      if (!bin) return { ok: false, error: 'The claude CLI isn’t installed (or isn’t on your PATH). Install Claude Code, or copy the command instead.' };
      const name = serverName(project, env);
      const cmd = serveCommand();
      // Replace, not duplicate: remove any earlier install of the same name.
      await runClaude(bin, ['mcp', 'remove', name, '--scope', 'user']);
      const r = await runClaude(bin, ['mcp', 'add', name, '--scope', 'user', '--', cmd.command, ...serveArgs(cmd, p, env)]);
      if (!r.ok) return { ok: false, error: r.out.split('\n').slice(-3).join(' ') || 'claude mcp add failed.' };
      st.markInstalled(p, { at: new Date().toISOString(), env: env.name, name });
      return { ok: true, name };
    };
    // The way back. Only the name overapi added; anything else is left alone.
    const claudeRemove = async (p: string, envName: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> => {
      const installed = st.installedFor(p)[envName];
      if (!installed) return { ok: false, error: 'overapi didn’t add this one to Claude Code.' };
      const bin = claudeBin();
      if (!bin) return { ok: false, error: 'The claude CLI isn’t installed (or isn’t on your PATH).' };
      const out = await runClaude(bin, ['mcp', 'remove', installed.name, '--scope', 'user']);
      // Already gone (removed by hand) counts as removed.
      if (!out.ok && !/not found|no .*server/i.test(out.out)) return { ok: false, error: out.out.split('\n').slice(-2).join(' ') || 'claude mcp remove failed.' };
      st.clearInstalled(p, envName);
      return { ok: true, name: installed.name };
    };
    handle('install:claude', (p, envName) => claudeAdd(p, envName));
    handle('install:claudeRemove', (p, envName) => claudeRemove(p, envName));

    // Renaming changes the internal name too — it is what the server is
    // called in Claude Code and overgo, and a name that no longer matches the
    // API helps nobody. Installs move with it: each installed environment is
    // removed under the old name and added under the new one. overgo can't
    // be renamed from here; the caller is told to publish again.
    handle('projects:rename', async (p, title) => {
      let project: Project;
      try {
        project = core.readProject(p);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const clean = title.trim();
      if (!clean) return { ok: false, error: 'An API needs a name.' };
      const name = slug(clean) || project.name;
      if (name === project.name) {
        core.writeProject(p, { ...project, title: clean });
        return { ok: true, name, moved: [], overgo: false };
      }
      const envs = Object.keys(st.installedFor(p));
      for (const e of envs) await claudeRemove(p, e);
      core.writeProject(p, { ...project, title: clean, name });
      // APIs it signs in, and systems it signs in for, follow the new name.
      for (const other of st.listProjects()) {
        if (other === p) continue;
        try {
          const o = core.readProject(other);
          if (!o.envs.some((e) => e.auth.type === 'via' && e.auth.api === project.name)) continue;
          core.writeProject(other, { ...o, envs: o.envs.map((e) => (e.auth.type === 'via' && e.auth.api === project.name ? { ...e, auth: { type: 'via' as const, api: name, path: p } } : e)) });
        } catch {
          // Unreadable: left alone.
        }
      }
      for (const f of st.listSystems()) {
        try {
          const sys = readSystem(f);
          if (sys.signedInBy === project.name) writeSystem({ ...sys, signedInBy: name });
        } catch {
          // Unreadable: left alone.
        }
      }
      const moved: string[] = [];
      for (const e of envs) {
        const r = await claudeAdd(p, e);
        if (r.ok) moved.push(r.name);
      }
      return { ok: true, name, moved, overgo: !!st.publishedFor(p) };
    });
    // Deleting an API leaves nothing behind that would surprise anyone: its
    // servers come out of Claude Code (every environment), its secrets out
    // of the keychain, its history, its place in the list — and, if asked,
    // its folder goes to the Trash (recoverable), not gone for good.
    handle('projects:delete', async (p, { trash }) => {
      const removed: string[] = [];
      for (const envName of Object.keys(st.installedFor(p))) {
        const r = await claudeRemove(p, envName);
        if (r.ok) removed.push(r.name);
      }
      secrets.clearSecrets(p);
      st.clearHistory(p);
      st.forgetProject(p);
      runtimes.delete(p);
      if (trash) {
        try {
          await shell.trashItem(path.dirname(p));
        } catch (e) {
          return { ok: false, error: `Removed from overapi, but the folder couldn’t be moved to the Trash: ${(e as Error).message}` };
        }
      }
      return { ok: true, removed };
    });

    // ---- the recorder: listen here, go there — or record a browser -------
    const { startRecorder, callsToHar } = await import('../core/recorder');
    const { requestGraph, applyGraph } = await import('../shared/graph');
    const { within } = await import('../shared/recording');
    const { sessionPlan, sessionPrefix } = await import('../shared/session');
    const browser = await import('./browserRecorder');
    const chrome = await import('./chromeRecorder');
    let chromeRec: import('./chromeRecorder').ChromeRecorder | null = null;
    let recVia: import('../shared/recording').BrowserVia = 'overapi';
    /// The session's cookies, from whichever browser holds it.
    const cookiesFrom = (via: import('../shared/recording').BrowserVia, site: string, url: string) => (via === 'chrome' ? chrome.chromeCookies(url) : browser.cookiesFor(site, url));
    let recorder: Awaited<ReturnType<typeof startRecorder>> | null = null;
    let browserRec: import('./browserRecorder').BrowserRecorder | null = null;
    let recorded: import('../shared/recording').RecordedCall[] = [];
    let recTarget = '';
    let recPort = 4545;
    let recMode: import('../shared/recording').RecordMode = 'proxy';
    let recSite: string | undefined;
    /// The API it was started from, when it was — its Traffic tab shows it.
    let recProject: string | undefined;
    const recording = () => !!recorder || !!browserRec || !!chromeRec;
    const onCall = (c: import('../shared/recording').RecordedCall) => {
      recorded.push(c);
      if (recorded.length > 2000) recorded.shift();
      emit({ type: 'recorder:call', call: c });
      updateTray({ count: trayState.count + 1 });
    };
    const stopAll = async () => {
      await recorder?.stop();
      recorder = null;
      const b = browserRec;
      browserRec = null;
      b?.stop();
      const c = chromeRec;
      chromeRec = null;
      c?.stop();
    };
    const announceStopped = () => {
      emit({ type: 'recorder:status', running: false, projectPath: recProject, mode: recMode, via: recVia });
      updateTray({ running: false });
    };
    const stopRecording = async () => {
      await stopAll();
      announceStopped();
    };
    handle('recorder:start', async (target, port, projectPath) => {
      await stopAll();
      try {
        recorder = await startRecorder({ target, port, onCall });
        recTarget = recorder.target;
        recPort = recorder.port;
        recProject = projectPath;
        recMode = 'proxy';
        recSite = undefined;
        recorded = [];
        updateTray({ running: true, mode: 'proxy', port: recorder.port, target: recorder.target, count: 0, stop: stopRecording });
        emit({ type: 'recorder:status', running: true, port: recorder.port, target: recorder.target, projectPath, mode: 'proxy' });
        return { ok: true, port: recorder.port, target: recorder.target };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    // A web app with no public API: open it in a window overapi records.
    handle('recorder:browse', async (site, projectPath, apiBase, via = 'overapi') => {
      await stopAll();
      if (via === 'chrome') {
        try {
          const rec = await chrome.startChromeRecorder({
            site,
            onCall,
            onClosed: () => {
              // Closing its last tab is how most people will stop.
              if (chromeRec !== rec) return;
              chromeRec = null;
              announceStopped();
            },
          });
          chromeRec = rec;
          recSite = rec.site;
          recTarget = (apiBase ?? '').replace(/\/+$/, '');
          recProject = projectPath;
          recMode = 'browser';
          recVia = 'chrome';
          recorded = [];
          updateTray({ running: true, mode: 'browser', target: rec.site, count: 0, stop: stopRecording, show: () => rec.focus() });
          emit({ type: 'recorder:status', running: true, target: recTarget || undefined, site: rec.site, projectPath, mode: 'browser', via: 'chrome' });
          return { ok: true, site: rec.site };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
      try {
        let me: import('./browserRecorder').BrowserRecorder | null = null;
        const rec = await browser.startBrowserRecorder({
          site,
          label: '● Recording',
          bar: { kind: 'record', text: '' },
          onCall: (c) => {
            onCall(c);
            me?.setCount(recorded.length);
          },
          onClosed: () => {
            // Closing the window is how most people will stop.
            if (browserRec !== rec) return;
            browserRec = null;
            announceStopped();
          },
        });
        me = rec;
        browserRec = rec;
        recSite = rec.site;
        recTarget = (apiBase ?? '').replace(/\/+$/, '');
        recProject = projectPath;
        recMode = 'browser';
        recVia = 'overapi';
        recorded = [];
        updateTray({ running: true, mode: 'browser', target: rec.site, count: 0, stop: stopRecording, show: () => rec.window.isDestroyed() || rec.window.focus() });
        emit({ type: 'recorder:status', running: true, target: recTarget || undefined, site: rec.site, projectPath, mode: 'browser', via: 'overapi' });
        return { ok: true, site: rec.site };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    // Explore for me: overapi drives the recording window itself.
    let exploring = false;
    let exploreStop = false;
    handle('explore:start', async (opts) => {
      const rec = browserRec;
      if (!rec || rec.window.isDestroyed()) return { ok: false, error: chromeRec ? 'Exploring works in overapi’s own browser window, not Chrome.' : 'Start a browser recording first.' };
      if (exploring) return { ok: false, error: 'Already exploring.' };
      const { explore, DEFAULT_EXPLORE } = await import('./explorer');
      const { routeOf } = await import('../shared/metrics');
      const { coverageOf } = await import('../shared/coverage');
      const scoped = () => within(recorded, recTarget || undefined).filter((c) => !c.error && c.status < 400);
      exploring = true;
      exploreStop = false;
      // Nothing but reads leaves the browser while overapi drives it.
      let blocked = 0;
      let flood: string | null = null;
      await rec.guard({
        safeSearch: !!opts?.safeSearch,
        onBlocked: () => void blocked++,
        onFlood: (why) => {
          flood = why;
          exploreStop = true;
        },
      });
      try {
        const status = await explore(rec.page, DEFAULT_EXPLORE, {
          routes: () => new Set(scoped().map((c) => `${c.method} ${routeOf(c.path)}`)).size,
          wanted: () => coverageOf(scoped()).things.filter((t) => t.list !== t.detail).map((t) => t.noun),
          stopped: () => exploreStop || browserRec !== rec,
          onStatus: (s) => {
            s = { ...s, blocked };
            emit({ type: 'explore:status', status: s });
            rec.setNote(s.running ? `Exploring · page ${s.pages} of ${s.maxPages} · ${s.found} new` : '');
          },
        });
        return { ok: true, status: flood ? { ...status, running: false, blocked, reason: `stopped to protect your network: ${flood}` } : { ...status, blocked } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        if (!rec.window.isDestroyed()) await rec.guard(null);
        exploring = false;
        if (!rec.window.isDestroyed()) rec.setNote('');
      }
    });
    handle('explore:stop', () => {
      exploreStop = true;
    });
    handle('recorder:showBrowser', () => {
      if (browserRec && !browserRec.window.isDestroyed()) browserRec.window.focus();
      chromeRec?.focus();
    });
    handle('recorder:stop', () => stopRecording());
    // Our own listeners (the recorder, the dev renderer) are never the API.
    handle('local:scan', async () => {
      const { findLocalServers } = await import('../core/localServers');
      return findLocalServers({ skipPorts: [5473, ...(recorder ? [recorder.port] : [])] });
    });
    // A local service whose spec needs signing in: fetch it with the token
    // (or cookie) the person has, and keep that as the environment's sign-in.
    handle('local:importSpec', async ({ port, auth, title }) => {
      const { SPEC_PATHS } = await import('../core/localServers');
      const raw = auth.trim().replace(/^(authorization|cookie)\s*:\s*/i, '');
      const isCookie = /^cookie\s*:/i.test(auth.trim()) || (/^[\w.-]+=[^\s]/.test(raw) && !/^(bearer|basic)\s/i.test(raw));
      const header: [string, string] = isCookie ? ['cookie', raw] : ['authorization', /^(bearer|basic)\s/i.test(raw) ? raw : `Bearer ${raw}`];
      const withAuth: typeof fetch = (u, init) => fetch(u, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), [header[0]]: header[1] } });
      const base = `http://127.0.0.1:${port}`;
      let last = '';
      for (const p of SPEC_PATHS) {
        try {
          const r = await core.importFromUrl(base + p, withAuth);
          const project = r.project;
          if (title?.trim()) project.title = title.trim();
          const prefix = varPrefix(project.name);
          const secret = isCookie ? `${prefix}_SESSION` : `${prefix}_TOKEN`;
          project.envs = project.envs.map((e, i) =>
            i === 0
              ? {
                  ...e,
                  baseUrl: e.baseUrl && !/^\//.test(e.baseUrl) ? e.baseUrl.replace('127.0.0.1', 'localhost') : `http://localhost:${port}${e.baseUrl ?? ''}`,
                  ...(isCookie || /^basic\s/i.test(header[1])
                    ? { auth: { type: 'none' as const }, headers: { ...(e.headers ?? {}), [isCookie ? 'Cookie' : 'Authorization']: `\${${secret}}` } }
                    : { auth: { type: 'bearer' as const, tokenVar: secret } }),
                }
              : e,
          );
          const file = create(project);
          secrets.setSecret(file, secret, isCookie ? raw : header[1].replace(/^bearer\s+/i, ''));
          return { ok: true, path: file, note: `${project.tools.length} requests from ${p}. Your ${isCookie ? 'cookie' : 'token'} is kept as ${secret} for sending them — replace it under Environments when it expires.` };
        } catch (e) {
          last = (e as Error).message;
        }
      }
      return { ok: false, error: /\b40[13]\b/.test(last) ? `Still refused with that ${isCookie ? 'cookie' : 'token'} — it may have expired, or need a different header. Try Read its code instead.` : `No spec at the usual places on :${port} (${last}). Try Read its code instead.` };
    });
    handle('recorder:state', () => ({ running: recording(), port: recPort, target: recTarget || undefined, calls: recorded, projectPath: recProject, mode: recMode, site: recSite, via: recVia }));
    // Recorded routes the API doesn't have yet, added to it — as requests,
    // not tools: try them first, as with any new request.
    handle('traffic:addNew', async (p) => {
      try {
        const project = core.readProject(p);
        const env = project.envs.find((e) => recTarget.startsWith(e.baseUrl.replace(/\/+$/, ''))) ?? project.envs[0];
        const calls = within(recorded, env?.baseUrl).filter((c) => !c.error);
        if (!calls.length) return { ok: false, error: 'Nothing recorded yet.' };
        const imported = core.importText(JSON.stringify(callsToHar(calls, env?.baseUrl || recTarget)), 'recording');
        const { mergeRecorded } = await import('../shared/merge');
        const merged = mergeRecorded(project, env?.baseUrl ?? '', imported);
        if (merged.added || merged.removed) core.writeProject(p, merged.project);
        return { ok: true, added: merged.added, removed: merged.removed };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    // Sends a recorded call again, exactly as captured — the browser's
    // session for browser calls — and records what came back beside it.
    handle('recorder:replay', async (id, base) => {
      const c = recorded.find((x) => x.id === id);
      if (!c) return { ok: false, error: 'That call is gone — it was cleared.' };
      const { replayable } = await import('../shared/snippets');
      const r = replayable(c, base || recTarget);
      const doFetch = c.url && recSite ? browser.sessionFetch(recSite) : (await import('../core/localFetch')).localFetch;
      const out: import('../shared/recording').RecordedCall = {
        id: randomUUID(),
        at: new Date().toISOString(),
        method: c.method,
        path: c.path,
        url: c.url,
        status: 0,
        statusText: '',
        ms: 0,
        requestHeaders: r.headers,
        requestBody: r.body,
        responseHeaders: {},
        contentType: '',
        bytes: 0,
        replayOf: c.id,
      };
      const started = Date.now();
      try {
        const res = await doFetch(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        Object.assign(out, { status: res.status, statusText: res.statusText, responseHeaders: headers, contentType: res.headers.get('content-type') ?? '', bytes: buf.length, responseBody: buf.length ? buf.subarray(0, 256 * 1024).toString('utf8') : undefined });
      } catch (e) {
        const reason = (e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
        out.error = `Could not send it again: ${reason}`;
      }
      out.ms = Date.now() - started;
      onCall(out);
      return { ok: true, call: out };
    });
    handle('recorder:clear', () => {
      recorded = [];
      if (recording()) updateTray({ count: 0 });
    });
    handle('recorder:build', async ({ title, signIn, target }) => {
      const base = (target || recTarget).trim().replace(/\/+$/, '');
      const calls = within(recorded, recMode === 'browser' ? base : undefined).filter((c) => !c.error);
      if (!calls.length) return { ok: false, error: recMode === 'browser' ? `Nothing recorded to ${base || 'that host'} yet.` : 'Nothing recorded yet.' };
      try {
        const imported = core.importText(JSON.stringify(callsToHar(calls, base)), `recording of ${base}`);
        const built = applyGraph(imported, calls, requestGraph(calls), { signIn });
        const project = built.project;
        if (title) project.title = title;
        else if (recMode === 'browser' && recSite) {
          project.title = nameForOrigin(new URL(recSite).origin);
        } else {
          // A local server: name it after its spec, or the project folder it
          // runs from — what the person would call it.
          const port = (() => {
            try {
              const u = new URL(base);
              return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) ? Number(u.port || 80) : 0;
            } catch {
              return 0;
            }
          })();
          if (port) {
            const { findLocalServers } = await import('../core/localServers');
            const here = (await findLocalServers({ skipPorts: [5473, recPort] })).find((s) => s.port === port);
            const named = here?.spec?.title ?? here?.folder;
            if (named) project.title = named;
          }
        }
        project.name = slug(project.title) || project.name;
        project.source = { kind: 'har', ref: `recorded from ${recMode === 'browser' ? `${recSite} (browser)` : base}`, importedAt: new Date().toISOString() };
        // Recorded in the browser: the session it used becomes the
        // environment's sign-in, unless a login request already is.
        let session: { found: string[]; secrets: Record<string, string> } | undefined;
        const env0 = project.envs[0];
        if (recMode === 'browser' && recSite && env0 && env0.auth.type !== 'login') {
          try {
            const plan = sessionPlan(await cookiesFrom(recVia, recSite, env0.baseUrl), recorded, env0.baseUrl, sessionPrefix(project.name, env0.name));
            project.envs[0] = { ...env0, auth: { type: 'none' }, headers: { ...(env0.headers ?? {}), ...plan.headers }, browserSession: { site: recSite, at: new Date().toISOString(), via: recVia } };
            session = plan;
          } catch {
            /* no session: it works signed out, or the person sets it up later */
          }
        }
        const file = create(project);
        for (const [name, value] of Object.entries(built.secrets)) secrets.setSecret(file, name, value);
        for (const [name, value] of Object.entries(session?.secrets ?? {})) secrets.setSecret(file, name, value);
        const parts = [`${project.tools.length} requests from ${calls.length} calls`];
        if (session) parts.push(`signed in with your browser session (${session.found.join(', ')})`);
        if (built.summary.length) parts.push(built.summary.slice(0, 3).join('; '));
        if (built.signIn && !signIn) parts.push(`${built.signIn.toolName} looks like a sign-in — set it up under Environments if it is`);
        return { ok: true, path: file, note: parts.join('. ') + '.' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    app.on('before-quit', () => void stopAll());

    // ---- tests: scenarios run once, or as load ------------------------------
    const { scenarioFromCalls } = await import('../shared/scenario');
    handle('scenario:fromRecording', (p, name) => {
      try {
        const project = core.readProject(p);
        const env = project.envs.find((e) => recTarget && recTarget.startsWith(e.baseUrl.replace(/\/+$/, ''))) ?? project.envs[0];
        const calls = within(recorded, env?.baseUrl).filter((c) => !c.error && !c.replayOf);
        if (!calls.length) return { ok: false, error: 'Nothing recorded for this API yet. Record traffic first, then save it as a test.' };
        const { basePathOf } = require('../shared/graph') as typeof import('../shared/graph');
        const sc = scenarioFromCalls(project, calls, requestGraph(calls), recMode === 'browser' || !recTarget ? basePathOf(env?.baseUrl) : basePathOf(recTarget), name);
        if (!sc.steps.length) return { ok: false, error: `None of the recorded calls is a request in ${project.title} yet. Add them from Coverage first.` };
        return { ok: true, scenario: { ...sc, env: env?.name } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('scenario:run', async (p, project, scenarioId, envName, allowWrites, until) => {
      const sc = project.scenarios?.find((s) => s.id === scenarioId);
      const env = project.envs.find((e) => e.name === envName);
      if (!sc || !env) return { ok: false, error: 'That scenario or environment is gone.' };
      try {
        const { peer, flush } = peers();
        const run = await core.runScenario(project, sc, env, {
          vars: vars(p),
          peer,
          timeoutMs: st.getSettings().timeoutSec * 1000,
          allowWrites,
          until,
          onStep: (result) => emit({ type: 'scenario:step', scenarioId, result }),
        });
        flush();
        // A partial run (one step replayed) isn't the scenario's result.
        if (!until) st.saveRun(p, run);
        return { ok: true, run };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('scenario:runs', (p) => st.lastRuns(p));
    let loadAbort: AbortController | null = null;
    handle('load:start', async (p, project, scenarioId, envName, opts) => {
      const sc = project.scenarios?.find((s) => s.id === scenarioId);
      const env = project.envs.find((e) => e.name === envName);
      if (!sc || !env) return { ok: false, error: 'That scenario or environment is gone.' };
      // A public host gets a polite load at most, whatever the page asked for.
      const { isPrivateHost, PUBLIC_LOAD_LIMITS } = await import('../shared/network');
      if (!isPrivateHost(env.baseUrl)) opts = { ...opts, users: Math.min(opts.users, PUBLIC_LOAD_LIMITS.users), durationSec: Math.min(opts.durationSec, PUBLIC_LOAD_LIMITS.durationSec) };
      if (loadAbort) return { ok: false, error: 'A load test is already running. Stop it first.' };
      loadAbort = new AbortController();
      try {
        const result = await core.runLoad(project, sc, env, { vars: vars(p), peer: peers().peer, timeoutMs: st.getSettings().timeoutSec * 1000, signal: loadAbort.signal, onTick: (snapshot) => emit({ type: 'load:tick', scenarioId, snapshot }) }, opts);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        loadAbort = null;
      }
    });
    handle('load:stop', () => loadAbort?.abort());

    // ---- browser sign-in: an environment that uses the person's session ---
    const useSession = async (p: string, project: Project, envName: string, site: string, via: import('../shared/recording').BrowserVia, extra: import('../shared/recording').RecordedCall[] = []) => {
      const env = project.envs.find((e) => e.name === envName);
      if (!env?.baseUrl) return { ok: false as const, error: `${envName} has no base URL.` };
      try {
        const plan = sessionPlan(await cookiesFrom(via, site, env.baseUrl), [...recorded, ...extra], env.baseUrl, sessionPrefix(project.name, env.name));
        for (const [name, value] of Object.entries(plan.secrets)) {
          const r = secrets.setSecret(p, name, value);
          if (!r.ok) return { ok: false as const, error: r.error ?? 'The keychain refused it.' };
        }
        return { ok: true as const, headers: plan.headers, found: plan.found, site: browser.normalizeSite(site), at: new Date().toISOString(), via };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
    };
    handle('browser:session', (p, project, envName, site, via) => useSession(p, project, envName, site, via ?? (chromeRec ? 'chrome' : recVia)));
    // Opens the site in its session to sign in (again); when the window
    // closes, the fresh session is read.
    let finishSignIn: (() => void) | null = null;
    handle('browser:signInDone', () => finishSignIn?.());
    handle('browser:signIn', async (p, project, envName, site, via = 'overapi') => {
      const seen: import('../shared/recording').RecordedCall[] = [];
      try {
        await new Promise<void>((resolve, reject) => {
          if (via === 'chrome') {
            chrome
              .startChromeRecorder({ site, onCall: (c) => seen.push(c), onClosed: resolve })
              .then((r) => (finishSignIn = () => r.stop()))
              .catch(reject);
            return;
          }
          browser
            .startBrowserRecorder({ site, label: `Sign in to ${project.title}`, bar: { kind: 'signin', text: project.title }, onCall: (c) => seen.push(c), onClosed: resolve })
            .then((r) => (finishSignIn = () => r.stop()))
            .catch(reject);
        });
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      finishSignIn = null;
      return useSession(p, project, envName, site, via, seen);
    });


    /// How an environment signs in, done again. Follows "signed in by
    /// another API" to the API that actually signs in (a few hops at most).
    const renew = async (p: string, envName: string, hops = 0): Promise<{ ok: true; renewed: string; title: string; note: string } | { ok: false; error: string; manual?: boolean }> => {
      let project: Project;
      try {
        project = core.readProject(p);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const env = project.envs.find((e) => e.name === envName);
      if (!env) return { ok: false, error: `${project.title} has no ${envName} environment.` };
      if (env.auth.type === 'via') {
        if (hops > 3) return { ok: false, error: 'The sign-ins point at each other in a loop. Pick the API that really signs in.' };
        const via = env.auth;
        const peerPath = [via.path, ...st.listProjects()].find((x) => {
          try {
            return !!x && core.readProject(x).name === via.api;
          } catch {
            return false;
          }
        });
        if (!peerPath) return { ok: false, error: `Can’t find ${via.api} on this Mac.` };
        const { providerEnv } = await import('../shared/system');
        const pe = providerEnv(core.readProject(peerPath), envName);
        if (!pe) return { ok: false, error: `${via.api} has no ${envName} environment to sign in with.` };
        return renew(peerPath, pe.name, hops + 1);
      }
      if (env.auth.type === 'login') {
        const rt = runtimeValues(p);
        try {
          await core.signIn(project, env, env.auth, { vars: vars(p), runtime: rt, timeoutMs: st.getSettings().timeoutSec * 1000 });
          syncRuntime(p, rt, 'sign-in');
          return { ok: true, renewed: p, title: project.title, note: `Signed in to ${project.title} (${env.name}) again.` };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
      if (env.browserSession) {
        const { site, via } = env.browserSession;
        const seen: import('../shared/recording').RecordedCall[] = [];
        try {
          await new Promise<void>((resolve, reject) => {
            if (via === 'chrome') {
              chrome
                .startChromeRecorder({ site, onCall: (c) => seen.push(c), onClosed: resolve })
                .then((r) => (finishSignIn = () => r.stop()))
                .catch(reject);
              return;
            }
            browser
              .startBrowserRecorder({ site, label: `Sign in to ${project.title}`, bar: { kind: 'signin', text: project.title }, onCall: (c) => seen.push(c), onClosed: resolve })
              .then((r) => (finishSignIn = () => r.stop()))
              .catch(reject);
          });
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        } finally {
          finishSignIn = null;
        }
        const r = await useSession(p, project, envName, site, via ?? 'overapi', seen);
        if (!r.ok) return { ok: false, error: r.error };
        const { isSessionHeader } = await import('../shared/session');
        const fresh = core.readProject(p);
        fresh.envs = fresh.envs.map((e) =>
          e.name === envName
            ? { ...e, auth: r.headers.Authorization ? { type: 'none' as const } : e.auth, headers: { ...Object.fromEntries(Object.entries(e.headers ?? {}).filter(([, v]) => !isSessionHeader(v))), ...r.headers }, browserSession: { site: r.site, at: r.at, via: r.via } }
            : e,
        );
        core.writeProject(p, fresh);
        return { ok: true, renewed: p, title: project.title, note: `Signed in to ${project.title} again — ${r.found.join(', ')}.` };
      }
      return { ok: false, manual: true, error: `${project.title}’s ${envName} uses a ${env.auth.type === 'none' ? 'no sign-in' : 'token or key you set'} — overapi can’t renew it by itself. Update it under Environments.` };
    };
    handle('auth:renew', (p, envName) => renew(p, envName));

    handle('installs:get', (p) => ({ claude: st.installedFor(p), overgo: st.publishedFor(p) }));
    handle('clipboard:write', (text) => clipboard.writeText(text));
    handle('shell:open', (url) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    });
  }

  function createWindow(): void {
    win = new BrowserWindow({
      icon: asset('icon.png'),
      width: 1360,
      height: 860,
      minWidth: 980,
      minHeight: 600,
      title: 'Overapi',
      titleBarStyle: 'hiddenInset',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c21' : '#f6f6f8',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Opens filling the screen: three panes of requests and responses want the room.
    win.once('ready-to-show', () => {
      win?.maximize();
      win?.show();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!DEV_URL || !url.startsWith(DEV_URL)) e.preventDefault();
    });
    if (DEV_URL) void win.loadURL(DEV_URL);
    else void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.on('closed', () => (win = null));
  }

  void app.whenReady().then(async () => {
    // Our icon in the Dock even unpackaged (packaged, the .icns does it).
    if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(asset('icon.png')));
    const trayImage = nativeImage.createFromPath(asset('trayTemplate.png'));
    trayImage.setTemplateImage(true);
    tray = new Tray(trayImage);
    updateTray();
    await registerIpc();
    createWindow();
    app.on('activate', () => {
      // A recording browser may be open; overapi's own window is what's missing.
      if (!win) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
