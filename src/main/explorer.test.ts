import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { DEFAULT_EXPLORE, explore, pageKind, type ExploreOptions, type ExploreStatus } from './explorer';

describe('pageKind', () => {
  it.each([
    ['https://acme.example/', '/'],
    ['https://acme.example', '/'],
    ['https://acme.example/clubs', '/clubs'],
    ['https://acme.example/Clubs/Teams', '/clubs/teams'],
    ['https://acme.example/clubs/1/acme-rovers', '/clubs/{id}/{name}'],
    ['https://acme.example/clubs/2/acme-united', '/clubs/{id}/{name}'],
    ['https://acme.example/clubs/42', '/clubs/{id}'],
    ['https://acme.example/clubs/42/squad/7', '/clubs/{id}/{name}/{id}'],
    ['https://acme.example/u/3fa85f64-5717-4562-b3fc-2c963f66afa6', '/u/{id}'],
    ['https://acme.example/u/0123456789abcdef', '/u/{id}'],
    ['https://acme.example/u/0123456789abcde', '/u/{id}'], // 15 chars: digit+letter and >= 6
    ['https://acme.example/match/abc123', '/match/{id}'],
    ['https://acme.example/match/ab12', '/match/ab12'], // short mixed slug stays
    ['https://acme.example/season/2024-25', '/season/2024-25'], // digits but no letters
    ['https://acme.example/players/9/Kai_Acme', '/players/{id}/kai_acme'], // underscore isn't a name
    ['https://acme.example/players/9/kai-acme/stats', '/players/{id}/{name}/stats'],
    ['https://acme.example/clubs/1/acme-rovers?tab=squad#top', '/clubs/{id}/{name}'],
    ['https://acme.example//double//slash/', '/double/slash'],
  ])('%s → %s', (url, kind) => {
    expect(pageKind(url)).toBe(kind);
  });

  it('groups pages that differ only by ids and names', () => {
    expect(pageKind('https://acme.example/clubs/1/acme-rovers')).toBe(pageKind('https://acme.example/clubs/77/acme-rovers'));
  });

  it('gives a non-URL back as it is', () => {
    expect(pageKind('not a url')).toBe('not a url');
    expect(pageKind('')).toBe('');
  });
});

// ---- explore -------------------------------------------------------------------

type Site = Record<string, string[]>;

interface FakeOpts {
  /// Pages whose visit adds routes.
  productive?: (url: string) => boolean;
  /// Script behaviour per url.
  script?: (url: string) => Promise<unknown> | unknown;
  loadFails?: (url: string) => boolean;
}

/// Just what explore uses of a WebContents: getURL, loadURL,
/// executeJavaScript, on/removeListener('will-navigate').
function fakePage(start: string, site: Site, o: FakeOpts = {}) {
  const em = new EventEmitter();
  let url = start;
  let routes = 0;
  const loads: string[] = [];
  const scripts: string[] = [];
  const page = {
    getURL: () => url,
    loadURL: vi.fn(async (u: string) => {
      loads.push(u);
      if (o.loadFails?.(u)) throw new Error('ERR_NAME_NOT_RESOLVED');
      url = u;
    }),
    executeJavaScript: vi.fn(async (code: string) => {
      scripts.push(code);
      if (o.productive?.(url)) routes++;
      if (o.script) return o.script(url);
      return { links: (site[url] ?? []).map((href) => ({ href, text: '' })), acted: 0 };
    }),
    on: (ev: string, fn: (...a: unknown[]) => void) => (em.on(ev, fn), page),
    removeListener: (ev: string, fn: (...a: unknown[]) => void) => (em.removeListener(ev, fn), page),
  };
  return { page, em, loads, scripts, routes: () => routes, visited: () => [start, ...loads] };
}

const opts = (o: Partial<ExploreOptions> = {}): ExploreOptions => ({ maxPages: 50, maxMinutes: 60, delayMs: 10, perKind: 2, ...o });

