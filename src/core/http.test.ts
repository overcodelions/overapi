import { describe, expect, it } from 'vitest';
import { buildRequest, scrub, send } from './http';
import type { EnvDef, ToolDef } from '../shared/project';

const env: EnvDef = { name: 'local', baseUrl: 'http://localhost:4010/api/v1/', auth: { type: 'bearer', tokenVar: 'T' }, allowWrites: true, headers: { 'X-Tenant': 'acme-${TENANT}' } };
const vars = (n: string) => ({ T: 'tok_abcdef', TENANT: 'west' })[n];

const tool: ToolDef = {
  id: 'POST /orders/{id}/notes',
  name: 'add_note',
  description: '',
  enabled: true,
  safety: 'write',
  method: 'POST',
  path: '/orders/{id}/notes',
  bodyMode: 'json-fields',
  params: [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'tags', in: 'query', required: false, schema: { type: 'array' } },
    { name: 'text', in: 'body', required: true, schema: { type: 'string' } },
    { name: 'pinned', in: 'body', required: false, schema: { type: 'boolean' } },
  ],
};

describe('buildRequest', () => {
  it('fills the path, query, headers, auth and body', () => {
    const r = buildRequest(tool, env, { id: 'a/b', tags: ['x', 'y'], text: 'hi' }, vars);
    expect(r.url).toBe('http://localhost:4010/api/v1/orders/a%2Fb/notes?tags=x&tags=y');
    expect(r.headers.authorization).toBe('Bearer tok_abcdef');
    expect(r.headers['x-tenant']).toBe('acme-west');
    expect(r.body).toBe('{"text":"hi"}');
    expect(r.secrets).toContain('tok_abcdef');
  });

  it('names every missing required argument', () => {
    expect(() => buildRequest(tool, env, {}, vars)).toThrow('Missing required arguments: id, text.');
  });

  it('sends without auth when the variable is unset', () => {
    const r = buildRequest(tool, env, { id: '1', text: 'x' }, () => undefined);
    expect(r.headers.authorization).toBeUndefined();
  });

  it('puts a query api key in the URL and scrubs it from what is shown', () => {
    const e: EnvDef = { ...env, headers: undefined, auth: { type: 'apiKey', in: 'query', name: 'key', valueVar: 'K' } };
    const r = buildRequest(tool, e, { id: '1', text: 'x' }, (n) => (n === 'K' ? 'k3y-value' : undefined));
    expect(r.url).toContain('key=k3y-value');
    expect(scrub(r.url, r.secrets)).toContain('key=•••');
  });
});

describe('send', () => {
  it('compacts JSON, cuts long bodies and scrubs echoed secrets', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ echo: 'tok_abcdef', data: 'x'.repeat(200) }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const r = await send(buildRequest(tool, env, { id: '1', text: 'x' }, vars), { limit: 60, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.body).not.toContain('tok_abcdef');
    expect(r.truncated).toBe(true);
    expect(r.body).toMatch(/cut at 60 of \d+ characters/);
    expect(r.request.headers.authorization).toBe('Bearer •••');
  });

  it('explains a connection failure without leaking the token', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    await expect(send(buildRequest(tool, env, { id: '1', text: 'x' }, vars), { fetchImpl })).rejects.toThrow('Could not reach http://localhost:4010: ECONNREFUSED.');
  });
});
