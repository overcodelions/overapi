import { describe, expect, it } from 'vitest';
import { isSystemFile, mergedNames, providerEnv, shortName, systemEnvs, SYSTEM_FILE } from './system';
import type { EnvDef, Project, ToolDef } from './project';

const env = (name: string): EnvDef => ({ name, baseUrl: `https://${name}.acme.example`, auth: { type: 'none' }, allowWrites: false });
const tool = (name: string): ToolDef => ({ id: `GET /${name}`, name, description: '', enabled: true, safety: 'read', method: 'GET', path: `/${name}`, params: [], bodyMode: 'none' });
const project = (name: string, envs: string[] = []): Project => ({ overapi: 1, name, title: name, description: '', version: '1', envs: envs.map(env), tools: [] });

describe('isSystemFile', () => {
  it('knows a system file by its marker and member list', () => {
    expect(SYSTEM_FILE).toBe('overapi-system.json');
    expect(isSystemFile({ overapiSystem: 1, name: 'acme', title: 'Acme', members: ['a/overapi.json'] })).toBe(true);
    expect(isSystemFile({ overapiSystem: 1, members: [] })).toBe(true);
  });
  it.each([[null], [undefined], ['text'], [{}], [{ overapiSystem: 2, members: [] }], [{ overapiSystem: 1 }], [{ overapiSystem: 1, members: 'a' }], [{ overapi: 1, members: [] }]])('refuses %j', (v) => {
    expect(isSystemFile(v)).toBe(false);
  });
});

describe('shortName', () => {
  it.each([
    ['orders-service', 'orders'],
    ['billing_svc', 'billing'],
    ['catalog-api', 'catalog'],
    ['Users-REST', 'users'],
    ['auth-server', 'auth'],
    ['acme.shipping v2', 'acme_shipping_v2'],
    ['inventory', 'inventory'],
    ['', 'api'],
  ])('%s -> %s', (name, short) => expect(shortName(project(name))).toBe(short));
});

describe('mergedNames', () => {
  it('keeps names that only one member uses', () => {
    const out = mergedNames([
      { project: project('orders-service'), tools: [tool('list_orders')] },
      { project: project('billing-service'), tools: [tool('list_invoices')] },
    ]);
    expect(out.map((x) => [x.name, x.member])).toEqual([
      ['list_orders', 0],
      ['list_invoices', 1],
    ]);
  });

  it('prefixes both members when two share a name', () => {
    const a = tool('health');
    const b = tool('health');
    const out = mergedNames([
      { project: project('orders-service'), tools: [a] },
      { project: project('billing-service'), tools: [b] },
    ]);
    expect(out.map((x) => x.name)).toEqual(['orders_health', 'billing_health']);
    expect(out[0].tool).toBe(a);
    expect(out[1].tool).toBe(b);
  });

  it('adds _2, _3 when the prefixed name is still taken', () => {
    // Two members with the same short name, both with a shared tool name.
    const out = mergedNames([
      { project: project('orders-api'), tools: [tool('ping')] },
      { project: project('orders-service'), tools: [tool('ping')] },
      { project: project('orders'), tools: [tool('ping')] },
    ]);
    expect(out.map((x) => x.name)).toEqual(['orders_ping', 'orders_ping_2', 'orders_ping_3']);
  });

  it('adds a suffix when a prefixed name collides with a plain one', () => {
    const out = mergedNames([
      { project: project('orders'), tools: [tool('orders_ping'), tool('ping')] },
      { project: project('billing'), tools: [tool('ping')] },
    ]);
    expect(out.map((x) => x.name)).toEqual(['orders_ping', 'orders_ping_2', 'billing_ping']);
  });

  it('cuts names to 64 characters', () => {
    const long = 'x'.repeat(60);
    const out = mergedNames([
      { project: project('orders'), tools: [tool(long)] },
      { project: project('billing'), tools: [tool(long)] },
    ]);
    expect(out.every((x) => x.name.length <= 64)).toBe(true);
    expect(out[0].name).toBe(`orders_${long}`.slice(0, 64));
  });

  it('is empty with no members', () => expect(mergedNames([])).toEqual([]));

  // BUG: mergedNames checks `taken` before slicing to 64, so orders_<60x> and
  // orders_<60x>_2 both come out as the same 64-character name.
  it('keeps long names unique after cutting them to 64', () => {
    const long = 'x'.repeat(60);
    const out = mergedNames([
      { project: project('orders-api'), tools: [tool(long)] },
      { project: project('orders'), tools: [tool(long)] },
    ]);
    expect(new Set(out.map((x) => x.name)).size).toBe(2);
  });
});

describe('systemEnvs', () => {
  it('lists every name once, the first member first, and says which all have', () => {
    expect(systemEnvs([project('a', ['local', 'staging', 'prod']), project('b', ['staging', 'local', 'qa'])])).toEqual([
      { name: 'local', all: true },
      { name: 'staging', all: true },
      { name: 'prod', all: false },
      { name: 'qa', all: false },
    ]);
  });
  it('is empty with no members', () => expect(systemEnvs([])).toEqual([]));
});

describe('providerEnv', () => {
  it('uses the environment of the same name', () => {
    const p = project('auth', ['local', 'staging']);
    expect(providerEnv(p, 'staging')?.name).toBe('staging');
  });
  it('falls back to the only environment there is', () => {
    expect(providerEnv(project('auth', ['default']), 'staging')?.name).toBe('default');
  });
  it('gives up when there are several and none match, or none at all', () => {
    expect(providerEnv(project('auth', ['local', 'prod']), 'staging')).toBeUndefined();
    expect(providerEnv(project('auth'), 'staging')).toBeUndefined();
  });
});
