import { describe, expect, it } from 'vitest';
import { importFromUrl, importSpecUrls, mergeProjects, probeSpecs, specLinks, titleFromHost, USUAL_SPEC_PATHS } from './fromUrl';
import type { Project } from '../../shared/project';

const spec = (title: string, paths: Record<string, string>, security = '') => `openapi: 3.0.3
info: { title: ${title}, version: '1' }
servers: [{ url: 'https://api.acme.example/v1' }]
${security}
paths:
${Object.entries(paths)
  .map(([p, op]) => `  ${p}:\n    get: { operationId: ${op}, summary: ${op}, responses: {} }`)
  .join('\n')}
`;

type Seen = { url: string; init?: RequestInit };
const fake = (pages: Record<string, string>, seen: Seen[] = []) =>
  (async (u: string | URL, init?: RequestInit) => {
    seen.push({ url: String(u), init });
    const body = pages[String(u)];
    return body === undefined ? new Response('nope', { status: 404, statusText: 'Not Found' }) : new Response(body, { status: 200 });
  }) as typeof fetch;

describe('probeSpecs', () => {
  it('finds a spec at one of the usual paths on the site, with a timeout signal', async () => {
    const seen: Seen[] = [];
    const r = await probeSpecs('https://docs.acme.example/guide/intro?x=1', fake({ 'https://docs.acme.example/v3/api-docs': spec('Orders', { '/orders': 'listOrders' }) }, seen));
    expect(r?.project.tools.map((t) => t.name)).toEqual(['list_orders']);
    expect(seen.map((s) => s.url).sort()).toEqual(USUAL_SPEC_PATHS.map((p) => `https://docs.acme.example${p}`).sort());
    expect(seen.every((s) => s.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('is null when nothing is found, or the URL is not one', async () => {
    expect(await probeSpecs('https://docs.acme.example/', fake({}))).toBeNull();
    expect(await probeSpecs('not a url', fake({}))).toBeNull();
  });

  it('is null when the fetch itself fails everywhere', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await probeSpecs('https://docs.acme.example/', failing)).toBeNull();
  });
});

describe('importSpecUrls', () => {
  const a = 'https://docs.acme.example/specs/orders.yaml';
  const b = 'https://docs.acme.example/specs/stock.json?v=2';
  const pages = {
    [a]: spec('Orders', { '/orders': 'listOrders' }),
    [b]: JSON.stringify({ openapi: '3.0.0', info: { title: 'Stock', version: '1' }, servers: [{ url: 'https://api.acme.example/v1' }], paths: { '/stock': { get: { operationId: 'listStock', responses: {} } } } }),
  };

  it('imports one spec as it is', async () => {
    const r = await importSpecUrls([a], 'https://docs.acme.example', fake(pages));
    expect(r.project.title).toBe('Orders');
    expect(r.note).toBe('Found 1 spec on the docs site (1 requests).');
  });

  it('merges several, named after the site, and says which it skipped', async () => {
    const r = await importSpecUrls([a, b, 'https://docs.acme.example/specs/gone.yaml'], 'https://developer.acme.example/', fake(pages));
    expect(r.project.title).toBe('Acme');
    expect(r.project.tools.map((t) => [t.name, t.group])).toEqual([
      ['list_orders', 'orders'],
      ['list_stock', 'stock'],
    ]);
    expect(r.note).toBe('Found 2 specs on the docs site (2 requests); skipped gone.');
  });

  it('throws when none import', async () => {
    await expect(importSpecUrls(['https://x.example/a.yaml'], 'https://x.example', fake({}))).rejects.toThrow('None of the 1 spec link found imported.');
    await expect(importSpecUrls(['https://x.example/a.yaml', 'https://x.example/b.yaml'], 'https://x.example', fake({}))).rejects.toThrow('None of the 2 spec links found imported.');
  });
});

describe('importFromUrl', () => {
  it('says what the server answered when the URL fails', async () => {
    await expect(importFromUrl('https://x.example/spec.yaml', fake({}))).rejects.toThrow('https://x.example/spec.yaml answered 404 Not Found.');
  });

  it('rethrows the importer’s reason for something that is neither a spec nor a page', async () => {
    await expect(importFromUrl('https://x.example/notes.txt', fake({ 'https://x.example/notes.txt': 'just some words' }))).rejects.toThrow();
    await expect(importFromUrl('https://x.example/notes.txt', fake({ 'https://x.example/notes.txt': 'just some words' }))).rejects.not.toThrow(/links to none/);
  });

  it('imports the only spec a page links to, unmerged', async () => {
    const r = await importFromUrl(
      'https://x.example/api-docs',
      fake({ 'https://x.example/api-docs': '<html><a href="orders.yaml">Orders</a></html>', 'https://x.example/orders.yaml': spec('Orders', { '/orders': 'listOrders' }) }),
    );
    expect(r.project.title).toBe('Orders');
    expect(r.note).toBe('Imported 1 spec linked from that page (1 requests).');
  });

  it('says so when a page’s linked specs all fail', async () => {
    await expect(importFromUrl('https://x.example/openapi', fake({ 'https://x.example/openapi': '<a href="/a.yaml">a</a>' }))).rejects.toThrow('The page links to 1 spec file, but none of them imported.');
    await expect(importFromUrl('https://x.example/openapi', fake({ 'https://x.example/openapi': '<a href="/a.yaml">a</a><a href="/b.json">b</a>' }))).rejects.toThrow('The page links to 2 spec files, but none of them imported.');
  });
});

describe('specLinks', () => {
  it('on a page with no spec hints, keeps only links that hint at a spec', () => {
    const html = '<a href="/data.json">data</a><a href="/files/api-docs.yaml">docs</a><a href=\'/v1/spec.json\'>sw</a>';
    expect(specLinks(html, 'https://x.example/downloads')).toEqual(['https://x.example/files/api-docs.yaml', 'https://x.example/v1/spec.json']);
  });

  it('keeps every spec-like file on a page that mentions OpenAPI, de-duplicated, http(s) only', () => {
    const html = 'Our OpenAPI files: <a href="/a.json">a</a><a href="/a.json">again</a><a href="ftp://x.example/b.yaml">ftp</a><a href="/c.yml#top">c</a><a href="http://[bad/d.yaml">bad</a>';
    expect(specLinks(html, 'https://x.example/files')).toEqual(['https://x.example/a.json', 'https://x.example/c.yml#top']);
  });

  it('stops at forty links', () => {
    const html = Array.from({ length: 50 }, (_, i) => `<a href="/s${i}.yaml">s</a>`).join('');
    expect(specLinks(html, 'https://x.example/openapi')).toHaveLength(40);
  });
});

describe('titleFromHost', () => {
  it('skips the generic parts, and falls back to API', () => {
    expect(titleFromHost('https://www.acme.example')).toBe('Acme');
    expect(titleFromHost('https://api.dev.com')).toBe('API');
    expect(titleFromHost('not a url')).toBe('API');
  });
});

describe('mergeProjects', () => {
  const part = (name: string, envName: string, auth: Project['envs'][0]['auth'], toolIds: string[], tags?: string[]): Project => ({
    overapi: 1,
    name,
    title: name,
    description: '',
    version: '1',
    envs: [{ name: envName, baseUrl: `https://${envName}.acme.example`, auth, allowWrites: false }],
    tools: toolIds.map((id) => ({ id, name: 'list', description: '', enabled: true, safety: 'read', method: 'GET', path: id.split(' ')[1], params: [], bodyMode: 'none', origin: tags ? { tags } : undefined })),
  });

  it('keeps distinct environments, renames secrets after the merged API, drops duplicate ids and makes names unique', () => {
    const m = mergeProjects(
      [
        { project: part('analytics', 'production', { type: 'apiKey', in: 'header', name: 'X-Key', valueVar: 'ANALYTICS_API_KEY' }, ['GET /events', 'GET /shared']), ref: 'https://d.acme.example/analytics.yaml' },
        { project: part('billing', 'sandbox', { type: 'basic', userVar: 'BILLING_USER', passVar: 'BILLING_PASSWORD' }, ['GET /invoices', 'GET /shared'], ['Billing']), ref: 'https://d.acme.example/billing.json' },
        { project: part('extra', 'production', { type: 'none' }, ['GET /other']), ref: 'extra.yml' },
      ],
      'Acme Platform',
      'https://d.acme.example',
    );
    expect(m.envs.map((e) => [e.name, e.auth])).toEqual([
      ['production', { type: 'apiKey', in: 'header', name: 'X-Key', valueVar: 'ACME_PLATFORM_API_KEY' }],
      ['sandbox', { type: 'basic', userVar: 'ACME_PLATFORM_USER', passVar: 'ACME_PLATFORM_PASSWORD' }],
    ]);
    expect(m.tools.map((t) => t.id)).toEqual(['GET /events', 'GET /shared', 'GET /invoices', 'GET /other']);
    expect(m.tools.map((t) => t.group)).toEqual(['analytics', 'analytics', undefined, 'extra']);
    expect(new Set(m.tools.map((t) => t.name)).size).toBe(4);
    expect(m.description).toBe('Acme Platform, from 3 OpenAPI files: analytics, billing, extra.');
    expect(m.source).toMatchObject({ kind: 'openapi', ref: 'https://d.acme.example' });
  });
});
