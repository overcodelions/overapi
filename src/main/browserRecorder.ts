// The recording browser: a window overapi opens on a web app, which the
// person signs in to and uses normally while every call the page makes to
// its backend is kept — for the system with no public API, whose web app
// talks to a private one.
//
// overapi owns this browser, so it reads the traffic through Chromium's
// own debugging protocol (the Network domain): requests and responses with
// their bodies, HTTPS included, with no certificate to install and nothing
// else on the Mac touched. Only the page's own data calls (fetch and XHR)
// are kept; pages, scripts, images and analytics are not.
//
// Each site gets its own persistent session, so a sign-in survives between
// recordings — and is what "Use browser sign-in" reads cookies from.

import { BaseWindow, WebContentsView, session as electronSession } from 'electron';
import type { RecordedCall } from '../shared/recording';
import { createTap, ENABLE_NETWORK } from './networkTap';


export interface BrowserRecorder {
  site: string;
  window: BaseWindow;
  /// The bar's call count (recording).
  setCount(n: number): void;
  /// A line of status on the bar — "Exploring · page 7 of 40". Empty clears it.
  setNote(text: string): void;
  /// The site's page — for the explorer to drive.
  page: Electron.WebContents;
  stop(): void;
}

/// One session per site host: sign in once, record many times.
export function partitionFor(site: string): string {
  let host = site;
  try {
    host = new URL(site).host;
  } catch {
    /* use as is */
  }
  return `persist:site-${host.toLowerCase().replace(/[^a-z0-9.-]/g, '_')}`;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

export function normalizeSite(input: string): string {
  const t = input.trim();
  if (!t) throw new Error('Give the web app’s address, like https://app.acme.example.');
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(t);
  const withScheme = /^[a-z]+:\/\//i.test(t) ? t : `${local ? 'http' : 'https'}://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a web address.`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://.');
  return u.toString();
}

/// Cookies the site's session holds for a URL — HttpOnly ones included,
/// which a page's own script can't see.
/// A dev server's self-signed certificate is fine on this Mac, nowhere else;
/// anything else gets Chromium's usual checks.
function trustLocal(ses: Electron.Session): void {
  ses.setCertificateVerifyProc((req, cb) => cb(LOCAL_HOST.test(req.hostname) ? 0 : -3));
}

/// fetch in the site's own session — for replaying a recorded call with
/// the same network, certificates and all.
export function sessionFetch(site: string): typeof fetch {
  const ses = electronSession.fromPartition(partitionFor(site));
  trustLocal(ses);
  return ((url: string | URL | Request, init?: RequestInit) => ses.fetch(String(url), init as never)) as typeof fetch;
}

export async function cookiesFor(site: string, url: string): Promise<{ name: string; value: string }[]> {
  const ses = electronSession.fromPartition(partitionFor(site));
  const list = await ses.cookies.get({ url });
  return list.map((c) => ({ name: c.name, value: c.value }));
}


export async function startBrowserRecorder(opts: {
  site: string;
  /// Shown in the window's title.
  label: string;
  onCall: (c: RecordedCall) => void;
  onClosed: () => void;
  /// Record (default) or only browse — for signing in again.
  record?: boolean;
  /// What the bar says: recording, or "sign in, then Done" (text: the API's name).
  bar?: { kind: 'record' | 'signin'; text: string };
}): Promise<BrowserRecorder> {
  const site = normalizeSite(opts.site);
  const record = opts.record !== false;
  /// The address an error page stands in for — what ⌘R retries.
  let lastFailed = '';
  // The window is two views: overapi's bar across the top — what's going
  // on and how to finish — and the site below it.
  const win = new BaseWindow({ width: 1280, height: 900, title: opts.label });
  const page = new WebContentsView({
    webPreferences: {
      partition: partitionFor(site),
      // A website, not overapi: none of the app's bridge, all of the sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const bar = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: true } });
  win.contentView.addChildView(page);
  win.contentView.addChildView(bar);
  const BAR = 44;
  const layout = () => {
    const { width, height } = win.getContentBounds();
    bar.setBounds({ x: 0, y: 0, width, height: BAR });
    page.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) });
  };
  layout();
  win.on('resize', layout);
  void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml(opts.bar ?? { kind: record ? 'record' : 'signin', text: opts.label }, site))}`);
  // The bar's buttons are links to a host that never resolves; following
  // one is the button press.
  bar.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (url.startsWith('https://overapi.invalid/')) stop();
  });
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const wc = page.webContents;

  trustLocal(wc.session);
  // Some sign-in pages turn embedded browsers away by their user agent.
  wc.setUserAgent(wc.getUserAgent().replace(/\s(Electron|overapi|Overapi)\/\S+/g, ''));
  // Sign-in popups ("Continue with…") open as windows in the same session.
  wc.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } },
  }));
  wc.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win.setTitle(`${opts.label} — ${title}`);
  });
  // A browser's keys: back, forward, reload.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta) return;
    const nav = wc.navigationHistory;
    if (input.key === '[' && nav.canGoBack()) nav.goBack();
    else if (input.key === ']' && nav.canGoForward()) nav.goForward();
    else if (input.key.toLowerCase() === 'r') void (lastFailed ? wc.loadURL(lastFailed).catch(() => undefined) : wc.reload());
    else return;
    e.preventDefault();
  });

  const dbg = wc.debugger;
  let stopped = false;
  const tap = createTap((method, params) => dbg.sendCommand(method, params), (c) => !stopped && opts.onCall(c));

  if (record) {
    // The debugger answers only once the window has a page: start blank,
    // switch recording on, then go to the site — so its first calls count.
    await wc.loadURL('about:blank');
    dbg.attach('1.3');
    dbg.on('message', (_e, method, params) => tap.handle(method, params));
    await dbg.sendCommand(...ENABLE_NETWORK);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    tap.stop();
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      /* closing */
    }
    if (!win.isDestroyed()) win.close();
  };
  win.on('closed', () => {
    stopped = true;
    // Views outlive their window unless closed.
    if (!wc.isDestroyed()) wc.close();
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
    opts.onClosed();
  });
  // A dev server's self-signed certificate: fine on this Mac, nowhere else.
  wc.on('certificate-error', (e, url, _error, _cert, callback) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL */
    }
    if (LOCAL_HOST.test(host)) {
      e.preventDefault();
      callback(true);
    } else callback(false);
  });
  // Never a blank window: say why the page didn't load, and try plain
  // http once when https was a guess at a local server that doesn't speak it.
  let retried = false;
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted: a redirect or a new navigation */ || url.startsWith('data:')) return;
    let u: URL | null = null;
    try {
      u = new URL(url);
    } catch {
      /* shown below */
    }
    if (!retried && u?.protocol === 'https:' && LOCAL_HOST.test(u.hostname) && /SSL|CONNECTION_(CLOSED|RESET)|EMPTY_RESPONSE/i.test(description)) {
      retried = true;
      u.protocol = 'http:';
      void wc.loadURL(u.toString()).catch(() => undefined);
      return;
    }
    const why =
      /CONNECTION_REFUSED/.test(description) ? 'Nothing is answering there — is the app running, and on that port?'
      : /NAME_NOT_RESOLVED/.test(description) ? 'That host name doesn’t resolve. Check the address.'
      : /CERT|SSL/.test(description) ? 'Its HTTPS certificate was refused. If it’s plain http, use http:// in the address.'
      : 'Check the address, then press ⌘R to try again.';
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const html = `<!doctype html><meta charset="utf-8"><title>Couldn’t open it</title><body style="font:14px -apple-system,system-ui,sans-serif;color:#222;background:#f6f6f8;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:520px;padding:24px"><h2 style="margin:0 0 8px;font-weight:600">Couldn’t open ${esc(url)}</h2><p style="color:#555;margin:0 0 12px">${esc(why)}</p><code style="color:#999;font-size:12px">${esc(description)} (${code})</code><p style="color:#777;margin-top:16px;font-size:13px">Still recording. Fix the address in overapi and press Stop, then start again — or press ⌘R here once it’s up.</p></div></body>`;
    void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
    lastFailed = url;
  });
  // ⌘R on the error page reloads the site, not the error page.
  wc.on('did-navigate', (_e, url) => {
    if (!url.startsWith('data:')) lastFailed = '';
  });
  void wc.loadURL(site).catch(() => {
    /* did-fail-load says why */
  });
  return {
    site,
    window: win,
    stop,
    page: wc,
    setNote: (text) => {
      if (!bar.webContents.isDestroyed()) void bar.webContents.executeJavaScript(`window.setNote && setNote(${JSON.stringify(text)})`).catch(() => undefined);
    },
    setCount: (n) => {
      if (!bar.webContents.isDestroyed()) void bar.webContents.executeJavaScript(`window.setCount && setCount(${Number(n)})`).catch(() => undefined);
    },
  };
}

/// overapi's bar above the site: what this window is for, and the button
/// that finishes it — so nobody has to guess that closing it is the end.
function barHtml(bar: { kind: 'record' | 'signin'; text: string }, site: string): string {
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const host = esc(site.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  const left =
    bar.kind === 'record'
      ? `<span class="dot rec"></span><b>Recording</b><span class="muted">${host} · use the app as usual — every call it makes is kept</span><span class="count"><span id="n">0</span> <span id="l">calls</span></span>`
      : `<span class="dot"></span><b>Sign in to ${esc(bar.text)}</b><span class="muted">then click Done — overapi keeps your session when you do</span>`;
  const button = bar.kind === 'record' ? 'Stop recording' : 'Done';
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#1f1f24;color:#ececf1;font:13px -apple-system,system-ui,sans-serif;overflow:hidden;-webkit-user-select:none}
.bar{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px 0 16px;border-bottom:1px solid #2c2c33;box-sizing:border-box}
.dot{width:8px;height:8px;border-radius:50%;background:#7c8bff;flex:none}.dot.rec{background:#f87171;animation:p 1.4s infinite}
@keyframes p{50%{opacity:.35}}
.muted{color:#a3a3ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.count{color:#a3a3ad;font-variant-numeric:tabular-nums;white-space:nowrap}
.note{color:#c7cdff;background:rgba(124,139,255,.15);padding:3px 9px;border-radius:999px;font-size:12px;white-space:nowrap}.sp{flex:1}.hint{color:#8b8b95;font-size:12px;white-space:nowrap}
a.btn{background:${bar.kind === 'record' ? '#ef4444' : '#5d72ff'};color:#fff;text-decoration:none;font-weight:600;padding:6px 14px;border-radius:7px;white-space:nowrap}
a.btn:focus-visible{outline:2px solid #c7cdff;outline-offset:2px}
</style><div class="bar" role="banner"><span style="font-weight:700;letter-spacing:-.01em">overapi</span>${left}<span class="sp"></span><span id="note" class="note" style="display:none"></span><span class="hint">or close this window</span><a class="btn" href="https://overapi.invalid/done">${button}</a></div>
<script>window.setNote=function(t){var e=document.getElementById('note');if(e){e.textContent=t;e.style.display=t?'':'none'}};window.setCount=function(n){var e=document.getElementById('n'),l=document.getElementById('l');if(e)e.textContent=n;if(l)l.textContent=n===1?'call':'calls'}</script>`;
}
