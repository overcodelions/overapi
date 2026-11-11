import { describe, expect, it } from 'vitest';
import { asCurl, asFetch, asHttpie, asPython, replayable, replayHeaders, SNIPPETS, type Replayable } from './snippets';
import type { RecordedCall } from './recording';

const call = (extra: Partial<RecordedCall> = {}): RecordedCall => ({ id: 'c1', at: '2026-01-01T00:00:00Z', method: 'POST', path: '/orders?x=1', status: 200, statusText: 'OK', ms: 5, requestHeaders: { accept: 'application/json', host: 'api.acme.example', 'content-length': '9', 'sec-fetch-mode': 'cors', ':authority': 'x', 'accept-encoding': 'gzip' }, responseHeaders: {}, requestBody: '{"a":"b"}', contentType: 'application/json', bytes: 2, ...extra });

describe('replayHeaders', () => {
  it('drops connection and browser headers, keeps the rest', () => {
    expect(replayHeaders({ Host: 'x', Connection: 'keep-alive', 'Proxy-Authorization': 'x', TE: 'trailers', Upgrade: 'h2c', 'sec-ch-ua': 'x', priority: 'u=1', 'Transfer-Encoding': 'chunked', Authorization: 'Bearer t', 'X-Tenant': 'acme' })).toEqual({ Authorization: 'Bearer t', 'X-Tenant': 'acme' });
  });
});

describe('replayable', () => {
  it('uses the call’s own URL when it has one', () => {
    const r = replayable(call({ url: 'https://api.acme.example/orders?x=1' }), 'https://ignored.example');
    expect(r).toEqual({ method: 'POST', url: 'https://api.acme.example/orders?x=1', headers: { accept: 'application/json' }, body: '{"a":"b"}' });
  });
  it('joins the base and the path otherwise', () => {
    expect(replayable(call(), 'https://api.acme.example/v1//').url).toBe('https://api.acme.example/v1/orders?x=1');
    expect(replayable(call()).url).toBe('/orders?x=1');
  });
  it('sends no body with GET or HEAD', () => {
    expect(replayable(call({ method: 'GET' })).body).toBeUndefined();
    expect(replayable(call({ method: 'HEAD' })).body).toBeUndefined();
    expect(replayable(call({ requestBody: undefined })).body).toBeUndefined();
  });
});

describe('snippets', () => {
  const post: Replayable = { method: 'POST', url: "https://api.acme.example/q?name=O'Brien", headers: { 'content-type': 'application/json' }, body: `{"who":"O'Brien"}` };
  const get: Replayable = { method: 'GET', url: 'https://api.acme.example/orders', headers: {} };

  it('cURL quotes for the shell and leaves -X off a GET', () => {
    expect(asCurl(get)).toBe(`curl 'https://api.acme.example/orders'`);
    expect(asCurl(post)).toBe([`curl -X POST 'https://api.acme.example/q?name=O'\\''Brien'`, `  -H 'content-type: application/json'`, `  --data-raw '{"who":"O'\\''Brien"}'`].join(' \\\n'));
  });

  it('fetch carries method, headers and body', () => {
    expect(asFetch(post)).toContain(`fetch("https://api.acme.example/q?name=O'Brien", {`);
    expect(asFetch(post)).toContain(`"body": "{\\"who\\":\\"O'Brien\\"}"`);
    expect(asFetch(get)).not.toContain('"body"');
  });

  it('Python uses requests, data only with a body', () => {
    expect(asPython(post)).toContain('import requests');
    expect(asPython(post)).toContain(`    "POST",`);
    expect(asPython(post)).toContain(`    data="{\\"who\\":\\"O'Brien\\"}",`);
    expect(asPython(get)).not.toContain('data=');
    expect(asPython(get).split('\n').at(-1)).toBe('print(res.status_code, res.text)');
  });

  it('HTTPie puts headers as name:value', () => {
    expect(asHttpie(get)).toBe(`http GET 'https://api.acme.example/orders'`);
    expect(asHttpie(post)).toBe([`http --raw '{"who":"O'\\''Brien"}' POST 'https://api.acme.example/q?name=O'\\''Brien'`, `  'content-type:application/json'`].join(' \\\n'));
  });

  it('lists all four', () => {
    expect(SNIPPETS.map((s) => s.id)).toEqual(['curl', 'fetch', 'python', 'httpie']);
    for (const s of SNIPPETS) expect(s.make(get)).toContain('https://api.acme.example/orders');
  });
});
