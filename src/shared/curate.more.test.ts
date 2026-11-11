import { describe, expect, it } from 'vitest';
import { isWeak, suggestOff, toolTokens } from './curate';
import type { EnvDef, Project, ToolDef } from './project';

const tool = (path: string, extra: Partial<ToolDef> = {}): ToolDef => ({ id: `${extra.method ?? 'GET'} ${path}`, name: path.replace(/\W+/g, '_').replace(/^_|_$/g, ''), description: 'x', enabled: true, safety: 'read', method: 'GET', path, params: [], bodyMode: 'none', ...extra });
const env: EnvDef = { name: 'prod', baseUrl: 'https://api.acme.example', auth: { type: 'none' }, allowWrites: false };
const project = (tools: ToolDef[], extra: Partial<Project> = {}): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: '', version: '1', envs: [env], tools, ...extra });

describe('suggestOff, more', () => {
  it('suggests nothing at or under the budget, counting only tools that are on', () => {
    const tools = [tool('/a'), tool('/b'), tool('/c', { enabled: false })];
    expect(suggestOff(project(tools), env, 2)).toEqual([]);
    expect(suggestOff(project(tools), env, 3)).toEqual([]);
  });

  it('puts tools the environment hides anyway first', () => {
    const tools = [tool('/a'), tool('/b'), tool('/orders', { method: 'POST', safety: 'write', name: 'create_order' })];
    const s = suggestOff(project(tools), env, 2);
    expect(s).toEqual([{ toolId: 'POST /orders', name: 'create_order', reason: 'hidden on prod anyway (changes data, read-only)', score: 8 }]);
  });

  it('without an environment, a write is just a write', () => {
    const tools = [tool('/a'), tool('/b'), tool('/orders', { method: 'POST', safety: 'write', name: 'create_order' })];
    const [first] = suggestOff(project(tools), undefined, 2);
    expect(first).toMatchObject({ name: 'create_order', reason: 'nothing leads to it and no test uses it', score: 2 });
  });

  it('spares tools a test uses or a chain connects', () => {
    const list = tool('/teams', { returns: { t: 'object', keys: { data: { t: 'array', of: { t: 'object', keys: { id: { t: 'number' } } } } } } });
    const one = tool('/teams/{team_id}', { params: [{ name: 'team_id', in: 'path', required: true, schema: {} }] });
    const lonely = tool('/lonely');
    const tested = tool('/tested', { method: 'POST', safety: 'write' });
    const p = project([list, one, lonely, tested], { scenarios: [{ id: 's', name: 's', createdAt: '', steps: [{ id: 's1', toolId: tested.id, args: {}, saves: [], expect: { status: '2xx' }, enabled: true }] }] });
    const s = suggestOff(p, undefined, 1);
    expect(s.map((x) => x.name)).toEqual(['lonely']);
  });

  it('finds the longer-path twin of a request', () => {
    const tools = [tool('/teams', { name: 'list_teams' }), tool('/api/v2/teams', { name: 'list_teams_v2' }), tool('/x'), tool('/y')];
    const s = suggestOff(project(tools), undefined, 3);
    expect(s).toEqual([{ toolId: 'GET /api/v2/teams', name: 'list_teams_v2', reason: 'a near-duplicate of list_teams', score: 5 }]);
  });

  it('does not take a different method for a twin', () => {
    const tools = [tool('/teams', { name: 'list_teams', method: 'POST', id: 'POST /teams' }), tool('/v2/teams', { name: 'list_teams_2' })];
    const s = suggestOff(project(tools), undefined, 1);
    expect(s[0].reason).not.toMatch(/duplicate/);
  });

  it('breaks ties by name and cuts to what is over', () => {
    const tools = ['/c', '/a', '/b'].map((p) => tool(p));
    expect(suggestOff(project(tools), undefined, 1).map((x) => x.name)).toEqual(['a', 'b']);
  });
});

describe('isWeak', () => {
  it.each([
    ['', true],
    ['   ', true],
    ['Seen 3 times in the capture', true],
    ['Inferred from 12 captured calls.', true],
    ['Lists.', true],
    ['Lists every order, newest first.', false],
  ])('%j -> %s', (d, weak) => expect(isWeak(tool('/a', { description: d }))).toBe(weak));
  it('treats a missing description as weak', () => {
    expect(isWeak({ ...tool('/a'), description: undefined as unknown as string })).toBe(true);
  });
});

describe('toolTokens', () => {
  it('grows with the name, description and params', () => {
    const small = toolTokens(tool('/a'));
    const big = toolTokens(tool('/a', { description: 'x'.repeat(400), params: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'search' }] }));
    expect(small).toBeGreaterThan(0);
    expect(big - small).toBeGreaterThanOrEqual(100);
  });
});
