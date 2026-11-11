import { describe, expect, it } from 'vitest';
import { isNoise, isUnder, likelyApi, originsOf, within, type RecordedCall } from './recording';

const call = (url: string | undefined, contentType = 'application/json'): RecordedCall => ({ id: url ?? 'local', at: '', method: 'GET', path: '/x', url, status: 200, statusText: 'OK', ms: 1, requestHeaders: {}, responseHeaders: {}, contentType, bytes: 0 });

describe('isNoise', () => {
  it.each([
    ['https://www.google-analytics.com/collect', true],
    ['https://o1.ingest.sentry.io/api/1/envelope', true],
    ['https://app.acme.example/main.3f2a.js', true],
    ['https://app.acme.example/logo.svg', true],
    ['http://localhost:4200/sockjs-node/info', true],
    ['http://localhost:5173/@vite/client', true],
    ['http://localhost:3000/main.hot-update.json', true],
    ['ws://app.acme.example/socket', true],
    ['not a url', true],
    ['https://api.acme.example/v1/orders', false],
    ['http://localhost:8080/api/teams?page=1', false],
  ])('%s -> %s', (url, noise) => expect(isNoise(url)).toBe(noise));
});

describe('isUnder and within', () => {
  it('counts calls with no URL, or no base, as the API’s', () => {
    expect(isUnder(call(undefined), 'https://api.acme.example')).toBe(true);
    expect(isUnder(call('https://other.example/x'), undefined)).toBe(true);
    expect(isUnder(call('https://other.example/x'), '///')).toBe(true);
  });
  it('matches the base, its paths and its query, not a longer name', () => {
    const base = 'https://api.acme.example/v1/';
    expect(isUnder(call('https://api.acme.example/v1'), base)).toBe(true);
    expect(isUnder(call('https://api.acme.example/v1/orders'), base)).toBe(true);
    expect(isUnder(call('https://api.acme.example/v1?x=1'), base)).toBe(true);
    expect(isUnder(call('https://api.acme.example/v10/orders'), base)).toBe(false);
    expect(isUnder(call('https://cdn.acme.example/v1/orders'), base)).toBe(false);
  });
  it('filters a list', () => {
    expect(within([call('https://a.example/x'), call('https://b.example/x'), call(undefined)], 'https://a.example').map((c) => c.id)).toEqual(['https://a.example/x', 'local']);
  });
});

describe('originsOf and likelyApi', () => {
  const calls = [call('https://cdn.acme.example/a', 'text/html'), call('https://cdn.acme.example/b', 'text/html'), call('https://cdn.acme.example/c', 'text/html'), call('https://api.acme.example/x'), call('https://api.acme.example/y', 'text/plain'), call(undefined), call('::bad::')];

  it('counts hosts, busiest first, skipping calls with no or a bad URL', () => {
    expect(originsOf(calls)).toEqual([
      { origin: 'https://cdn.acme.example', count: 3 },
      { origin: 'https://api.acme.example', count: 2 },
    ]);
  });

  it('prefers the busiest host that answers JSON', () => {
    expect(likelyApi(calls)).toBe('https://api.acme.example');
  });

  it('falls back to the busiest host, or nothing', () => {
    expect(likelyApi([call('https://cdn.acme.example/a', 'text/html')])).toBe('https://cdn.acme.example');
    expect(likelyApi([])).toBeUndefined();
  });
});
