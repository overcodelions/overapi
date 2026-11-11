import { describe, expect, it } from 'vitest';
import { addStep, emptyScenario, feedsFrom, fits, nounOf, paramsFor, wireInto } from './wire';
import type { Scenario } from './scenario';
import type { Project, ToolDef } from './project';

const tool = (id: string, params: string[] = [], extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_|_$/g, ''), description: '', enabled: true, safety: 'read', method: method as ToolDef['method'], path, bodyMode: 'none', params: params.map((name) => ({ name, in: path.includes(`{${name}}`) ? 'path' : 'query', required: true, schema: { type: 'string' } })), ...extra };
};
const project = (tools: ToolDef[]): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: '', version: '1', envs: [], tools });

describe('nounOf', () => {
  it.each([
    ['GET /api/v2/accounts/{id}', 'account'],
    ['GET /rest/v1.2/categories', 'category'],
    ['GET /boxes', 'box'],
    ['GET /{id}', ''],
    ['GET /', ''],
  ])('%s -> %s', (id, noun) => expect(nounOf(tool(id))).toBe(noun));
});

describe('fits, more', () => {
  it('needs something on both sides', () => {
    expect(fits('', 'id')).toBe(false);
    expect(fits('id', '__')).toBe(false);
  });
  it('a bare id needs a producer', () => {
    expect(fits('id', 'account_id')).toBe(false);
  });
});

describe('feedsFrom, more', () => {
  it('matches by the last key of the capture path', () => {
    const src = tool('GET /x', [], { captures: [{ var: 'kept', from: 'body', path: 'data.items[0].pricebookId' }] });
    const target = tool('GET /pricebooks/{pricebook_id}', ['pricebook_id']);
    expect(feedsFrom(project([src, target]), src)).toEqual([{ var: 'kept', toolId: target.id, toolName: target.name, param: 'pricebook_id' }]);
  });
  it('is empty with no captures', () => {
    expect(feedsFrom(project([tool('GET /a')]), tool('GET /a'))).toEqual([]);
  });
});

describe('paramsFor and wireInto, more', () => {
  it('puts the fitting params first, then the rest', () => {
    const t = tool('GET /x', ['q', 'account_id', 'page']);
    expect(paramsFor(t, 'accountId')).toEqual([
      { param: 'account_id', fits: true },
      { param: 'q', fits: false },
      { param: 'page', fits: false },
    ]);
  });
  it('wires into a tool with no example yet, without changing it', () => {
    const t = tool('GET /x', ['a']);
    expect(wireInto(t, 'a', 'v').example).toEqual({ a: '{{v}}' });
    expect(t.example).toBeUndefined();
  });
});

describe('addStep, more', () => {
  const getAccount = tool('GET /accounts/{account_id}', ['account_id']);

  it('uses a value an earlier step already hands on', () => {
    const p = project([tool('GET /deals/{deal_id}', ['deal_id']), getAccount]);
    const sc: Scenario = { ...emptyScenario('x'), steps: [{ id: 's3', toolId: 'GET /deals/{deal_id}', args: {}, saves: [{ var: 's3_accountId', from: 'body', path: 'accountId' }], expect: { status: '2xx' }, enabled: true }] };
    const r = addStep(p, sc, getAccount);
    expect(r.wired).toEqual(['account_id ← step 1']);
    expect(r.scenario.steps[1]).toMatchObject({ id: 's4', args: { account_id: '{{s3_accountId}}' } });
    // The input scenario is untouched.
    expect(sc.steps).toHaveLength(1);
  });

  it('keeps arguments given and step variables, but rewires a request-level {{var}}', () => {
    const p = project([tool('GET /accounts'), getAccount]);
    let sc = addStep(p, emptyScenario('x'), tool('GET /accounts'), { response: [{ id: 'a1' }] }).scenario;
    expect(addStep(p, sc, getAccount, { args: { account_id: 'a-9' } }).scenario.steps[1].args).toEqual({ account_id: 'a-9' });
    expect(addStep(p, sc, getAccount, { args: { account_id: '{{s7_gone}}' } }).scenario.steps[1].args).toEqual({ account_id: '{{s7_gone}}' });
    // A chain's {{account_id}} lives on the request, not in the test: the test wires its own.
    const r = addStep(p, sc, getAccount, { args: { account_id: '{{account_id}}' } });
    expect(r.scenario.steps[1].args).toEqual({ account_id: '{{s1_id}}' });
    // Adding twice does not save the value twice.
    sc = r.scenario;
    expect(addStep(p, sc, getAccount).scenario.steps[0].saves).toEqual([{ var: 's1_id', from: 'body', path: '[0].id' }]);
  });

  it('leaves an argument empty when nothing earlier fits, and uses the tool’s example by default', () => {
    const p = project([tool('GET /accounts'), getAccount]);
    const sc = addStep(p, emptyScenario('x'), tool('GET /accounts'), { response: 'just text' }).scenario;
    const r = addStep(p, sc, { ...getAccount, example: { other: 1 } });
    expect(r.wired).toEqual([]);
    expect(r.scenario.steps[1].args).toEqual({ other: 1 });
    expect(r.scenario.steps[0].expect.shape).toEqual({ t: 'string' });
  });
});

describe('emptyScenario', () => {
  it('starts with no steps, built by hand, on the given environment', () => {
    expect(emptyScenario('Smoke', 'staging')).toMatchObject({ name: 'Smoke', from: 'built by hand', env: 'staging', steps: [] });
    expect(emptyScenario('Smoke').id).toMatch(/^sc-/);
  });
});
