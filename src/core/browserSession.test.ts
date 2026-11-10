// Recording a web app in the browser, and signing in the way it does:
// which calls count, which host is the API, how a session becomes headers
// — and, end to end against a real server, that requests carry it and an
// expired one says what to do instead of failing mysteriously.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isNoise, isUnder, likelyApi, originsOf, within, type RecordedCall } from '../shared/recording';
import { sessionPlan } from '../shared/session';
import { callsToHar } from './recorder';
import { importHar } from './import/har';
import { callTool } from './flow';
import type { Project } from '../shared/project';

let n = 0;
function call(url: string, extra: Partial<RecordedCall> = {}): RecordedCall {
  const u = new URL(url);
  return {
    id: `c${++n}`,
    at: new Date().toISOString(),
    method: 'GET',
    path: u.pathname + u.search,
    url,
    status: 200,
    statusText: 'OK',
    ms: 12,
    requestHeaders: {},
    responseHeaders: {},
    contentType: 'application/json',
    bytes: 10,
    responseBody: '{"ok":true}',
    ...extra,
  };
}

describe('browser recording', () => {
  it('leaves out analytics, assets and anything not http', () => {
    expect(isNoise('https://www.google-analytics.com/g/collect?v=2')).toBe(true);
    expect(isNoise('https://o123.ingest.sentry.io/api/5/envelope/')).toBe(true);
    expect(isNoise('https://app.acme.example/static/main.3f2a.js')).toBe(true);
    expect(isNoise('data:application/json,{}')).toBe(true);
    expect(isNoise('https://api.acme.example/v2/orders?page=2')).toBe(false);
  });

  it('scopes calls to the API by base URL, path included', () => {
    const a = call('https://api.acme.example/v2/orders');
    const b = call('https://api.acme.example/v2?x=1');
    const c = call('https://api.acme.example/v20/orders');
    const d = call('https://cdn.acme.example/v2/orders');
    expect(within([a, b, c, d], 'https://api.acme.example/v2/').map((x) => x.id)).toEqual([a.id, b.id]);
    // Calls through the local address have no URL: they all went to the API.
    const proxied = { ...a, url: undefined };
    expect(isUnder(proxied, 'https://elsewhere.example')).toBe(true);
  });

  it('picks the busiest JSON host as the likely API', () => {
    const calls = [
      call('https://app.acme.example/config', { contentType: 'text/html' }),
      call('https://app.acme.example/config', { contentType: 'text/html' }),
      call('https://app.acme.example/config', { contentType: 'text/html' }),
      call('https://api.acme.example/v2/orders'),
      call('https://api.acme.example/v2/orders/7'),
    ];
    expect(originsOf(calls)[0]).toEqual({ origin: 'https://app.acme.example', count: 3 });
    expect(likelyApi(calls)).toBe('https://api.acme.example');
  });

  it('builds requests from the API host only, with whole URLs', () => {
    const calls = [call('https://api.acme.example/v2/orders'), call('https://api.acme.example/v2/orders/1042'), call('https://app.acme.example/whoami')];
    const p = importHar(callsToHar(within(calls, 'https://api.acme.example'), 'https://ignored.example'), 'rec');
    expect(p.envs[0].baseUrl).toBe('https://api.acme.example/v2');
    expect(p.tools.map((t) => t.id).sort()).toEqual(['GET /orders', 'GET /orders/{order_id}']);
  });
});

describe('a browser session as headers', () => {
  const base = 'https://api.acme.example/v2';

  it('keeps cookies, and a CSRF header carrying a cookie’s value — using the cookie’s fresher value', () => {
    const calls = [
      call(`${base}/orders`, { method: 'POST', requestHeaders: { 'x-csrf-token': 'old-token-value-1', 'content-type': 'application/json' } }),
      call(`${base}/orders`, { method: 'POST', requestHeaders: { 'x-acme-guard': 'csrf-cookie-value-2' } }),
    ];
    const plan = sessionPlan(
      [
        { name: 'sid', value: 's%3Aabc123' },
        { name: 'csrf', value: 'csrf-cookie-value-2' },
      ],
      calls,
      base,
      'ACME',
    );
    expect(plan.headers).toEqual({ Cookie: '${ACME_SESSION}', 'X-Acme-Guard': '${ACME_CSRF}' });
    expect(plan.secrets).toEqual({ ACME_SESSION: 'sid=s%3Aabc123; csrf=csrf-cookie-value-2', ACME_CSRF: 'csrf-cookie-value-2' });
  });

  it('keeps a token the page sends itself, and ignores other hosts’ headers', () => {
    const calls = [call('https://other.example/x', { requestHeaders: { authorization: 'Bearer not-this' } }), call(`${base}/me`, { requestHeaders: { authorization: 'Bearer eyJ.page.token' } })];
    const plan = sessionPlan([], calls, base, 'ACME');
    expect(plan.headers).toEqual({ Authorization: '${ACME_TOKEN}' });
    expect(plan.secrets.ACME_TOKEN).toBe('Bearer eyJ.page.token');
    expect(plan.found).toEqual(['a bearer token']);
  });

  it('says so when there is no sign-in to use', () => {
    expect(() => sessionPlan([], [call(`${base}/me`)], base, 'ACME')).toThrow(/No sign-in found for api\.acme\.example.*Sign in in the browser window/);
  });
});

