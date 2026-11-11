// "Explore for me": overapi drives the recording window itself, so the
// recording covers the site instead of whatever someone happened to click.
//
// It aims for coverage, not every page. Pages are grouped the way API
// paths are — /clubs/1/acme-rovers and /clubs/2/acme-united are one kind of
// page — and each kind is visited at most twice. On each page it scrolls
// (lazy loading), opens tabs, picks a couple of options in each dropdown
// (that's how a season picker's calls appear) and presses "load more"
// once. It prefers links into parts of the site that haven't produced
// requests yet, and stops when new pages stop producing new requests.
//
// It only reads: it never submits a form or presses anything that sounds
// like buying, deleting, sending, saving, signing in or out, and it never
// leaves the site. One page at a time, with a pause between.

import type { WebContents } from 'electron';

export interface ExploreOptions {
  maxPages: number;
  maxMinutes: number;
  /// Pause between pages.
  delayMs: number;
  /// Pages of one kind to visit.
  perKind: number;
}

export interface ExploreStatus {
  running: boolean;
  pages: number;
  maxPages: number;
  current?: string;
  /// API routes found while exploring.
  found: number;
  /// Why it stopped.
  reason?: string;
  /// Requests the read-only guard stopped before they went.
  blocked?: number;
}

export const DEFAULT_EXPLORE: ExploreOptions = { maxPages: 40, maxMinutes: 5, delayMs: 1200, perKind: 2 };

/// The same site exactly — not one whose address merely starts the same
/// (acme.example.evil.test, acme.example:8443).
function sameOrigin(href: string, origin: string): boolean {
  try {
    return new URL(href).origin === origin;
  } catch {
    return false;
  }
}

/// /clubs/1/acme-rovers → /clubs/{id}/{name}: the kind of page.
export function pageKind(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (/^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || (/\d/.test(s) && /[a-z]/i.test(s) && s.length >= 6)) out.push('{id}');
      else if (out[out.length - 1] === '{id}' && /^[a-z0-9-]+$/i.test(s)) out.push('{name}');
      else out.push(s.toLowerCase());
    }
    return `/${out.join('/')}`;
  } catch {
    return url;
  }
}

/// Runs in the page: scroll, open tabs and dropdowns, load more — within
/// the rules — then report the links. Plain JS, as executeJavaScript
/// takes it; nothing from overapi is left behind on the page.
const PAGE_SCRIPT = String.raw`(async (perControl) => {
  const UNSAFE = /buy|pay|checkout|basket|cart|order|delete|remove|send|post|submit|save|publish|sign ?(in|out|up)|log ?(in|out)|register|subscribe|unsubscribe|share|download|print|report|vote|predict|enter|join|follow|like|comment|ticket|bet|donate|contact|email|apply/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 60);
  // Never submit anything, and never follow a link, whatever gets clicked —
  // links are collected and visited on purpose, one page at a time.
  const noSubmit = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const noFollow = (e) => { const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a) e.preventDefault(); };
  document.addEventListener('submit', noSubmit, true);
  document.addEventListener('click', noFollow, true);
  // The site's own menus (header, navigation) are for getting around — the
  // links already cover them.
  const inChrome = (el) => !!el.closest('header, nav, [role=navigation], [role=banner], footer');
  let acted = 0;
  const click = async (el) => { if (!el || !visible(el) || UNSAFE.test(label(el)) || el.closest('form')) return false; try { el.click(); acted++; await sleep(500); return true; } catch { return false; } };
  // Cookie banners: decline, the least that lets the page work.
  for (const b of [...document.querySelectorAll('button, [role=button]')]) { if (/^(reject all|decline|necessary only|only necessary|reject)$/i.test(label(b))) { try { b.click(); await sleep(400); } catch {} break; } }
  // Scroll, for whatever loads lazily.
  for (let y = 0; y < 6; y++) { window.scrollBy(0, window.innerHeight * 0.9); await sleep(350); }
  window.scrollTo(0, 0);
  // Tabs.
  for (const t of [...document.querySelectorAll('[role=tab]')].filter((t) => !inChrome(t)).slice(0, 6)) await click(t);
  // Native dropdowns: a couple of options each.
  for (const s of [...document.querySelectorAll('select')].slice(0, 4)) {
    if (!visible(s) || s.closest('form[method=post]')) continue;
    for (const o of [...s.options].filter((o) => !o.disabled && !o.selected).slice(0, perControl)) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); acted++; await sleep(700); }
  }
  // Custom dropdowns: open, pick a couple of options.
  for (const b of [...document.querySelectorAll('[aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"]')].filter((b) => !inChrome(b)).slice(0, 4)) {
    for (let i = 0; i < perControl; i++) {
      if (!(await click(b))) break;
      const opts = [...document.querySelectorAll('[role=option], [role=menuitemradio]')].filter((o) => visible(o) && !o.closest('a[href]') && !o.matches('a[href]'));
      if (!opts[i + 1]) { document.body.click(); break; }
      await click(opts[i + 1]);
    }
  }
  // Load more, once.
  const more = [...document.querySelectorAll('button, [role=button]')].find((b) => /^(load|show|see|view) more/i.test(label(b)));
  if (more) { await click(more); await sleep(800); }
  document.removeEventListener('submit', noSubmit, true);
  document.removeEventListener('click', noFollow, true);
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: label(a) })).filter((l) => { try { return new URL(l.href).origin === location.origin; } catch { return false; } }).filter((l) => !UNSAFE.test(l.text));
  return { links, acted };
})`;

