import { describe, expect, it, vi } from 'vitest';
import { createTap, ENABLE_NETWORK, NOT_SENT } from './networkTap';
import type { RecordedCall } from '../shared/recording';

type Answer = Record<string, unknown> | Error;

/// A fake CDP `send`: answers per request id, throws when there is nothing.
function fakeSend(bodies: Record<string, Answer> = {}, posts: Record<string, Answer> = {}) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const id = String(params?.requestId);
    const table = method === 'Network.getResponseBody' ? bodies : method === 'Network.getRequestPostData' ? posts : {};
    const a = table[id];
    if (!a) throw new Error('No resource with given identifier found');
    if (a instanceof Error) throw a;
    return a as never;
  });
  return send as unknown as (<T>(method: string, params?: Record<string, unknown>) => Promise<T>) & typeof send;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(bodies: Record<string, Answer> = {}, posts: Record<string, Answer> = {}) {
  const send = fakeSend(bodies, posts);
  const calls: RecordedCall[] = [];
  const tap = createTap(send, (c) => calls.push(c));
  return { send, calls, tap };
}

const willBeSent = (id: string, over: Record<string, unknown> = {}, req: Record<string, unknown> = {}) => ({
  requestId: id,
  type: 'Fetch',
  timestamp: 100,
  wallTime: 1_700_000_000,
  ...over,
  request: { url: 'https://api.acme.example/v1/teams?season=2024', method: 'GET', headers: { Accept: 'application/json' }, ...req },
});

const responded = (id: string, r: Record<string, unknown> = {}) => ({
  requestId: id,
  response: { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, mimeType: 'application/json', ...r },
});

