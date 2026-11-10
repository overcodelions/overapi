import { describe, expect, it } from 'vitest';
import { apiPushFileName, buildApiPush } from './overgo';
import { fillVars, type Project } from './project';

const project: Project = {
  overapi: 1,
  name: 'acme-orders',
  title: 'Acme Orders',
  description: '',
  version: '1',
  envs: [
    { name: 'local', baseUrl: 'http://localhost:4010', auth: { type: 'bearer', tokenVar: 'ACME_TOKEN' }, allowWrites: true },
    { name: 'production', baseUrl: 'https://orders.acme.example', auth: { type: 'bearer', tokenVar: 'ACME_PROD_TOKEN' }, allowWrites: false, headers: { 'X-Key': '${EXTRA}' } },
  ],
  tools: [
    { id: 'GET /a', name: 'a', description: 'A.', enabled: true, safety: 'read', method: 'GET', path: '/a', params: [], bodyMode: 'none', example: { x: 1 } },
    { id: 'GET /b', name: 'b', description: 'B.', enabled: false, safety: 'read', method: 'GET', path: '/b', params: [], bodyMode: 'none' },
  ],
};

describe('buildApiPush', () => {
  it('sends only the chosen environment and the tools that are on, naming the secrets to fill', () => {
    const r = buildApiPush(project, 'production', { id: 'abc', now: Date.UTC(2026, 10, 8) });
    if (!r.ok) throw new Error(r.error);
    expect(r.push).toMatchObject({ version: 1, kind: 'overapi-project', id: 'abc', env: 'production', secrets: ['ACME_PROD_TOKEN', 'EXTRA'] });
    expect(r.push.project.envs.map((e) => e.name)).toEqual(['production']);
    expect(r.push.project.tools.map((t) => t.name)).toEqual(['a']);
    expect(apiPushFileName(r.push)).toBe('2026-11-08T00-00-00-000Z-abc.json');
  });

  it('refuses an environment the server cannot reach', () => {
    const r = buildApiPush(project, 'local', { id: 'x', now: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/points at this machine/);
  });

  it('refuses when nothing is on', () => {
    const r = buildApiPush({ ...project, tools: [project.tools[1]] }, 'production', { id: 'x', now: 0 });
    expect(!r.ok && r.error).toMatch(/Every tool is off/);
  });
});

describe('fillVars', () => {
  it('fills known names and leaves unknown ones visible', () => {
    expect(fillVars('https://{{region}}.acme.example/{{ v }}/{{nope}}', { vars: { region: 'eu', v: 'v2' } })).toBe('https://eu.acme.example/v2/{{nope}}');
  });
});
