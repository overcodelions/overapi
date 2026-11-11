import { describe, expect, it } from 'vitest';
import { guardRequest } from './readOnlyGuard';

const sends = (m: string, u: string, b?: string, safe = false) => guardRequest(m, u, b, safe).send;

describe('the read-only guard while exploring', () => {
  it('lets reads through and stops everything else', () => {
    expect(sends('GET', 'https://acme.example/api/orders')).toBe(true);
    expect(sends('OPTIONS', 'https://acme.example/api/orders')).toBe(true);
    expect(sends('POST', 'https://acme.example/api/orders')).toBe(false);
    expect(sends('DELETE', 'https://acme.example/api/orders/1')).toBe(false);
    expect(sends('POST', 'https://acme.example/api/search')).toBe(false);
  });
  it('with safe search, lets read-only queries through — never writes or tracking', () => {
    expect(sends('POST', 'https://acme.example/api/products/search', '{"q":"lamp"}', true)).toBe(true);
    expect(sends('POST', 'https://acme.example/api/orders/filter', '{}', true)).toBe(true);
    expect(sends('POST', 'https://acme.example/graphql', '{"query":"{ orders { id } }"}', true)).toBe(true);
    expect(sends('POST', 'https://acme.example/graphql', '{"query":"mutation { cancel(id: 1) }"}', true)).toBe(false);
    expect(sends('POST', 'https://acme.example/api/search/track-event', '{}', true)).toBe(false);
    expect(sends('POST', 'https://acme.example/api/orders', '{}', true)).toBe(false);
    expect(sends('PUT', 'https://acme.example/api/search', '{}', true)).toBe(false);
  });
});
