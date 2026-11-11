import { describe, expect, it } from 'vitest';
import { aiPlan, applyChanges, rulePlan } from './agentReady';
import type { EnvDef, ParamDef, Project, ToolDef } from './project';

const prm = (name: string, inn: ParamDef['in'] = 'query', extra: Partial<ParamDef> = {}): ParamDef => ({ name, in: inn, required: inn === 'path', schema: { type: 'string' }, ...extra });

const tool = (id: string, extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_|_$/g, ''), description: 'A tool that does a thing.', enabled: true, safety: method === 'GET' ? 'read' : 'write', method: method as ToolDef['method'], path, params: [], bodyMode: 'none', ...extra };
};

const env: EnvDef = { name: 'staging', baseUrl: 'https://api.acme.example', auth: { type: 'none' }, allowWrites: false };
const project = (tools: ToolDef[], extra: Partial<Project> = {}): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: '', version: '1', envs: [env], tools, ...extra });

describe('rulePlan', () => {
  it('is empty for a tidy, unconnected project', () => {
    expect(rulePlan(project([tool('GET /ping')]), env)).toEqual([]);
  });

  it('offers to remove a request with "undefined" in its path, and a junk argument', () => {
    const p = project([tool('GET /teams/undefined/players'), tool('GET /matches', { params: [prm('kickoff>2026-11-09'), prm('season')] })]);
    const plan = rulePlan(p, undefined);
    expect(plan.map((c) => [c.group, c.after])).toEqual([
      ['Tidy up', 'Removed'],
      ['Tidy up', 'Argument kickoff>2026-11-09 removed'],
    ]);
    const after = applyChanges(p, plan);
    expect(after.tools.map((t) => t.id)).toEqual(['GET /matches']);
    expect(after.tools[0].params.map((x) => x.name)).toEqual(['season']);
  });

  it('fixes a value every request sends the same, only when there is an environment', () => {
    const mk = (path: string) => tool(`GET ${path}`, { params: [prm('season')], example: { season: 2025 } });
    const p = project([mk('/teams'), mk('/matches'), mk('/players')]);
    expect(rulePlan(p, undefined).filter((c) => c.group === 'Same every time')).toEqual([]);
    const plan = rulePlan(p, env).filter((c) => c.group === 'Same every time');
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: 'shared:season', title: 'season is always 2025', before: 'asked of agents in 3 tools', after: 'fixed at 2025 for staging' });
    const after = applyChanges(p, plan);
    expect(after.envs[0].vars).toEqual({ season: '2025' });
    expect(after.tools[0].params[0]).toMatchObject({ required: false, schema: { type: 'string', default: '2025' } });
  });

  it('connects a list to the request that needs its ids, and leaves done links out', () => {
    const list = tool('GET /teams', { returns: { t: 'object', keys: { data: { t: 'array', of: { t: 'object', keys: { id: { t: 'number' }, name: { t: 'string' } } } } } } });
    const one = tool('GET /teams/{team_id}', { params: [prm('team_id', 'path')] });
    const p = project([list, one]);
    const plan = rulePlan(p, env).filter((c) => c.group === 'Chains');
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: 'chain:GET /teams/{team_id}:team_id', title: 'teams_team_id gets team_id from teams', after: 'teams → data[].id → teams_team_id.team_id' });
    const after = applyChanges(p, plan);
    expect(after.tools[0].captures).toEqual([{ var: 'team_id', from: 'body', path: 'data[0].id' }]);
    expect(after.tools[1].example).toEqual({ team_id: '{{team_id}}' });
    // Once wired, the chain is done and not offered again.
    expect(rulePlan(after, env).filter((c) => c.group === 'Chains')).toEqual([]);
  });
});

