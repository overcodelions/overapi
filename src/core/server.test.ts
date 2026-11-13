// The server end to end: a real MCP client over an in-memory transport,
// calling a real HTTP server on a loopback port.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server';
import type { Project } from '../shared/project';

let api: http.Server;
let baseUrl = '';
const seen: string[] = [];

beforeAll(async () => {
  api = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? '-'}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/orders/404')) {
      res.statusCode = 404;
      return res.end('{"error":"no such order"}');
    }
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

function project(allowWrites: boolean): Project {
  return {
    overapi: 1,
    name: 'acme',
    title: 'Acme',
    description: 'Orders.',
    version: '1.0.0',
    instructions: 'Order ids are integers.',
    envs: [{ name: 'local', baseUrl, auth: { type: 'bearer', tokenVar: 'TOKEN' }, allowWrites }],
    tools: [
      { id: 'GET /orders/{id}', name: 'get_order', description: 'One order.', enabled: true, safety: 'read', method: 'GET', path: '/orders/{id}', bodyMode: 'none', params: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      { id: 'POST /orders', name: 'create_order', description: 'New order.', enabled: true, safety: 'write', method: 'POST', path: '/orders', bodyMode: 'json-fields', params: [{ name: 'sku', in: 'body', required: true, schema: { type: 'string' } }] },
      { id: 'DELETE /orders/{id}', name: 'delete_order', description: 'Remove.', enabled: true, safety: 'destructive', method: 'DELETE', path: '/orders/{id}', bodyMode: 'none', params: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      { id: 'GET /secret', name: 'secret_report', description: 'Off.', enabled: false, safety: 'read', method: 'GET', path: '/secret', bodyMode: 'none', params: [] },
    ],
  };
}

async function connect(p: Project) {
  const server = createServer({ project: () => p, envName: 'local', vars: (n) => (n === 'TOKEN' ? 'tok_live_1234' : undefined) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content[0].text as string;

describe('MCP server', () => {
  it('offers only reads on a read-only environment, and tells the agent why', async () => {
    const client = await connect(project(false));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_order']);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(client.getInstructions()).toMatch(/Order ids are integers[\s\S]*Read-only/);
    const r = await client.callTool({ name: 'create_order', arguments: { sku: 'A' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/read-only/);
    const off = await client.callTool({ name: 'secret_report', arguments: {} });
    expect(text(off)).toMatch(/turned off/);
  });

  it('calls the API with auth and returns the status and body', async () => {
    const client = await connect(project(false));
    const r = await client.callTool({ name: 'get_order', arguments: { id: 7 } });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/^HTTP 200/);
    expect(text(r)).toContain('"/orders/7"');
    expect(seen).toContain('GET /orders/7 Bearer tok_live_1234');
  });

  it('marks API errors as errors', async () => {
    const client = await connect(project(false));
    const r = await client.callTool({ name: 'get_order', arguments: { id: 404 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^HTTP 404[\s\S]*no such order/);
  });

  it('requires confirm on destructive tools when writes are allowed', async () => {
    const client = await connect(project(true));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_order', 'create_order', 'delete_order']);
    const del = tools.find((t) => t.name === 'delete_order')!;
    expect(del.inputSchema.required).toEqual(['id', 'confirm']);
    expect(del.annotations?.destructiveHint).toBe(true);
    const refused = await client.callTool({ name: 'delete_order', arguments: { id: 3 } });
    expect(text(refused)).toMatch(/confirm: true/);
    const done = await client.callTool({ name: 'delete_order', arguments: { id: 3, confirm: true } });
    expect(done.isError).toBe(false);
    expect(seen).toContain('DELETE /orders/3 Bearer tok_live_1234');
  });

  it('tells the client when the offered tools change under it', async () => {
    let p = project(false);
    const server = createServer({ project: () => p, envName: 'local', vars: () => undefined, watchMs: 20 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools).toHaveLength(1);
    p = project(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(changed).toBe(1);
    expect((await client.listTools()).tools).toHaveLength(3);
    await server.close();
  });

  it('chains: a login’s token is kept and sent on the calls after it', async () => {
    const proj = project(false);
    proj.envs[0].auth = { type: 'none' };
    proj.tools.push(
      { id: 'GET /login', name: 'login', description: 'Log in.', enabled: true, safety: 'read', method: 'GET', path: '/login', bodyMode: 'none', params: [], captures: [{ var: 'token', from: 'body', path: 'url' }] },
      { id: 'GET /me', name: 'me', description: 'Who am I.', enabled: true, safety: 'read', method: 'GET', path: '/me', bodyMode: 'none', params: [], headers: { Authorization: 'Bearer {{token}}' } },
    );
    const client = await connect(proj);
    const first = await client.callTool({ name: 'login', arguments: {} });
    expect(text(first)).toMatch(/kept token for the calls after this one/);
    await client.callTool({ name: 'me', arguments: {} });
    expect(seen).toContain('GET /me Bearer /login');
  });

  it('reports missing arguments plainly', async () => {
    const client = await connect(project(true));
    const r = await client.callTool({ name: 'create_order', arguments: {} });
    expect(text(r)).toBe('Missing required argument: sku.');
  });
});

describe('examples for agents', () => {
  it('offers real, short values and never secrets or chain variables', async () => {
    const { toMcpTool } = await import('./server');
    const t = toMcpTool({
      id: 'GET /x', name: 'get_x', description: 'x', enabled: true, safety: 'read', method: 'GET', path: '/x', bodyMode: 'none',
      params: ['season', 'team', 'next', 'key', 'blank'].map((name) => ({ name, in: 'query' as const, required: false, schema: { type: 'string' } })),
      example: { season: 2025, team: 'Acme Rovers', next: '{{teamId}}', key: 'sk_live_abcdefghijklmnopqrstuvwx', blank: '' },
    });
    const props = (t.inputSchema as { properties: Record<string, { examples?: unknown[] }> }).properties;
    expect(props.season.examples).toEqual([2025]);
    expect(props.team.examples).toEqual(['Acme Rovers']);
    expect(props.next.examples).toBeUndefined();
    expect(props.key.examples).toBeUndefined();
    expect(props.blank.examples).toBeUndefined();
  });
});

describe('parameter names an agent can use', () => {
  it('renames bracketed query params and maps them back on a call', async () => {
    const p = project(false);
    p.tools.push({ id: 'GET /notes', name: 'list_notes', description: 'Notes.', enabled: true, safety: 'read', method: 'GET', path: '/notes', bodyMode: 'none', params: [
      { name: 'type[]', in: 'query', required: false, schema: { type: 'array', items: { type: 'string' } } },
      { name: 'type', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'filter[status]', in: 'query', required: true, schema: { type: 'string' } },
    ] });
    const client = await connect(p);
    const { tools } = await client.listTools();
    const notes = tools.find((t) => t.name === 'list_notes')!;
    expect(Object.keys(notes.inputSchema.properties!)).toEqual(['type_2', 'type', 'filter_status']);
    expect(notes.inputSchema.required).toEqual(['filter_status']);
    for (const t of tools) for (const k of Object.keys(t.inputSchema.properties ?? {})) expect(k).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
    const r = await client.callTool({ name: 'list_notes', arguments: { type_2: ['simple', 'conversation'], filter_status: 'open' } });
    expect(text(r)).toContain(encodeURIComponent('type[]') + '=simple');
    expect(text(r)).toContain(encodeURIComponent('filter[status]') + '=open');
  });
});
