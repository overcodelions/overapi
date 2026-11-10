import { describe, expect, it } from 'vitest';
import { importText } from './index';

const collection = {
  info: { name: 'Acme Warehouse', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://wh.acme.example/rest' }],
  auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-WH-Key' }, { key: 'value', value: 'should-not-be-kept' }, { key: 'in', value: 'header' }] },
  item: [
    {
      name: 'Stock',
      item: [
        {
          name: 'Get stock level',
          request: {
            method: 'GET',
            url: { raw: '{{baseUrl}}/stock/:sku?warehouse=3', query: [{ key: 'warehouse', value: '3' }], variable: [{ key: 'sku', value: 'ANVIL-1', description: 'Product code' }] },
          },
        },
        {
          name: 'Adjust stock',
          request: { method: 'POST', url: '{{baseUrl}}/stock/:sku/adjust', body: { mode: 'raw', raw: '{"delta": -2, "reason": "{{reason}}"}' } },
        },
      ],
    },
  ],
};

describe('Postman import', () => {
  const p = importText(JSON.stringify(collection));

  it('takes the base URL from the collection variable and keeps no key value', () => {
    expect(p.envs[0].baseUrl).toBe('https://wh.acme.example/rest');
    expect(p.envs[0].auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-WH-Key', valueVar: 'ACME_WAREHOUSE_API_KEY' });
    expect(JSON.stringify(p)).not.toContain('should-not-be-kept');
  });

  it('turns :vars into path params and names tools from request names', () => {
    const get = p.tools[0];
    expect(get).toMatchObject({ name: 'get_stock_level', path: '/stock/{sku}', safety: 'read' });
    expect(get.params.map((x) => [x.name, x.in])).toEqual([
      ['sku', 'path'],
      ['warehouse', 'query'],
    ]);
    expect(get.params[0].description).toBe('Product code');
    expect(get.description).toContain('(Stock)');
  });

  it('infers body fields from the example, with {{vars}} blanked', () => {
    const adjust = p.tools[1];
    expect(adjust.bodyMode).toBe('json-fields');
    expect(adjust.params.filter((x) => x.in === 'body').map((x) => [x.name, x.schema.type])).toEqual([
      ['delta', 'integer'],
      ['reason', 'string'],
    ]);
  });
});
