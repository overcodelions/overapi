// Recording in the person's own Chrome — for when the web app needs what
// only a real browser has: a password manager, other extensions, saved
// sign-ins.
//
// overapi launches the installed Chrome (or Brave, Edge, Chromium) with
// remote debugging, on a profile of its own: Chrome refuses debugging on the
// everyday profile, and a separate one keeps overapi out of everything else
// the person does. Extensions installed there stay. The calls come through
// the DevTools socket into the same network tap as overapi's own window.

import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RecordedCall } from '../shared/recording';
import { createTap, ENABLE_NETWORK, type Tap } from './networkTap';
import { normalizeSite } from './browserRecorder';

const CANDIDATES: [string, string][] = [
  ['Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
];

/// The first Chromium-family browser installed, if any.
export function findChrome(): { name: string; bin: string } | null {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    for (const [name, rel] of CANDIDATES) {
      const bin = path.join(dir, rel);
      if (fs.existsSync(bin)) return { name, bin };
    }
  }
  return null;
}

/// overapi's own profile in that browser — kept between recordings, so
/// extensions and sign-ins installed there stay.
const profileDir = () => path.join(app.getPath('userData'), 'chrome-profile');

/// A DevTools socket: commands with replies, events, flat sessions.
class Cdp {
  private id = 0;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners: ((method: string, params: any, sessionId?: string) => void)[] = [];
  onClose: () => void = () => undefined;
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.fail(new Error(m.error.message));
        else w?.ok(m.result);
      } else for (const l of this.listeners) l(m.method, m.params, m.sessionId);
    };
    ws.onclose = () => {
      for (const w of this.waiting.values()) w.fail(new Error('Chrome closed the connection.'));
      this.waiting.clear();
      this.onClose();
    };
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error('Could not connect to Chrome’s debugging port.'));
    });
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn: (method: string, params: any, sessionId?: string) => void): void {
    this.listeners.push(fn);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

/// Launches the browser on overapi's profile (or finds it already running
/// there) and connects to it.
async function launch(): Promise<{ cdp: Cdp; name: string }> {
  const found = findChrome();
  if (!found) throw new Error('No Chrome found — install Google Chrome (or Brave, Edge or Chromium), or record in overapi’s own window.');
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  const portFile = path.join(dir, 'DevToolsActivePort');
  // Already running on this profile from an earlier recording? Use it.
  const existing = await endpoint(portFile);
  if (existing) return { cdp: await Cdp.connect(existing), name: found.name };
  try {
    fs.rmSync(portFile, { force: true });
  } catch {
    /* fine */
  }
  const child = spawn(found.bin, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const url = await endpoint(portFile);
    if (url) return { cdp: await Cdp.connect(url), name: found.name };
  }
  throw new Error(`${found.name} started but didn’t open its debugging port. Quit it and try again.`);
}

/// The browser's DevTools socket, if one is answering for this profile.
async function endpoint(portFile: string): Promise<string | null> {
  let port: string;
  try {
    port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(port)) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return ((await r.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/// Cookies overapi's Chrome profile holds for a URL, HttpOnly ones
/// included — while that Chrome is running, recording or not.
export async function chromeCookies(url: string): Promise<{ name: string; value: string }[]> {
  const ws = await endpoint(path.join(profileDir(), 'DevToolsActivePort'));
  if (!ws) throw new Error('Chrome isn’t running on overapi’s profile. Use “Sign in again” to open it, sign in, then close the tab.');
  const cdp = await Cdp.connect(ws);
  try {
    const { cookies } = await cdp.send<{ cookies: { name: string; value: string; domain: string; path: string }[] }>('Storage.getCookies');
    const u = new URL(url);
    return cookies
      .filter((c) => (c.domain.startsWith('.') ? u.hostname === c.domain.slice(1) || u.hostname.endsWith(c.domain) : u.hostname === c.domain))
      .filter((c) => u.pathname.startsWith(c.path || '/'))
      .map((c) => ({ name: c.name, value: c.value }));
  } finally {
    cdp.close();
  }
}

export interface ChromeRecorder {
  site: string;
  name: string;
  /// Cookies the browser holds for a URL, HttpOnly ones included.
  cookies(url: string): Promise<{ name: string; value: string }[]>;
  focus(): void;
  /// Stops recording; the browser stays open.
  stop(): void;
  /// Stops and quits the browser.
  quit(): void;
}

export async function startChromeRecorder(opts: { site: string; onCall: (c: RecordedCall) => void; onClosed: () => void; record?: boolean }): Promise<ChromeRecorder> {
  const site = normalizeSite(opts.site);
  const record = opts.record !== false;
  const { cdp, name } = await launch();
  let stopped = false;
  const taps = new Map<string, Tap>();
  /// Pages (tabs) open on this profile: when the last closes, it's done.
  const pages = new Set<string>();
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    for (const t of taps.values()) t.stop();
    cdp.close();
    opts.onClosed();
  };
  cdp.onClose = done;

  /// One listener per tab: auto-attach and an explicit attach can both
  /// hand us a session for the same tab, and two would record each call twice.
  const primary = new Map<string, string>();
  const claim = (targetId: string, sessionId: string): string => {
    const have = primary.get(targetId);
    if (have && have !== sessionId) {
      void cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      return have;
    }
    primary.set(targetId, sessionId);
    void watch(sessionId);
    return sessionId;
  };
  const watch = async (sessionId: string) => {
    if (!record || taps.has(sessionId)) return;
    const tap = createTap((m, p) => cdp.send(m, p, sessionId), (c) => !stopped && opts.onCall(c));
    taps.set(sessionId, tap);
    await cdp.send(...ENABLE_NETWORK, sessionId).catch(() => undefined);
  };
  cdp.on((method, params, sessionId) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'page') {
      pages.add(params.targetInfo.targetId);
      claim(params.targetInfo.targetId, params.sessionId);
    } else if (method === 'Target.targetDestroyed') {
      if (pages.delete(params.targetId) && pages.size === 0) done();
    } else if (sessionId) taps.get(sessionId)?.handle(method, params);
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  // New tabs and windows are attached as they open.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  // One tab for the site: a blank one if the launch made it, else a new one.
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; attached: boolean }[] }>('Target.getTargets');
  for (const t of targetInfos) if (t.type === 'page') pages.add(t.targetId);
  const blank = targetInfos.find((t) => t.type === 'page' && t.url === 'about:blank');
  const targetId = blank?.targetId ?? (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true })).targetId;
  pages.add(targetId);
  const sessionId = primary.get(targetId) ?? claim(targetId, (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId);
  await cdp.send(...ENABLE_NETWORK, sessionId).catch(() => undefined);
  await cdp.send('Page.navigate', { url: site }, sessionId).catch(() => undefined);
  await cdp.send('Target.activateTarget', { targetId }).catch(() => undefined);

  return {
    site,
    name,
    cookies: (url) => chromeCookies(url),
    focus: () => void cdp.send('Target.activateTarget', { targetId }).catch(() => undefined),
    stop: () => {
      if (stopped) return;
      stopped = true;
      done();
    },
    quit: () => {
      stopped = true;
      void cdp.send('Browser.close').catch(() => undefined);
      done();
    },
  };
}
