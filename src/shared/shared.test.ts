import { describe, expect, it } from 'vitest';
import { nameFromRoute, uniqueNames, snake } from './naming';
import { checkProject } from './check';
import { snippets, shq } from './install';
import type { Project } from './project';

describe('naming', () => {
  it.each([
    ['GET', '/api/v2/orders', 'list_orders'],
    ['GET', '/api/v2/orders/{id}', 'get_order'],
    ['POST', '/orders', 'create_order'],
    ['POST', '/orders/{id}/cancel', 'cancel_order'],
    ['GET', '/customers/{id}/orders', 'list_customer_orders'],
    ['PATCH', '/categories/{id}', 'update_category'],
    ['DELETE', '/addresses/{id}', 'delete_address'],
  ] as const)('%s %s -> %s', (m, p, name) => expect(nameFromRoute(m, p)).toBe(name));

  it('snake-cases operationIds', () => expect(snake('getHTTPOrderByID')).toBe('get_http_order_by_id'));
  it('de-duplicates in order', () => expect(uniqueNames(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a_2', 'a_3']));
});

const base: Project = {
  overapi: 1,
  name: 'acme',
  title: 'Acme',
  description: 'Orders.',
  version: '1',
  envs: [{ name: 'production', baseUrl: 'http://orders.acme.example', auth: { type: 'bearer', tokenVar: 'ACME_TOKEN' }, allowWrites: true }],
  tools: [
    { id: 'GET /orders/{id}', name: 'get_order', description: 'Fetch one order with its items and totals.', enabled: true, safety: 'read', method: 'GET', path: '/orders/{id}', bodyMode: 'none', params: [{ name: 'id', in: 'path', required: true, schema: {} }] },
    { id: 'GET /x/{y}', name: 'get_order', description: '', enabled: true, safety: 'read', method: 'GET', path: '/x/{y}', bodyMode: 'none', params: [] },
  ],
};

describe('checkProject', () => {
  const r = checkProject(base, { ACME_TOKEN: false });
  const messages = r.issues.map((i) => i.message).join('\n');

  it('finds the things that break an agent', () => {
    expect(messages).toMatch(/2 tools are named "get_order"/);
    expect(messages).toMatch(/has \{y\} but no path parameter/);
    expect(messages).toMatch(/has no description/);
    expect(messages).toMatch(/plain http/);
    expect(messages).toMatch(/"production" lets agents write/);
    expect(messages).toMatch(/ACME_TOKEN, which is not set/);
  });

  it('orders errors first and scores below a clean project', () => {
    expect(r.issues[0].level).toBe('error');
    expect(r.score).toBeLessThan(70);
    const clean = checkProject({ ...base, envs: [{ ...base.envs[0], name: 'local', baseUrl: 'http://localhost:1' }], tools: [base.tools[0]] }, { ACME_TOKEN: true });
    expect(clean.issues).toEqual([]);
    expect(clean.score).toBe(100);
  });
});

describe('install snippets', () => {
  const s = snippets(base, base.envs[0], '/Users/someone/My APIs/acme/overapi.json', { command: '/usr/local/bin/node', prefix: ['/opt/overapi/cli.js'] });

  it('quotes paths with spaces for the shell and never includes a secret', () => {
    const claude = s.find((x) => x.client === 'claude')!.text;
    expect(claude).toBe(
      "claude mcp add acme-production --scope user --env 'ACME_TOKEN=<ACME_TOKEN>' -- /usr/local/bin/node /opt/overapi/cli.js serve '/Users/someone/My APIs/acme/overapi.json' --env production",
    );
  });

  it('writes valid JSON and TOML-ish config', () => {
    const json = JSON.parse(s.find((x) => x.client === 'json')!.text);
    expect(json.mcpServers['acme-production'].args).toEqual(['/opt/overapi/cli.js', 'serve', '/Users/someone/My APIs/acme/overapi.json', '--env', 'production']);
    expect(s.find((x) => x.client === 'codex')!.text).toContain('[mcp_servers.acme-production]');
  });

  it('shell-quotes single quotes', () => expect(shq("it's")).toBe("'it'\\''s'"));
});
