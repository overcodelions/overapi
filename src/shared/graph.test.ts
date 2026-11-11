import { describe, expect, it } from 'vitest';
import { applyGraph, argsFromCall, basePathOf, requestGraph, suggestSignIn, toolForCall } from './graph';
import type { ParamDef, Project, ToolDef } from './project';
import type { RecordedCall } from './recording';
import { buildEnvelope } from './soap';

let n = 0;
const call = (method: string, path: string, extra: Partial<RecordedCall> = {}): RecordedCall => ({ id: `c${++n}`, at: new Date(2026, 0, 1, 0, 0, n).toISOString(), method, path, status: 200, statusText: 'OK', ms: 5, requestHeaders: {}, responseHeaders: {}, contentType: 'application/json', bytes: 0, ...extra });
const prm = (name: string, inn: ParamDef['in'], extra: Partial<ParamDef> = {}): ParamDef => ({ name, in: inn, required: inn === 'path', schema: { type: 'string' }, ...extra });
const tool = (id: string, extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'root', description: '', enabled: true, safety: method === 'GET' ? 'read' : 'write', method: method as ToolDef['method'], path, params: [], bodyMode: 'none', ...extra };
};
const project = (tools: ToolDef[], baseUrl = 'https://api.acme.example/v1'): Project => ({ overapi: 1, name: 'acme-shop', title: 'Acme', description: '', version: '1', envs: [{ name: 'local', baseUrl, auth: { type: 'none' }, allowWrites: false }, { name: 'prod', baseUrl, auth: { type: 'none' }, allowWrites: false }], tools });

describe('requestGraph', () => {
  it('follows an id from a response into a later path, query and body', () => {
    const create = call('POST', '/orders', { responseBody: JSON.stringify({ id: 1042, status: 'open', items: [{ sku: 'SKU-0001' }] }) });
    const get = call('GET', '/orders/1042?sku=SKU-0001&page=1042');
    const ship = call('POST', '/shipments', { requestBody: JSON.stringify({ order: { id: 1042 } }) });
    const edges = requestGraph([create, get, ship]);
    expect(edges.map((e) => [e.from, e.to, e.value, e.fromPath, e.where, e.auth])).toEqual([
      [create.id, get.id, '1042', 'id', 'path', false],
      [create.id, get.id, 'SKU-0001', 'items[0].sku', 'query:sku', false],
      [create.id, ship.id, '1042', 'id', 'body:order.id', false],
    ]);
  });

  it('marks a token that went into a credential header as a sign-in, bearer prefix off', () => {
    const login = call('POST', '/auth/login', { responseBody: JSON.stringify({ access_token: 'tok_abcdefghijkl' }) });
    const a = call('GET', '/me', { requestHeaders: { Authorization: 'Bearer tok_abcdefghijkl' } });
    const b = call('GET', '/me', { requestHeaders: { Authorization: 'Bearer tok_abcdefghijkl' } });
    const edges = requestGraph([login, a, b, b]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: login.id, to: a.id, where: 'header:authorization', auth: true, fromPath: 'access_token', fromHeader: false });
  });

  it('follows a session value from a response header into a cookie', () => {
    const login = call('POST', '/login', { responseHeaders: { 'x-session-id': 'sess-12345678' } });
    const next = call('GET', '/cart', { requestHeaders: { Cookie: 'theme=dark; sid=sess-12345678' } });
    const [e] = requestGraph([login, next]);
    expect(e).toMatchObject({ fromHeader: true, fromPath: 'x-session-id', where: 'header:cookie', auth: true });
  });

  it('ignores failed calls, small and status-like values', () => {
    const failed = call('GET', '/a', { status: 500, responseBody: JSON.stringify({ id: 5555 }) });
    const errored = call('GET', '/b', { error: 'reset', status: 0, responseBody: JSON.stringify({ id: 6666 }) });
    const small = call('GET', '/c', { responseBody: JSON.stringify({ n: 7, s: 'open', b: true, short: 'ab', ok: 'pending1'.replace('1', '') }) });
    const later = call('GET', '/x/5555/6666/7/open');
    expect(requestGraph([failed, errored, small, later])).toEqual([]);
  });

  it('reads XML responses too', () => {
    const a = call('POST', '/soap', { responseBody: '<Order><Id>ORD-9001</Id></Order>' });
    const b = call('GET', '/orders/ORD-9001');
    expect(requestGraph([a, b])[0]).toMatchObject({ fromPath: 'Order.Id', where: 'path' });
  });
});

