// Importing from a URL, including the common case where the URL is not a
// spec but a page that LINKS to specs — Productboard's
// developer.productboard.com/openapi lists one OpenAPI file per area
// (notes, entities, teams…). Each linked spec is fetched, imported, and
// merged into one project, grouped by area.
//
// Electron-free; `fetchImpl` is injectable for tests.

import type { Project, ToolDef } from '../../shared/project';
import { emptyProject, varPrefix, type AuthSpec } from '../../shared/project';
import { uniqueNames, distinctNames } from '../../shared/naming';
import { importText } from './index';

const SPEC_FILE = /\.(ya?ml|json)(\?|#|$)/i;
const SPEC_HINT = /openapi|swagger|api-docs|spec/i;
/// More than this and it is probably not a spec index but a site.
const MAX_SPECS = 40;

/// Links on an HTML page that look like spec files, made absolute.
export function specLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const pageHints = SPEC_HINT.test(pageUrl) || /openapi|swagger/i.test(html);
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1];
    if (!SPEC_FILE.test(href)) continue;
    if (!pageHints && !SPEC_HINT.test(href)) continue;
    try {
      const abs = new URL(href, pageUrl);
      if (/^https?:$/.test(abs.protocol)) out.add(abs.toString());
    } catch {
      // Not a URL.
    }
  }
  return [...out].slice(0, MAX_SPECS);
}

/// A name from the host: developer.productboard.com -> Productboard.
export function titleFromHost(url: string): string {
  try {
    const part = new URL(url).hostname.split('.').find((p) => !/^(www|developer|developers|docs|api|apis|dev|com|io|net|org|co)$/.test(p)) ?? 'API';
    return part.charAt(0).toUpperCase() + part.slice(1);
  } catch {
    return 'API';
  }
}

/// Several imported specs as one project: the first one's environments
/// (others' added when their names differ), every tool, ids unique, names
/// unique, and each spec's tools grouped under its file name when the spec
/// gave them no tags of their own.
export function mergeProjects(parts: { project: Project; ref: string }[], title: string, ref: string): Project {
  const merged = emptyProject(title);
  merged.source = { kind: 'openapi', ref, importedAt: new Date().toISOString() };
  merged.description = `${title}, from ${parts.length} OpenAPI files: ${parts.map((p) => stem(p.ref)).join(', ')}.`;
  const seen = new Set<string>();
  const tools: ToolDef[] = [];
  for (const { project, ref: partRef } of parts) {
    for (const e of project.envs) if (!merged.envs.some((x) => x.name === e.name)) merged.envs.push(e);
    for (const t of project.tools) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tools.push(t.origin?.tags?.length ? t : { ...t, group: stem(partRef) });
    }
  }
  const names = distinctNames(tools.map((t) => ({ name: t.name, path: t.path })));
  merged.tools = tools.map((t, i) => ({ ...t, name: names[i] }));
  // Each part named its secrets after its own title (ANALYTICS_TOKEN); the
  // merged API names them after itself (PRODUCTBOARD_TOKEN).
  const prefix = varPrefix(merged.name);
  const rename = (a: AuthSpec): AuthSpec =>
    a.type === 'bearer'
      ? { ...a, tokenVar: `${prefix}_TOKEN` }
      : a.type === 'apiKey'
        ? { ...a, valueVar: `${prefix}_API_KEY` }
        : a.type === 'basic'
          ? { ...a, userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` }
          : a;
  merged.envs = merged.envs.map((e) => ({ ...e, auth: rename(e.auth) }));
  return merged;
}

/// Where specs usually live, relative to a docs or API origin.
export const USUAL_SPEC_PATHS = ['/openapi', '/openapi.json', '/openapi.yaml', '/swagger.json', '/swagger.yaml', '/v3/api-docs', '/api-docs', '/swagger/v1/swagger.json', '/api/openapi.json', '/docs/openapi.json'];

/// Tries the usual places on the URL's site. The first that imports wins;
/// none is not an error, just null.
export async function probeSpecs(url: string, fetchImpl: typeof fetch = fetch): Promise<UrlImport | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const tries = await Promise.all(
    USUAL_SPEC_PATHS.map((p) =>
      importFromUrl(origin + p, withTimeout(fetchImpl, 8000)).then(
        (r) => r,
        () => null,
      ),
    ),
  );
  return tries.find((r): r is UrlImport => !!r) ?? null;
}

/// Spec URLs found by someone (a model browsing the docs) imported and,
/// when several, merged.
export async function importSpecUrls(urls: string[], siteUrl: string, fetchImpl: typeof fetch = fetch): Promise<UrlImport> {
  const results = await Promise.all(
    urls.slice(0, MAX_SPECS).map((u) =>
      importFromUrl(u, fetchImpl).then(
        (r) => ({ ok: true as const, project: r.project, ref: u }),
        (e: Error) => ({ ok: false as const, ref: u, error: e.message }),
      ),
    ),
  );
  const good = results.filter((r): r is { ok: true; project: Project; ref: string } => r.ok);
  if (!good.length) throw new Error(`None of the ${urls.length} spec link${urls.length === 1 ? '' : 's'} found imported.`);
  const project = good.length === 1 ? good[0].project : mergeProjects(good, titleFromHost(siteUrl), siteUrl);
  const bad = results.filter((r) => !r.ok).map((r) => stem(r.ref));
  return { project, note: `Found ${good.length} spec${good.length === 1 ? '' : 's'} on the docs site (${project.tools.length} requests)${bad.length ? `; skipped ${bad.join(', ')}` : ''}.` };
}

function withTimeout(f: typeof fetch, ms: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return f(input, { ...init, signal: c.signal }).finally(() => clearTimeout(t));
  }) as typeof fetch;
}

function stem(ref: string): string {
  return (ref.split('/').pop() ?? ref).replace(/\.(ya?ml|json)(\?.*)?$/i, '');
}

export interface UrlImport {
  project: Project;
  /// A line for the person: what was found and what was skipped.
  note?: string;
}

/// Fetch a URL and import it: a spec, a capture or collection, or a page
/// linking to specs. Throws with a plain reason when it is none of these —
/// the caller can then hand the page to discovery instead.
export async function importFromUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<UrlImport> {
  const get = async (u: string) => {
    const res = await fetchImpl(u, { headers: { accept: 'application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5' } });
    if (!res.ok) throw new Error(`${u} answered ${res.status} ${res.statusText}.`);
    return res.text();
  };
  const text = await get(url);
  try {
    return { project: importText(text, url) };
  } catch (direct) {
    if (!/^\s*</.test(text)) throw direct;
  }
  const links = specLinks(text, url);
  if (!links.length) throw new Error('That page is not a spec and links to none. Try From documentation, which reads the page itself.');

  const results = await Promise.all(
    links.map(async (u) => {
      try {
        return { ok: true as const, project: importText(await get(u), u), ref: u };
      } catch (e) {
        return { ok: false as const, ref: u, error: (e as Error).message };
      }
    }),
  );
  const good = results.filter((r): r is { ok: true; project: Project; ref: string } => r.ok);
  if (!good.length) throw new Error(`The page links to ${links.length} spec file${links.length === 1 ? '' : 's'}, but none of them imported.`);
  const bad = results.filter((r) => !r.ok).map((r) => stem(r.ref));
  const project = good.length === 1 ? good[0].project : mergeProjects(good, titleFromHost(url), url);
  return {
    project,
    note: `Imported ${good.length} spec${good.length === 1 ? '' : 's'} linked from that page (${project.tools.length} requests)${bad.length ? `; skipped ${bad.join(', ')}` : ''}.`,
  };
}
