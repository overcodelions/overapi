// A system: one API signs the others in. Against a real HTTP server — the
// "security" service hands out tokens, the "groups" service only answers
// with one — through a call, a refusal and refresh, and the system served
// as one MCP server.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callTool, type Peer } from './flow';
import { createServer } from './server';
import type { Project } from '../shared/project';
import { mergedNames } from '../shared/system';

let api: http.Server;
let base = '';
let issued = 0;
let current = '';

beforeAll(async () => {
  api = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/security/login') {
      current = `tok-${++issued}`;
      return res.end(JSON.stringify({ token: current }));
    }
    if (req.headers.authorization !== `Bearer ${current}` || !current) {
      res.statusCode = 401;
      return res.end('{"error":"no"}');
    }
    res.end(JSON.stringify({ items: [{ id: 'g1' }], path: req.url }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

const tool = (id: string, name: string, path: string, method: 'GET' | 'POST' = 'GET') => ({ id, name, description: name, enabled: true, safety: method === 'GET' ? ('read' as const) : ('write' as const), method, path, bodyMode: 'none' as const, params: [] });

function security(): Project {
  return {
    overapi: 1,
    name: 'security-service',
    title: 'Security',
    description: '',
    version: '1',
    envs: [{ name: 'local', baseUrl: `${base}/security`, allowWrites: false, auth: { type: 'login', toolId: 'POST /login', from: 'body', path: 'token', sendAs: 'bearer' } }],
    tools: [tool('POST /login', 'login', '/login', 'POST'), tool('GET /items', 'list_items', '/items')],
  };
}
function groups(): Project {
  return {
    overapi: 1,
    name: 'groups-service',
    title: 'Groups',
    description: '',
    version: '1',
    envs: [{ name: 'local', baseUrl: `${base}/groups`, allowWrites: false, auth: { type: 'via', api: 'security-service' } }],
    tools: [tool('GET /items', 'list_items', '/items'), tool('GET /groups', 'list_groups', '/groups')],
  };
}

describe('signed in by another API', () => {
  it('borrows the other API’s login, and refreshes it on a refusal', async () => {
    const sec = security();
    const secRuntime: Record<string, string> = {};
    const peer = (api: string): Peer | undefined => (api === sec.name ? { project: sec, vars: () => undefined, runtime: secRuntime } : undefined);
    const g = groups();
    const runtime: Record<string, string> = {};
    const first = await callTool(g, g.tools[1], g.envs[0], {}, { vars: () => undefined, runtime, peer });
    expect(first.result.status).toBe(200);
    expect(issued).toBe(1);
    // The token lives in the security API's session, once for everyone.
    expect(Object.values(secRuntime)).toContain('tok-1');
    expect(first.result.request.headers.authorization).not.toContain('tok-1');

    current = 'rotated';
    const again = await callTool(g, g.tools[1], g.envs[0], {}, { vars: () => undefined, runtime, peer });
    expect(again.result.status).toBe(200);
    expect(again.signedIn).toBe(true);
    expect(issued).toBe(2);
  });

  it('says plainly when the other API can’t be found', async () => {
    const g = groups();
    await expect(callTool(g, g.tools[1], g.envs[0], {}, { vars: () => undefined, runtime: {}, peer: () => undefined })).rejects.toThrow(/can’t find that API/);
  });
});

describe('a system served as one server', () => {
  it('prefixes only names two members share', () => {
    const named = mergedNames([
      { project: security(), tools: security().tools },
      { project: groups(), tools: groups().tools },
    ]).map((n) => n.name);
    expect(named).toEqual(['login', 'security_list_items', 'groups_list_items', 'list_groups']);
  });

  it('serves every member’s tools, signed in by the member that signs in', async () => {
    const members = [
      { path: '/x/security/overapi.json', project: security(), vars: () => undefined },
      { path: '/x/groups/overapi.json', project: groups(), vars: () => undefined },
    ];
    const server = createServer({ project: () => members[0].project, system: () => ({ name: 'acme-platform', title: 'Acme platform', members }), envName: 'local', vars: () => undefined, watchMs: 0 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['groups_list_items', 'list_groups', 'security_list_items']);
    expect(client.getInstructions()).toMatch(/2 services/);
    const r = (await client.callTool({ name: 'list_groups', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('/groups/groups');
    await client.close();
  });
});