describe('basePathOf', () => {
  it.each([
    ['https://api.acme.example/v1/', '/v1'],
    ['https://api.acme.example', ''],
    [undefined, ''],
    ['nope', ''],
  ])('%s -> %s', (u, out) => expect(basePathOf(u)).toBe(out));
});

describe('toolForCall', () => {
  const p = project([tool('GET /orders'), tool('GET /orders/{id}'), tool('GET /{{tenant}}/items/{id}'), tool('POST /orders/{id}/cancel'), tool('GET /files/a.b')]);

  it('matches method and template under the base path', () => {
    expect(toolForCall(p, call('get', '/v1/orders?x=1'))?.id).toBe('GET /orders');
    expect(toolForCall(p, call('GET', '/v1/orders/7'))?.id).toBe('GET /orders/{id}');
    expect(toolForCall(p, call('POST', '/v1/orders/7/cancel'))?.id).toBe('POST /orders/{id}/cancel');
    expect(toolForCall(p, call('DELETE', '/v1/orders/7'))).toBeUndefined();
  });

  it('matches {{var}} segments as any value', () => {
    expect(toolForCall(p, call('GET', '/v1/acme-eu/items/9'))?.id).toBe('GET /{{tenant}}/items/{id}');
  });

  it('escapes regex characters in the template', () => {
    expect(toolForCall(p, call('GET', '/v1/files/a.b'))?.id).toBe('GET /files/a.b');
    expect(toolForCall(p, call('GET', '/v1/files/aXb'))).toBeUndefined();
  });

  it('takes the path as is when it is not under the base path, and / for the base itself', () => {
    const q = project([tool('GET /'), tool('GET /health')]);
    expect(toolForCall(q, call('GET', '/v1'))?.id).toBe('GET /');
    expect(toolForCall(q, call('GET', '/health'))?.id).toBe('GET /health');
  });

  it('tells SOAP operations at one address apart by the envelope', () => {
    const getItem = tool('POST /service', { name: 'GetItem', soap: { operation: 'GetItem', namespace: 'urn:acme', version: '1.1' } });
    const listItems = tool('POST /service', { name: 'ListItems', soap: { operation: 'ListItems', namespace: 'urn:acme', version: '1.1' } });
    const plain = tool('POST /service', { name: 'plain' });
    const q = project([getItem, listItems, plain], 'https://api.acme.example');
    const env = buildEnvelope({ operation: 'ListItems', namespace: 'urn:acme', version: '1.1' }, {});
    expect(toolForCall(q, call('POST', '/service', { requestHeaders: env.headers, requestBody: env.body }))?.name).toBe('ListItems');
    expect(toolForCall(q, call('POST', '/service', { requestBody: '{"a":1}' }))?.name).toBe('plain');
    const other = buildEnvelope({ operation: 'Nope', namespace: 'urn:acme', version: '1.1' }, {});
    expect(toolForCall(project([getItem], 'https://api.acme.example'), call('POST', '/service', { requestBody: other.body }))).toBeUndefined();
  });
});