describe('calling with a browser session', () => {
  let api: http.Server;
  let url = '';
  let valid = 'sid=live';
  beforeAll(async () => {
    api = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.cookie !== valid || req.headers['x-csrf-token'] !== 'guard-1') {
        res.statusCode = 401;
        return res.end('{"error":"signed out"}');
      }
      res.end('{"orders":[]}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => api.close());

  const project = (): Project => ({
    overapi: 1,
    name: 'acme',
    title: 'Acme',
    description: '',
    version: '1',
    envs: [
      {
        name: 'prod',
        baseUrl: url,
        allowWrites: false,
        auth: { type: 'none' },
        headers: { Cookie: '${ACME_SESSION}', 'X-Csrf-Token': '${ACME_CSRF}' },
        browserSession: { site: `${url}/`, at: '2026-11-09T10:00:00Z' },
      },
    ],
    tools: [{ id: 'GET /orders', name: 'list_orders', description: '', enabled: true, safety: 'read', method: 'GET', path: '/orders', params: [], bodyMode: 'none' }],
  });
  const secrets: Record<string, string> = { ACME_SESSION: 'sid=live', ACME_CSRF: 'guard-1' };

  it('sends the session, and scrubs it from what is shown', async () => {
    const p = project();
    const out = await callTool(p, p.tools[0], p.envs[0], {}, { vars: (k) => secrets[k], runtime: {} });
    expect(out.result.status).toBe(200);
    expect(out.hint).toBeUndefined();
    expect(JSON.stringify(out.result.request)).not.toContain('sid=live');
  });

  it('says how to sign in again once the session has ended', async () => {
    valid = 'sid=rotated';
    const p = project();
    const out = await callTool(p, p.tools[0], p.envs[0], {}, { vars: (k) => secrets[k], runtime: {} });
    expect(out.result.status).toBe(401);
    expect(out.hint).toMatch(/browser sign-in for "prod" has probably expired.*Sign in again \(it opens http:\/\/127\.0\.0\.1:\d+\/\)/);
  });
});

describe('the request graph and paging', () => {
  it('does not link a number that only matches a page size', async () => {
    const { requestGraph } = await import('../shared/graph');
    const a = call('https://api.acme.example/settings', { responseBody: '{"limitPct":100,"partnerId":"p-8a7c9fef2b8f"}' });
    const b = call('https://api.acme.example/events?size=100&partnerId=p-8a7c9fef2b8f');
    const edges = requestGraph([a, b]);
    expect(edges.map((e) => e.where)).toEqual(['query:partnerId']);
  });
});

describe('replaying a recorded call', () => {
  it('keeps what the request needs and drops what one connection added', async () => {
    const { replayable, asCurl, asFetch, asPython, asHttpie } = await import('../shared/snippets');
    const c = call('https://api.acme.example/v2/orders?x=1', {
      method: 'POST',
      requestHeaders: { host: 'api.acme.example', 'content-length': '13', 'sec-fetch-mode': 'cors', cookie: "sid=a'b", 'content-type': 'application/json' },
      requestBody: '{"sku":"A1"}',
    });
    const r = replayable(c);
    expect(r.headers).toEqual({ cookie: "sid=a'b", 'content-type': 'application/json' });
    expect(asCurl(r)).toBe(`curl -X POST 'https://api.acme.example/v2/orders?x=1' \\\n  -H 'cookie: sid=a'\\''b' \\\n  -H 'content-type: application/json' \\\n  --data-raw '{"sku":"A1"}'`);
    expect(asFetch(r)).toContain('"body": "{\\"sku\\":\\"A1\\"}"');
    expect(asPython(r)).toContain('requests.request(\n    "POST",');
    expect(asHttpie(r)).toMatch(/^http --raw '\{"sku":"A1"\}' POST/);
    // Through the local address: the API's base comes from the recorder.
    expect(replayable({ ...c, url: undefined, path: '/orders' }, 'http://localhost:5002/api/').url).toBe('http://localhost:5002/api/orders');
  });
});

describe('dev server noise', () => {
  it('leaves out the dev server’s own traffic', () => {
    for (const u of ['http://localhost:4200/sockjs-node/info?t=1', 'http://localhost:4200/assets/i18n/en.json?0.0.0', 'http://localhost:5173/@vite/client', 'http://localhost:3000/_next/static/x.json', 'http://localhost:3000/main.abc.hot-update.json']) {
      expect(isNoise(u), u).toBe(true);
    }
    expect(isNoise('http://localhost:4200/api/suppliers/settings')).toBe(false);
  });
});

describe('one session per environment and site', () => {
  it('names secrets per environment and knows when a session can’t sign a base URL', async () => {
    const { sessionPrefix, sameSite, isSessionHeader, siteGuess } = await import('../shared/session');
    expect(sessionPrefix('Sandbox API', 'default')).toBe('SANDBOX_DEFAULT');
    expect(sessionPrefix('Sandbox API', 'staging-2')).toBe('SANDBOX_STAGING_2');
    expect(sameSite('https://app.acme.example/', 'https://api.acme.example/v2')).toBe(true);
    expect(sameSite('https://app.sandbox.acme.example/', 'https://localhost:4200/api')).toBe(false);
    expect(sameSite('http://localhost:4200/', 'https://localhost:4200/api')).toBe(true);
    expect(isSessionHeader('${SANDBOX_SESSION}')).toBe(true);
    expect(isSessionHeader('{{tenant}}')).toBe(false);
    expect(siteGuess('https://localhost:4200/api')).toBe('https://localhost:4200');
  });
});

describe('a sign-in for another site', () => {
  it('says so instead of calling it expired', async () => {
    const { sessionExpiredHint } = await import('../shared/session');
    expect(sessionExpiredHint('default', 'https://app.sandbox.acme.example/', 'https://localhost:4200/api')).toBe(
      '"default" is signed in to app.sandbox.acme.example, but its requests go to localhost:4200 — that session can\'t sign them. In overapi, open Environments → default → Sign in there.',
    );
    expect(sessionExpiredHint('prod', 'https://app.acme.example/', 'https://api.acme.example/v2')).toMatch(/has probably expired/);
  });
});