describe('aiPlan', () => {
  const list = tool('GET /orders', { name: 'list_orders', description: 'old', params: [prm('status', 'query', { description: 'old status' }), prm('page')] });
  const del = tool('DELETE /orders/{id}', { name: 'delete_order', params: [prm('id', 'path')] });
  const p = project([list, del], { instructions: 'old brief', examples: ['old q'] });

  it('skips tools the project does not have, and unchanged text', () => {
    const plan = aiPlan(p, { tools: { 'GET /nope': { description: 'x' }, 'GET /orders': { description: 'old', params: { status: 'old status', missing: 'x' } } } });
    expect(plan).toEqual([]);
  });

  it('turns each part of the answer into a change, in its group, with before and after', () => {
    const plan = aiPlan(p, {
      brief: 'new brief',
      questions: ['Which orders shipped today?', 'What did order 7 contain?'],
      tools: {
        'GET /orders': { description: 'Lists orders, newest first.', params: { status: 'open, shipped or closed', page: 'Page, from 1' }, name: 'find_orders' },
        'DELETE /orders/{id}': { hide: 'Deletes data; agents should not.' },
      },
    });
    expect(plan.map((c) => [c.id, c.group])).toEqual([
      ['desc:GET /orders', 'Descriptions'],
      ['param:GET /orders:status', 'Arguments'],
      ['param:GET /orders:page', 'Arguments'],
      ['name:GET /orders', 'Names'],
      ['hide:DELETE /orders/{id}', 'Hide from agents'],
      ['questions', 'Example questions'],
      ['brief', 'Agent brief'],
    ]);
    expect(plan.find((c) => c.group === 'Descriptions')).toMatchObject({ title: 'list_orders', before: 'old', after: 'Lists orders, newest first.' });
    expect(plan.find((c) => c.id === 'param:GET /orders:status')).toMatchObject({ title: 'list_orders · status', before: 'old status', after: 'open, shipped or closed' });
    expect(plan.find((c) => c.group === 'Names')).toMatchObject({ title: 'list_orders → find_orders', before: 'list_orders', after: 'find_orders' });
    expect(plan.find((c) => c.group === 'Example questions')).toMatchObject({ before: 'old q', after: '• Which orders shipped today?\n• What did order 7 contain?' });
    expect(plan.find((c) => c.group === 'Agent brief')).toMatchObject({ before: 'old brief', after: 'new brief' });

    const after = applyChanges(p, plan);
    const o = after.tools[0];
    expect(o).toMatchObject({ name: 'find_orders', description: 'Lists orders, newest first.' });
    expect(o.params.map((x) => x.description)).toEqual(['open, shipped or closed', 'Page, from 1']);
    expect(after.tools[1].enabled).toBe(false);
    expect(after.examples).toEqual(['Which orders shipped today?', 'What did order 7 contain?']);
    expect(after.instructions).toBe('new brief');
    // The original is untouched.
    expect(p.tools[0].name).toBe('list_orders');
    expect(p.tools[1].enabled).toBe(true);
  });

  it('does not offer to hide a tool that is already off, nor a brief that is the same', () => {
    const off = project([{ ...del, enabled: false }], { instructions: 'same' });
    expect(aiPlan(off, { brief: 'same', questions: [], tools: { 'DELETE /orders/{id}': { hide: 'x' } } })).toEqual([]);
  });

  it('applies a rename only when no other tool has taken the name by then', () => {
    const plan = aiPlan(p, { tools: { 'GET /orders': { name: 'delete_order' } } });
    expect(plan).toHaveLength(1);
    expect(applyChanges(p, plan).tools.map((t) => t.name)).toEqual(['list_orders', 'delete_order']);
    // Two renames to the same name: the first wins, the second is a no-op.
    const both = aiPlan(p, { tools: { 'GET /orders': { name: 'orders' }, 'DELETE /orders/{id}': { name: 'orders' } } });
    expect(applyChanges(p, both).tools.map((t) => t.name)).toEqual(['orders', 'delete_order']);
  });

  it('has no "before" for questions when the project had none', () => {
    const plan = aiPlan(project([list]), { questions: ['How many orders are open?'], tools: {} });
    expect(plan[0].before).toBeUndefined();
  });
});

describe('applyChanges', () => {
  it('returns the project as is with no changes', () => {
    const p = project([tool('GET /a')]);
    expect(applyChanges(p, [])).toBe(p);
  });
});