async function run(f: ReturnType<typeof fakePage>, o: Partial<ExploreOptions> = {}, hooks: { wanted?: string[]; stopped?: () => boolean; routes?: () => number } = {}) {
  const statuses: ExploreStatus[] = [];
  const p = explore(f.page as unknown as WebContents, opts(o), {
    routes: hooks.routes ?? f.routes,
    wanted: () => hooks.wanted ?? [],
    onStatus: (s) => statuses.push(s),
    stopped: hooks.stopped ?? (() => false),
  });
  await vi.runAllTimersAsync();
  return { result: await p, statuses };
}

const O = 'https://acme.example';

describe('explore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has sensible defaults', () => {
    expect(DEFAULT_EXPLORE).toEqual({ maxPages: 40, maxMinutes: 5, delayMs: 1200, perKind: 2 });
  });

  it('follows links on the site and stops when nothing is left', async () => {
    const f = fakePage(`${O}/`, {
      [`${O}/`]: [`${O}/clubs`, `${O}/news`],
      [`${O}/clubs`]: [`${O}/`, `${O}/clubs/1/acme-rovers`],
    });
    const { result, statuses } = await run(f);
    expect(result).toMatchObject({ running: false, reason: 'nothing left to visit', pages: 4, maxPages: 50 });
    expect(new Set(f.visited())).toEqual(new Set([`${O}/`, `${O}/clubs`, `${O}/news`, `${O}/clubs/1/acme-rovers`]));
    // The page it starts on isn't reloaded.
    expect(f.loads).not.toContain(`${O}/`);
    expect(statuses.filter((s) => s.current).map((s) => s.current)).toHaveLength(4);
    expect(statuses.at(-1)).toMatchObject({ running: false, reason: 'nothing left to visit' });
  });

  it('never leaves the origin, skips files, strips #fragments and de-duplicates', async () => {
    const f = fakePage(`${O}/`, {
      [`${O}/`]: [
        'https://elsewhere.example/a',
        'http://acme.example/plain-http',
        `${O}/guide.pdf`,
        `${O}/photo.JPG?w=1`,
        `${O}/cal.ics`,
        `${O}/table#top`,
        `${O}/table#bottom`,
        `${O}/table`,
      ],
    });
    await run(f);
    expect(f.loads).toEqual([`${O}/table`]);
  });

  // BUG: the on-origin check is a string prefix (h.startsWith(origin)), so a
  // look-alike host such as https://acme.example.evil.test passes it and
  // the explorer leaves the site. The in-page PAGE_SCRIPT filters links the
  // same way (l.href.startsWith(location.origin)). Should compare
  // new URL(h).origin === origin.
  it('does not follow a look-alike host that merely starts with the origin', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: ['https://acme.example.evil.test/steal', 'https://acme.example:8443/other-port'] });
    await run(f);
    expect(f.loads).toEqual([]);
  });

  it('stops at maxPages', async () => {
    const site: Site = { [`${O}/`]: Array.from({ length: 10 }, (_, i) => `${O}/section${'abcdefghij'[i]}`) };
    const f = fakePage(`${O}/`, site, { productive: () => true });
    const { result } = await run(f, { maxPages: 3 });
    expect(result).toMatchObject({ running: false, pages: 3, reason: 'visited 3 pages' });
    expect(f.loads).toHaveLength(2);
  });

  it('stops when told to', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/a`, `${O}/b`, `${O}/c`] }, { productive: () => true });
    let n = 0;
    const { result } = await run(f, {}, { stopped: () => ++n > 2 });
    expect(result).toMatchObject({ running: false, reason: 'stopped', pages: 2 });
  });

  it('stops after maxMinutes', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/a`, `${O}/b`, `${O}/c`, `${O}/d`] }, { productive: () => true });
    // Each page takes 1.5 s + 0.8 s + delay; 0.1 min = 6 s → three pages.
    const { result } = await run(f, { maxMinutes: 0.1, delayMs: 0 });
    expect(result).toMatchObject({ running: false, reason: 'ran 0.1 minutes', pages: 3 });
  });

  it('stops when eight pages in a row find no new requests', async () => {
    const links = Array.from({ length: 12 }, (_, i) => `${O}/area${'abcdefghijkl'[i]}`);
    const f = fakePage(`${O}/`, { [`${O}/`]: links });
    const { result } = await run(f);
    expect(result).toMatchObject({ running: false, reason: 'new pages stopped finding new requests', pages: 8 });
  });

  it('a productive page resets the quiet count', async () => {
    // Only the fifth page adds a route: 4 quiet before it, then 8 quiet
    // pages among the ten it links to.
    const more = Array.from({ length: 10 }, (_, i) => `${O}/more${'abcdefghij'[i]}`);
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/a`, `${O}/b`, `${O}/c`, `${O}/d`], [`${O}/d`]: more }, { productive: (u) => u === `${O}/d` });
    const { result } = await run(f);
    expect(result.reason).toBe('new pages stopped finding new requests');
    expect(result.pages).toBe(13);
    expect(result.found).toBe(1);
  });

  it('visits at most perKind pages of one kind', async () => {
    const f = fakePage(`${O}/clubs`, {
      [`${O}/clubs`]: [`${O}/clubs/1/acme-rovers`, `${O}/clubs/2/acme-united`, `${O}/clubs/3/acme-rovers`, `${O}/clubs/4/acme-united`],
    });
    await run(f, { perKind: 2 });
    expect(f.loads).toHaveLength(2);
    expect(f.loads.every((u) => pageKind(u) === '/clubs/{id}/{name}')).toBe(true);
  });

  it('perKind 1 still visits other kinds', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/clubs/1/a-team`, `${O}/clubs/2/b-team`, `${O}/news`] });
    await run(f, { perKind: 1 });
    expect(f.loads.sort()).toEqual([`${O}/clubs/1/a-team`, `${O}/news`]);
  });

  it('prefers new kinds of page, and links mentioning what is wanted', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/about`, `${O}/news`, `${O}/fixtures/team`] }, { productive: () => true });
    await run(f, {}, { wanted: ['team'] });
    expect(f.loads[0]).toBe(`${O}/fixtures/team`);
  });

  it('prefers shallower kinds when scores tie', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/a/b/c`, `${O}/a`] }, { productive: () => true });
    await run(f);
    expect(f.loads).toEqual([`${O}/a`, `${O}/a/b/c`]);
  });

  it('moves on from a page that will not load (it still counts as a page)', async () => {
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/broken`, `${O}/fine`] }, { loadFails: (u) => u.endsWith('/broken'), productive: () => true });
    const { result } = await run(f);
    expect(f.loads.sort()).toEqual([`${O}/broken`, `${O}/fine`]);
    expect(result.pages).toBe(3);
    expect(f.page.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it('moves on when the page script throws or returns nothing', async () => {
    const f = fakePage(`${O}/`, {}, {
      script: (u) => {
        if (u === `${O}/`) return { links: [{ href: `${O}/x`, text: '' }] };
        if (u === `${O}/x`) throw new Error('page went away');
        return undefined;
      },
    });
    const { result } = await run(f);
    expect(result.reason).toBe('nothing left to visit');
    expect(f.loads).toEqual([`${O}/x`]);
  });

  it('gives up on a page script after 25 seconds', async () => {
    const f = fakePage(`${O}/`, {}, { script: () => new Promise(() => undefined) });
    const t0 = Date.now();
    const { result } = await run(f, { delayMs: 0 });
    expect(result.reason).toBe('nothing left to visit');
    // 1.5 s settle + 25 s timeout + 0.8 s.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(27_300);
  });

  it('runs the page script with two picks per control', async () => {
    const f = fakePage(`${O}/`, {});
    await run(f);
    expect(f.scripts).toHaveLength(1);
    expect(f.scripts[0]).toMatch(/^\(async \(perControl\) => \{/);
    expect(f.scripts[0].endsWith('})(2)')).toBe(true);
    expect(f.page.executeJavaScript).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('holds navigation only while working on a page, and lets go afterwards', async () => {
    const prevented: boolean[] = [];
    const nav = () => {
      const e = { preventDefault: vi.fn() };
      f.em.emit('will-navigate', e);
      prevented.push(e.preventDefault.mock.calls.length > 0);
    };
    const f = fakePage(`${O}/`, {}, {
      script: () => {
        nav();
        return { links: [] };
      },
    });
    const p = explore(f.page as unknown as WebContents, opts(), { routes: () => 0, wanted: () => [], onStatus: () => undefined, stopped: () => false });
    nav(); // before the script: not held
    await vi.runAllTimersAsync();
    await p;
    expect(prevented).toEqual([false, true]);
    expect(f.em.listenerCount('will-navigate')).toBe(0);
  });

  it('reports found routes relative to the start, and the current page', async () => {
    let r = 5;
    const f = fakePage(`${O}/`, { [`${O}/`]: [`${O}/a`] }, { script: (u) => (r += 2, { links: u === `${O}/` ? [{ href: `${O}/a`, text: '' }] : [] }) });
    const { result, statuses } = await run(f, {}, { routes: () => r });
    expect(result.found).toBe(4);
    expect(statuses[0]).toMatchObject({ running: true, pages: 1, current: `${O}/`, found: 0 });
    expect(statuses.some((s) => s.current === `${O}/a`)).toBe(true);
  });

  it('removes the navigation listener even when a hook throws', async () => {
    const f = fakePage(`${O}/`, {});
    const p = explore(f.page as unknown as WebContents, opts(), {
      routes: () => 0,
      wanted: () => {
        throw new Error('boom');
      },
      onStatus: () => undefined,
      stopped: () => false,
    });
    const caught = p.catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await caught).toBeInstanceOf(Error);
    expect(f.em.listenerCount('will-navigate')).toBe(0);
  });
});

// ---- the in-page script's safety rules ----------------------------------------

describe('PAGE_SCRIPT UNSAFE words', () => {
  let UNSAFE: RegExp;
  let script: string;
  beforeEach(async () => {
    vi.useFakeTimers();
    const f = fakePage(`${O}/`, {});
    const p = explore(f.page as unknown as WebContents, opts(), { routes: () => 0, wanted: () => [], onStatus: () => undefined, stopped: () => false });
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    script = f.scripts[0];
    const m = script.match(/const UNSAFE = \/(.+?)\/i;/);
    expect(m).toBeTruthy();
    UNSAFE = new RegExp(m![1], 'i');
  });

  it.each(['Buy now', 'Pay', 'Checkout', 'Add to basket', 'Cart', 'Delete', 'Remove player', 'Send', 'Submit', 'Save', 'Publish', 'Sign in', 'Sign out', 'Signup', 'Log in', 'Logout', 'Register', 'Subscribe', 'Download CSV', 'Report abuse', 'Vote', 'Follow', 'Like', 'Comment', 'Donate', 'Contact us', 'Email', 'Apply', 'Join', 'Bet', 'Tickets'])('treats "%s" as unsafe', (label) => {
    expect(UNSAFE.test(label)).toBe(true);
  });

  it.each(['Fixtures', 'Results', 'Table', 'Squad', 'Stats', 'Season 2024/25', 'Next', 'Previous', 'Overview', 'Load more', 'History', 'Teams'])('treats "%s" as safe', (label) => {
    expect(UNSAFE.test(label)).toBe(false);
  });

  it('never submits forms or follows clicked links, and only collects same-origin links', () => {
    expect(script).toContain("document.addEventListener('submit', noSubmit, true)");
    expect(script).toContain("document.removeEventListener('submit', noSubmit, true)");
    expect(script).toContain("el.closest('form')");
    expect(script).toContain('new URL(l.href).origin === location.origin');
  });

  it('is valid JavaScript', () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });
});
