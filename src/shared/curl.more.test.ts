import { describe, expect, it } from 'vitest';
import { parseCurl, shellWords, toolFromCurl } from './curl';

describe('shellWords, more', () => {
  it('keeps empty quoted words and single-quoted backslashes', () => {
    expect(shellWords(`curl '' "" 'a\\nb'`)).toEqual(['curl', '', '', 'a\\nb']);
  });
  it('keeps other backslashes inside double quotes', () => {
    expect(shellWords(`"a\\nb" "\\$x" "\\\\"`)).toEqual(['a\\nb', '$x', '\\']);
  });
  it('joins CRLF continuations and splits on any whitespace', () => {
    expect(shellWords('curl \\\r\n  -H\t"x: y"\n\nhttps://a.example')).toEqual(['curl', '-H', 'x: y', 'https://a.example']);
  });
  it('undoes Windows cmd ^ escapes in words without spaces', () => {
    expect(shellWords('curl https://a.example/?a=1^&b=2 -H "x: ^y"')).toEqual(['curl', 'https://a.example/?a=1&b=2', '-H', 'x: ^y']);
  });
  // BUG: Chrome's "Copy as cURL (cmd)" wraps every value in ^"…^". shellWords
  // leaves a trailing ^ on the URL (https://a.example/?a=1&b=2^) and keeps
  // both carets on values with spaces (header name becomes "^accept").
  it('reads a Chrome "Copy as cURL (cmd)" with ^"…^" quoting', () => {
    const c = parseCurl('curl ^"https://a.example/?a=1^&b=2^" ^\n  -H ^"accept: application/json^"');
    expect(c.url.href).toBe('https://a.example/?a=1&b=2');
    expect(c.headers).toEqual({ accept: 'application/json' });
  });
  it('is empty for nothing', () => expect(shellWords('   ')).toEqual([]));
});

describe('parseCurl, more', () => {
  it('reads -X glued to the method and --request', () => {
    expect(parseCurl('curl -XPATCH https://a.example/x').method).toBe('PATCH');
    expect(parseCurl('curl --request put https://a.example/x').method).toBe('PUT');
  });

  it('reads headers, lower-casing names and skipping ones with no colon', () => {
    const c = parseCurl(`curl https://a.example -H 'X-Tenant:  acme ' --header 'Accept: a:b' -H 'bogus' -H ':x'`);
    expect(c.headers).toEqual({ 'x-tenant': 'acme', accept: 'a:b' });
  });

  it.each(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'])('%s makes it a POST with that body', (flag) => {
    const c = parseCurl(`curl https://a.example/x ${flag} 'a=1'`);
    expect(c.method).toBe('POST');
    expect(c.body).toBe('a=1');
  });

  it('joins several data parts with &', () => {
    expect(parseCurl(`curl https://a.example -d a=1 --data-raw b=2`).body).toBe('a=1&b=2');
  });

  it('--json sets JSON headers unless given', () => {
    const c = parseCurl(`curl --json '{"a":1}' https://a.example`);
    expect(c.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json' });
    expect(c.body).toBe('{"a":1}');
    const d = parseCurl(`curl -H 'Content-Type: application/vnd.acme+json' --json '{}' https://a.example`);
    expect(d.headers['content-type']).toBe('application/vnd.acme+json');
  });

  it('makes -u a Basic header', () => {
    expect(parseCurl('curl --user wile:coyote https://a.example').headers.authorization).toBe(`Basic ${btoa('wile:coyote')}`);
  });

  it('skips the values of options it does not use, and flags like --compressed', () => {
    const c = parseCurl(`curl -b 'sid=1' -A agent -e https://ref.example -o out.json -m 5 --connect-timeout 3 -w '%{http_code}' --compressed -s -k https://a.example/real`);
    expect(c.url.href).toBe('https://a.example/real');
    expect(c.method).toBe('GET');
    expect(c.headers).toEqual({});
  });

  it('takes --url, the first bare word only, and adds https:// to a bare host', () => {
    expect(parseCurl('curl --url https://a.example/u').url.href).toBe('https://a.example/u');
    expect(parseCurl('curl a.example/x https://b.example').url.href).toBe('https://a.example/x');
    expect(parseCurl('curl.exe HTTP://A.example').url.host).toBe('a.example');
  });

  it('reads a multi-line Chrome copy with continuations', () => {
    const c = parseCurl(`curl 'https://api.acme.example/v1/teams?season=2025' \\
  -H 'accept: application/json' \\
  -H 'x-csrf-token: abc' \\
  --compressed`);
    expect(c.url.searchParams.get('season')).toBe('2025');
    expect(c.headers).toEqual({ accept: 'application/json', 'x-csrf-token': 'abc' });
  });

  it('refuses a URL it cannot read', () => {
    expect(() => parseCurl('curl "http://exa mple.com"')).toThrow(/is not a URL/);
  });
});