describe('createTap', () => {
  it('turns a fetch into a RecordedCall with method, path, url, status, headers and body', async () => {
    const { tap, calls, send } = setup({ r1: { body: '{"teams":[]}', base64Encoded: false } });
    tap.handle('Network.requestWillBeSent', willBeSent('r1'));
    tap.handle('Network.responseReceived', responded('r1'));
    tap.handle('Network.loadingFinished', { requestId: 'r1', timestamp: 100.25, encodedDataLength: 321 });
    await flush();
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c).toMatchObject({
      method: 'GET',
      path: '/v1/teams?season=2024',
      url: 'https://api.acme.example/v1/teams?season=2024',
      status: 200,
      statusText: 'OK',
      ms: 250,
      requestHeaders: { accept: 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      contentType: 'application/json',
      bytes: 321,
      responseBody: '{"teams":[]}',
      at: new Date(1_700_000_000 * 1000).toISOString(),
    });
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.error).toBeUndefined();
    expect(send).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' });
    expect(send).not.toHaveBeenCalledWith('Network.getRequestPostData', expect.anything());
  });

  it('keeps XHR as well as Fetch, and nothing else', async () => {
    const { tap, calls } = setup();
    for (const [id, type] of [['a', 'XHR'], ['b', 'Fetch'], ['c', 'Document'], ['d', 'Script'], ['e', 'Image'], ['f', undefined]] as const) {
      tap.handle('Network.requestWillBeSent', willBeSent(id, { type }));
      tap.handle('Network.loadingFinished', { requestId: id, timestamp: 101 });
    }
    await flush();
    expect(calls.map((c) => c.method + ' ' + c.status)).toHaveLength(2);
  });

  it('leaves out noise: analytics hosts, static files, dev-server traffic, non-http', async () => {
    const { tap, calls } = setup();
    const urls = [
      'https://www.google-analytics.com/collect',
      'https://o1.ingest.sentry.io/api/1/envelope/',
      'https://api.acme.example/app.js',
      'https://api.acme.example/logo.png',
      'https://api.acme.example/@vite/client',
      'https://api.acme.example/sockjs-node/info',
      'ws://api.acme.example/live',
      'not a url',
      'https://api.acme.example/v1/ok',
    ];
    urls.forEach((url, i) => {
      tap.handle('Network.requestWillBeSent', willBeSent(`n${i}`, {}, { url }));
      tap.handle('Network.loadingFinished', { requestId: `n${i}`, timestamp: 101 });
    });
    await flush();
    expect(calls.map((c) => c.path)).toEqual(['/v1/ok']);
  });

  it('keeps only GET/POST/PUT/PATCH/DELETE, any case, upper-cased', async () => {
    const { tap, calls } = setup();
    ['get', 'POST', 'Put', 'patch', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE'].forEach((method, i) => {
      tap.handle('Network.requestWillBeSent', willBeSent(`m${i}`, {}, { method }));
      tap.handle('Network.loadingFinished', { requestId: `m${i}`, timestamp: 101 });
    });
    await flush();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it('lowercases header names, stringifies values and drops HTTP/2 pseudo-headers', async () => {
    const { tap, calls } = setup();
    tap.handle('Network.requestWillBeSent', willBeSent('h', {}, { headers: { ':authority': 'api.acme.example', ':path': '/x', 'X-Acme-Trace': 'abc', 'Content-Length': 12 } }));
    tap.handle('Network.responseReceived', responded('h', { headers: { ':status': '200', 'X-Rate-Limit': 10, 'Content-Type': 'application/json' } }));
    tap.handle('Network.loadingFinished', { requestId: 'h', timestamp: 101 });
    await flush();
    expect(calls[0].requestHeaders).toEqual({ 'x-acme-trace': 'abc', 'content-length': '12' });
    expect(calls[0].responseHeaders).toEqual({ 'x-rate-limit': '10', 'content-type': 'application/json' });
  });

  it('merges the extra-info headers (cookies) over the request headers, before or after the request', async () => {
    const { tap, calls } = setup();
    // After.
    tap.handle('Network.requestWillBeSent', willBeSent('x1', {}, { headers: { Accept: 'application/json', 'X-A': '1' } }));
    tap.handle('Network.requestWillBeSentExtraInfo', { requestId: 'x1', headers: { Cookie: 'sid=acme', 'X-A': '2' } });
    tap.handle('Network.loadingFinished', { requestId: 'x1', timestamp: 101 });
    // Extra info for an unknown id is ignored.
    tap.handle('Network.requestWillBeSentExtraInfo', { requestId: 'nobody', headers: { Cookie: 'x' } });
    await flush();
    expect(calls[0].requestHeaders).toEqual({ accept: 'application/json', 'x-a': '2', cookie: 'sid=acme' });
  });

  it('keeps extra headers across a redirect (a second requestWillBeSent for the same id)', async () => {
    const { tap, calls } = setup();
    tap.handle('Network.requestWillBeSent', willBeSent('rd'));
    tap.handle('Network.requestWillBeSentExtraInfo', { requestId: 'rd', headers: { Cookie: 'sid=1' } });
    tap.handle('Network.requestWillBeSent', willBeSent('rd', {}, { url: 'https://api.acme.example/v2/teams' }));
    tap.handle('Network.loadingFinished', { requestId: 'rd', timestamp: 101 });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v2/teams');
    expect(calls[0].requestHeaders.cookie).toBe('sid=1');
  });

  it('takes the request body from postData, or asks for it when only hasPostData is set', async () => {
    const { tap, calls, send } = setup({}, { p2: { postData: '{"name":"Acme FC"}' } });
    tap.handle('Network.requestWillBeSent', willBeSent('p1', {}, { method: 'POST', postData: '{"a":1}' }));
    tap.handle('Network.loadingFinished', { requestId: 'p1', timestamp: 101 });
    tap.handle('Network.requestWillBeSent', willBeSent('p2', {}, { method: 'POST', hasPostData: true }));
    tap.handle('Network.loadingFinished', { requestId: 'p2', timestamp: 101 });
    await flush();
    expect(calls.find((c) => c.requestBody === '{"a":1}')).toBeTruthy();
    expect(calls.find((c) => c.requestBody === '{"name":"Acme FC"}')).toBeTruthy();
    expect(send).toHaveBeenCalledWith('Network.getRequestPostData', { requestId: 'p2' });
    expect(send).not.toHaveBeenCalledWith('Network.getRequestPostData', { requestId: 'p1' });
  });

  it('survives getRequestPostData failing (body gone) and still records the call', async () => {
    const { tap, calls } = setup({}, { p: new Error('gone') });
    tap.handle('Network.requestWillBeSent', willBeSent('p', {}, { method: 'PUT', hasPostData: true }));
    tap.handle('Network.loadingFinished', { requestId: 'p', timestamp: 101 });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].requestBody).toBeUndefined();
  });

  it('truncates request bodies at 64 KB and response bodies at 256 KB', async () => {
    const big = 'x'.repeat(300 * 1024);
    const { tap, calls } = setup({ t1: { body: big, base64Encoded: false }, t2: { body: 'ok', base64Encoded: false } }, { t2: { postData: big } });
    tap.handle('Network.requestWillBeSent', willBeSent('t1', {}, { method: 'POST', postData: big }));
    tap.handle('Network.loadingFinished', { requestId: 't1', timestamp: 101 });
    tap.handle('Network.requestWillBeSent', willBeSent('t2', {}, { method: 'POST', hasPostData: true }));
    tap.handle('Network.loadingFinished', { requestId: 't2', timestamp: 101 });
    await flush();
    const t1 = calls[0];
    expect(t1.requestBody).toHaveLength(64 * 1024);
    expect(t1.responseBody).toHaveLength(256 * 1024);
    expect(calls[1].requestBody).toHaveLength(64 * 1024);
  });

  it('decodes base64 bodies when the type is text-like, and drops binary ones', async () => {
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const { tap, calls } = setup({
      j: { body: enc('{"ok":true}'), base64Encoded: true },
      x: { body: enc('<a/>'), base64Encoded: true },
      b: { body: enc('\u0000\u0001'), base64Encoded: true },
    });
    for (const [id, mimeType] of [['j', 'application/json'], ['x', 'application/xml'], ['b', 'application/octet-stream']]) {
      tap.handle('Network.requestWillBeSent', willBeSent(id));
      tap.handle('Network.responseReceived', responded(id, { mimeType }));
      tap.handle('Network.loadingFinished', { requestId: id, timestamp: 101 });
    }
    await flush();
    expect(calls.map((c) => c.responseBody)).toEqual(['{"ok":true}', '<a/>', undefined]);
    // No encodedDataLength: bytes fall back to the decoded size.
    expect(calls[0].bytes).toBe(Buffer.byteLength('{"ok":true}'));
  });

  it('falls back to the content-type header when there is no mimeType, then to empty', async () => {
    const { tap, calls } = setup();
    tap.handle('Network.requestWillBeSent', willBeSent('c1'));
    tap.handle('Network.responseReceived', responded('c1', { mimeType: undefined, statusText: undefined, headers: { 'Content-Type': 'text/csv' } }));
    tap.handle('Network.loadingFinished', { requestId: 'c1', timestamp: 101 });
    tap.handle('Network.requestWillBeSent', willBeSent('c2'));
    tap.handle('Network.responseReceived', responded('c2', { mimeType: undefined, headers: {} }));
    tap.handle('Network.loadingFinished', { requestId: 'c2', timestamp: 101 });
    await flush();
    expect(calls[0].contentType).toBe('text/csv');
    expect(calls[0].statusText).toBe('');
    expect(calls[1].contentType).toBe('');
  });

  it('records a call with no body (204, redirect) when getResponseBody fails', async () => {
    const { tap, calls } = setup();
    tap.handle('Network.requestWillBeSent', willBeSent('n', {}, { method: 'DELETE' }));
    tap.handle('Network.responseReceived', responded('n', { status: 204, statusText: 'No Content', mimeType: '' }));
    tap.handle('Network.loadingFinished', { requestId: 'n', timestamp: 101 });
    await flush();
    expect(calls[0]).toMatchObject({ status: 204, bytes: 0 });
    expect(calls[0].responseBody).toBeUndefined();
  });

  it('an empty body leaves responseBody undefined', async () => {
    const { tap, calls } = setup({ e: { body: '', base64Encoded: false } });
    tap.handle('Network.requestWillBeSent', willBeSent('e'));
    tap.handle('Network.loadingFinished', { requestId: 'e', timestamp: 101 });
    await flush();
    expect(calls[0].responseBody).toBeUndefined();
  });

  it('drops a canceled request without recording it', async () => {
    const { tap, calls, send } = setup();
    tap.handle('Network.requestWillBeSent', willBeSent('cx'));
    tap.handle('Network.loadingFailed', { requestId: 'cx', timestamp: 101, canceled: true, errorText: 'net::ERR_ABORTED' });
    tap.handle('Network.loadingFinished', { requestId: 'cx', timestamp: 102 });
    await flush();
    expect(calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('marks a request the read-only guard blocked as NOT_SENT, without fetching a body', async () => {
    const { tap, calls, send } = setup({ bl: { body: 'nope', base64Encoded: false } });
    tap.handle('Network.requestWillBeSent', willBeSent('bl', {}, { method: 'POST' }));
    tap.handle('Network.loadingFailed', { requestId: 'bl', timestamp: 100.5, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].error).toBe(NOT_SENT);
    expect(calls[0].ms).toBe(500);
    expect(calls[0].responseBody).toBeUndefined();
    expect(send).not.toHaveBeenCalledWith('Network.getResponseBody', expect.anything());
  });

  it('describes any other failure in the error text', async () => {
    const { tap, calls } = setup();
    tap.handle('Network.requestWillBeSent', willBeSent('f'));
    tap.handle('Network.loadingFailed', { requestId: 'f', timestamp: 101, errorText: 'net::ERR_CONNECTION_REFUSED' });
    await flush();
    expect(calls[0].error).toBe('The browser could not complete it: net::ERR_CONNECTION_REFUSED');
  });

  it('ignores events for requests it never kept, and records each call once', async () => {
    const { tap, calls } = setup();
    tap.handle('Network.responseReceived', responded('ghost'));
    tap.handle('Network.loadingFinished', { requestId: 'ghost', timestamp: 1 });
    tap.handle('Network.loadingFailed', { requestId: 'ghost', timestamp: 1, errorText: 'x' });
    tap.handle('Network.dataReceived', { requestId: 'ghost' });
    tap.handle('Network.requestWillBeSent', willBeSent('once'));
    tap.handle('Network.loadingFinished', { requestId: 'once', timestamp: 101 });
    tap.handle('Network.loadingFinished', { requestId: 'once', timestamp: 102 });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('never reports a negative duration, and uses now when wallTime is missing', async () => {
    const { tap, calls } = setup();
    const before = Date.now();
    tap.handle('Network.requestWillBeSent', willBeSent('neg', { wallTime: undefined, timestamp: 200 }));
    tap.handle('Network.loadingFinished', { requestId: 'neg', timestamp: 199 });
    await flush();
    expect(calls[0].ms).toBe(0);
    expect(new Date(calls[0].at).getTime()).toBeGreaterThanOrEqual(before - 1);
  });

  it('after stop(): ignores new events and does not report calls already in flight', async () => {
    let release!: (v: unknown) => void;
    const send = vi.fn(() => new Promise((r) => (release = r))) as never;
    const calls: RecordedCall[] = [];
    const tap = createTap(send, (c) => calls.push(c));
    tap.handle('Network.requestWillBeSent', willBeSent('s1'));
    tap.handle('Network.loadingFinished', { requestId: 's1', timestamp: 101 });
    tap.stop();
    release({ body: 'late', base64Encoded: false });
    tap.handle('Network.requestWillBeSent', willBeSent('s2'));
    tap.handle('Network.loadingFinished', { requestId: 's2', timestamp: 101 });
    await flush();
    expect(calls).toEqual([]);
  });

  it('enables the Network domain with the request-body cap', () => {
    expect(ENABLE_NETWORK).toEqual(['Network.enable', { maxPostDataSize: 64 * 1024 }]);
  });
});
