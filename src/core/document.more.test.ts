import { describe, expect, it } from 'vitest';
import { documentPrompt, parseDocReply } from './document';
import type { Shape } from '../shared/scenario';
import type { Project, ToolDef } from '../shared/project';

const tool = (id: string, extra: Partial<ToolDef> = {}): ToolDef => {
  const [method, path] = id.split(' ');
  return { id, name: path.replace(/\W+/g, '_').replace(/^_/, ''), description: 'old', enabled: true, safety: 'read', method: method as ToolDef['method'], path, bodyMode: 'none', params: [], ...extra };
};
const project = (tools: ToolDef[], extra: Partial<Project> = {}): Project => ({ overapi: 1, name: 'acme-fleet', title: 'Acme Fleet', description: '', version: '1', envs: [], tools, ...extra });

/// The tools JSON inside the prompt.
const toolsIn = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('Tools (JSON):\n') + 14, prompt.indexOf('\n\nWrite, for every tool:')));

describe('documentPrompt', () => {
  const p = project(
    [
      tool('GET /trucks', {
        params: [
          { name: 'region', in: 'query', required: false, description: 'Two letters', schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: {} },
          { name: 'note', in: 'query', required: false, schema: { type: 'string' } },
        ],
        example: { region: 'eu', limit: 10, note: 'x'.repeat(81) },
      }),
      tool('POST /trucks', { safety: 'write' }),
    ],
    { description: 'Trucks and their routes.' },
  );
  const env = { name: 'production', baseUrl: 'https://fleet.acme.example/v1', auth: { type: 'none' as const }, allowWrites: false, vars: { tenant: 'acme-west' } };

  it('includes examples only with samples on, and never long ones', () => {
    const withSamples = toolsIn(documentPrompt(p, env, { samples: true }));
    expect(withSamples[0].arguments).toEqual([
      { name: 'region', in: 'query', type: 'string', required: false, note: 'Two letters', example: 'eu' },
      { name: 'limit', in: 'query', type: 'any', required: false, example: 10 },
      { name: 'note', in: 'query', type: 'string', required: false },
    ]);
    const without = toolsIn(documentPrompt(p, env, { samples: false }));
    expect(without[0].arguments.some((a: { example?: unknown }) => 'example' in a)).toBe(false);
  });

  it('marks writes, says unknown returns, and shows fixed values only with samples', () => {
    const prompt = documentPrompt(p, env, { samples: true });
    const tools = toolsIn(prompt);
    expect(tools.map((t: { changes_data: boolean; returns: string }) => [t.changes_data, t.returns])).toEqual([
      [false, 'unknown'],
      [true, 'unknown'],
    ]);
    expect(prompt).toContain('API: Acme Fleet (fleet.acme.example)');
    expect(prompt).toContain('Values fixed for this environment (agents never pass these): tenant = acme-west');
    expect(prompt).toContain('Notes: Trucks and their routes.');
    expect(documentPrompt(p, env, { samples: false })).toContain('tenant = (set)');
  });

  it('works without an environment or notes', () => {
    const prompt = documentPrompt(project([tool('GET /trucks')]), undefined, { samples: true });
    expect(prompt).toContain('API: Acme Fleet\n');
    expect(prompt).not.toMatch(/Values fixed|Notes:/);
  });

  it('outlines deep and wide shapes compactly', () => {
    const deep: Shape = { t: 'object', keys: { a: { t: 'object', keys: { b: { t: 'object', keys: { c: { t: 'object', keys: { d: { t: 'object', keys: { e: { t: 'string' } } } } } } } } }, list: { t: 'array', of: { t: 'number' } }, empty: { t: 'array' } } };
    const wide: Shape = { t: 'object', keys: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, { t: 'string' as const }])) };
    const tools = toolsIn(documentPrompt(project([tool('GET /deep', { returns: deep }), tool('GET /wide', { returns: wide }), tool('GET /n', { returns: { t: 'number' } })]), undefined, { samples: false }));
    expect(tools[0].returns).toBe('{a:{b:{c:{…}}}, list:number[], empty:…[]}');
    expect(tools[1].returns.endsWith('k59, …}')).toBe(true);
    expect(tools[2].returns).toBe('number');
  });
});

describe('parseDocReply', () => {
  const p = project([tool('GET /trucks', { name: 'trucks', params: [{ name: 'region', in: 'query', required: false, schema: {} }] }), tool('GET /drivers', { name: 'drivers' })]);

  it('says when the JSON does not parse', () => {
    expect(() => parseDocReply('{ "brief": nope }', p)).toThrow(/wasn't valid JSON/);
  });

  it('says when nothing in it is usable', () => {
    expect(() => parseDocReply('{"brief": "  ", "questions": ["short"], "tools": {"GET /trucks": {"params": {"region": " "}}}}', p)).toThrow(/nothing overapi could use/);
    expect(() => parseDocReply('{"tools": {"GET /trucks": null, "GET /drivers": "x"}}', p)).toThrow(/nothing overapi could use/);
  });

  it('keeps up to six real questions, trimmed and cut', () => {
    const qs = ['  Which trucks are in the EU?  ', 'tiny', 7, ...Array.from({ length: 8 }, (_, i) => `Question number ${i} ${'x'.repeat(200)}`)];
    const doc = parseDocReply(JSON.stringify({ questions: qs }), p);
    expect(doc.questions).toHaveLength(6);
    expect(doc.questions![0]).toBe('Which trucks are in the EU?');
    expect(doc.questions![1]).toHaveLength(160);
    expect(doc.tools).toEqual({});
  });

  it('cuts long text and refuses invalid, long, unchanged or taken names', () => {
    const doc = parseDocReply(
      JSON.stringify({
        brief: 'b'.repeat(2000),
        tools: {
          'GET /trucks': { description: 'd'.repeat(700), name: 'has spaces', params: { region: 'r'.repeat(400) }, hide: 'h'.repeat(300) },
          'GET /drivers': { name: 'drivers', description: 'Drivers.' },
        },
      }),
      p,
    );
    expect(doc.brief).toHaveLength(1500);
    const t = doc.tools['GET /trucks'];
    expect([t.description?.length, t.name, t.params?.region.length, t.hide?.length]).toEqual([600, undefined, 300, 200]);
    expect(doc.tools['GET /drivers']).toEqual({ description: 'Drivers.' });
    expect(() => parseDocReply(JSON.stringify({ tools: { 'GET /trucks': { name: 'x'.repeat(49) }, 'GET /drivers': { name: 'trucks' } } }), p)).toThrow(/nothing overapi could use/);
  });
});
