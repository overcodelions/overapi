import { describe, expect, it } from 'vitest';
import { parseCurl, shellWords, toolFromCurl } from './curl';

describe('shellWords', () => {
  it('handles quotes, escapes and continuations', () => {
    expect(shellWords(`curl 'a b' "c \\"d\\"" e\\ f \\\n -H x`)).toEqual(['curl', 'a b', 'c "d"', 'e f', '-H', 'x']);
  });
});

describe('parseCurl', () => {
  it('reads a Chrome "Copy as cURL"', () => {
    const c = parseCurl(`curl 'https://orders.acme.example/api/v1/orders/1042/cancel?notify=true' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer tok_live_SECRET' \\
  --data-raw '{"reason":"customer asked","refund":true}'`);
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/api/v1/orders/1042/cancel');
    expect(c.headers.authorization).toBe('Bearer tok_live_SECRET');
    expect(c.body).toBe('{"reason":"customer asked","refund":true}');
  });

  it('honours -X, -G and -u', () => {
    expect(parseCurl(`curl -X DELETE https://x.example/a/9`).method).toBe('DELETE');
    const g = parseCurl(`curl -G https://x.example/s -d q=anvil -d page=2`);
    expect(g.method).toBe('GET');
    expect(g.url.search).toBe('?q=anvil&page=2');
    expect(parseCurl(`curl -u wile:pass https://x.example/`).headers.authorization).toMatch(/^Basic /);
  });

  it('refuses things that are not curl', () => {
    expect(() => parseCurl('wget https://x')).toThrow(/curl/);
    expect(() => parseCurl('curl -H x:y')).toThrow(/No URL/);
  });
});

describe('toolFromCurl', () => {
  const c = parseCurl(`curl 'https://orders.acme.example/api/v1/orders/1042/cancel?notify=true' -H 'Authorization: Bearer tok_live_SECRET' --data-raw '{"reason":"late","refund":true}'`);

  it('makes the path relative to the base, templates ids, and keeps the values as the example', () => {
    const r = toolFromCurl(c, { base: 'https://orders.acme.example/api/v1', varPrefix: 'ACME' });
    expect(r.baseUrl).toBe('https://orders.acme.example/api/v1');
    expect(r.tool).toMatchObject({ id: 'POST /orders/{order_id}/cancel', name: 'cancel_order', safety: 'write', bodyMode: 'json-fields' });
    expect(r.tool.example).toEqual({ order_id: 1042, notify: 'true', reason: 'late', refund: true });
    expect(r.tool.params.map((p) => `${p.in}:${p.name}`)).toEqual(['path:order_id', 'query:notify', 'body:reason', 'body:refund']);
  });

  it('turns the credential into a variable and hands the value back separately', () => {
    const r = toolFromCurl(c, { varPrefix: 'ACME' });
    expect(r.auth).toEqual({ type: 'bearer', tokenVar: 'ACME_TOKEN' });
    expect(r.secret).toEqual({ value: 'tok_live_SECRET' });
    expect(JSON.stringify(r.tool)).not.toContain('SECRET');
  });

  it('keeps a query api key out of the arguments', () => {
    const r = toolFromCurl(parseCurl('curl "https://x.example/v1/items?api_key=k123&limit=5"'), { varPrefix: 'X' });
    expect(r.auth).toEqual({ type: 'apiKey', in: 'query', name: 'api_key', valueVar: 'X_API_KEY' });
    expect(r.tool.params.map((p) => p.name)).toEqual(['limit']);
    expect(r.baseUrl).toBe('https://x.example');
  });
});
