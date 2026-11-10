import { describe, expect, it } from 'vitest';
import { suggestOff } from './curate';
import { TOOL_BUDGET } from './check';
import type { Project, ToolDef } from './project';

const tool = (path: string, extra: Partial<ToolDef> = {}): ToolDef => ({ id: `GET ${path}`, name: path.replace(/\W+/g, '_').replace(/^_/, ''), description: 'x', enabled: true, safety: 'read', method: 'GET', path, params: [], bodyMode: 'none', ...extra });

describe('suggesting what to turn off', () => {
  it('gets to the budget, plumbing and duplicates first, each with a reason', () => {
    const tools = Array.from({ length: TOOL_BUDGET }, (_, i) => tool(`/things${i}`));
    tools.push(tool('/metadata/SDP_TEAM/{id}'), tool('/teams', { name: 'list_teams' }), tool('/v2/teams', { name: 'list_teams_2' }));
    const p: Project = { overapi: 1, name: 'a', title: 'A', description: '', version: '1', envs: [{ name: 'default', baseUrl: 'https://a.example', auth: { type: 'none' }, allowWrites: false }], tools };
    const s = suggestOff(p, p.envs[0]);
    expect(s).toHaveLength(3);
    expect(s.find((x) => x.name === 'list_teams')?.reason).not.toMatch(/duplicate/);
    expect(s.slice(0, 2).map((x) => [x.name, x.reason])).toEqual([
      ['metadata_SDP_TEAM_id_', 'internal plumbing, not something people ask for'],
      ['list_teams_2', 'a near-duplicate of list_teams'],
    ]);
  });
});
