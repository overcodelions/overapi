import { describe, expect, it } from 'vitest';
import { documentPrompt, parseDocReply } from './document';
import { aiPlan, applyChanges, rulePlan } from '../shared/agentReady';
import { shapeOf } from '../shared/scenario';
import type { Project, ToolDef } from '../shared/project';

const t = (id: string, params: string[], extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_/, ''), description: `${id}, seen 1 time in the capture (status 200).`, enabled: true, safety: 'read', method: method as ToolDef['method'], path, bodyMode: 'none', params: params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })), ...extra };
};
const project = (): Project => ({
  overapi: 1,
  name: 'league',
  title: 'League',
  description: '',
  version: '1',
  envs: [{ name: 'default', baseUrl: 'https://api.league.example', auth: { type: 'none' }, allowWrites: false }],
  tools: [
    t('GET /teams', [], { returns: shapeOf({ data: [{ id: 't1', name: 'Arsenal' }] }), example: { token: 'Bearer abcdefghijklmnopqrstuvwx' } }),
    t('GET /teams/{team_id}', ['team_id']),
    t('GET /metadata/SDP_TEAM/{id}', ['id']),
  ],
});

describe('documenting with AI', () => {
  it('asks with shapes and chains, and never sends a secret', () => {
    const prompt = documentPrompt(project(), project().envs[0], { samples: true });
    expect(prompt).toContain('"returns": "{data:{id, name}[]}"');
    expect(prompt).toContain('team_id ← teams (data[].id)');
    expect(prompt).not.toContain('abcdefghijklmnop');
  });

  it('takes only what checks out: known tools and arguments, valid unique names', () => {
    const reply = '```json\n' + JSON.stringify({
      brief: 'Teams first, then one team.',
      tools: {
        'GET /teams': { description: 'Every team in the league.', name: 'list_teams' },
        'GET /teams/{team_id}': { description: 'One team.', params: { team_id: 'From list_teams.', nope: 'x' }, name: 'list_teams' },
        'GET /metadata/SDP_TEAM/{id}': { hide: 'Internal metadata.' },
        'GET /ghost': { description: 'Invented.' },
      },
    }) + '\n```';
    const doc = parseDocReply(reply, project());
    expect(doc.brief).toBe('Teams first, then one team.');
    expect(Object.keys(doc.tools)).toEqual(['GET /teams', 'GET /teams/{team_id}', 'GET /metadata/SDP_TEAM/{id}']);
    expect(doc.tools['GET /teams/{team_id}']).toEqual({ description: 'One team.', params: { team_id: 'From list_teams.' } });
    expect(() => parseDocReply('Sorry, I cannot.', project())).toThrow(/without the JSON/);
  });

  it('becomes one list of changes to accept', () => {
    const p = project();
    const rules = rulePlan(p, p.envs[0]);
    expect(rules.map((c) => c.group)).toEqual(['Chains', 'Chains']);
    const ready = applyChanges(p, rules);
    const ai = aiPlan(ready, parseDocReply(JSON.stringify({ brief: 'B', tools: { 'GET /teams': { description: 'Every team.' }, 'GET /metadata/SDP_TEAM/{id}': { hide: 'Internal.' } } }), ready));
    expect(ai.map((c) => c.group)).toEqual(['Descriptions', 'Hide from agents', 'Agent brief']);
    const done = applyChanges(ready, ai);
    expect([done.tools[0].description, done.tools[2].enabled, done.instructions]).toEqual(['Every team.', false, 'B']);
  });
});
