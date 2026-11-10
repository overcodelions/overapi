import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpSession } from './mcpClient';
import { createServer } from './server';
import type { Project } from '../shared/project';

let api: http.Server;
let baseUrl = '';
beforeAll(async () => {
  api = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
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
    version: '1',
    envs: [{ name: 'local', baseUrl, auth: { type: 'none' }, allowWrites }],
    tools: [
      { id: 'GET /orders/{id}', name: 'get_order', description: 'One order.', enabled: true, safety: 'read', method: 'GET', path: '/orders/{id}', bodyMode: 'none', params: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      { id: 'DELETE /orders/{id}', name: 'delete_order', description: 'Gone.', enabled: true, safety: 'destructive', method: 'DELETE', path: '/orders/{id}', bodyMode: 'none', params: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
    ],
  };
}

describe('McpSession (self)', () => {
  it('sees exactly what an agent sees, and calls through MCP', async () => {
    let p = project(false);
    let changed = 0;
    const server = createServer({ project: () => p, envName: 'local', vars: () => undefined, watchMs: 20 });
    const s = await McpSession.connect({ kind: 'self', server, label: 'acme' }, { onToolsChanged: () => changed++ });
    const info = await s.info();
    expect(info.name).toBe('acme');
    expect(info.instructions).toMatch(/Read-only/);
    expect(info.tools.map((t) => t.name)).toEqual(['get_order']);
    expect(info.approxTokens).toBeGreaterThan(20);

    const r = await s.call('get_order', { id: 7 });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('/orders/7');

    p = project(true);
    await new Promise((res) => setTimeout(res, 80));
    expect(changed).toBeGreaterThan(0);
    const after = await s.info();
    expect(after.tools.find((t) => t.name === 'delete_order')?.inputSchema.required).toContain('confirm');
    await s.close();
  });

  it('explains a stdio server that will not start', async () => {
    await expect(McpSession.connect({ kind: 'stdio', command: '', args: [] })).rejects.toThrow(/command/);
  });

  it('refuses a bad URL plainly', async () => {
    await expect(McpSession.connect({ kind: 'http', url: 'not a url' })).rejects.toThrow(/not a URL/);
  });
});
