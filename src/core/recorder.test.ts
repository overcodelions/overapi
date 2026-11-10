import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { callsToHar, startRecorder, type RecordedCall, type Recorder } from './recorder';
import { importHar } from './import/har';
import { applyGraph, argsFromCall, basePathOf, requestGraph, suggestSignIn, toolForCall } from '../shared/graph';

let api: http.Server;
let target = '';
let rec: Recorder;
const calls: RecordedCall[] = [];

beforeAll(async () => {
  api = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ id: 1042, ...JSON.parse(body || '{}') }));
    }
    res.end(JSON.stringify(req.url?.startsWith('/v1/orders/') ? { id: Number(req.url.split('/').pop()), status: 'open' } : [{ id: 1, status: 'open' }]));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  target = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`;
  rec = await startRecorder({ target, port: 0, onCall: (c) => calls.push(c) });
});
afterAll(async () => {
  await rec.stop();
  api.close();
});

describe('recorder', () => {
  it('forwards calls untouched and records each exchange', async () => {
    const local = `http://127.0.0.1:${rec.port}`;
    const list = await fetch(`${local}/orders?status=open`, { headers: { authorization: 'Bearer live-secret-123' } });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{ id: 1, status: 'open' }]);
    await fetch(`${local}/orders/1042`);
    await fetch(`${local}/orders/1043`);
    const made = await fetch(`${local}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'ANVIL-1', qty: 2 }) });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ id: 1042, sku: 'ANVIL-1', qty: 2 });

    expect(calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toEqual(['GET /orders?status=open 200', 'GET /orders/1042 200', 'GET /orders/1043 200', 'POST /orders 201']);
    expect(calls[3].requestBody).toBe('{"sku":"ANVIL-1","qty":2}');
    expect(calls[0].responseBody).toBe('[{"id":1,"status":"open"}]');
  });

  it('builds an API from the calls, keeping no credential', () => {
    const p = importHar(callsToHar(calls, target), 'recording');
    expect(p.envs[0].baseUrl).toBe(target);
    expect(p.envs[0].auth.type).toBe('bearer');
    expect(p.tools.map((t) => t.id)).toEqual(['GET /orders', 'POST /orders', 'GET /orders/{order_id}']);
    expect(JSON.stringify(p)).not.toContain('live-secret-123');
  });

  it('finds the request graph and writes it into the API', async () => {
    // A legacy flow: log in, get a token, use it; create, get the id, fetch it.
    const graphCalls: RecordedCall[] = [];
    const g = await startRecorder({ target, port: 0, onCall: (c) => graphCalls.push(c), fetchImpl: (async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ data: { access_token: 'tok-abcdef-123456' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/orders') && init?.method === 'POST') return new Response(JSON.stringify({ id: 77001 }), { status: 201, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 77001, status: 'open' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch });
    const local = `http://127.0.0.1:${g.port}`;
    await fetch(`${local}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'wile', password: 'acme-pass-99' }) });
    const auth = { authorization: 'Bearer tok-abcdef-123456', 'content-type': 'application/json' };
    await fetch(`${local}/orders`, { method: 'POST', headers: auth, body: JSON.stringify({ sku: 'ANVIL-1' }) });
    await fetch(`${local}/orders/77001`, { headers: auth });
    await g.stop();

    const edges = requestGraph(graphCalls);
    expect(edges.map((e) => `${e.fromPath} -> ${e.where}${e.auth ? ' (auth)' : ''}`)).toEqual([
      'data.access_token -> header:authorization (auth)',
      'id -> path',
      'data.access_token -> header:authorization (auth)',
    ]);
    // Sign-in is suggested, never assumed: without the go-ahead nothing changes.
    const suggested = applyGraph(importHar(callsToHar(graphCalls, target), 'rec'), graphCalls, edges, { signIn: false });
    expect(suggested.signIn).toMatchObject({ toolName: 'create_login', path: 'data.access_token', header: 'authorization' });
    expect(suggested.project.envs[0].auth.type).not.toBe('login');
    expect(suggested.secrets).toEqual({});
    const built = applyGraph(importHar(callsToHar(graphCalls, target), 'rec'), graphCalls, edges, { signIn: true });
    expect(built.project.envs[0].auth).toMatchObject({ type: 'login', toolId: 'POST /auth/login', from: 'body', path: 'data.access_token', sendAs: 'bearer' });
    const login = built.project.tools.find((t) => t.id === 'POST /auth/login')!;
    expect(login.example).toEqual({ user: 'wile', password: '${' + Object.keys(built.secrets)[0] + '}' });
    expect(Object.values(built.secrets)).toEqual(['acme-pass-99']);
    expect(JSON.stringify(built.project)).not.toContain('acme-pass-99');
    expect(JSON.stringify(built.project)).not.toContain('tok-abcdef');
    expect(built.project.tools.find((t) => t.id === 'POST /orders')!.captures).toEqual([{ var: 'order_id', from: 'body', path: 'id' }]);
    const get = built.project.tools.find((t) => t.id === 'GET /orders/{order_id}')!;
    expect(get.example).toEqual({ order_id: '{{order_id}}' });
    expect(get.params[0].description).toBe('Get it from create_order (id).');
    expect(built.summary[0]).toMatch(/^Sign-in: create_login|^Sign-in: .*login/);
  });

  it('reads real arguments out of a call, and plans a sign-in to suggest', () => {
    const p = importHar(callsToHar(calls, target), 'rec');
    const get = p.tools.find((t) => t.id === 'GET /orders/{order_id}')!;
    const one = calls.find((c) => c.path === '/orders/1043')!;
    expect(argsFromCall(get, one, basePathOf(target))).toEqual({ order_id: 1043 });
    const post = p.tools.find((t) => t.id === 'POST /orders')!;
    expect(argsFromCall(post, calls.find((c) => c.method === 'POST')!, basePathOf(target))).toEqual({ sku: 'ANVIL-1', qty: 2 });
    expect(toolForCall(p, one, basePathOf(target))?.id).toBe('GET /orders/{order_id}');
    expect(suggestSignIn(p, calls, requestGraph(calls), basePathOf(target))).toBeUndefined();
  });

  it('refuses a target that is not a URL', async () => {
    await expect(startRecorder({ target: 'acme', port: 0, onCall: () => undefined })).rejects.toThrow(/not a URL/);
  });
});
