import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importText } from './index';
import { deref } from './openapi';

const spec = fs.readFileSync(path.join(__dirname, '../../../examples/acme-orders.openapi.yaml'), 'utf8');

describe('OpenAPI import', () => {
  const p = importText(spec, 'acme.yaml');
  const tool = (name: string) => p.tools.find((t) => t.name === name)!;

  it('names the project and its environments from the spec', () => {
    expect(p.name).toBe('acme-orders');
    expect(p.envs.map((e) => [e.name, e.baseUrl])).toEqual([
      ['local', 'http://localhost:4010/api/v1'],
      ['staging', 'https://orders.staging.acme.example/api/v1'],
      ['production', 'https://orders.acme.example/api/v1'],
    ]);
    expect(p.envs.every((e) => !e.allowWrites)).toBe(true);
  });

  it('turns bearer auth into a variable name, never a value', () => {
    expect(p.envs[0].auth).toEqual({ type: 'bearer', tokenVar: 'ACME_ORDERS_TOKEN' });
  });

  it('makes one tool per operation, named from operationId', () => {
    expect(p.tools.map((t) => t.name).sort()).toEqual(
      ['cancel_order', 'create_order', 'delete_order', 'get_customer', 'get_order', 'list_orders', 'search_orders'].sort(),
    );
  });

  it('classifies safety, including POST-that-reads', () => {
    expect(tool('list_orders').safety).toBe('read');
    expect(tool('search_orders').safety).toBe('read');
    expect(tool('create_order').safety).toBe('write');
    expect(tool('cancel_order').safety).toBe('write');
    expect(tool('delete_order').safety).toBe('destructive');
  });

  it('merges path-level parameters', () => {
    const get = tool('get_order');
    expect(get.params).toEqual([expect.objectContaining({ name: 'orderId', in: 'path', required: true, description: 'The order number.' })]);
  });

  it('flattens an object body into named arguments, dropping readOnly fields', () => {
    const create = tool('create_order');
    expect(create.bodyMode).toBe('json-fields');
    expect(create.params.map((x) => [x.name, x.in, x.required])).toEqual([
      ['customer_id', 'body', true],
      ['items', 'body', true],
      ['note', 'body', false],
    ]);
    const items = create.params.find((x) => x.name === 'items')!.schema;
    expect(items.items?.properties).not.toHaveProperty('unit_price');
  });

  it('describes what an operation returns', () => {
    expect(tool('get_order').description).toMatch(/^One order with its line items\. Returns id, customer_id, status/);
    expect(tool('list_orders').description).toMatch(/Returns a list of objects with id/);
  });

  it('keeps enums and defaults on query params', () => {
    const status = tool('list_orders').params.find((x) => x.name === 'status')!;
    expect(status.schema.enum).toEqual(['open', 'shipped', 'cancelled']);
  });
});

describe('Swagger 2 import', () => {
  const doc = {
    swagger: '2.0',
    info: { title: 'Legacy Billing', version: '1' },
    host: 'billing.acme.example',
    basePath: '/v1',
    schemes: ['https'],
    securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-Billing-Key' } },
    paths: {
      '/invoices/{id}': {
        get: { parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }], responses: { 200: { description: 'ok' } } },
      },
      '/invoices': {
        post: {
          parameters: [{ name: 'payload', in: 'body', schema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } }],
          responses: { 201: { description: 'ok' } },
        },
      },
      '/login': {
        post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'user', in: 'formData', type: 'string', required: true }], responses: {} },
      },
    },
  };
  const p = importText(JSON.stringify(doc));

  it('builds the base URL and api-key auth', () => {
    expect(p.envs[0].baseUrl).toBe('https://billing.acme.example/v1');
    expect(p.envs[0].auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-Billing-Key', valueVar: 'LEGACY_BILLING_API_KEY' });
  });

  it('names routes without operationIds', () => {
    expect(p.tools.map((t) => t.name).sort()).toEqual(['create_invoice', 'create_login', 'get_invoice']);
  });

  it('reads body and formData parameters', () => {
    expect(p.tools.find((t) => t.name === 'create_invoice')!.params).toEqual([expect.objectContaining({ name: 'amount', in: 'body', required: true })]);
    const login = p.tools.find((t) => t.name === 'create_login')!;
    expect(login.bodyMode).toBe('form');
  });
});

describe('relative servers', () => {
  const spec = JSON.stringify({ openapi: '3.0.2', info: { title: 'Pets', version: '1' }, servers: [{ url: '/api/v3' }], paths: { '/pet/{id}': { get: { responses: {} } } } });
  it('resolves against the URL the spec came from', () => {
    expect(importText(spec, 'https://petstore3.swagger.io/api/v3/openapi.json').envs[0].baseUrl).toBe('https://petstore3.swagger.io/api/v3');
  });
  it('stays relative when imported from a file', () => {
    expect(importText(spec, 'openapi.json').envs[0].baseUrl).toBe('/api/v3');
  });
});

describe('deref', () => {
  it('stops on recursive schemas', () => {
    const doc = { components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } }, x: { $ref: '#/components/schemas/Node' } };
    const out = deref(doc) as any;
    expect(out.x.properties.child.description).toMatch(/Recursive \(Node\)/);
  });
});

describe('format detection', () => {
  it('reads a WSDL, and refuses other XML with a pointer to one', () => {
    expect(() => importText('<?xml version="1.0"?><definitions/>')).toThrow(/WSDL has no operations/);
    expect(() => importText('<?xml version="1.0"?><orders/>')).toThrow(/not a WSDL.*\?wsdl/);
  });
  it('refuses unknown JSON plainly', () => {
    expect(() => importText('{"hello": 1}')).toThrow(/OpenAPI 3, Swagger 2, a WSDL, a HAR/);
  });
});
