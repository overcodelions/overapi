import { describe, expect, it } from 'vitest';
import { aboutRoute, coverageOf } from './coverage';
import { pageKind } from '../main/explorer';
import type { RecordedCall } from './recording';

let n = 0;
const call = (path: string, body: unknown = {}): RecordedCall => ({ id: `c${++n}`, at: new Date().toISOString(), method: 'GET', path, status: 200, statusText: 'OK', ms: 5, requestHeaders: {}, responseHeaders: {}, responseBody: JSON.stringify(body), contentType: 'application/json', bytes: 2 });

describe('coverage', () => {
  it('reads what a route is about', () => {
    expect(aboutRoute('/v1/competitions/{id}/seasons/{id}/teams')).toEqual({ noun: 'team', kind: 'list' });
    expect(aboutRoute('/v2/teams/{id}')).toEqual({ noun: 'team', kind: 'detail' });
    expect(aboutRoute('/v1/teams/{id}/form')).toEqual({ noun: 'form', kind: 'list' });
    expect(aboutRoute('/v3/matches/{id}/lineups')).toEqual({ noun: 'lineup', kind: 'list' });
  });

  it('says what’s found and what’s missing, in words', () => {
    const c = coverageOf([call('/v1/teams', { data: [{ id: 7001 }] }), call('/v1/teams/7001'), call('/v1/matches'), call('/v1/players/9')]);
    expect(c.things.map((t) => [t.noun, t.list, t.detail])).toEqual([
      ['team', true, true],
      ['match', true, false],
      ['player', false, true],
    ]);
    expect(c.gaps).toEqual(['Open a match to see one match’s details', 'Find a page that lists players']);
    expect(c.chains).toBe(1);
  });

  it('groups pages by kind', () => {
    expect(pageKind('https://x.example/clubs/1/acme-rovers/overview')).toBe('/clubs/{id}/{name}/overview');
    expect(pageKind('https://x.example/clubs/2/acme-united/overview')).toBe('/clubs/{id}/{name}/overview');
    expect(pageKind('https://x.example/news/a1b2c3d4e5')).toBe('/news/{id}');
    expect(pageKind('https://x.example/tables')).toBe('/tables');
  });
});
