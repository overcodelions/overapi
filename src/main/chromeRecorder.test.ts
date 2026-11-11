import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-chrome-'));
vi.mock('electron', () => ({ app: { getPath: () => root }, BaseWindow: class {}, WebContentsView: class {}, session: {} }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const { findChrome, chromeCookies } = await import('./chromeRecorder');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('findChrome', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds the first Chromium-family browser, /Applications before ~/Applications', () => {
    const present = new Set([path.join(os.homedir(), 'Applications', 'Google Chrome.app/Contents/MacOS/Google Chrome'), '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => present.has(String(p)));
    expect(findChrome()).toEqual({ name: 'Brave', bin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' });
  });

  it('prefers Chrome, then Brave, Edge, Chromium', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => /Microsoft Edge|Chromium|Google Chrome/.test(String(p)));
    expect(findChrome()?.name).toBe('Chrome');
  });

  it('looks in ~/Applications too', () => {
    const bin = path.join(os.homedir(), 'Applications', 'Chromium.app/Contents/MacOS/Chromium');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p) === bin);
    expect(findChrome()).toEqual({ name: 'Chromium', bin });
  });

  it('is null with none installed', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(findChrome()).toBeNull();
  });
});

// ---- chromeCookies over a fake DevTools socket ------------------------------------------

type Cookie = { name: string; value: string; domain: string; path: string };
let cookies: Cookie[] = [];
let sockets: FakeSocket[] = [];
let answerError: string | null = null;

class FakeSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: { id: number; method: string }[] = [];
  closed = false;
  constructor(public url: string) {
    sockets.push(this);
    queueMicrotask(() => (url.includes('refuse') ? this.onerror?.() : this.onopen?.()));
  }
  send(s: string) {
    const m = JSON.parse(s) as { id: number; method: string };
    this.sent.push(m);
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(answerError ? { id: m.id, error: { message: answerError } } : { id: m.id, result: { cookies } }) }));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const portFile = path.join(root, 'chrome-profile', 'DevToolsActivePort');

describe('chromeCookies', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sockets = [];
    answerError = null;
    cookies = [
      { name: 'host', value: '1', domain: 'app.acme.example', path: '/' },
      { name: 'dot', value: '2', domain: '.acme.example', path: '/' },
      { name: 'api', value: '3', domain: 'app.acme.example', path: '/api' },
      { name: 'other', value: '4', domain: 'other.example', path: '/' },
      { name: 'sub', value: '5', domain: 'deep.app.acme.example', path: '/' },
      { name: 'nopath', value: '6', domain: 'app.acme.example', path: '' },
      { name: 'evil', value: '7', domain: '.evilacme.example', path: '/' },
    ];
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, '9222\n/devtools/browser/abc\n');
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(portFile, { force: true });
  });

  it('asks the running Chrome for its cookies and keeps those for the URL’s host and path', async () => {
    const list = await chromeCookies('https://app.acme.example/api/teams');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9222/json/version', expect.objectContaining({ signal: expect.anything() }));
    expect(sockets[0].url).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
    expect(sockets[0].sent[0]).toMatchObject({ method: 'Storage.getCookies' });
    expect(list).toEqual([
      { name: 'host', value: '1' },
      { name: 'dot', value: '2' },
      { name: 'api', value: '3' },
      { name: 'nopath', value: '6' },
    ]);
    expect(sockets[0].closed).toBe(true);
  });

  it('a domain cookie matches the bare domain too, and a path cookie only under its path', async () => {
    const list = await chromeCookies('https://acme.example/teams');
    expect(list.map((c) => c.name)).toEqual(['dot']);
  });

  // BUG: path matching is a plain prefix test, so a cookie for /api is
  // also sent for /apix (RFC 6265 §5.1.4: the next character after the
  // cookie path must be "/" unless the path already ends in one).
  it('does not match a cookie path that is only a string prefix', async () => {
    const list = await chromeCookies('https://app.acme.example/apix');
    expect(list.map((c) => c.name)).not.toContain('api');
  });

  it('says Chrome is not running when there is no port file', async () => {
    fs.rmSync(portFile);
    await expect(chromeCookies('https://app.acme.example/')).rejects.toThrow('Chrome isn’t running on overapi’s profile.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says Chrome is not running when the port file is junk or nothing answers', async () => {
    fs.writeFileSync(portFile, 'abc\n');
    await expect(chromeCookies('https://app.acme.example/')).rejects.toThrow('isn’t running');
    fs.writeFileSync(portFile, '9222\n');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(chromeCookies('https://app.acme.example/')).rejects.toThrow('isn’t running');
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await expect(chromeCookies('https://app.acme.example/')).rejects.toThrow('isn’t running');
  });

  it('reports a socket that will not connect', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/refuse' })));
    await expect(chromeCookies('https://app.acme.example/')).rejects.toThrow('Could not connect to Chrome’s debugging port.');
  });

  it('passes on a protocol error, and still closes the socket', async () => {
    answerError = 'Storage domain not available';
    await expect(chromeCookies('https://app.acme.example/')).rejects.toThrow('Storage domain not available');
    expect(sockets[0].closed).toBe(true);
  });
});
