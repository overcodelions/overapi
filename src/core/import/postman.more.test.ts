import { describe, expect, it } from 'vitest';
import { importPostman, isPostman } from './postman';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const collection = (item: unknown[], extra: Record<string, unknown> = {}) => ({ info: { name: 'Acme Depot', schema: SCHEMA }, item, ...extra });

describe('isPostman', () => {
  it('needs info, a list of items and a Postman marker', () => {
    expect(isPostman(collection([]))).toBe(true);
    expect(isPostman({ info: { _postman_id: 'postman-123' }, item: [] })).toBe(true);
    expect(isPostman({ info: { name: 'x' }, item: [] })).toBe(false);
    expect(isPostman({ info: { schema: SCHEMA }, item: {} })).toBe(false);
    expect(isPostman(null)).toBe(false);
  });
});

describe('importPostman: sign-in', () => {
  const auth = (a: unknown) => importPostman(collection([], a === undefined ? {} : { auth: a })).envs[0].auth;

  it('maps every kind of collection auth to variable names', () => {
    expect(auth(undefined)).toEqual({ type: 'none' });
    expect(auth({ type: 'bearer' })).toEqual({ type: 'bearer', tokenVar: 'ACME_DEPOT_TOKEN' });
    expect(auth({ type: 'oauth2' })).toEqual({ type: 'bearer', tokenVar: 'ACME_DEPOT_TOKEN' });
    expect(auth({ type: 'basic' })).toEqual({ type: 'basic', userVar: 'ACME_DEPOT_USER', passVar: 'ACME_DEPOT_PASSWORD' });
    expect(auth({ type: 'apikey', apikey: [{ key: 'in', value: 'query' }, { key: 'key', value: 'api_key' }] })).toEqual({ type: 'apiKey', in: 'query', name: 'api_key', valueVar: 'ACME_DEPOT_API_KEY' });
    expect(auth({ type: 'apikey' })).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key', valueVar: 'ACME_DEPOT_API_KEY' });
    expect(auth({ type: 'hawk' })).toEqual({ type: 'none' });
  });
});

