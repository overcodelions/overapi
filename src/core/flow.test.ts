// Sign in with a request, end to end against a real HTTP server: the token
// is fetched on first need, sent on every call, refreshed on a 401 with one
// retry — and the login request is hidden from agents.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callTool, loginKey } from './flow';
import { createServer } from './server';
import { offered, type Project } from '../shared/project';

let api: http.Server;
let base = '';
let issued = 0;
let current = '';
const logins: string[] = [];

beforeAll(async () => {
  api = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/login') {
      let body = '';
      for await (const c of req) body += c;
      logins.push(body);
      const { user, password } = JSON.parse(body || '{}');
      if (user !== 'wile' || password !== 's3cret-pass') {
        res.statusCode = 401;
        return res.end('{"error":"bad login"}');
      }
      current = `tok-${++issued}`;
      return res.end(JSON.stringify({ data: { access_token: current } }));
    }
    if (req.headers.authorization !== `Bearer ${current}` || !current) {
      res.statusCode = 401;
      return res.end('{"error":"expired"}');
    }
    res.end(JSON.stringify({ id: 7, saw: req.headers.authorization }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

function project(): Project {
  return {
    overapi: 1,
    name: 'acme',
    title: 'Acme',
    description: '',
    version: '1',
    envs: [{ name: 'local', baseUrl: base, allowWrites: false, auth: { type: 'login', toolId: 'POST /auth/login', from: 'body', path: 'data.access_token', sendAs: 'bearer' } }],
    tools: [
      {
        id: 'POST /auth/login',
        name: 'login',
        description: 'Log in.',
        enabled: true,
        safety: 'write',
        method: 'POST',
        path: '/auth/login',
        bodyMode: 'json-fields',
        params: [
          { name: 'user', in: 'body', required: true, schema: { type: 'string' } },
          { name: 'password', in: 'body', required: true, schema: { type: 'string' } },
        ],
        example: { user: 'wile', password: '${ACME_PASSWORD}' },
      },
      { id: 'GET /orders/{id}', name: 'get_order', description: 'One order.', enabled: true, safety: 'read', method: 'GET', path: '/orders/{id}', bodyMode: 'none', params: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
    ],
  };
}
const vars = (n: string) => (n === 'ACME_PASSWORD' ? 's3cret-pass' : undefined);

describe('sign in with a request', () => {
  it('signs in on first need, then reuses the token', async () => {
    const p = project();
    const runtime: Record<string, string> = {};
    const first = await callTool(p, p.tools[1], p.envs[0], { id: 7 }, { vars, runtime });
    expect(first.signedIn).toBe(true);
    expect(first.result.status).toBe(200);
    expect(runtime[loginKey('local')]).toBe(current);
    // The password filled from the keychain, and never shown.
    expect(logins.at(-1)).toContain('s3cret-pass');
    const second = await callTool(p, p.tools[1], p.envs[0], { id: 7 }, { vars, runtime });
    expect(second.signedIn).toBe(false);
    expect(second.result.request.headers.authorization).toBe('Bearer •••');
  });

  it('signs in again on a 401 and retries once', async () => {
    const p = project();
    const runtime: Record<string, string> = { [loginKey('local')]: 'tok-stale' };
    const r = await callTool(p, p.tools[1], p.envs[0], { id: 7 }, { vars, runtime });
    expect(r.signedIn).toBe(true);
    expect(r.result.status).toBe(200);
    expect(runtime[loginKey('local')]).toBe(current);
  });

  it('says why when signing in fails', async () => {
    const p = project();
    await expect(callTool(p, p.tools[1], p.envs[0], { id: 7 }, { vars: () => 'wrong', runtime: {} })).rejects.toThrow(/Signing in failed: login answered 401/);
  });

  it('runs another request first — only while its value is missing', async () => {
    const p = project();
    p.tools.push({ id: 'GET /orders/{id}/x', name: 'next_order', description: '', enabled: true, safety: 'read', method: 'GET', path: '/orders/{{order_id}}', bodyMode: 'none', params: [], before: [{ toolId: 'GET /orders/{id}', when: 'missing', var: 'order_id' }] });
    p.tools[1] = { ...p.tools[1], example: { id: 7 }, captures: [{ var: 'order_id', from: 'body', path: 'id' }] };
    const runtime: Record<string, string> = {};
    const first = await callTool(p, p.tools[2], p.envs[0], {}, { vars, runtime });
    expect(first.ranFirst).toEqual(['get_order']);
    expect(first.result.request.url).toMatch(/\/orders\/7$/);
    const again = await callTool(p, p.tools[2], p.envs[0], {}, { vars, runtime });
    expect(again.ranFirst).toEqual([]);
  });

  it('hides the login request from agents, and agents still get signed in', async () => {
    const p = project();
    expect(offered(p.tools[0], p.envs[0])).toBe(false);
    const server = createServer({ project: () => p, envName: 'local', vars, watchMs: 0 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['get_order']);
    const r = await client.callTool({ name: 'get_order', arguments: { id: 7 } });
    expect(r.isError).toBe(false);
    expect((r.content as { text: string }[])[0].text).toMatch(/^HTTP 200/);
    await server.close();
  });
});
