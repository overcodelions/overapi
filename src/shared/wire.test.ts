import { describe, expect, it } from 'vitest';
import { addStep, emptyScenario, feedsFrom, fits, paramsFor, wireInto } from './wire';
import { shapeOf } from './scenario';
import type { Project, ToolDef } from './project';

const tool = (id: string, params: string[] = [], extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_/, ''), description: '', enabled: true, safety: 'read', method: method as ToolDef['method'], path, bodyMode: 'none', params: params.map((name) => ({ name, in: path.includes(`{${name}}`) ? 'path' : 'query', required: true, schema: { type: 'string' } })), ...extra };
};
const project = (tools: ToolDef[]): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: '', version: '1', envs: [{ name: 'local', baseUrl: 'http://x', auth: { type: 'none' }, allowWrites: false }], tools });

describe('wiring values between requests', () => {
  const getDeal = tool('GET /deals/{deal_id}', ['deal_id'], { captures: [{ var: 'accountId', from: 'body', path: 'accountId' }, { var: 'pricebookId', from: 'body', path: 'pricebookId' }] });
  const getAccount = tool('GET /accounts/{account_id}', ['account_id']);
  const getPricebook = tool('GET /pricebooks/{pricebook_id}', ['pricebook_id']);
  const listAccounts = tool('GET /accounts');

  it('matches names loosely, and a bare id by what it came from', () => {
    expect(fits('accountId', 'account_id')).toBe(true);
    expect(fits('id', 'account_id', listAccounts)).toBe(true);
    expect(fits('id', 'deal_id', listAccounts)).toBe(false);
    expect(fits('s3_accountId', 'account_id')).toBe(true);
  });

  it('suggests what kept values could feed, and stops once wired', () => {
    const p = project([getDeal, getAccount, getPricebook]);
    expect(feedsFrom(p, getDeal).map((f) => [f.var, f.toolName, f.param])).toEqual([
      ['accountId', 'accounts_account_id_', 'account_id'],
      ['pricebookId', 'pricebooks_pricebook_id_', 'pricebook_id'],
    ]);
    const wired = project([getDeal, wireInto(getAccount, 'account_id', 'accountId'), getPricebook]);
    expect(feedsFrom(wired, getDeal).map((f) => f.var)).toEqual(['pricebookId']);
    expect(paramsFor(getAccount, 'accountId').map((x) => x.param)).toEqual(['account_id']);
  });

  it('builds a chain step by step, taking ids from earlier responses', () => {
    const p = project([listAccounts, getAccount]);
    let sc = emptyScenario('Accounts');
    sc = addStep(p, sc, listAccounts, { response: { content: [{ id: 'a-1', name: 'Acme' }] } }).scenario;
    const r = addStep(p, sc, getAccount);
    expect(r.wired).toEqual(['account_id ← step 1']);
    expect(r.scenario.steps[1].args).toEqual({ account_id: '{{s1_id}}' });
    expect(r.scenario.steps[0].saves).toEqual([{ var: 's1_id', from: 'body', path: 'content[0].id' }]);
    expect(r.scenario.steps[0].expect.shape).toEqual(shapeOf({ content: [{ id: 'a-1', name: 'Acme' }] }));
  });
});
