import { describe, expect, it } from 'vitest';
import { emptyProject, envKind, envVars, exampleSecrets, fillVars, groupOf, isLoginTool, offered, projectProblem, slug, toolId, varPrefix, type EnvDef, type ToolDef } from './project';

const tool = (extra: Partial<ToolDef> = {}): ToolDef => ({ id: 'GET /a', name: 'a', description: '', enabled: true, safety: 'read', method: 'GET', path: '/a', params: [], bodyMode: 'none', ...extra });
const env = (extra: Partial<EnvDef> = {}): EnvDef => ({ name: 'local', baseUrl: 'http://localhost', auth: { type: 'none' }, allowWrites: false, ...extra });

describe('envKind', () => {
  it.each([
    ['production', 'production'],
    ['live-eu', 'production'],
    ['local', 'local'],
    ['dev', 'local'],
    ['staging', 'test'],
    ['qa', 'test'],
    ['sandbox', 'test'],
    ['acme', 'other'],
  ] as const)('%s -> %s', (name, kind) => expect(envKind(name)).toBe(kind));
});

describe('groupOf', () => {
  it('uses the group, then a tag other than the docs one, then the first real path word', () => {
    expect(groupOf(tool({ group: ' Orders ' }))).toBe('Orders');
    expect(groupOf(tool({ group: ' ', origin: { tags: ['drafted from docs', 'Teams'] } }))).toBe('Teams');
    expect(groupOf(tool({ path: '/api/v2/{id}/invoices' }))).toBe('invoices');
    expect(groupOf(tool({ path: '/rest/{id}' }))).toBe('other');
  });
});

describe('fillVars', () => {
  it('fills from runtime first, then the environment, and leaves unknowns', () => {
    expect(fillVars('/{{ tenant }}/{{region}}/{{nope}}', { vars: { tenant: 'env-t', region: 'eu' } }, { tenant: 'run-t' })).toBe('/run-t/eu/{{nope}}');
    expect(fillVars('{{a}}', {})).toBe('{{a}}');
  });
});

describe('secrets and variables', () => {
  it('lists the variables an environment reads, once each', () => {
    expect(envVars(env({ auth: { type: 'bearer', tokenVar: 'T' }, headers: { 'x-a': '${A} ${T}', 'x-b': 'plain' } }))).toEqual(['T', 'A']);
    expect(envVars(env({ auth: { type: 'apiKey', in: 'header', name: 'k', valueVar: 'K' } }))).toEqual(['K']);
    expect(envVars(env({ auth: { type: 'wsse', userVar: 'U', passVar: 'P' } }))).toEqual(['U', 'P']);
    expect(envVars(env({ auth: { type: 'via', api: 'auth' } }))).toEqual([]);
  });
  it('finds ${SECRET}s in a request’s saved values', () => {
    expect(exampleSecrets(tool({ example: { user: 'wile', pass: '${ACME_PASS}', nested: { k: '${ACME_KEY}' } } }))).toEqual(['ACME_PASS', 'ACME_KEY']);
    expect(exampleSecrets(tool())).toEqual([]);
  });
});

describe('offered and isLoginTool', () => {
  const login = tool({ id: 'POST /login', method: 'POST', safety: 'write' });
  const signIn = env({ allowWrites: true, auth: { type: 'login', toolId: 'POST /login', from: 'body', path: 'token', sendAs: 'bearer' } });
  it('never offers the sign-in request', () => {
    expect(isLoginTool(login, signIn)).toBe(true);
    expect(isLoginTool(login, env())).toBe(false);
    expect(offered(login, signIn)).toBe(false);
  });
  it('offers reads always, writes where allowed, nothing turned off', () => {
    expect(offered(tool(), env())).toBe(true);
    expect(offered(tool({ enabled: false }), env())).toBe(false);
    expect(offered(tool({ safety: 'write' }), env())).toBe(false);
    expect(offered(tool({ safety: 'destructive' }), env({ allowWrites: true }))).toBe(true);
  });
});

describe('names', () => {
  it('slugs, prefixes and ids', () => {
    expect(slug('  Acme Shipping API!! ')).toBe('acme-shipping-api');
    expect(slug('x'.repeat(60))).toHaveLength(48);
    expect(varPrefix('Acme Shipping API')).toBe('ACME_SHIPPING');
    expect(varPrefix('rest')).toBe('API');
    expect(varPrefix('a'.repeat(40))).toHaveLength(30);
    expect(toolId('get', '/a')).toBe('GET /a');
  });
  it('starts an empty project', () => {
    expect(emptyProject('Acme Orders')).toEqual({ overapi: 1, name: 'acme-orders', title: 'Acme Orders', description: '', version: '0.1.0', envs: [], tools: [] });
    expect(emptyProject('!!!').name).toBe('api');
  });
});

describe('projectProblem', () => {
  const ok = { overapi: 1, name: 'a', envs: [], tools: [{ name: 'x', path: '/x', method: 'GET' }] };
  it.each([
    [null, 'not a JSON object'],
    ['text', 'not a JSON object'],
    [{ overapi: 2 }, 'missing "overapi": 1 — this is not an overapi project file'],
    [{ overapi: 1, name: '' }, 'missing "name"'],
    [{ overapi: 1, name: 'a', envs: {} }, '"envs" must be a list'],
    [{ overapi: 1, name: 'a', envs: [], tools: null }, '"tools" must be a list'],
    [{ ...ok, tools: [null] }, 'a tool is missing its name, method or path'],
    [{ ...ok, tools: [{ name: 'x', path: '/x' }] }, 'a tool is missing its name, method or path'],
  ])('%j -> %s', (v, msg) => expect(projectProblem(v)).toBe(msg));
  it('accepts a project', () => expect(projectProblem(ok)).toBeNull());
});
