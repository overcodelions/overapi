import { describe, expect, it } from 'vitest';
import { applyLinks, applyShared, applyTidy, cleanPath, findLinks, sharedValues, tidyUps } from './chains';
import { shapeOf } from './scenario';
import type { Project, ToolDef } from './project';

const t = (id: string, params: [string, 'path' | 'query'][], extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: extra.name ?? path.replace(/\W+/g, '_').replace(/^_/, ''), description: '', enabled: true, safety: 'read', method: method as ToolDef['method'], path, bodyMode: 'none', params: params.map(([name, at]) => ({ name, in: at, required: at === 'path', schema: { type: 'string' } })), ...extra };
};

function league(): Project {
  return {
    overapi: 1,
    name: 'league',
    title: 'League',
    description: '',
    version: '1',
    envs: [{ name: 'default', baseUrl: 'https://api.league.example', auth: { type: 'none' }, allowWrites: false }],
    tools: [
      t('GET /competitions/{competition_id}/seasons/{season_id}/teams', [['competition_id', 'path'], ['season_id', 'path'], ['_limit', 'query']], {
        name: 'list_season_teams',
        example: { competition_id: 8, season_id: 2025, _limit: 50 },
        returns: shapeOf({ pagination: { _limit: 50 }, data: [{ id: 't1', name: 'Arsenal' }] }),
      }),
      t('GET /teams/{team_id}', [['team_id', 'path']], { name: 'get_team', returns: shapeOf({ id: 't1', name: 'Arsenal' }) }),
      t('GET /competitions/{competition_id}/seasons/{season_id}/teams/{team_id}/form', [['competition_id', 'path'], ['season_id', 'path'], ['team_id', 'path']], { name: 'list_team_form', example: { competition_id: 8, season_id: 2025, team_id: 't1' } }),
      t('GET /competitions/{competition_id}/seasons/{season_id}/standings', [['competition_id', 'path'], ['season_id', 'path']], { name: 'list_standings', example: { competition_id: 8, season_id: 2025 } }),
      t('GET /competitions/{competition_id}/seasons/{season_id}/phases/undefined/matches', [['competition_id', 'path'], ['season_id', 'path'], ['kickoff>2026-11-09', 'query']], { name: 'list_undefined_matches' }),
    ],
  };
}

describe('chains', () => {
  it('finds which request gives each id, preferring the list', () => {
    const links = findLinks(league());
    expect(links.map((l) => `${l.fromName} ${l.path} → ${l.toName}.${l.param}`)).toEqual(['list_season_teams data[0].id → get_team.team_id', 'list_season_teams data[0].id → list_team_form.team_id']);
    expect(cleanPath('data[44].seasons[27]')).toBe('data[0].seasons[0]');
  });

  it('connects them: kept as team_id, used, and explained to agents', () => {
    const p = applyLinks(league(), findLinks(league()));
    const list = p.tools.find((x) => x.name === 'list_season_teams')!;
    const get = p.tools.find((x) => x.name === 'get_team')!;
    expect(list.captures).toEqual([{ var: 'team_id', from: 'body', path: 'data[0].id' }]);
    expect(get.example).toEqual({ team_id: '{{team_id}}' });
    expect(get.params[0].description).toBe('Get it from list_season_teams (data[].id).');
    expect(findLinks(p).every((l) => l.done)).toBe(true);
  });

  it('moves values every request sends the same into the environment', () => {
    const shared = sharedValues(league(), league().envs[0]);
    expect(shared.map((s) => [s.name, s.value, s.tools.length])).toEqual([
      ['competition_id', '8', 3],
      ['season_id', '2025', 3],
    ]);
    const p = applyShared(league(), 'default', shared[0]);
    const form = p.tools.find((x) => x.name === 'list_team_form')!;
    expect(form.path).toBe('/competitions/{{competition_id}}/seasons/{season_id}/teams/{team_id}/form');
    expect(form.params.map((x) => x.name)).toEqual(['season_id', 'team_id']);
    expect(p.envs[0].vars).toEqual({ competition_id: '8' });
  });

  it('spots recording noise', () => {
    const tidy = tidyUps(league());
    expect(tidy.map((x) => x.id)).toEqual(['tool:GET /competitions/{competition_id}/seasons/{season_id}/phases/undefined/matches', 'param:GET /competitions/{competition_id}/seasons/{season_id}/phases/undefined/matches:kickoff>2026-11-09']);
    expect(applyTidy(league(), tidy[0]).tools).toHaveLength(4);
  });
});

describe('readiness after moving a value to the environment', () => {
  it('doesn’t count {{env}} values in a path as missing arguments', async () => {
    const { checkProject } = await import('./check');
    const p = applyShared(league(), 'default', sharedValues(league(), league().envs[0])[0]);
    expect(checkProject(p, {}).issues.filter((i) => /no path parameter/.test(i.message))).toEqual([]);
  });
});
