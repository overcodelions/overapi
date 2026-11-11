// The rest of runScenario and runLoad: every reason a step is skipped or
// fails, aborting, and load against a server that is not there.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Project, ToolDef } from '../shared/project';
import type { Scenario, ScenarioStep } from '../shared/scenario';
import { runLoad, runScenario, writesAllowed } from './scenario';

let api: http.Server;
let base = '';
const hits: string[] = [];
beforeAll(async () => {
  api = http.createServer((req, res) => {
    hits.push(req.url!);
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/bins') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ items: [{ id: 'b-1' }] }));
    }
    if (u.pathname === '/slow') {
      return setTimeout(() => res.end('{}'), 60);
    }
    if (u.pathname === '/text') {
      res.setHeader('content-type', 'text/plain');
      return res.end('fine');
    }
    if (u.pathname.startsWith('/bins/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: u.pathname.split('/')[2] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

const tool = (id: string, extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'root', description: '', enabled: true, safety: method === 'GET' ? 'read' : 'write', method: method as ToolDef['method'], path, bodyMode: 'none', params: [], ...extra };
};
const binTool = tool('GET /bins/{bin_id}', { name: 'get_bin', params: [{ name: 'bin_id', in: 'path', required: true, schema: { type: 'string' } }] });
const project = (envBase = base): Project => ({
  overapi: 1,
  name: 'acme-depot',
  title: 'Acme Depot',
  description: '',
  version: '1',
  envs: [
    { name: 'local', baseUrl: envBase, auth: { type: 'none' }, allowWrites: false },
    { name: 'staging', baseUrl: envBase, auth: { type: 'none' }, allowWrites: true },
  ],
  tools: [tool('GET /bins'), binTool, tool('GET /slow'), tool('GET /text'), tool('GET /gone'), tool('POST /bins')],
});
let n = 0;
const step = (toolId: string, extra: Partial<ScenarioStep> = {}): ScenarioStep => ({ id: `s${++n}`, toolId, args: {}, saves: [], expect: { status: '2xx' }, enabled: true, ...extra });
const scenario = (steps: ScenarioStep[]): Scenario => ({ id: 'sc', name: 'Depot', createdAt: '', steps });
const vars = () => undefined;

describe('writesAllowed', () => {
  it('needs the opt-in, an environment that allows writes, and not production', () => {
    const env = (name: string, allowWrites: boolean) => ({ name, baseUrl: '', auth: { type: 'none' as const }, allowWrites });
    expect(writesAllowed(env('staging', true), true)).toBe(true);
    expect(writesAllowed(env('staging', true))).toBe(false);
    expect(writesAllowed(env('staging', false), true)).toBe(false);
    expect(writesAllowed(env('production', true), true)).toBe(false);
  });
});

describe('runScenario', () => {
  it('skips disabled steps and reports a request gone from the API', async () => {
    const p = project();
    const run = await runScenario(p, scenario([step('GET /bins', { enabled: false }), step('GET /nowhere')]), p.envs[0], { vars });
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ name: 'GET /nowhere', method: 'GET', ok: false, problems: ['The request GET /nowhere is gone from the API.'] });
    expect([run.passed, run.failed, run.skipped]).toEqual([0, 1, 0]);
  });

  it('says a write is skipped because the environment does not allow writes', async () => {
    const p = project();
    const run = await runScenario(p, scenario([step('POST /bins', { write: true })]), p.envs[0], { vars, allowWrites: true });
    expect(run.results[0].skipped).toBe("changes data — local doesn't allow writes");
    expect(run.skipped).toBe(1);
  });

  it('skips a step needing a value no earlier step saves', async () => {
    const p = project();
    const run = await runScenario(p, scenario([step('GET /bins/{bin_id}', { args: { bin_id: '{{s9_id}}' } })]), p.envs[0], { vars });
    expect(run.results[0].skipped).toBe("needs {{s9_id}}, which an earlier step didn't provide");
  });

  it('checks the exact status, the time budget and the shape', async () => {
    const p = project();
    const run = await runScenario(
      p,
      scenario([
        step('GET /gone', { expect: { status: 200 } }),
        step('GET /slow', { expect: { status: '2xx', maxMs: 1 } }),
        step('GET /text', { expect: { status: '2xx', shape: { t: 'object', keys: {} } } }),
        step('GET /bins', { expect: { status: 200, shape: { t: 'object', keys: { items: { t: 'array' } } } } }),
      ]),
      p.envs[0],
      { vars },
    );
    expect(run.results[0].problems).toEqual(['answered 404 Not Found, expected 200']);
    expect(run.results[1].problems[0]).toMatch(/^took \d+ ms, over the 1 ms budget$/);
    expect(run.results[2].problems).toEqual(['answered something other than JSON']);
    expect(run.results[3]).toMatchObject({ ok: true, problems: [], status: 200 });
    expect(run.results[3].body).toBe('{"items":[{"id":"b-1"}]}');
    expect([run.passed, run.failed]).toEqual([1, 3]);
  });

  it('warns when a value to save is missing from the response', async () => {
    const p = project();
    const run = await runScenario(p, scenario([step('GET /bins', { saves: [{ var: 's1_id', from: 'body', path: 'nope[0].id' }] })]), p.envs[0], { vars });
    expect(run.results[0].warnings).toEqual(["{{s1_id}} wasn't in the response at nope[0].id"]);
    expect(run.results[0].ok).toBe(true);
  });

  it('does not warn about a missing save when the status was already wrong', async () => {
    const p = project();
    const run = await runScenario(p, scenario([step('GET /gone', { saves: [{ var: 's1_id', from: 'body', path: 'id' }] })]), p.envs[0], { vars });
    expect(run.results[0].warnings).toEqual([]);
  });

  it('passes a saved value on to the next step', async () => {
    const p = project();
    const run = await runScenario(
      p,
      scenario([step('GET /bins', { saves: [{ var: 's1_id', from: 'body', path: 'items[0].id' }] }), step('GET /bins/{bin_id}', { args: { bin_id: '{{s1_id}}' } })]),
      p.envs[0],
      { vars },
    );
    expect(run.results[1].url).toBe(`${base}/bins/b-1`);
    expect(run.results.every((r) => r.ok)).toBe(true);
  });

  // BUG: a value an earlier step was meant to save but didn't (the path was
  // not in the response) is tracked in `failedSaves`, but `unmetVars` only
  // returns variables that NO earlier step saves, so the check never fires
  // and the next step is sent with the literal "{{s1_id}}" in its URL
  // (GET /bins/%7B%7Bs1_id%7D%7D) instead of being skipped.
  it('skips a step whose value an earlier step failed to save', async () => {
    const p = project();
    const run = await runScenario(
      p,
      scenario([step('GET /bins', { saves: [{ var: 's1_id', from: 'body', path: 'nope' }] }), step('GET /bins/{bin_id}', { args: { bin_id: '{{s1_id}}' } })]),
      p.envs[0],
      { vars },
    );
    expect(run.results[1].skipped).toBe("needs {{s1_id}}, which an earlier step didn't provide");
  });

  it('turns a thrown error into a problem', async () => {
    const p = project();
    const run = await runScenario(p, scenario([step('GET /bins/{bin_id}', { saves: [{ var: 's1_x', from: 'body', path: 'id' }] })]), p.envs[0], { vars });
    expect(run.results[0].problems).toEqual(['Missing required argument: bin_id.']);
  });

  it('runs nothing once aborted, and reports each step as it goes', async () => {
    const p = project();
    const seen: string[] = [];
    const run = await runScenario(p, scenario([step('GET /bins')]), p.envs[0], { vars, signal: AbortSignal.abort(), onStep: (r) => seen.push(r.stepId) });
    expect([run.results, seen]).toEqual([[], []]);
    const live = await runScenario(p, scenario([step('GET /bins'), step('GET /text')]), p.envs[0], { vars, onStep: (r) => seen.push(r.name) });
    expect(seen).toEqual(['bins', 'text']);
    expect(live.env).toBe('local');
  });
});

describe('runLoad', () => {
  it('refuses a scenario with no reads', async () => {
    const p = project();
    await expect(runLoad(p, scenario([step('POST /bins'), step('GET /bins', { enabled: false }), step('GET /nowhere')]), p.envs[0], { vars }, { users: 1, durationSec: 1 })).rejects.toThrow(
      'This scenario has no reads to load-test. Load tests never send writes.',
    );
  });

  const deadServer = async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((r) => closed.close(() => r()));
    return deadBase;
  };

  it('counts every failed connection as an error, with a sample', async () => {
    const deadBase = await deadServer();
    const p = project(deadBase);
    const out = await runLoad(p, scenario([step('GET /bins')]), p.envs[0], { vars }, { users: 1, durationSec: 0.3 });
    expect(out.errors).toBe(out.total);
    expect(out.total).toBeGreaterThan(0);
    expect(out.steps[0].failures).toHaveLength(1);
    expect(out.steps[0].failures[0].count).toBe(out.total);
    expect(out.sampleErrors[0]).toBe(`bins: Could not reach ${deadBase}: ECONNREFUSED.`);
  });

  // BUG: the failure label is meant to drop the host ("Could not reach x:
  // no answer after 21 s." -> one kind, whatever the host), but the pattern
  // /^Could not reach [^:]+: / cannot match an origin, which always has a
  // colon in "http://". The label stays "Could not reach http://127.0.0.1:PORT: ECONNREFUSED".
  it('groups connection failures by kind, whatever the host', async () => {
    const deadBase = await deadServer();
    const p = project(deadBase);
    const out = await runLoad(p, scenario([step('GET /bins')]), p.envs[0], { vars }, { users: 1, durationSec: 0.3 });
    expect(out.steps[0].failures.map((f) => f.label)).toEqual(['ECONNREFUSED']);
  });

  it('skips steps whose values are never saved, clamps users, and stops when aborted mid-ramp', async () => {
    const p = project();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const out = await runLoad(
      p,
      scenario([step('GET /text'), step('GET /bins/{bin_id}', { args: { bin_id: '{{s7_id}}' } })]),
      p.envs[0],
      { vars, signal: controller.signal },
      { users: 500, durationSec: 30, rampSec: 30 },
    );
    expect(out.done).toBe(true);
    expect(out.stopped).toBe('stopped');
    expect(out.elapsedSec).toBeLessThan(5);
    expect(out.steps.map((s) => [s.name, s.errors])).toEqual([
      ['text', 0],
      ['get_bin', 0],
    ]);
    expect(out.steps[1].count).toBe(0);
    expect(hits.some((h) => h.includes('s7_id'))).toBe(false);
  });
});
