import { describe, expect, it } from 'vitest';
import { aboutRoute, coverageOf } from './coverage';
import type { RecordedCall } from './recording';

let n = 0;
const call = (path: string, extra: Partial<RecordedCall> = {}): RecordedCall => ({ id: `c${++n}`, at: '2026-01-01T00:00:00Z', method: 'GET', path, status: 200, statusText: 'OK', ms: 5, requestHeaders: {}, responseHeaders: {}, responseBody: '{}', contentType: 'application/json', bytes: 2, ...extra });

describe('aboutRoute, more', () => {
  it('has nothing to say about noise-only routes, or a noun that starts with a digit', () => {
    expect(aboutRoute('/api/v1/{id}')).toBeUndefined();
    expect(aboutRoute('/')).toBeUndefined();
    expect(aboutRoute('/3d-models')).toBeUndefined();
    expect(aboutRoute('/!!!')).toBeUndefined();
  });
  it('reads a sub-resource as more, and ignores the query', () => {
    expect(aboutRoute('/teams/{id}/players/{id}/stats')).toEqual({ noun: 'player', kind: 'more' });
    expect(aboutRoute('/Order_Lines?x=1')).toEqual({ noun: 'order-line', kind: 'list' });
  });
});

describe('coverageOf, more', () => {
  it('leaves out failures and non-GETs, counts recent routes once', () => {
    const now = Date.parse('2026-01-01T00:10:00Z');
    const c = coverageOf(
      [
        call('/teams', { at: '2026-01-01T00:09:30Z' }),
        call('/teams', { at: '2026-01-01T00:00:00Z' }),
        call('/teams/7', { at: '2026-01-01T00:09:59Z' }),
        call('/orders', { method: 'POST' }),
        call('/players', { status: 500 }),
        call('/matches', { error: 'reset', status: 0 }),
        call('/teams/7/fixtures'),
        call('/teams/7/lineups'),
      ],
      now,
    );
    expect(c.requests).toBe(5);
    expect(c.recent).toBe(1);
    expect(c.things).toEqual([
      { noun: 'team', list: true, detail: true, more: 0 },
      { noun: 'fixture', list: true, detail: false, more: 0 },
      { noun: 'lineup', list: true, detail: false, more: 0 },
    ]);
    expect(c.chains).toBe(0);
  });

  it('suggests at most six things to do', () => {
    const calls = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => call(`/thing${x}s`));
    expect(coverageOf(calls).gaps).toHaveLength(6);
  });

  it('is empty for no calls', () => {
    expect(coverageOf([])).toEqual({ requests: 0, chains: 0, recent: 0, things: [], gaps: [] });
  });
});

describe('coverageOf, sub-resources', () => {
  it('counts other routes about a thing as more', () => {
    const c = coverageOf([call('/teams/7/players/9/stats'), call('/teams/7/players/9/leaderboard')]);
    expect(c.things).toEqual([{ noun: 'player', list: false, detail: false, more: 2 }]);
    expect(c.gaps).toEqual([]);
  });
});
