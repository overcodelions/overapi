import { describe, expect, it } from 'vitest';
import { isSessionHeader, sameSite, sessionExpiredHint, sessionPlan, sessionPrefix, siteGuess } from './session';
import type { RecordedCall } from './recording';

const BASE = 'https://api.acme.example';
let n = 0;
const call = (requestHeaders: Record<string, string>, url = `${BASE}/v1/orders`): RecordedCall => ({ id: `c${++n}`, at: '', method: 'GET', path: '/v1/orders', url, status: 200, statusText: 'OK', ms: 1, requestHeaders, responseHeaders: {}, contentType: 'application/json', bytes: 0 });

describe('sessionPlan', () => {
  it('keeps the cookies as one secret, skipping empty ones', () => {
    const p = sessionPlan([{ name: 'sid', value: 'abc' }, { name: 'theme', value: 'dark' }, { name: '', value: 'x' }, { name: 'empty', value: '' }], [], BASE, 'ACME');
    expect(p.headers).toEqual({ Cookie: '${ACME_SESSION}' });
    expect(p.secrets).toEqual({ ACME_SESSION: 'sid=abc; theme=dark' });
    expect(p.found).toEqual(['2 cookies']);
  });

  it('says "1 cookie" for one', () => {
    expect(sessionPlan([{ name: 'sid', value: 'abc' }], [], BASE, 'X').found).toEqual(['1 cookie']);
  });

  it('takes the latest Authorization the page sent to the API', () => {
    const calls = [call({ Authorization: 'Bearer old' }), call({ authorization: 'Bearer new' }), call({ authorization: 'Bearer elsewhere' }, 'https://other.example/x')];
    const p = sessionPlan([], calls, BASE, 'ACME');
    expect(p.secrets).toEqual({ ACME_TOKEN: 'Bearer new' });
    expect(p.headers).toEqual({ Authorization: '${ACME_TOKEN}' });
    expect(p.found).toEqual(['a bearer token']);
  });

  it('calls a non-bearer one an Authorization header', () => {
    expect(sessionPlan([], [call({ authorization: 'Token abc' })], BASE, 'X').found).toEqual(['an Authorization header']);
  });

  it('finds a CSRF header by name, preferring the cookie’s fresher value', () => {
    const p = sessionPlan([{ name: 'XSRF-TOKEN', value: 'fresh-value-123' }], [call({ 'x-xsrf-token': 'stale-value' })], BASE, 'ACME');
    expect(p.headers['X-Xsrf-Token']).toBe('${ACME_CSRF}');
    expect(p.secrets.ACME_CSRF).toBe('fresh-value-123');
    expect(p.found).toEqual(['1 cookie', 'the X-Xsrf-Token header']);
  });

  it('finds a double-submit header by its value matching a cookie', () => {
    const p = sessionPlan([{ name: 'guard', value: 'abcdef123456' }], [call({ 'x-request-guard': 'abcdef123456', accept: 'abcdef123456' })], BASE, 'ACME');
    expect(p.headers['X-Request-Guard']).toBe('${ACME_CSRF}');
    expect(p.headers.Accept).toBeUndefined();
    expect(p.secrets.ACME_CSRF).toBe('abcdef123456');
  });

  it('uses the header’s own value when no cookie matches', () => {
    const p = sessionPlan([], [call({ 'x-csrf-token': 'sent-value', ':path': '/x' })], BASE, 'ACME');
    expect(p.secrets).toEqual({ ACME_CSRF: 'sent-value' });
  });

  it('ignores calls without a URL', () => {
    const local: RecordedCall = { ...call({ authorization: 'Bearer x' }), url: undefined };
    expect(() => sessionPlan([], [local], BASE, 'ACME')).toThrow(/No sign-in found for api\.acme\.example/);
  });

  it('says so when it finds nothing, naming the base as written if it is not a URL', () => {
    expect(() => sessionPlan([], [], 'not a url', 'ACME')).toThrow(/No sign-in found for not a url:/);
  });
});

describe('sessionExpiredHint', () => {
  it('says the session expired', () => {
    expect(sessionExpiredHint('staging', 'https://app.acme.example', 'https://api.acme.example')).toBe('The browser sign-in for "staging" has probably expired. In overapi, open Environments → staging → Sign in again (it opens https://app.acme.example).');
    expect(sessionExpiredHint('staging', 'https://app.acme.example')).toMatch(/probably expired/);
  });
  it('says the session is for another site', () => {
    expect(sessionExpiredHint('staging', 'https://app.acme.example/login', 'https://api.other.example/v1')).toBe('"staging" is signed in to app.acme.example, but its requests go to api.other.example — that session can\'t sign them. In overapi, open Environments → staging → Sign in there.');
  });
});

describe('sessionPrefix', () => {
  it.each([
    ['Acme Shipping API', 'staging', 'ACME_SHIPPING_STAGING'],
    ['acme', 'us-east prod', 'ACME_US_EAST_PROD'],
    ['acme', '---', 'ACME_ENV'],
    ['acme', '-local-', 'ACME_LOCAL'],
  ])('%s / %s -> %s', (p, e, out) => expect(sessionPrefix(p, e)).toBe(out));
});

describe('isSessionHeader', () => {
  it.each([
    ['${ACME_SESSION}', true],
    ['${ACME_STAGING_CSRF}', true],
    ['Bearer ${ACME_TOKEN}', true],
    ['${ACME_API_KEY}', false],
    ['ACME_SESSION', false],
  ])('%s -> %s', (v, out) => expect(isSessionHeader(v)).toBe(out));
});

describe('sameSite', () => {
  it.each([
    ['https://app.acme.example', 'https://api.acme.example/v1', true],
    ['https://acme.example', 'https://api.acme.example', true],
    ['https://app.acme.example', 'https://api.other.example', false],
    ['http://localhost:4200', 'http://localhost:8080/api', true],
    ['http://localhost:4200', 'http://127.0.0.1:8080', false],
    ['http://10.0.0.5', 'http://10.0.0.5:9000', true],
    ['http://10.0.0.5', 'http://10.0.0.6', false],
    ['not a url', 'https://api.acme.example', true],
  ])('%s and %s -> %s', (a, b, out) => expect(sameSite(a, b)).toBe(out));
});

describe('siteGuess', () => {
  it.each([
    ['https://api.acme.example/v1', 'https://acme.example'],
    ['https://gateway.acme.example', 'https://acme.example'],
    ['http://localhost:4200/api', 'http://localhost:4200'],
    ['https://orders.acme.example', 'https://orders.acme.example'],
    ['', ''],
    [undefined, ''],
  ])('%s -> %s', (base, out) => expect(siteGuess(base)).toBe(out));
});