describe('argsFromCall', () => {
  it('takes path values by position, numbers as numbers, and query values by name', () => {
    const t = tool('GET /{{tenant}}/orders/{order_id}/lines/{line}', { params: [prm('order_id', 'path'), prm('line', 'path'), prm('q', 'query'), prm('n', 'query'), prm('absent', 'query')] });
    expect(argsFromCall(t, call('GET', '/v1/acme/orders/1042/lines/a%20b?q=x&n=-3&other=1'), '/v1')).toEqual({ order_id: 1042, line: 'a b', q: 'x', n: -3 });
  });

  it('reads json-fields bodies, only the body params', () => {
    const t = tool('POST /orders', { bodyMode: 'json-fields', params: [prm('sku', 'body'), prm('qty', 'body'), prm('note', 'body')] });
    expect(argsFromCall(t, call('POST', '/orders', { requestBody: '{"sku":"A1","qty":2,"extra":true}' }), '')).toEqual({ sku: 'A1', qty: 2 });
    expect(argsFromCall(t, call('POST', '/orders', { requestBody: '[1,2]' }), '')).toEqual({});
  });

  it('reads json-whole bodies as `body`', () => {
    const t = tool('POST /orders', { bodyMode: 'json-whole', params: [prm('body', 'body')] });
    expect(argsFromCall(t, call('POST', '/orders', { requestBody: '[1,2]' }), '')).toEqual({ body: [1, 2] });
    expect(argsFromCall(t, call('POST', '/orders', { requestBody: 'not json' }), '')).toEqual({});
  });

  it('reads form bodies', () => {
    const t = tool('POST /login', { bodyMode: 'form', params: [prm('user', 'body'), prm('pass', 'body'), prm('remember', 'body')] });
    expect(argsFromCall(t, call('POST', '/login', { requestBody: 'user=wile&pass=x%26y' }), '')).toEqual({ user: 'wile', pass: 'x&y' });
  });

  it('reads SOAP bodies', () => {
    const t = tool('POST /service', { bodyMode: 'soap', params: [prm('id', 'body'), prm('missing', 'body')], soap: { operation: 'GetItem', namespace: 'urn:acme', version: '1.1' } });
    const env = buildEnvelope({ operation: 'GetItem', namespace: 'urn:acme', version: '1.1' }, { id: '7', other: 'x' });
    expect(argsFromCall(t, call('POST', '/service', { requestHeaders: env.headers, requestBody: env.body }), '')).toEqual({ id: '7' });
    expect(argsFromCall(t, call('POST', '/service', { requestBody: '<x/>' }), '')).toEqual({});
  });

  it('ignores a body with bodyMode none', () => {
    expect(argsFromCall(tool('POST /x'), call('POST', '/x', { requestBody: '{"a":1}' }), '')).toEqual({});
  });
});

