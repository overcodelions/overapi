import { describe, expect, it } from 'vitest';
import { importFromUrl, specLinks, titleFromHost } from './fromUrl';

const index = `<div class="header">All OpenAPI Files for v2.0.0</div>
<a href="/openapi/notes.yaml">notes.yaml</a>
<a href="/openapi/teams.yaml">teams.yaml</a>
<a href="/openapi/broken.yaml">broken.yaml</a>
<a href="/about">About</a>`;

const notes = `openapi: 3.0.3
info: { title: Notes, version: '2' }
servers: [{ url: 'https://api.acme.example/v2' }]
components: { securitySchemes: { t: { type: http, scheme: bearer } } }
security: [{ t: [] }]
paths:
  /notes:
    get: { operationId: listNotes, summary: List notes, responses: {} }
    post: { operationId: createNote, summary: Create a note, responses: {} }
`;
const teams = `openapi: 3.0.3
info: { title: Teams, version: '2' }
servers: [{ url: 'https://api.acme.example/v2' }]
paths:
  /teams:
    get: { operationId: listTeams, tags: [Teams], summary: List teams, responses: {} }
`;

const fake = (pages: Record<string, string>) =>
  (async (u: string | URL) => {
    const body = pages[String(u)];
    return body === undefined ? new Response('nope', { status: 404, statusText: 'Not Found' }) : new Response(body, { status: 200 });
  }) as typeof fetch;

describe('importFromUrl', () => {
  it('follows a page of spec links and merges them, grouped by file', async () => {
    const r = await importFromUrl(
      'https://developer.acme.example/openapi',
      fake({
        'https://developer.acme.example/openapi': index,
        'https://developer.acme.example/openapi/notes.yaml': notes,
        'https://developer.acme.example/openapi/teams.yaml': teams,
        'https://developer.acme.example/openapi/broken.yaml': 'not: [a spec',
      }),
    );
    expect(r.project.title).toBe('Acme');
    expect(r.project.tools.map((t) => [t.name, t.group ?? t.origin?.tags?.[0]])).toEqual([
      ['list_notes', 'notes'],
      ['create_note', 'notes'],
      ['list_teams', 'Teams'],
    ]);
    expect(r.project.envs[0].baseUrl).toBe('https://api.acme.example/v2');
    expect(r.project.envs[0].auth).toEqual({ type: 'bearer', tokenVar: 'ACME_TOKEN' });
    expect(r.note).toMatch(/Imported 2 specs .* skipped broken/);
  });

  it('imports a direct spec URL as before', async () => {
    const r = await importFromUrl('https://x.example/notes.yaml', fake({ 'https://x.example/notes.yaml': notes }));
    expect(r.project.tools).toHaveLength(2);
    expect(r.note).toBeUndefined();
  });

  it('says so when a page links to no specs', async () => {
    await expect(importFromUrl('https://x.example/', fake({ 'https://x.example/': '<html><a href="/a">a</a></html>' }))).rejects.toThrow(/links to none/);
  });
});

describe('helpers', () => {
  it('finds spec links only', () => {
    expect(specLinks(index, 'https://d.example/openapi')).toEqual([
      'https://d.example/openapi/notes.yaml',
      'https://d.example/openapi/teams.yaml',
      'https://d.example/openapi/broken.yaml',
    ]);
  });
  it('names from the host', () => expect(titleFromHost('https://developer.productboard.com/openapi')).toBe('Productboard'));
});
