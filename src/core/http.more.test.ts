// More of http.ts: every sign-in shape, argument filling, body modes, and
// sending against a real local server (XML, SOAP Faults, truncation,
// scrubbing, timeouts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ArgumentError, buildRequest, scrub, send, shown, viaKey, type Borrowed, type BuiltRequest } from './http';
import type { AuthSpec, EnvDef, ToolDef } from '../shared/project';

const tool = (extra: Partial<ToolDef> = {}): ToolDef => ({
  id: 'GET /items/{id}',
  name: 'get_item',
  description: '',
  enabled: true,
  safety: 'read',
  method: 'GET',
  path: '/items/{id}',
  bodyMode: 'none',
  params: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  ...extra,
});
const env = (auth: AuthSpec, extra: Partial<EnvDef> = {}): EnvDef => ({ name: 'local', baseUrl: 'http://acme.example/api', auth, allowWrites: true, ...extra });
const none = () => undefined;
const from = (map: Record<string, string>) => (n: string) => map[n];

describe('buildRequest: sign-in', () => {
  it('puts an api key in a header, lower-cased', () => {
    const r = buildRequest(tool(), env({ type: 'apiKey', in: 'header', name: 'X-Acme-Key', valueVar: 'K' }), { id: '1' }, from({ K: 'key-12345' }));
    expect(r.headers['x-acme-key']).toBe('key-12345');
    expect(r.url).toBe('http://acme.example/api/items/1');
    expect(r.secrets).toEqual(['key-12345']);
  });

  it('sends no api key when the variable is unset', () => {
    const r = buildRequest(tool(), env({ type: 'apiKey', in: 'query', name: 'key', valueVar: 'K' }), { id: '1' }, none);
    expect(r.url).not.toContain('key=');
    expect(r.secrets).toEqual([]);
  });

  it('encodes basic auth and treats both the pair and the password as secrets', () => {
    const r = buildRequest(tool(), env({ type: 'basic', userVar: 'U', passVar: 'P' }), { id: '1' }, from({ U: 'wile', P: 'acme-pass' }));
    const encoded = Buffer.from('wile:acme-pass').toString('base64');
    expect(r.headers.authorization).toBe(`Basic ${encoded}`);
    expect(r.secrets).toEqual([encoded, 'acme-pass']);
  });

  it('sends basic with only a user, and nothing with neither', () => {
    const r = buildRequest(tool(), env({ type: 'basic', userVar: 'U', passVar: 'P' }), { id: '1' }, from({ U: 'wile' }));
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from('wile:').toString('base64')}`);
    expect(buildRequest(tool(), env({ type: 'basic', userVar: 'U', passVar: 'P' }), { id: '1' }, none).headers.authorization).toBeUndefined();
  });

  it('borrows another API’s sign-in from the runtime', () => {
    const borrowed: Borrowed = { headers: { 'X-Session': 'sess-abcdef' }, query: { tenant: 'acme' }, secrets: ['sess-abcdef'], from: 'acme-sso' };
    const r = buildRequest(tool(), env({ type: 'via', api: 'acme-sso' }), { id: '1' }, none, { [viaKey('local')]: JSON.stringify(borrowed) });
    expect(viaKey('local')).toBe('__via:local');
    expect(r.headers['x-session']).toBe('sess-abcdef');
    expect(r.url).toBe('http://acme.example/api/items/1?tenant=acme');
    expect(r.secrets).toEqual(['sess-abcdef']);
  });

  it('goes without a borrowed sign-in that is not there yet', () => {
    const r = buildRequest(tool(), env({ type: 'via', api: 'acme-sso' }), { id: '1' }, none, {});
    expect(r.secrets).toEqual([]);
    expect(r.headers.authorization).toBeUndefined();
  });

  it('sends a login token every way it can be sent, with default names', () => {
    const login = (sendAs: 'bearer' | 'header' | 'query' | 'cookie', name?: string): AuthSpec => ({ type: 'login', toolId: 'POST /login', from: 'body', path: 'token', sendAs, name });
    const rt = { '__login:local': 'tok-login-1' };
    expect(buildRequest(tool(), env(login('bearer')), { id: '1' }, none, rt).headers.authorization).toBe('Bearer tok-login-1');
    expect(buildRequest(tool(), env(login('header')), { id: '1' }, none, rt).headers['x-auth-token']).toBe('tok-login-1');
    expect(buildRequest(tool(), env(login('header', 'X-Session')), { id: '1' }, none, rt).headers['x-session']).toBe('tok-login-1');
    expect(buildRequest(tool(), env(login('query')), { id: '1' }, none, rt).url).toContain('?token=tok-login-1');
    expect(buildRequest(tool(), env(login('query', 'sid')), { id: '1' }, none, rt).url).toContain('?sid=tok-login-1');
    expect(buildRequest(tool(), env(login('cookie')), { id: '1' }, none, rt).headers.cookie).toBe('session=tok-login-1');
    expect(buildRequest(tool(), env(login('cookie', 'JSESSIONID')), { id: '1' }, none, rt).headers.cookie).toBe('JSESSIONID=tok-login-1');
    const signedOut = buildRequest(tool(), env(login('bearer')), { id: '1' }, none, {});
    expect([signedOut.headers.authorization, signedOut.secrets]).toEqual([undefined, []]);
  });

  it('lets a request’s own sign-in win over its environment’s', () => {
    const r = buildRequest(tool({ auth: { type: 'none' } }), env({ type: 'bearer', tokenVar: 'T' }), { id: '1' }, from({ T: 'tok-12345' }));
    expect(r.headers.authorization).toBeUndefined();
  });

  it('keeps secrets shorter than four characters out of the scrub list', () => {
    const r = buildRequest(tool(), env({ type: 'bearer', tokenVar: 'T' }), { id: '1' }, from({ T: 'abc' }));
    expect(r.headers.authorization).toBe('Bearer abc');
    expect(r.secrets).toEqual([]);
  });
});

describe('buildRequest: arguments', () => {
  it('names a single missing argument in the singular, as an ArgumentError', () => {
    let e: unknown;
    try {
      buildRequest(tool(), env({ type: 'none' }), {}, none);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ArgumentError);
    expect((e as Error).message).toBe('Missing required argument: id.');
    expect(() => buildRequest(tool(), env({ type: 'none' }), { id: null }, none)).toThrow('Missing required argument: id.');
    expect(() => buildRequest(tool(), env({ type: 'none' }), { id: '' }, none)).toThrow(ArgumentError);
  });

  it('fills a left-out argument from its default', () => {
    const t = tool({ params: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', default: 'acme-1' } }, { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1 } }] });
    const r = buildRequest(t, env({ type: 'none' }), { id: '' }, none);
    expect(r.url).toBe('http://acme.example/api/items/acme-1?page=1');
  });

  it('fills {{kept}} values and ${SECRETS} in string arguments, scrubbing the secret', () => {
    const t = tool({ method: 'POST', bodyMode: 'json-fields', params: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'password', in: 'body', required: true, schema: { type: 'string' } }] });
    const r = buildRequest(t, env({ type: 'none' }), { id: '{{order_id}}', password: '${ACME_PASS}' }, from({ ACME_PASS: 'hunter-22' }), { order_id: '77' });
    expect(r.url).toBe('http://acme.example/api/items/77');
    expect(r.body).toBe('{"password":"hunter-22"}');
    expect(r.secrets).toEqual(['hunter-22']);
    expect(shown(r).body).toBe('{"password":"•••"}');
  });

  it('fills an unset ${SECRET} with nothing', () => {
    const t = tool({ headers: { 'X-Key': 'k-${NOPE}' } });
    expect(buildRequest(t, env({ type: 'none' }), { id: '1' }, none).headers['x-key']).toBe('k-');
  });

  it('needs a base URL, and explains one that does not parse', () => {
    expect(() => buildRequest(tool(), env({ type: 'none' }, { baseUrl: '' }), { id: '1' }, none)).toThrow('The "local" environment has no base URL.');
    expect(() => buildRequest(tool(), env({ type: 'none' }, { baseUrl: 'http://acme.example:{{port}}/api' }), { id: '1' }, none)).toThrow(/a \{\{variable\}\} in it has no value/);
    expect(() => buildRequest(tool(), env({ type: 'none' }, { baseUrl: 'not a url' }), { id: '1' }, none)).toThrow(/"not a url" is not a usable base URL. Check the "local" environment\.$/);
  });

  it('fills {{vars}} in the base URL and path, and adds a missing leading slash', () => {
    const t = tool({ path: '{{version}}/items/{id}' });
    const e = env({ type: 'none' }, { baseUrl: 'https://{{region}}.acme.example//', vars: { region: 'eu', version: 'v2' } });
    expect(buildRequest(t, e, { id: '9' }, none).url).toBe('https://eu.acme.example/v2/items/9');
  });

  it('sends header arguments and env/tool headers, the tool’s on top', () => {
    const t = tool({ headers: { 'X-Tenant': 'tool' }, params: [{ name: 'id', in: 'path', required: true, schema: {} }, { name: 'X-Trace', in: 'header', required: false, schema: {} }, { name: 'X-Empty', in: 'header', required: false, schema: {} }] });
    const r = buildRequest(t, env({ type: 'none' }, { headers: { 'X-Tenant': 'env', 'X-Region': 'eu' } }), { id: '1', 'X-Trace': 42, 'X-Empty': null }, none);
    expect(r.headers).toMatchObject({ 'x-tenant': 'tool', 'x-region': 'eu', 'x-trace': '42' });
    expect(r.headers['x-empty']).toBeUndefined();
  });

  it('serialises object query values as JSON and skips empty ones', () => {
    const t = tool({ params: [{ name: 'id', in: 'path', required: true, schema: {} }, { name: 'filter', in: 'query', required: false, schema: {} }, { name: 'q', in: 'query', required: false, schema: {} }] });
    const r = buildRequest(t, env({ type: 'none' }), { id: '1', filter: { status: 'open' }, q: null }, none);
    expect(new URL(r.url).searchParams.get('filter')).toBe('{"status":"open"}');
    expect(new URL(r.url).searchParams.has('q')).toBe(false);
  });
});

describe('buildRequest: bodies', () => {
  const bodyTool = (bodyMode: ToolDef['bodyMode'], params: ToolDef['params']) => tool({ method: 'POST', path: '/items', bodyMode, params });

  it('json-whole: passes a JSON string through, stringifies anything else', () => {
    const t = bodyTool('json-whole', [{ name: 'payload', in: 'body', required: false, schema: {} }]);
    expect(buildRequest(t, env({ type: 'none' }), { payload: '{"a":1}' }, none).body).toBe('{"a":1}');
    expect(buildRequest(t, env({ type: 'none' }), { payload: { a: 1 } }, none).body).toBe('{"a":1}');
    expect(buildRequest(t, env({ type: 'none' }), { payload: 'plain text' }, none).body).toBe('"plain text"');
    expect(buildRequest(t, env({ type: 'none' }), { body: [1, 2] }, none).body).toBe('[1,2]');
    const empty = buildRequest(t, env({ type: 'none' }), {}, none);
    expect([empty.body, empty.headers['content-type']]).toEqual([undefined, undefined]);
    const r = buildRequest(t, env({ type: 'none' }), { payload: 1 }, none);
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('json-whole: falls back to an argument named body', () => {
    const t = bodyTool('json-whole', []);
    expect(buildRequest(t, env({ type: 'none' }), { body: { x: true } }, none).body).toBe('{"x":true}');
  });

  it('form: url-encodes the fields, leaving out absent ones', () => {
    const t = bodyTool('form', [
      { name: 'name', in: 'body', required: false, schema: {} },
      { name: 'tags', in: 'body', required: false, schema: {} },
      { name: 'gone', in: 'body', required: false, schema: {} },
    ]);
    const r = buildRequest(t, env({ type: 'none' }), { name: 'Road Runner', tags: ['a', 'b'], gone: null }, none);
    expect(r.body).toBe('name=Road+Runner&tags=%5B%22a%22%2C%22b%22%5D');
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('soap: builds the envelope with WS-Security, scrubbing the password', () => {
    const t = bodyTool('soap', [{ name: 'Sku', in: 'body', required: true, schema: {} }, { name: 'Note', in: 'body', required: false, schema: {} }]);
    t.soap = { operation: 'GetItem', action: 'urn:acme/GetItem', namespace: 'urn:acme', version: '1.1', qualified: true };
    const r = buildRequest(t, env({ type: 'wsse', userVar: 'U', passVar: 'P' }), { Sku: 'ANVIL-1' }, from({ U: 'wile', P: 'wsse-pass-1' }));
    expect(r.body).toContain('<tns:GetItem><tns:Sku>ANVIL-1</tns:Sku></tns:GetItem>');
    expect(r.body).toContain('<wsse:Username>wile</wsse:Username>');
    expect(r.headers.soapaction).toBe('"urn:acme/GetItem"');
    expect(r.secrets).toEqual(['wsse-pass-1']);
    expect(shown(r).body).not.toContain('wsse-pass-1');
  });

  it('soap: no security header without credentials, nor for other sign-ins', () => {
    const t = bodyTool('soap', [{ name: 'Sku', in: 'body', required: true, schema: {} }]);
    t.soap = { operation: 'GetItem', namespace: 'urn:acme', version: '1.1' };
    expect(buildRequest(t, env({ type: 'wsse', userVar: 'U', passVar: 'P' }), { Sku: 'A' }, none).body).not.toContain('Security');
    expect(buildRequest(t, env({ type: 'bearer', tokenVar: 'T' }), { Sku: 'A' }, from({ T: 'tok-1234' })).body).not.toContain('Security');
    // A username alone still signs in, with nothing secret to scrub.
    const userOnly = buildRequest(t, env({ type: 'wsse', userVar: 'U', passVar: 'P' }), { Sku: 'A' }, from({ U: 'wile' }));
    expect([userOnly.body?.includes('<wsse:Username>wile'), userOnly.secrets]).toEqual([true, []]);
  });

  it('none: no body even with body arguments', () => {
    const t = bodyTool('none', [{ name: 'x', in: 'body', required: false, schema: {} }]);
    expect(buildRequest(t, env({ type: 'none' }), { x: 1 }, none).body).toBeUndefined();
  });
});

describe('scrub and shown', () => {
  it('scrubs a secret and its URL-encoded form, ignoring empty ones', () => {
    expect(scrub('a=p@ss word&b=p%40ss%20word', ['p@ss word', ''])).toBe('a=•••&b=•••');
  });

  it('shows a request without a body', () => {
    const r: BuiltRequest = { method: 'GET', url: 'http://x.example/?k=secret-1', headers: { a: 'secret-1' }, secrets: ['secret-1'] };
    expect(shown(r)).toEqual({ method: 'GET', url: 'http://x.example/?k=•••', headers: { a: '•••' }, body: undefined });
  });
});

// ---- send, against a real server ----------------------------------------

const FAULT = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>No item ANVIL-9.</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
const OK_ENVELOPE = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetItemResponse><Sku>ANVIL-1</Sku></GetItemResponse></soap:Body></soap:Envelope>`;

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const reply = (type: string, body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    switch (u.pathname) {
      case '/xml':
        return reply('application/xml', '<?xml version="1.0"?><orders><order id="1">Anvil</order></orders>');
      case '/fault':
        return reply('text/xml', FAULT, 500);
      case '/fault-200':
        return reply('text/xml', FAULT, 200);
      case '/envelope':
        return reply('text/plain', OK_ENVELOPE);
      case '/broken-xml':
        return reply('application/xml', '<orders><order>');
      case '/text':
        return reply('text/plain', `hello ${req.headers.authorization ?? ''}`);
      case '/json-as-text':
        return reply('text/plain', ' {"a": 1} ');
      case '/bad-json':
        return reply('application/json', '{not json');
      case '/echo':
        return reply('application/json', JSON.stringify({ seen: req.headers.authorization, items: Array.from({ length: 50 }, (_, i) => i) }), 200, { 'x-echo': String(req.headers.authorization) });
      case '/slow':
        return; // never answers
      default:
        return reply('application/json', '{"error":"no"}', 404);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const req = (path: string, secrets: string[] = ['tok-secret-9']): BuiltRequest => ({ method: 'GET', url: base + path, headers: { authorization: 'Bearer tok-secret-9' }, secrets });

describe('send', () => {
  it('hands XML on as JSON', async () => {
    const r = await send(req('/xml'));
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ orders: { order: { '@id': '1', '#text': 'Anvil' } } });
    expect(r.body).toBe(JSON.stringify(r.json));
    expect(r.contentType).toBe('application/xml');
  });

  it('turns a SOAP Fault into an error, whatever the status', async () => {
    for (const p of ['/fault', '/fault-200']) {
      const r = await send(req(p));
      expect(r.ok).toBe(false);
      expect(r.statusText).toBe('SOAP Fault: No item ANVIL-9.');
      expect((r.json as { Fault: unknown }).Fault).toBeDefined();
    }
  });

  it('spots an envelope without an XML content type or prolog', async () => {
    const r = await send(req('/envelope'));
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ GetItemResponse: { Sku: 'ANVIL-1' } });
  });

  it('keeps XML that does not parse as it was sent', async () => {
    const r = await send(req('/broken-xml'));
    expect([r.json, r.body]).toEqual([undefined, '<orders><order>']);
  });

  it('keeps plain text, scrubbing secrets from it', async () => {
    const r = await send(req('/text'));
    expect(r.body).toBe('hello Bearer •••');
    expect(r.json).toBeUndefined();
    expect(r.bytes).toBe(Buffer.byteLength('hello Bearer tok-secret-9'));
  });

  it('reads JSON sent as text, and keeps JSON that is not', async () => {
    const a = await send(req('/json-as-text'));
    expect([a.json, a.body]).toEqual([{ a: 1 }, '{"a":1}']);
    const b = await send(req('/bad-json'));
    expect([b.json, b.body]).toEqual([undefined, '{not json']);
  });

  it('cuts the agent’s copy at the limit, keeps the whole for people, and scrubs headers', async () => {
    const r = await send(req('/echo'), { limit: 30 });
    expect(r.truncated).toBe(true);
    expect(r.body.startsWith(r.full!.slice(0, 30))).toBe(true);
    expect(r.full).toBe(JSON.stringify({ seen: 'Bearer •••', items: Array.from({ length: 50 }, (_, i) => i) }));
    expect(r.headers['x-echo']).toBe('Bearer •••');
    expect(r.request.headers.authorization).toBe('Bearer •••');
    const whole = await send(req('/echo'));
    expect([whole.truncated, whole.full]).toEqual([false, undefined]);
  });

  it('reports a non-2xx status as not ok', async () => {
    const r = await send(req('/missing'));
    expect([r.ok, r.status, r.json]).toEqual([false, 404, { error: 'no' }]);
  });

  it('gives up after the timeout with a plain reason', async () => {
    await expect(send(req('/slow'), { timeoutMs: 600 })).rejects.toThrow(`Could not reach ${base}: no answer after 1 s.`);
  });

  it('explains a failure with no cause code by its message, scrubbed', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up near tok-secret-9');
    }) as typeof fetch;
    await expect(send(req('/x'), { fetchImpl })).rejects.toThrow(`Could not reach ${base}: socket hang up near •••.`);
  });
});
