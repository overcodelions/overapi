import { describe, expect, it } from 'vitest';
import { callsToHar, startRecorder, type RecordedCall } from './recorder';

describe('startRecorder', () => {
  it('refuses a target that is not http(s)', async () => {
    await expect(startRecorder({ target: 'ftp://files.acme.example', port: 0, onCall: () => undefined })).rejects.toThrow('The API address must start with http:// or https://.');
  });

  it('says plainly when the port is taken', async () => {
    const first = await startRecorder({ target: 'http://acme.example', port: 0, onCall: () => undefined });
    try {
      await expect(startRecorder({ target: 'http://acme.example', port: first.port, onCall: () => undefined })).rejects.toThrow(`Port ${first.port} is in use. Pick another.`);
    } finally {
      await first.stop();
    }
  });

  it('answers 502 and records the reason when the API cannot be reached', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const rec = await startRecorder({ target: 'http://depot.acme.example:9/', port: 0, onCall: (c) => calls.push(c), fetchImpl });
    try {
      expect(rec.target).toBe('http://depot.acme.example:9');
      const res = await fetch(`http://127.0.0.1:${rec.port}/bins`);
      expect(res.status).toBe(502);
      expect(await res.text()).toBe('overapi recorder: Could not reach http://depot.acme.example:9: ECONNREFUSED');
      expect(calls[0]).toMatchObject({ status: 502, statusText: 'Bad Gateway', error: 'Could not reach http://depot.acme.example:9: ECONNREFUSED' });
    } finally {
      await rec.stop();
    }
  });

  it('uses the error message when there is no cause code', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const rec = await startRecorder({ target: 'http://depot.acme.example', port: 0, onCall: (c) => calls.push(c), fetchImpl });
    try {
      await fetch(`http://127.0.0.1:${rec.port}/`);
      expect(calls[0].error).toBe('Could not reach http://depot.acme.example: boom');
    } finally {
      await rec.stop();
    }
  });

  it('drops hop headers both ways, sends no body on GET, and keeps empty bodies as undefined', async () => {
    const calls: RecordedCall[] = [];
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (u: string | URL, init: RequestInit) => {
      seen.push({ url: String(u), init });
      return new Response(null, { status: 204, statusText: 'No Content', headers: { 'content-encoding': 'gzip', connection: 'close', 'x-acme': 'yes' } });
    }) as typeof fetch;
    const rec = await startRecorder({ target: 'http://depot.acme.example/v1', port: 0, onCall: (c) => calls.push(c), fetchImpl });
    try {
      const res = await fetch(`http://127.0.0.1:${rec.port}/bins?x=1`, { headers: { 'x-trace': 't1' } });
      expect(res.status).toBe(204);
      expect(res.headers.get('x-acme')).toBe('yes');
      expect(res.headers.get('content-encoding')).toBeNull();
    } finally {
      await rec.stop();
    }
    expect(seen[0].url).toBe('http://depot.acme.example/v1/bins?x=1');
    expect(seen[0].init.body).toBeUndefined();
    expect(seen[0].init.redirect).toBe('manual');
    const sent = seen[0].init.headers as Record<string, string>;
    expect(sent['x-trace']).toBe('t1');
    expect(sent.host).toBeUndefined();
    expect(sent.connection).toBeUndefined();
    expect(calls[0]).toMatchObject({ status: 204, statusText: 'No Content', requestBody: undefined, responseBody: undefined, bytes: 0, contentType: '' });
    expect(calls[0].responseHeaders).toEqual({ 'x-acme': 'yes' });
  });
});

describe('callsToHar', () => {
  const call = (extra: Partial<RecordedCall>): RecordedCall => ({ id: 'c', at: '', method: 'GET', path: '/x', status: 200, statusText: 'OK', ms: 1, requestHeaders: {}, responseHeaders: {}, contentType: 'application/json', bytes: 0, ...extra });

  it('leaves out failed calls, prefers a call’s own URL, and carries bodies', () => {
    const har = callsToHar(
      [
        call({ id: 'a', path: '/bins', responseBody: '[]' }),
        call({ id: 'b', error: 'Could not reach' }),
        call({ id: 'c', url: 'https://other.acme.example/full', method: 'POST', requestBody: '{"a":1}', requestHeaders: { 'content-type': 'application/json' } }),
        call({ id: 'd', method: 'POST', requestBody: 'raw' }),
      ],
      'https://depot.acme.example/v1///',
    );
    const entries = har.log.entries as Array<{ request: { url: string; postData?: { mimeType: string; text: string }; headers: unknown[] }; response: { content: { text: string } } }>;
    expect(entries.map((e) => e.request.url)).toEqual(['https://depot.acme.example/v1/bins', 'https://other.acme.example/full', 'https://depot.acme.example/v1/x']);
    expect(entries[0].request.postData).toBeUndefined();
    expect(entries[0].response.content.text).toBe('[]');
    expect(entries[1].request.postData).toEqual({ mimeType: 'application/json', text: '{"a":1}' });
    expect(entries[1].request.headers).toEqual([{ name: 'content-type', value: 'application/json' }]);
    expect(entries[2].request.postData).toEqual({ mimeType: '', text: 'raw' });
    expect(entries[2].response.content.text).toBe('');
  });
});