describe('toolFromCurl, more', () => {
  const tf = (cmd: string, base?: string) => toolFromCurl(parseCurl(cmd), { base, varPrefix: 'ACME' });

  it('uses the origin when the call is not under the base', () => {
    const r = tf('curl https://api.acme.example/orders', 'https://other.example/v1');
    expect(r.baseUrl).toBe('https://api.acme.example');
    expect(r.tool.path).toBe('/orders');
  });

  it('makes the base itself the path /', () => {
    expect(tf('curl https://api.acme.example/v1', 'https://api.acme.example/v1/').tool.path).toBe('/');
  });

  it('templates uuids and names them after the segment before, or item', () => {
    const uuid = '3f2a9c1e-7b4d-4e8a-9c2b-1d2e3f4a5b6c';
    const r = tf(`curl https://a.example/${uuid}/notes/12`);
    expect(r.tool.path).toBe('/{item_id}/notes/{note_id}');
    expect(r.tool.params.map((p) => [p.name, p.schema.type])).toEqual([
      ['item_id', 'string'],
      ['note_id', 'integer'],
    ]);
    expect(r.tool.example).toEqual({ item_id: uuid, note_id: 12 });
  });

  it('keeps Basic auth as variables, with no secret handed back', () => {
    const r = tf('curl -u wile:coyote https://a.example/x');
    expect(r.auth).toEqual({ type: 'basic', userVar: 'ACME_USER', passVar: 'ACME_PASSWORD' });
    expect(r.secret).toBeUndefined();
  });

  it('turns an API key header into apiKey auth', () => {
    const r = tf(`curl https://a.example/x -H 'X-API-Key: k-123'`);
    expect(r.auth).toEqual({ type: 'apiKey', in: 'header', name: 'x-api-key', valueVar: 'ACME_API_KEY' });
    expect(r.secret).toEqual({ value: 'k-123' });
  });

  it('prefers a bearer token to a key header', () => {
    expect(tf(`curl https://a.example/x -H 'Authorization: Bearer t' -H 'x-auth-token: k'`).auth.type).toBe('bearer');
  });

  it('types query values', () => {
    const r = tf('curl "https://a.example/x?n=-3&f=1.5&b=true&s=abc"');
    expect(r.tool.params.map((p) => [p.name, p.schema.type])).toEqual([
      ['n', 'integer'],
      ['f', 'number'],
      ['b', 'boolean'],
      ['s', 'string'],
    ]);
    expect(r.tool.example).toEqual({ n: -3, f: '1.5', b: 'true', s: 'abc' });
  });

  it('types JSON body fields, and skips one already a parameter', () => {
    const r = tf(`curl https://a.example/x?id=1 -d '{"id":2,"n":1,"f":1.5,"tags":[],"none":null,"ok":true,"s":"x","o":{}}'`);
    expect(r.tool.bodyMode).toBe('json-fields');
    expect(r.tool.params.filter((p) => p.in === 'body').map((p) => [p.name, p.schema])).toEqual([
      ['n', { type: 'integer' }],
      ['f', { type: 'number' }],
      ['tags', { type: 'array' }],
      ['none', {}],
      ['ok', { type: 'boolean' }],
      ['s', { type: 'string' }],
      ['o', { type: 'object' }],
    ]);
    expect(r.tool.example?.id).toBe(1);
  });

  it('sends a JSON array or scalar whole', () => {
    const r = tf(`curl https://a.example/x -d '[1,2]'`);
    expect(r.tool.bodyMode).toBe('json-whole');
    expect(r.tool.params).toEqual([{ name: 'body', in: 'body', required: true, description: 'The JSON request body.', schema: { type: 'array' } }]);
    expect(r.tool.example).toEqual({ body: [1, 2] });
  });

  it('reads a form body', () => {
    const r = tf(`curl https://a.example/login -d 'user=wile&remember=true'`);
    expect(r.tool.bodyMode).toBe('form');
    expect(r.tool.params.map((p) => [p.name, p.schema.type])).toEqual([
      ['user', 'string'],
      ['remember', 'boolean'],
    ]);
    expect(r.tool.example).toEqual({ user: 'wile', remember: 'true' });
  });

  it('sends any other text whole', () => {
    const r = tf(`curl https://a.example/x --data-binary '<x>{a=b}</x>'`);
    expect(r.tool.bodyMode).toBe('json-whole');
    expect(r.tool.params).toEqual([{ name: 'body', in: 'body', required: true, schema: {} }]);
    expect(r.tool.example).toEqual({ body: '<x>{a=b}</x>' });
  });

  it('marks a DELETE destructive', () => {
    expect(tf('curl -X DELETE https://a.example/orders/5').tool).toMatchObject({ safety: 'destructive', id: 'DELETE /orders/{order_id}' });
  });
});
