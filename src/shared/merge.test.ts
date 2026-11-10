import { describe, expect, it } from 'vitest';
import { mergeRecorded } from './merge';
import type { Project, ToolDef } from './project';

const tool = (method: string, path: string, enabled = true): ToolDef => ({ id: `${method} ${path}`, name: `${method}_${path}`.replace(/\W+/g, '_'), description: '', enabled, safety: 'read', method: method as ToolDef['method'], path, params: [], bodyMode: 'none' });
const project = (base: string, tools: ToolDef[]): Project => ({ overapi: 1, name: 'acme', title: 'Acme', description: '', version: '1', envs: [{ name: 'default', baseUrl: base, auth: { type: 'none' }, allowWrites: false }], tools });

describe('adding recorded routes to an API', () => {
  it('rebases onto the API’s own base path, so known routes stay known', () => {
    const mine = project('https://localhost:4200', [tool('GET', '/api/features')]);
    const imported = project('https://localhost:4200/api', [tool('GET', '/features'), tool('POST', '/authorization/login')]);
    const r = mergeRecorded(mine, 'https://localhost:4200', imported);
    expect(r.added).toBe(1);
    expect(r.project.tools.map((t) => t.id)).toEqual(['GET /api/features', 'POST /api/authorization/login']);
  });

  it('removes copies an earlier add saved without the /api', () => {
    const mine = project('https://localhost:4200', [tool('GET', '/api/features'), tool('GET', '/features', false), tool('POST', '/authorization/login', false)]);
    const imported = project('https://localhost:4200/api', [tool('POST', '/authorization/login')]);
    const r = mergeRecorded(mine, 'https://localhost:4200', imported);
    expect(r.removed).toBe(2);
    expect(r.project.tools.map((t) => t.id)).toEqual(['GET /api/features', 'POST /api/authorization/login']);
  });

  it('keeps routes the person turned on, and leaves calls outside the base out', () => {
    const mine = project('https://acme.example/api', [tool('GET', '/orders')]);
    const imported = project('https://acme.example', [tool('GET', '/api/orders'), tool('GET', '/health')]);
    const r = mergeRecorded(mine, 'https://acme.example/api', imported);
    expect(r).toMatchObject({ added: 0, removed: 0 });
  });
});

describe('cleaning up when an API opens', () => {
  it('drops only turned-off copies of a request minus its mount', async () => {
    const { dropShadows } = await import('./merge');
    const p = project('https://localhost:4200', [tool('GET', '/api/fields'), tool('GET', '/fields', false), tool('GET', '/features', true), tool('GET', '/api/features'), tool('GET', '/reports', false)]);
    const r = dropShadows(p);
    expect(r.removed).toEqual(['GET__fields']);
    // Not every request that's on is under /api, so /reports is left alone.
    expect(r.project.tools.map((t) => t.id)).toEqual(['GET /api/fields', 'GET /features', 'GET /api/features', 'GET /reports']);
  });

  it('puts a lost /api back when nearly every request is under it', async () => {
    const { dropShadows } = await import('./merge');
    const p = project('https://localhost:4200', [tool('GET', '/api/a'), tool('GET', '/api/b'), tool('GET', '/api/c'), tool('POST', '/authorization/login', false), tool('GET', '/a', false)]);
    const r = dropShadows(p);
    expect(r.removed).toEqual(['GET__a']);
    expect(r.repaired).toEqual(['POST__authorization_login']);
    expect(r.project.tools.map((t) => t.id)).toEqual(['GET /api/a', 'GET /api/b', 'GET /api/c', 'POST /api/authorization/login']);
  });
});

describe('names that say how they differ', () => {
  it('qualifies clashes from the path instead of numbering them', async () => {
    const { distinctNames } = await import('./naming');
    expect(
      distinctNames([
        { name: 'list_fields', path: '/fields' },
        { name: 'list_fields', path: '/crm/activities/fields' },
        { name: 'list_events', path: '/lms/events' },
        { name: 'list_events', path: '/deals/events' },
        { name: 'list_events', path: '/crm/campaigns/events' },
        { name: 'list_features', path: '/auth/users/me/features', keep: true },
        { name: 'list_features', path: '/features' },
      ]),
    ).toEqual(['list_fields', 'list_activity_fields', 'list_lms_events', 'list_deal_events', 'list_campaign_events', 'list_features', 'list_features_2']);
  });

  it('renames numbered names on open, leaving chosen ones alone', async () => {
    const { tidyNames } = await import('./merge');
    const p = project('https://x.example', [
      { ...tool('GET', '/fields'), name: 'list_fields' },
      { ...tool('GET', '/activities/fields'), name: 'list_fields_2' },
      { ...tool('GET', '/v2'), name: 'release_2' },
    ]);
    const r = tidyNames(p);
    expect(r.renamed).toEqual([['list_fields_2', 'list_activity_fields']]);
    expect(r.project.tools.map((t) => t.name)).toEqual(['list_fields', 'list_activity_fields', 'release_2']);
  });
});
