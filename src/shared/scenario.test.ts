import { describe, expect, it } from 'vitest';
import { compareShape, failedWhenRecorded, percentile, scenarioFromCalls, shapeExample, shapeKeys, shapeOf, unmetVars, type Scenario, type ScenarioStep, type Shape } from './scenario';
import { requestGraph } from './graph';
import type { ParamDef, Project, ToolDef } from './project';
import type { RecordedCall } from './recording';

describe('shapeOf', () => {
  it('describes values', () => {
    expect(shapeOf(null)).toEqual({ t: 'null' });
    expect(shapeOf(undefined)).toEqual({ t: 'null' });
    expect(shapeOf(1)).toEqual({ t: 'number' });
    expect(shapeOf(true)).toEqual({ t: 'boolean' });
    expect(shapeOf('x')).toEqual({ t: 'string' });
    expect(shapeOf([])).toEqual({ t: 'array' });
    expect(shapeOf([null, { a: 1 }])).toEqual({ t: 'array', of: { t: 'object', keys: { a: { t: 'number' } } } });
  });
  it('stops deep, and at 60 keys', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { d: deep };
    let s = shapeOf(deep);
    for (let i = 0; i < 7; i++) s = (s as { keys: Record<string, Shape> }).keys.d;
    expect(s).toEqual({ t: 'any' });
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys((shapeOf(wide) as { keys: object }).keys)).toHaveLength(60);
  });
});

describe('compareShape', () => {
  const expected = shapeOf({ id: 1, name: 'x', tags: ['a'], owner: { id: 2 }, note: null, items: [{ sku: 'a' }] });

  it('passes the same shape with other values', () => {
    expect(compareShape(expected, { id: 9, name: 'y', tags: [], owner: { id: 3 }, note: 'now text', items: [{ sku: 'b' }] })).toEqual({ problems: [], warnings: [] });
  });

  it('fails a type change, warns a missing key, and lets null through', () => {
    const r = compareShape(expected, { id: '9', tags: {}, owner: null, items: [{ sku: 1 }, { sku: 'ok' }, { sku: [] }, { sku: false }] });
    expect(r.problems).toEqual(['$.id was a number, now a string', '$.tags was an array, now an object', '$.items[0].sku was a string, now a number', '$.items[2].sku was a string, now an array']);
    expect(r.warnings).toEqual(['$.name is missing', '$.note is missing']);
  });

  it('fails an object that became a list, from a given root', () => {
    expect(compareShape({ t: 'object', keys: {} }, [], 'body').problems).toEqual(['body was an object, now an array']);
    expect(compareShape({ t: 'boolean' }, 'x').problems).toEqual(['$ was a boolean, now a string']);
  });

  it('accepts anything for "any" and an array of anything', () => {
    expect(compareShape({ t: 'any' }, 5)).toEqual({ problems: [], warnings: [] });
    expect(compareShape({ t: 'array' }, [1, 'a'])).toEqual({ problems: [], warnings: [] });
  });

  it('keeps at most 20 of each', () => {
    const keys = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, { t: 'number' } as Shape]));
    const r = compareShape({ t: 'object', keys }, {});
    expect(r.warnings).toHaveLength(20);
    const bad = compareShape({ t: 'object', keys }, Object.fromEntries(Object.keys(keys).map((k) => [k, 'x'])));
    expect(bad.problems).toHaveLength(20);
  });
});

describe('shapeKeys and shapeExample', () => {
  const s = shapeOf({ data: [{ id: 1, tags: ['a'] }], total: 3, raw: [] });
  it('counts keys at every level', () => {
    expect(shapeKeys(s)).toBe(5);
    expect(shapeKeys(undefined)).toBe(0);
    expect(shapeKeys({ t: 'string' })).toBe(0);
  });
  it('shows a shape as an example value', () => {
    expect(shapeExample(s)).toEqual({ data: [{ id: 'number', tags: ['string'] }], total: 'number', raw: [] });
    expect(shapeExample(undefined)).toBeNull();
    expect(shapeExample({ t: 'any' })).toBe('…');
  });
});

