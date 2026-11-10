import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { findLocalServers, parseLsofCwd, parseLsofListen, sourceKind } from './localServers';

describe('lsof parsing', () => {
  it('reads listening ports with their process, once per port', () => {
    const out = 'p813\ncrapportd\nf13\nn*:49157\nf14\nn*:49157\np9285\ncnode\nf20\nn127.0.0.1:4010\nf21\nn[::1]:4010\n';
    expect(parseLsofListen(out)).toEqual([
      { pid: 813, process: 'rapportd', port: 49157 },
      { pid: 9285, process: 'node', port: 4010 },
    ]);
  });
  it('reads working directories', () => {
    expect(parseLsofCwd('p9285\nfcwd\nn/Users/someone/git/acme-orders\n').get(9285)).toBe('/Users/someone/git/acme-orders');
  });
});

describe('findLocalServers', () => {
  let api: http.Server;
  let port = 0;
  beforeAll(async () => {
    api = http.createServer((req, res) => {
      if (req.url === '/openapi.json') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'Acme Local', version: '1' }, servers: [{ url: '/api/v1' }], paths: { '/orders': { get: { responses: {} } } } }));
      }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    port = (api.address() as AddressInfo).port;
  });
  afterAll(() => api.close());

  it('finds this test’s own server, its folder, and its spec', async () => {
    const found = await findLocalServers();
    const mine = found.find((s) => s.port === port);
    expect(mine).toMatchObject({ kind: 'json', status: 200, title: 'Acme Local', spec: { title: 'Acme Local', baseUrl: `http://127.0.0.1:${port}/api/v1`, tools: 1 } });
    expect(mine!.process).toMatch(/node/i);
    expect(mine!.folder).toBeTruthy();
    expect(found.indexOf(mine!)).toBeLessThan(found.findIndex((s) => !s.spec) === -1 ? Infinity : found.findIndex((s) => !s.spec) + 1);
  });

  it('skips ports it is told to', async () => {
    expect((await findLocalServers({ skipPorts: [port] })).some((s) => s.port === port)).toBe(false);
  });
});

describe('sourceKind', () => {
  it('names the source from its build file', () => {
    expect(sourceKind('/x/orders-service', (f) => f.endsWith('/pom.xml'))).toBe('Java');
    expect(sourceKind('/x/web', (f) => f.endsWith('/package.json'))).toBe('Node');
    expect(sourceKind('/nonexistent-dir-for-test', () => false)).toBeUndefined();
  });
});