describe('suggestSignIn and applyGraph', () => {
  const login = tool('POST /auth/login', { bodyMode: 'json-fields', params: [prm('username', 'body'), prm('password', 'body')] });
  const me = tool('GET /me');
  const teams = tool('GET /teams', { returns: { t: 'object', keys: { data: { t: 'array', of: { t: 'object', keys: { id: { t: 'number' } } } } } } });
  const team = tool('GET /teams/{team_id}', { params: [prm('team_id', 'path')] });
  const p = project([login, me, teams, team]);
  const loginCall = call('POST', '/v1/auth/login', { requestBody: JSON.stringify({ username: 'wile', password: 's3cret!', remember: true }), responseBody: JSON.stringify({ token: 'tok_0123456789ab' }) });
  const meCalls = [1, 2, 3].map(() => call('GET', '/v1/me', { requestHeaders: { authorization: 'Bearer tok_0123456789ab' } }));
  const calls = [loginCall, ...meCalls];
  const edges = requestGraph(calls);

  it('suggests the login as a bearer sign-in, keeping the password out of the file', () => {
    const s = suggestSignIn(p, calls, edges, '/v1');
    expect(s).toEqual({
      toolId: 'POST /auth/login',
      toolName: 'auth_login',
      auth: { type: 'login', toolId: 'POST /auth/login', from: 'body', path: 'token', sendAs: 'bearer' },
      example: { username: 'wile', password: '${ACME_SHOP_PASSWORD}', remember: true },
      secrets: { ACME_SHOP_PASSWORD: 's3cret!' },
      calls: 3,
    });
  });

  it('sends a cookie or another header by name', () => {
    const c = call('POST', '/v1/auth/login', { responseHeaders: { 'x-auth-token': 'hdr-token-0001' } });
    const viaHeader = [c, call('GET', '/v1/me', { requestHeaders: { 'x-auth-token': 'hdr-token-0001' } })];
    expect(suggestSignIn(p, viaHeader, requestGraph(viaHeader), '/v1')?.auth).toEqual({ type: 'login', toolId: 'POST /auth/login', from: 'header', path: 'x-auth-token', sendAs: 'header', name: 'x-auth-token' });
    const viaCookie = [c, call('GET', '/v1/me', { requestHeaders: { cookie: 'sid=hdr-token-0001' } })];
    expect(suggestSignIn(p, viaCookie, requestGraph(viaCookie), '/v1')?.auth).toMatchObject({ sendAs: 'cookie', name: 'cookie' });
  });

  it('suggests nothing without a credential link to a known request', () => {
    expect(suggestSignIn(p, calls, [], '/v1')).toBeUndefined();
    expect(suggestSignIn(project([me]), calls, edges, '/v1')).toBeUndefined();
  });

  it('only suggests a sign-in until asked, but still connects chains', () => {
    const r = applyGraph(p, calls, edges, { signIn: false });
    expect(r.signIn).toEqual({ toolName: 'auth_login', method: 'POST', path: 'token', header: 'authorization', calls: 3 });
    expect(r.project.envs[0].auth).toEqual({ type: 'none' });
    expect(r.secrets).toEqual({});
    expect(r.summary).toEqual(['teams → data[].id → teams_team_id (team_id)']);
    expect(r.project.tools.find((t) => t.id === team.id)?.example).toEqual({ team_id: '{{team_id}}' });
  });

  it('writes the sign-in into the first environment when asked', () => {
    const r = applyGraph(p, calls, edges, { signIn: true });
    expect(r.project.envs[0].auth).toEqual({ type: 'login', toolId: 'POST /auth/login', from: 'body', path: 'token', sendAs: 'bearer' });
    expect(r.project.envs[1].auth).toEqual({ type: 'none' });
    const l = r.project.tools.find((t) => t.id === login.id)!;
    expect(l.enabled).toBe(false);
    expect(l.example).toEqual({ username: 'wile', password: '${ACME_SHOP_PASSWORD}', remember: true });
    expect(r.secrets).toEqual({ ACME_SHOP_PASSWORD: 's3cret!' });
    expect(r.summary[0]).toBe('Sign-in: auth_login → token → authorization on 3 calls (ACME_SHOP_PASSWORD saved to the keychain)');
    // The input project is not changed.
    expect(p.envs[0].auth).toEqual({ type: 'none' });
  });

  it('names the header for a non-bearer sign-in, says "call" for one, and keeps the example when the login sent no body', () => {
    const c = call('POST', '/v1/auth/login', { responseBody: JSON.stringify({ key: 'key-acme-test-1' }) });
    const cs = [c, call('GET', '/v1/me', { requestHeaders: { 'x-api-key': 'key-acme-test-1' } })];
    const withExample = project([{ ...login, example: { username: 'kept' } }, me]);
    const r = applyGraph(withExample, cs, requestGraph(cs), { signIn: true });
    expect(r.project.envs[0].auth).toMatchObject({ sendAs: 'header', name: 'x-api-key' });
    expect(r.summary[0]).toBe('Sign-in: auth_login → key → x-api-key on 1 call');
    expect(r.project.tools[0].example).toEqual({ username: 'kept' });
  });
});

describe('requestGraph, odd paths', () => {
  it('skips a call whose path is not a URL', () => {
    const a = call('GET', '/a', { responseBody: JSON.stringify({ id: 'abc-12345' }) });
    const b = call('GET', 'http://[bad/abc-12345');
    expect(requestGraph([a, b])).toEqual([]);
  });
});
