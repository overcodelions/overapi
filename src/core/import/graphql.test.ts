import { describe, expect, it } from 'vitest';
import { importGraphql, INTROSPECTION_QUERY } from './graphql';
import { importText } from './index';
import { importFromUrl } from './fromUrl';

const scalar = (name: string) => ({ kind: 'SCALAR', name });
const nonNull = (t: object) => ({ kind: 'NON_NULL', name: null, ofType: t });
const list = (t: object) => ({ kind: 'LIST', name: null, ofType: t });
const obj = (name: string) => ({ kind: 'OBJECT', name });

const schema = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            { name: 'order', description: 'One order by id.', args: [{ name: 'id', type: nonNull(scalar('ID')) }], type: obj('Order') },
            {
              name: 'orders',
              args: [
                { name: 'first', type: nonNull(scalar('Int')), defaultValue: '10' },
                { name: 'status', type: { kind: 'ENUM', name: 'OrderStatus' } },
              ],
              type: list(obj('Order')),
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            { name: 'createOrder', args: [{ name: 'input', type: nonNull({ kind: 'INPUT_OBJECT', name: 'OrderInput' }) }], type: obj('Order') },
            { name: 'deleteOrder', args: [{ name: 'id', type: nonNull(scalar('ID')) }], type: scalar('Boolean') },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Order',
          fields: [
            { name: 'id', args: [], type: scalar('ID') },
            { name: 'total', args: [], type: scalar('Float') },
            { name: 'status', args: [], type: { kind: 'ENUM', name: 'OrderStatus' } },
            { name: 'customer', args: [], type: obj('Customer') },
            { name: 'lines', args: [{ name: 'first', type: nonNull(scalar('Int')) }], type: list(obj('Line')) },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Customer',
          fields: [
            { name: 'id', args: [], type: scalar('ID') },
            { name: 'name', args: [], type: scalar('String') },
          ],
        },
        { kind: 'ENUM', name: 'OrderStatus', enumValues: [{ name: 'OPEN' }, { name: 'SHIPPED' }] },
        {
          kind: 'INPUT_OBJECT',
          name: 'OrderInput',
          inputFields: [
            { name: 'customerId', type: nonNull(scalar('ID')) },
            { name: 'note', description: 'Shown on the packing slip.', type: scalar('String') },
          ],
        },
        scalar('ID'),
        scalar('Int'),
        scalar('Float'),
        scalar('String'),
        scalar('Boolean'),
      ],
    },
  },
};

describe('importGraphql', () => {
  const p = importGraphql(schema, 'test', 'https://api.acme.test/graphql');
  const byName = Object.fromEntries(p.tools.map((t) => [t.name, t]));

  it('makes queries reads and mutations writes, deletes destructive', () => {
    expect(p.tools.map((t) => [t.name, t.safety, t.group])).toEqual([
      ['order', 'read', 'Queries'],
      ['orders', 'read', 'Queries'],
      ['create_order', 'write', 'Mutations'],
      ['delete_order', 'destructive', 'Mutations'],
    ]);
    expect(p.envs[0].baseUrl).toBe('https://api.acme.test');
    expect(new Set(p.tools.map((t) => t.id)).size).toBe(4);
    expect(p.tools.every((t) => t.method === 'POST' && t.path === '/graphql' && t.bodyMode === 'graphql')).toBe(true);
  });

  it('writes the query, asking for plain fields and one level of objects, never fields that need arguments', () => {
    expect(byName.order.graphql).toEqual({ query: 'query Order($id: ID!) {\n  order(id: $id) { id total status customer { id name } }\n}', operationName: 'Order' });
    expect(byName.delete_order.graphql!.query).toBe('mutation DeleteOrder($id: ID!) {\n  deleteOrder(id: $id)\n}');
    expect(byName.order.description).toBe('One order by id.');
  });

  it('types the arguments: enums, defaults as optional, input objects with their required fields', () => {
    expect(byName.orders.params.map((x) => [x.name, x.required, x.schema])).toEqual([
      ['first', false, { type: 'integer' }],
      ['status', false, { type: 'string', enum: ['OPEN', 'SHIPPED'] }],
    ]);
    expect(byName.create_order.params[0]).toMatchObject({
      name: 'input',
      required: true,
      schema: { type: 'object', properties: { customerId: { type: 'string' }, note: { type: 'string', description: 'Shown on the packing slip.' } }, required: ['customerId'] },
    });
  });

  it('is found in an introspection file, and asked of a GraphQL endpoint', async () => {
    expect(importText(JSON.stringify(schema)).tools).toHaveLength(4);
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).query === INTROSPECTION_QUERY) return new Response(JSON.stringify(schema), { status: 200 });
      return new Response('Must provide query string.', { status: 400 });
    }) as typeof fetch;
    const r = await importFromUrl('https://api.acme.test/graphql', fetchImpl);
    expect(r.project.source?.kind).toBe('graphql');
    expect(r.project.envs[0].baseUrl).toBe('https://api.acme.test');
  });
});
