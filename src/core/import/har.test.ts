import { describe, expect, it } from 'vitest';
import { importHar, nameForOrigin, templatePaths } from './har';

function entry(method: string, url: string, opts: { body?: unknown; form?: string; headers?: Record<string, string>; status?: number; response?: unknown; mime?: string } = {}) {
  return {
    request: {
      method,
      url,
      headers: Object.entries({ Accept: 'application/json', ...(opts.headers ?? {}) }).map(([name, value]) => ({ name, value })),
      postData: opts.body !== undefined ? { mimeType: 'application/json', text: JSON.stringify(opts.body) } : opts.form ? { mimeType: 'application/x-www-form-urlencoded', text: opts.form } : undefined,
    },
    response: {
      status: opts.status ?? 200,
      content: { mimeType: opts.mime ?? 'application/json', text: opts.response === undefined ? '{}' : JSON.stringify(opts.response) },
    },
  };
}

const auth = { Authorization: 'Bearer sk_live_SECRET_123456' };
const base = 'https://erp.acme.example/api/v2';
const har = {
  log: {
    entries: [
      entry('GET', 'https://erp.acme.example/app.js', { mime: 'text/javascript' }),
      entry('GET', 'https://analytics.example.net/collect?x=1', { mime: 'application/json' }),
      entry('GET', `${base}/orders?status=open&page=1`, { headers: auth, response: [{ id: 1, status: 'open', items: [] }] }),
      entry('GET', `${base}/orders?status=shipped&page=2`, { headers: auth }),
      entry('GET', `${base}/orders?status=open`, { headers: auth }),
      entry('GET', `${base}/orders?status=shipped`, { headers: auth }),
      entry('GET', `${base}/orders/1042`, { headers: auth, response: { id: 1042, total: 9.5 } }),
      entry('GET', `${base}/orders/1043`, { headers: auth }),
      entry('GET', `${base}/orders/1042/items/7`, { headers: auth }),
      entry('POST', `${base}/orders`, { headers: auth, body: { customer: 5, lines: [{ sku: 'A', qty: 1 }] }, status: 201 }),
      entry('POST', `${base}/orders`, { headers: auth, body: { customer: 6, lines: [], rush: true }, status: 201 }),
      entry('POST', `${base}/orders/1042/delete`, { headers: auth }),
      entry('POST', `${base}/session`, { form: 'user=wile&remember=true' }),
    ],
  },
};

describe('HAR import', () => {
  const p = importHar(har, 'capture.har');
  const byId = (id: string) => p.tools.find((t) => t.id === id)!;

  it('picks the API origin and folds the mount prefix into the base URL', () => {
    expect(p.envs).toEqual([{ name: 'default', baseUrl: base, auth: { type: 'bearer', tokenVar: 'ERP_TOKEN' }, allowWrites: false }]);
  });

  it('never keeps a captured credential', () => {
    expect(JSON.stringify(p)).not.toContain('SECRET');
  });

  it('templates ids and groups calls into tools', () => {
    expect(p.tools.map((t) => t.id)).toEqual([
      'GET /orders',
      'POST /orders',
      'GET /orders/{order_id}',
      'POST /orders/{order_id}/delete',
      'GET /orders/{order_id}/items/{item_id}',
      'POST /session',
    ]);
  });

  it('infers query params, required-ness and enums', () => {
    const list = byId('GET /orders');
    expect(list.name).toBe('list_orders');
    const status = list.params.find((x) => x.name === 'status')!;
    expect(status).toMatchObject({ in: 'query', required: true, schema: { type: 'string', enum: ['open', 'shipped'] } });
    expect(list.params.find((x) => x.name === 'page')).toMatchObject({ required: false, schema: { type: 'integer' } });
    expect(list.description).toMatch(/^Lists orders\. Returns a list of objec/);
  });

  it('merges JSON bodies across samples', () => {
    const create = byId('POST /orders');
    expect(create.bodyMode).toBe('json-fields');
    expect(create.params.map((x) => [x.name, x.required])).toEqual([
      ['customer', true],
      ['lines', true],
      ['rush', false],
    ]);
  });

  it('flags legacy action paths as destructive', () => {
    expect(byId('POST /orders/{order_id}/delete').safety).toBe('destructive');
  });

  it('reads form bodies', () => {
    const s = byId('POST /session');
    expect(s.bodyMode).toBe('form');
    expect(s.params.find((x) => x.name === 'remember')!.schema).toEqual({ type: 'boolean' });
  });

  it('says so when a capture has no API calls', () => {
    expect(() => importHar({ log: { entries: [entry('GET', 'https://x.example/a.png', { mime: 'image/png' })] } })).toThrow(/no API calls/);
  });
});

describe('nameForOrigin', () => {
  it.each([
    ['https://erp.acme.example', 'Erp API'],
    ['https://api.acme.example', 'Acme API'],
    ['http://localhost:5002', 'Local API :5002'],
    ['http://127.0.0.1:4010', 'Local API :4010'],
  ])('%s -> %s', (o, n) => expect(nameForOrigin(o)).toBe(n));
});

describe('templatePaths', () => {
  it('handles uuids, hex and opaque ids, and leaves words alone', () => {
    expect(
      templatePaths([
        '/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        '/docs/5f8d0d55b54764421b7156c9',
        '/carts/ab12cd34ef',
        '/orders/search',
        '/v2/things',
      ]),
    ).toEqual(['/users/{user_id}', '/docs/{doc_id}', '/carts/{cart_id}', '/orders/search', '/v2/things']);
  });
});
