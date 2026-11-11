// McpSession against real servers of the other two kinds: a stdio server
// (a small node script, started as a command) and a Streamable HTTP server
// on a local port. Both page their tool list, to cover allTools().

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpSession, approxTokens } from './mcpClient';

const sdk = (p: string) => pathToFileURL(path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm', p)).href;

/// Two pages of tools; `echo` answers with its arguments, `fail` is an error.
function acmeServer(): Server {
  const server = new Server({ name: 'acme-depot', version: '1.2.3' }, { capabilities: { tools: {} }, instructions: 'Depot tools.' });
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => (req.params?.cursor === 'page2' ? { tools: [tool('fail')] } : { tools: [tool('echo')], nextCursor: 'page2' }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    req.params.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'no such bin' }] } : { content: [{ type: 'text', text: JSON.stringify(req.params.arguments) }], structuredContent: { got: req.params.arguments } },
  );
  return server;
}

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-mcp-'));
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import { Server } from '${sdk('server/index.js')}';
import { StdioServerTransport } from '${sdk('server/stdio.js')}';
import { CallToolRequestSchema, ListToolsRequestSchema } from '${sdk('types.js')}';
const server = new Server({ name: 'acme-stdio', version: '0.0.1' }, { capabilities: { tools: {} } });
const tool = (name) => ({ name, inputSchema: { type: 'object', properties: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (req) => (req.params?.cursor ? { tools: [tool('second')] } : { tools: [tool('first')], nextCursor: 'c1' }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: process.env.ACME_GREETING + ' ' + req.params.name }] }));
await server.connect(new StdioServerTransport());
`,
  );
  fs.writeFileSync(path.join(dir, 'noisy.mjs'), `console.error('acme depot failed to load its config'); setTimeout(() => {}, 3000);`);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('McpSession (stdio)', () => {
  it('starts a command, pages its tools, passes env, and calls', async () => {
    const s = await McpSession.connect({ kind: 'stdio', command: process.execPath, args: [path.join(dir, 'server.mjs')], env: { ACME_GREETING: 'hello' }, cwd: dir });
    try {
      const info = await s.info();
      expect([info.name, info.version, info.instructions]).toEqual(['acme-stdio', '0.0.1', undefined]);
      expect(info.tools.map((t) => t.name)).toEqual(['first', 'second']);
      expect(info.approxTokens).toBe(approxTokens(info.tools));
      const r = await s.call('first', {});
      expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'hello first' }], structured: undefined });
      expect(r.ms).toBeGreaterThanOrEqual(0);
    } finally {
      await s.close();
    }
  });

  it('times out a server that never answers, quoting what it said', async () => {
    await expect(McpSession.connect({ kind: 'stdio', command: process.execPath, args: [path.join(dir, 'noisy.mjs')] }, { timeoutMs: 1500 })).rejects.toThrow(
      'Starting the server took longer than 1.5 s.\n\nThe server said:\nacme depot failed to load its config',
    );
  });

  it('times out with no tail when the server says nothing', async () => {
    await expect(McpSession.connect({ kind: 'stdio', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 2000)'] }, { timeoutMs: 500 })).rejects.toThrow(/^Starting the server took longer than 0.5 s\.$/);
  });
});

describe('McpSession (http)', () => {
  let api: http.Server;
  let url = '';
  const seenHeaders: string[] = [];
  beforeAll(async () => {
    api = http.createServer(async (req, res) => {
      if (req.url === '/hang') return; // never answers
      seenHeaders.push(String(req.headers['x-acme-key'] ?? ''));
      const server = acmeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    api.closeAllConnections();
    api.close();
  });

  it('connects by URL with headers, pages tools, and reports errors and structured results', async () => {
    const s = await McpSession.connect({ kind: 'http', url: `${url}/mcp`, headers: { 'X-Acme-Key': 'k-1' } });
    try {
      const info = await s.info();
      expect([info.name, info.version, info.instructions]).toEqual(['acme-depot', '1.2.3', 'Depot tools.']);
      expect((await s.allTools()).map((t) => t.name)).toEqual(['echo', 'fail']);
      const ok = await s.call('echo', { bin: 'A1' });
      expect([ok.isError, ok.content[0].text, ok.structured]).toEqual([false, '{"bin":"A1"}', { got: { bin: 'A1' } }]);
      const bad = await s.call('fail', {});
      expect([bad.isError, bad.content[0].text]).toEqual([true, 'no such bin']);
    } finally {
      await s.close();
    }
    expect(seenHeaders.length).toBeGreaterThan(0);
    expect(seenHeaders.every((h) => h === 'k-1')).toBe(true);
  });

  it('times out a URL that never answers', async () => {
    await expect(McpSession.connect({ kind: 'http', url: `${url}/hang` }, { timeoutMs: 300 })).rejects.toThrow(`Connecting to ${url} took longer than 0.3 s.`);
  });
});