export async function explore(
  page: WebContents,
  opts: ExploreOptions,
  hooks: {
    /// API routes recorded so far — the explorer watches it grow.
    routes: () => number;
    /// Words that point at gaps (team, match) — links mentioning them go first.
    wanted: () => string[];
    onStatus: (s: ExploreStatus) => void;
    stopped: () => boolean;
  },
): Promise<ExploreStatus> {
  const started = Date.now();
  const origin = new URL(page.getURL()).origin;
  const seenKinds = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [page.getURL()];
  const startRoutes = hooks.routes();
  let pages = 0;
  let quiet = 0;
  const status = (patch: Partial<ExploreStatus>): ExploreStatus => {
    const s: ExploreStatus = { running: true, pages, maxPages: opts.maxPages, found: hooks.routes() - startRoutes, ...patch };
    hooks.onStatus(s);
    return s;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // While working on a page, it stays on that page: anything that would
  // navigate away (a menu item, a script) is stopped here too.
  let acting = false;
  const hold = (e: Electron.Event) => {
    if (acting) e.preventDefault();
  };
  page.on('will-navigate', hold);
  try {
    return await run();
  } finally {
    page.removeListener('will-navigate', hold);
  }

  async function run(): Promise<ExploreStatus> {
  while (queue.length) {
    if (hooks.stopped()) return status({ running: false, reason: 'stopped' });
    if (pages >= opts.maxPages) return status({ running: false, reason: `visited ${opts.maxPages} pages` });
    if (Date.now() - started > opts.maxMinutes * 60_000) return status({ running: false, reason: `ran ${opts.maxMinutes} minutes` });
    if (quiet >= 8) return status({ running: false, reason: 'new pages stopped finding new requests' });
    const url = queue.shift()!;
    const kind = pageKind(url);
    if (visited.has(url) || (seenKinds.get(kind) ?? 0) >= opts.perKind) continue;
    visited.add(url);
    seenKinds.set(kind, (seenKinds.get(kind) ?? 0) + 1);
    pages++;
    status({ current: url });
    const before = hooks.routes();
    try {
      if (page.getURL() !== url) await page.loadURL(url);
    } catch {
      continue; // a page that wouldn't load: on to the next
    }
    await sleep(1500);
    let found: { links: { href: string; text: string }[] } = { links: [] };
    acting = true;
    try {
      // One page can't stall the run.
      found = (await Promise.race([page.executeJavaScript(`${PAGE_SCRIPT}(2)`, true), sleep(25_000).then(() => undefined)])) ?? { links: [] };
    } catch {
      /* the page went away mid-way */
    } finally {
      acting = false;
    }
    await sleep(800);
    quiet = hooks.routes() > before ? 0 : quiet + 1;

    // Next: new kinds of page first, those mentioning what's missing
    // before those that don't.
    const wanted = hooks.wanted();
    const next = found.links
      .map((l) => l.href.split('#')[0])
      .filter((h) => sameOrigin(h, origin) && !/\.(pdf|jpe?g|png|gif|svg|zip|mp4|mp3|ics)(\?|$)/i.test(h) && !visited.has(h))
      .filter((h, i, all) => all.indexOf(h) === i)
      .map((h) => {
        const k = pageKind(h);
        const n = seenKinds.get(k) ?? 0;
        const hits = wanted.filter((w) => h.toLowerCase().includes(w)).length;
        return { h, score: (n === 0 ? 10 : n < opts.perKind ? 2 : -100) + hits * 5 - k.split('/').length * 0.1 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.h);
    queue.unshift(...next.slice(0, 12));
    await sleep(opts.delayMs);
  }
  return status({ running: false, reason: 'nothing left to visit' });
  }
}
