import { describe, expect, it } from 'vitest';
import { applyCaptures, formatPath, getPath, parsePath, toCurl, varsUsed } from './capture';
import { groupOf, secretNames, type Project, type ToolDef } from './project';

describe('paths', () => {
  it('reads dots, indexes, quoted keys and a leading $.', () => {
    expect(parsePath('$.data.items[0]["odd key"]')).toEqual(['data', 'items', 0, 'odd key']);
    expect(formatPath(['data', 'items', 0, 'odd key'])).toBe('data.items[0]["odd key"]');
    expect(getPath({ data: { items: [{ id: 7 }] } }, 'data.items[0].id')).toBe(7);
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
});

describe('applyCaptures', () => {
  it('keeps body and header values, skipping what is missing', () => {
    const out = applyCaptures(
      [
        { var: 'token', from: 'body', path: 'auth.token' },
        { var: 'sid', from: 'header', path: 'X-Session' },
        { var: 'gone', from: 'body', path: 'nope' },
        { var: 'obj', from: 'body', path: 'auth' },
      ],
      { auth: { token: 'abc' } },
      { 'x-session': 's-1' },
    );
    expect(out).toEqual({ token: 'abc', sid: 's-1', obj: '{"token":"abc"}' });
  });
});

describe('varsUsed and toCurl', () => {
  const t = { id: 'GET /a/{{tenant}}', path: '/a/{{tenant}}', headers: { Authorization: 'Bearer {{token}}' }, example: { q: '{{query}}' } } as unknown as ToolDef;
  it('finds variables in the path, headers and example', () => expect(varsUsed(t).sort()).toEqual(['query', 'tenant', 'token']));
  it('quotes for the shell', () => {
    expect(toCurl({ method: 'POST', url: 'https://x.example/a', headers: { 'content-type': 'application/json' }, body: `{"n":"it's"}` })).toBe(
      `curl -X POST 'https://x.example/a' \\\n  -H 'content-type: application/json' \\\n  --data-raw '{"n":"it'\\''s"}'`,
    );
  });
});

describe('groupOf and secretNames', () => {
  const base: Omit<ToolDef, 'path'> = { id: '', name: '', description: '', enabled: true, safety: 'read', method: 'GET', params: [], bodyMode: 'none' };
  it('groups by explicit group, then tag, then the first path word', () => {
    expect(groupOf({ ...base, path: '/api/v3/pet/{id}', group: 'Pets' })).toBe('Pets');
    expect(groupOf({ ...base, path: '/x', origin: { tags: ['store'] } })).toBe('store');
    expect(groupOf({ ...base, path: '/api/v3/user/login' })).toBe('user');
  });
  it('includes requests’ own sign-ins and header secrets', () => {
    const p = {
      envs: [{ name: 'a', baseUrl: '', auth: { type: 'bearer', tokenVar: 'ENV_TOKEN' }, allowWrites: false }],
      tools: [
        { ...base, path: '/l', auth: { type: 'basic', userVar: 'U', passVar: 'P' } },
        { ...base, path: '/h', headers: { 'X-K': '${HDR}' } },
      ],
    } as unknown as Project;
    expect(secretNames(p).sort()).toEqual(['ENV_TOKEN', 'HDR', 'P', 'U']);
  });
});