describe('percentile', () => {
  it('picks by rank, clamped', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 150)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('failedWhenRecorded', () => {
  const step = (status?: number): ScenarioStep => ({ id: 's1', toolId: 't', args: {}, saves: [], expect: { status: '2xx' }, enabled: true, ...(status ? { recorded: { status, ms: 1 } } : {}) });
  it('is true for 4xx and 5xx only', () => {
    expect(failedWhenRecorded(step(504))).toBe(true);
    expect(failedWhenRecorded(step(404))).toBe(true);
    expect(failedWhenRecorded(step(200))).toBe(false);
    expect(failedWhenRecorded(step())).toBe(false);
  });
});

describe('unmetVars', () => {
  const step = (id: string, args: Record<string, unknown>, saves: string[] = [], enabled = true): ScenarioStep => ({ id, toolId: 't', args, saves: saves.map((v) => ({ var: v, from: 'body', path: 'id' })), expect: { status: '2xx' }, enabled });
  it('lists step variables nothing enabled before it saves', () => {
    const sc: Scenario = { id: 'x', name: 'x', createdAt: '', steps: [step('s1', {}, ['s1_id']), step('s2', {}, ['s2_id'], false), step('s3', { a: '{{s1_id}}', b: '{{ s2_id }}', c: '{{token}}', d: '{{s9_x}}', e: '{{s9_x}}' })] };
    expect(unmetVars(sc, 2)).toEqual(['s2_id', 's9_x']);
    expect(unmetVars(sc, 0)).toEqual([]);
  });
});

describe('scenarioFromCalls', () => {
  let n = 0;
  const call = (method: string, path: string, extra: Partial<RecordedCall> = {}): RecordedCall => ({ id: `c${++n}`, at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, method, path, status: 200, statusText: 'OK', ms: 7, requestHeaders: {}, responseHeaders: {}, contentType: 'application/json', bytes: 0, ...extra });
  const prm = (name: string, inn: ParamDef['in']): ParamDef => ({ name, in: inn, required: true, schema: { type: 'string' } });
  const tool = (id: string, params: ParamDef[] = [], extra: Partial<ToolDef> = {}): ToolDef => {
    const [method, path] = id.split(' ');
    return { id, name: path.replace(/\W+/g, '_'), description: '', enabled: true, safety: method === 'GET' ? 'read' : 'write', method: method as ToolDef['method'], path, params, bodyMode: 'none', ...extra };
  };
  const p: Project = { overapi: 1, name: 'acme', title: 'Acme', description: '', version: '1', envs: [], tools: [tool('POST /login'), tool('GET /partners'), tool('GET /partners/{id}', [prm('id', 'path')]), tool('POST /partners/{id}/notes', [prm('id', 'path')])] };

  it('makes steps, folds repeated reads, and passes values along as variables', () => {
    const login = call('POST', '/login', { responseBody: JSON.stringify({ token: 'tok_0123456789ab' }) });
    const list = call('GET', '/partners', { responseBody: JSON.stringify({ data: [{ id: 1042 }] }) });
    const again = call('GET', '/partners', { responseBody: JSON.stringify({ data: [{ id: 1042 }] }) });
    const one = call('GET', '/partners/1042', { requestHeaders: { authorization: 'Bearer tok_0123456789ab' }, responseBody: 'not json' });
    const note = call('POST', '/partners/1042/notes', { status: 500, responseBody: '{"error":"down"}' });
    const unknown = call('GET', '/elsewhere');
    const broken = call('GET', '/partners', { error: 'reset' });
    const calls = [note, one, again, list, login, unknown, broken].sort(() => 0);
    const sc = scenarioFromCalls(p, calls, requestGraph([login, list, again, one, note]), '', 'Partners');
    expect(sc.name).toBe('Partners');
    expect(sc.from).toBe('recording of 6 calls');
    expect(sc.steps.map((s) => [s.id, s.toolId, s.enabled])).toEqual([
      ['s1', 'POST /login', true],
      ['s2', 'GET /partners', true],
      ['s3', 'GET /partners/{id}', true],
      ['s4', 'POST /partners/{id}/notes', false],
    ]);
    // The token is the sign-in's business, not a step variable.
    expect(sc.steps[0].saves).toEqual([]);
    expect(sc.steps[1].saves).toEqual([{ var: 's2_id', from: 'body', path: 'data[0].id' }]);
    expect(sc.steps[2].args).toEqual({ id: '{{s2_id}}' });
    expect(sc.steps[3].args).toEqual({ id: '{{s2_id}}' });
    expect(sc.steps[1].expect).toEqual({ status: '2xx', shape: shapeOf({ data: [{ id: 1042 }] }) });
    expect(sc.steps[2].expect).toEqual({ status: '2xx' });
    expect(sc.steps[3].expect).toEqual({ status: '2xx' });
    expect(sc.steps[3].recorded).toEqual({ status: 500, ms: 7 });
  });

  it('stops at 60 steps', () => {
    const many = Array.from({ length: 70 }, (_, i) => call('GET', `/partners/${i + 1}`));
    expect(scenarioFromCalls(p, many, [], '', 'x').steps).toHaveLength(60);
  });
});