describe('importPostman: requests', () => {
  it('reads string requests and full URLs, with the most common base', () => {
    const p = importPostman(
      collection([
        { name: 'Ping', request: 'https://depot.acme.example/ping' },
        { name: 'List bins', request: { method: 'get', url: 'https://depot.acme.example/bins/' } },
        { name: 'Elsewhere', request: { url: 'https://other.acme.example/x' } },
        { name: 'No URL', request: { method: 'GET' } },
      ]),
      'depot.json',
    );
    expect(p.envs[0].baseUrl).toBe('https://depot.acme.example');
    expect(p.tools.map((t) => [t.method, t.path, t.name])).toEqual([
      ['GET', '/ping', 'ping'],
      ['GET', '/bins', 'list_bins'],
      ['GET', '/x', 'elsewhere'],
    ]);
    expect(p.source).toMatchObject({ kind: 'postman', ref: 'depot.json' });
    expect(p.envs[0].allowWrites).toBe(false);
  });

  it('takes a description from text or an object, and names unnamed requests from the route', () => {
    const p = importPostman(
      collection([{ request: { method: 'DELETE', url: '{{base}}/bins/{{binId}}', description: { content: '  Removes a bin.  ' } } }], {
        info: { name: 'Acme Depot', schema: SCHEMA, description: 'The depot API.' },
        variable: [{ key: 'base', value: 'https://depot.acme.example/v1/' }],
      }),
    );
    expect(p.description).toBe('The depot API.');
    const t = p.tools[0];
    expect(t.path).toBe('/bins/{binId}');
    expect(t.params.map((x) => [x.name, x.in, x.required])).toEqual([['binId', 'path', true]]);
    expect(t.description).toBe('Removes a bin.');
    expect(t.safety).toBe('destructive');
    expect(t.origin?.tags).toBeUndefined();
    expect(p.envs[0].baseUrl).toBe('https://depot.acme.example/v1');
  });

  it('drops tokens from the query, marks disabled ones optional, and keeps useful headers', () => {
    const p = importPostman(
      collection([
        {
          name: 'Search',
          request: {
            method: 'GET',
            url: { raw: '{{base}}/search?q=anvil&api_key=xyz&page=2', query: [{ key: 'q', value: 'anvil', description: 'Text' }, { key: 'api_key', value: 'xyz' }, { key: 'page', value: '2', disabled: true }, { value: 'no key' }] },
            header: [
              { key: 'Authorization', value: 'Bearer x' },
              { key: 'X-Trace', value: 't', description: 'Trace id' },
              { key: 'X-Off', value: 'o', disabled: true },
              { value: 'nameless' },
            ],
          },
        },
      ]),
    );
    expect(p.tools[0].params.map((x) => [x.name, x.in, x.required, x.schema.type, x.description])).toEqual([
      ['q', 'query', true, 'string', 'Text'],
      ['page', 'query', false, 'integer', undefined],
      ['X-Trace', 'header', false, 'string', 'Trace id'],
    ]);
  });

  it('takes a raw body that is not an object as the whole body', () => {
    const p = importPostman(
      collection([
        { name: 'Bulk', request: { method: 'POST', url: '/bulk', body: { mode: 'raw', raw: '[{"sku":"A"}]' } } },
        { name: 'Text', request: { method: 'POST', url: '/text', body: { mode: 'raw', raw: 'hello there' } } },
        { name: 'Bare var', request: { method: 'POST', url: '/var', body: { mode: 'raw', raw: '{"n": {{count}}}' } } },
      ]),
    );
    const [bulk, text, bare] = p.tools;
    expect([bulk.bodyMode, bulk.params[0].name, bulk.params[0].schema.type]).toEqual(['json-whole', 'body', 'array']);
    expect([text.bodyMode, text.params[0].schema]).toEqual(['json-whole', {}]);
    expect([bare.bodyMode, bare.params.map((x) => x.name)]).toEqual(['json-fields', ['n']]);
  });

  it('takes the whole body when a body field clashes with another argument', () => {
    const p = importPostman(collection([{ name: 'Update bin', request: { method: 'PUT', url: '/bins/:id', body: { mode: 'raw', raw: '{"id": 1, "label": "x"}' } } }]));
    expect(p.tools[0].bodyMode).toBe('json-whole');
    expect(p.tools[0].params.map((x) => x.name)).toEqual(['id', 'body']);
  });

  it('reads urlencoded and form-data fields, skipping files and disabled ones', () => {
    const p = importPostman(
      collection([
        { name: 'Login', request: { method: 'POST', url: '/login', body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'wile' }, { key: 'pin', value: '1234', description: 'Four digits' }, { key: 'old', disabled: true }] } } },
        { name: 'Upload', request: { method: 'POST', url: '/upload', body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file' }, { key: 'note', value: '' }, {}] } } },
        { name: 'Empty form', request: { method: 'POST', url: '/empty', body: { mode: 'formdata' } } },
      ]),
    );
    const [login, upload, empty] = p.tools;
    expect(login.bodyMode).toBe('form');
    expect(login.params.map((x) => [x.name, x.schema.type, x.description])).toEqual([
      ['user', 'string', undefined],
      ['pin', 'integer', 'Four digits'],
    ]);
    expect(upload.params.map((x) => x.name)).toEqual(['note']);
    expect([empty.bodyMode, empty.params]).toEqual(['form', []]);
  });

  it('keeps the first of repeated routes and makes clashing names distinct', () => {
    const p = importPostman(
      collection([
        { name: 'Get', request: { method: 'GET', url: '/bins/:id' } },
        { name: 'Get again', request: { method: 'GET', url: '/bins/:id' } },
        { name: 'Get', request: { method: 'GET', url: '/shelves/:id' } },
      ]),
    );
    expect(p.tools.map((t) => t.id)).toEqual(['GET /bins/{id}', 'GET /shelves/{id}']);
    expect(new Set(p.tools.map((t) => t.name)).size).toBe(2);
  });

  it('nests folders into the description and tags, ignoring the query and fragment', () => {
    const p = importPostman(collection([{ name: 'Stock', item: [{ name: 'Levels', item: [{ name: 'Get level', request: { url: 'https://depot.acme.example/levels#top' } }] }] }]));
    expect(p.tools[0].path).toBe('/levels');
    expect(p.tools[0].origin?.tags).toEqual(['Stock', 'Levels']);
    expect(p.tools[0].description).toBe('Get level. (Stock / Levels)');
  });

  it('defaults the project name when the collection has none, and keeps a bare root route', () => {
    const p = importPostman({ info: { schema: SCHEMA }, item: [{ name: 'Root', request: { url: 'https://depot.acme.example' } }] });
    expect(p.title).toBe('API');
    expect(p.tools[0].path).toBe('/');
  });
});
