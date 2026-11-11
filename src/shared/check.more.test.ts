import { describe, expect, it } from 'vitest';
import { checkProject, TOOL_BUDGET } from './check';
import type { EnvDef, ParamDef, Project, ToolDef } from './project';

const prm = (name: string, inn: ParamDef['in'] = 'query', extra: Partial<ParamDef> = {}): ParamDef => ({ name, in: inn, required: inn === 'path', schema: { type: 'string' }, ...extra });
const tool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({ id: `GET /${name}`, name, description: 'Lists the things you ask for, newest first.', enabled: true, safety: 'read', method: 'GET', path: `/${name}`, params: [], bodyMode: 'none', ...extra });
const env = (extra: Partial<EnvDef> = {}): EnvDef => ({ name: 'local', baseUrl: 'http://localhost:8080', auth: { type: 'none' }, allowWrites: false, ...extra });
const project = (tools: ToolDef[], envs: EnvDef[] = [env()], extra: Partial<Project> = {}): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: 'Acme orders.', version: '1', envs, tools, ...extra });
const messages = (p: Project, vars?: Record<string, boolean>) => checkProject(p, vars).issues.map((i) => `${i.level}: ${i.message}`);

describe('checkProject, more', () => {
  it('a clean project scores 100 and counts what each environment offers', () => {
    const r = checkProject(project([tool('a'), tool('b', { enabled: false }), tool('c', { safety: 'write' })], [env(), env({ name: 'test', allowWrites: true })]));
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.offeredByEnv).toEqual({ local: 1, test: 2 });
  });

  it('says when there are no tools, or none on', () => {
    expect(messages(project([]))).toContain('error: The project has no tools. Import a spec, a capture or a collection.');
    expect(messages(project([tool('a', { enabled: false })]))[0]).toMatch(/^error: No request is a tool yet/);
  });

  it('warns past the tool budget', () => {
    const tools = Array.from({ length: TOOL_BUDGET + 1 }, (_, i) => tool(`t${i}`));
    expect(messages(project(tools)).join('\n')).toMatch(`${TOOL_BUDGET + 1} tools are on`);
  });

  it('warns with no description and no instructions, not with either', () => {
    expect(messages(project([tool('a')], undefined, { description: '  ' })).join('\n')).toMatch(/no description or instructions/);
    expect(messages(project([tool('a')], undefined, { description: '', instructions: 'Use it for orders.' }))).toEqual([]);
  });

  it('checks names and description lengths', () => {
    const m = messages(project([tool('bad name!'), tool('short', { description: 'Lists.' }), tool('long', { description: 'x'.repeat(1300) })])).join('\n');
    expect(m).toMatch(/"bad name!" is not a valid tool name/);
    expect(m).toMatch(/short's description is very short/);
    expect(m).toMatch(/long's description is 1300 characters/);
  });

  it('does not count {{env}} values as path parameters', () => {
    expect(messages(project([tool('a', { path: '/{{tenant}}/a/{id}', params: [prm('id', 'path')] })]))).toEqual([]);
  });

  it('notes undocumented and too many parameters', () => {
    const few = ['a', 'b', 'c'].map((n) => prm(n));
    expect(messages(project([tool('x', { params: [...few, prm('p', 'path'), prm('e', 'query', { schema: { enum: [1] } })], path: '/x/{p}' })]))).toEqual(['info: x has 3 parameters with no description (a, b, c).']);
    const many = Array.from({ length: 21 }, (_, i) => prm(`p${i}`, 'query', { description: 'd' }));
    expect(messages(project([tool('y', { params: [...many.slice(0, 16), ...['q1', 'q2', 'q3', 'q4', 'q5'].map((n) => prm(n))] })])).join('\n')).toMatch(/y has 5 parameters with no description \(q1, q2, q3, q4…\)/);
    expect(messages(project([tool('z', { params: many })]))).toEqual(['info: z takes 21 parameters. Long parameter lists are where agents make mistakes; describe the ones that matter.']);
  });

  it('checks each environment’s address', () => {
    const m = messages(project([tool('a')], [env({ name: 'none', baseUrl: ' ' }), env({ name: 'ftp', baseUrl: 'ftp://x' }), env({ name: 'plain', baseUrl: 'http://api.acme.example' }), env({ name: 'loop', baseUrl: 'http://127.0.0.1:9000/api' }), env({ name: 'safe', baseUrl: 'https://api.acme.example' })]));
    expect(m).toEqual(['error: "none" has no base URL.', 'error: "ftp" base URL must start with http:// or https://.', 'warn: "plain" sends credentials over plain http to a host that is not this machine.']);
  });

  it('says when there is no environment at all', () => {
    expect(messages(project([tool('a')], []))).toEqual(['error: There is no environment, so there is nowhere to send calls. Add one with a base URL.']);
  });

  it('checks a login sign-in: the request must exist and have saved values', () => {
    const loginAuth = (toolId: string): EnvDef['auth'] => ({ type: 'login', toolId, from: 'body', path: 'token', sendAs: 'bearer' });
    const login = tool('login', { id: 'POST /login', method: 'POST', safety: 'write', params: [prm('user', 'body', { required: true, description: 'd' })] });
    expect(messages(project([tool('a')], [env({ auth: loginAuth('POST /gone') })]))).toEqual(['error: "local" signs in with a request that no longer exists. Pick one in Environments → Sign-in.']);
    const r = checkProject(project([tool('a'), login], [env({ auth: loginAuth('POST /login'), allowWrites: true })]));
    expect(r.issues).toEqual([{ level: 'warn', env: 'local', toolId: 'POST /login', message: expect.stringMatching(/signs in with login, which has no saved values yet/) }]);
    expect(messages(project([tool('a'), { ...login, example: { user: 'wile' } }], [env({ auth: loginAuth('POST /login'), allowWrites: true })]))).toEqual([]);
  });

  it('says which variables are missing, one or several', () => {
    const e = env({ auth: { type: 'basic', userVar: 'U', passVar: 'P' } });
    expect(messages(project([tool('a')], [e]))).toEqual([]);
    expect(messages(project([tool('a')], [e]), { U: true, P: false })).toEqual(['warn: "local" reads P, which is not set here. Calls will go out without it.']);
    expect(messages(project([tool('a')], [e]), {})).toEqual(['warn: "local" reads U, P, which are not set here. Calls will go out without them.']);
  });

  it('notes write tools no environment shows, singular and plural', () => {
    expect(messages(project([tool('a', { safety: 'write' })]))).toEqual(["info: 1 write tool is on but no environment allows writes, so agents won't see it."]);
    expect(messages(project([tool('a', { safety: 'write' }), tool('b', { safety: 'destructive' })]))).toEqual(["info: 2 write tools are on but no environment allows writes, so agents won't see them."]);
  });

  it('never scores below zero', () => {
    const r = checkProject(project([tool('x!'), tool('x!'), tool('y!'), tool('z!'), tool('w!'), tool('v!')], []));
    expect(r.score).toBe(0);
  });
});
