// Scenarios end to end against a real server: built from a recording with
// the values that flowed between calls passed along, run as a test that
// checks shape (not values), and run as load.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestGraph } from '../shared/graph';
import { compareShape, scenarioFromCalls, shapeOf } from '../shared/scenario';
import type { Project, ToolDef } from '../shared/project';
import type { RecordedCall } from '../shared/recording';
import { runLoad, runScenario } from './scenario';

let api: http.Server;
let base = '';
let partnerId = 'p-a1b2c3d4';
let created = 0;
let shapeBroken = false;
beforeAll(async () => {
  api = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/partners') return res.end(JSON.stringify({ content: [{ id: partnerId, name: 'Acme', size: 3 }], total: 1 }));
    if (u.pathname.startsWith('/api/partners/')) {
      const id = u.pathname.split('/')[3];
      if (id !== partnerId) {
        res.statusCode = 404;
        return res.end('{"error":"no such partner"}');
      }
      return res.end(JSON.stringify(shapeBroken ? { id, name: ['Acme'] } : { id, name: 'Acme', tier: null }));
    }
    if (u.pathname === '/api/orders' && req.method === 'POST') {
      created++;
      return res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

const tool = (id: string, params: ToolDef['params'] = [], safety: ToolDef['safety'] = 'read'): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.split('/').filter((s) => s && !s.startsWith('{')).join('_') + (method === 'POST' ? '_create' : ''), description: '', enabled: true, safety, method: method as ToolDef['method'], path, params, bodyMode: method === 'POST' ? 'json-fields' : 'none' };
};
const project = (): Project => ({
  overapi: 1,
  name: 'acme',
  title: 'Acme',
  description: '',
  version: '1',
  envs: [
    { name: 'local', baseUrl: base, auth: { type: 'none' }, allowWrites: true },
    { name: 'production', baseUrl: base, auth: { type: 'none' }, allowWrites: true },
  ],
  tools: [tool('GET /api/partners'), tool('GET /api/partners/{partner_id}', [{ name: 'partner_id', in: 'path', required: true, schema: { type: 'string' } }]), tool('POST /api/orders', [{ name: 'sku', in: 'body', required: true, schema: { type: 'string' } }], 'write')],
});

let n = 0;
const call = (method: string, path: string, body: unknown, extra: Partial<RecordedCall> = {}): RecordedCall => ({
  id: `c${++n}`,
  at: new Date(Date.UTC(2026, 10, 9, 10, 0, n)).toISOString(),
  method,
  path,
  status: 200,
  statusText: 'OK',
  ms: 20,
  requestHeaders: {},
  responseHeaders: {},
  responseBody: JSON.stringify(body),
  contentType: 'application/json',
  bytes: 10,
  ...extra,
});

function recorded(): RecordedCall[] {
  return [
    call('GET', '/api/partners', { content: [{ id: 'p-recorded99', name: 'Old', size: 3 }], total: 1 }),
    call('GET', '/api/partners', { content: [{ id: 'p-recorded99', name: 'Old', size: 3 }], total: 1 }),
    call('GET', '/api/partners/p-recorded99', { id: 'p-recorded99', name: 'Old', tier: 'gold' }),
    call('POST', '/api/orders', { ok: true }, { requestBody: '{"sku":"A1"}' }),
  ];
}

describe('a scenario from a recording', () => {
  it('folds repeats and passes ids along as variables', () => {
    const calls = recorded();
    const sc = scenarioFromCalls(project(), calls, requestGraph(calls), '', 'Partners');
    expect(sc.steps.map((s) => s.toolId)).toEqual(['GET /api/partners', 'GET /api/partners/{partner_id}', 'POST /api/orders']);
    expect(sc.steps[0].saves).toEqual([{ var: 's1_id', from: 'body', path: 'content[0].id' }]);
    expect(sc.steps[1].args).toEqual({ partner_id: '{{s1_id}}' });
  });

  it('runs against today’s data: the id comes from this run, writes are skipped', async () => {
    partnerId = 'p-today777';
    const calls = recorded();
    const p = project();
    const sc = scenarioFromCalls(p, calls, requestGraph(calls), '', 'Partners');
    const run = await runScenario(p, sc, p.envs[0], { vars: () => undefined });
    expect(run.results.map((r) => [r.name, r.ok, r.skipped ?? ''])).toEqual([
      ['api_partners', true, ''],
      ['api_partners', true, ''],
      ['api_orders_create', false, 'changes data — turn on "Run it" for this step'],
    ]);
    expect(run.results[1].url).toContain('/api/partners/p-today777');
    // A field that was a string in the recording and is null now is fine.
    expect(run.results[1].warnings).toEqual([]);
    expect(created).toBe(0);
  });

  it('runs a write only where allowed, and never on production', async () => {
    const calls = recorded();
    const p = project();
    const sc = scenarioFromCalls(p, calls, requestGraph(calls), '', 'Partners');
    sc.steps[2].write = true;
    await runScenario(p, sc, p.envs[1], { vars: () => undefined, allowWrites: true });
    expect(created).toBe(0);
    const run = await runScenario(p, sc, p.envs[0], { vars: () => undefined, allowWrites: true });
    expect(created).toBe(1);
    expect(run.failed).toBe(0);
  });

  it('fails on a changed shape, not on changed values', async () => {
    shapeBroken = true;
    const calls = recorded();
    const p = project();
    const sc = scenarioFromCalls(p, calls, requestGraph(calls), '', 'Partners');
    const run = await runScenario(p, sc, p.envs[0], { vars: () => undefined });
    expect(run.results[1].problems).toEqual(['$.name was a string, now an array']);
    expect(run.results[1].warnings).toEqual(['$.tier is missing']);
    shapeBroken = false;
  });

  it('compares shapes leniently: empty lists and nulls pass', () => {
    const s = shapeOf({ items: [{ id: 1 }], next: 'x' });
    expect(compareShape(s, { items: [], next: null })).toEqual({ problems: [], warnings: [] });
  });
});

describe('load', () => {
  it('runs the reads with several users and reports percentiles', async () => {
    const calls = recorded();
    const p = project();
    const sc = scenarioFromCalls(p, calls, requestGraph(calls), '', 'Partners');
    const ticks: number[] = [];
    const out = await runLoad(p, sc, p.envs[0], { vars: () => undefined, onTick: (s) => ticks.push(s.total) }, { users: 4, durationSec: 1.2 });
    expect(out.done).toBe(true);
    expect(out.total).toBeGreaterThan(8);
    expect(out.errors).toBe(0);
    expect(out.steps.map((s) => s.name)).toEqual(['api_partners', 'api_partners']);
    expect(out.steps[1].count).toBeGreaterThan(0);
    expect(out.timeline.length).toBeGreaterThanOrEqual(1);
    expect(out.overall.p95).toBeGreaterThan(0);
    expect(out.overall.p50).toBeLessThanOrEqual(out.overall.p95);
    expect(Math.max(...out.timeline.map((x) => x.users))).toBe(4);
    expect(created).toBe(1);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('recorded failures and replaying one step', () => {
  it('turns off steps that failed while recording, and replays up to a step', async () => {
    partnerId = 'p-today777';
    const calls = [...recorded(), call('GET', '/api/partners/p-gone', { error: 'gateway' }, { status: 504, statusText: 'Gateway Timeout' })];
    const p = project();
    const sc = scenarioFromCalls(p, calls, requestGraph(calls), '', 'Partners');
    const last = sc.steps[sc.steps.length - 1];
    expect([last.enabled, last.recorded?.status]).toEqual([false, 504]);
    const run = await runScenario(p, sc, p.envs[0], { vars: () => undefined, until: sc.steps[1].id });
    expect(run.results.map((r) => r.stepId)).toEqual(['s1', 's2']);
    expect(run.results[1].ok).toBe(true);
  });
});

describe('load test failures', () => {
  it('groups each request’s errors by kind, with what the server said', async () => {
    const p = project();
    p.tools.push(tool('GET /api/missing'));
    const sc = { id: 'x', name: 'x', createdAt: '', steps: [{ id: 's1', toolId: 'GET /api/missing', args: {}, saves: [], expect: { status: '2xx' as const }, enabled: true }] };
    const out = await runLoad(p, sc, p.envs[0], { vars: () => undefined }, { users: 2, durationSec: 1 });
    const s = out.steps[0];
    expect(s.errors).toBe(s.count);
    expect(s.failures.map((f) => [f.label, f.count === s.count])).toEqual([['404 Not Found', true]]);
    expect(s.failures[0].sample).toBe('{}');
  });
});
