// What is already serving HTTP on this Mac — so an address can be picked
// rather than remembered and pasted. The API you want to wrap is very often
// a dev server you started yourself.
//
// Asks the system which ports are listening (lsof, no privileges needed for
// your own processes), then asks each one what it is with a single GET:
// JSON, a web page, or something else — and whether a spec sits at one of
// the usual places. Nothing is sent but plain GETs to 127.0.0.1.
//
// Electron-free; the parsing is pure and tested.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { importText } from './import';

export interface LocalServer {
  port: number;
  pid: number;
  /// The program: node, python3, java…
  process: string;
  /// Where it runs from — usually the project folder's name.
  folder?: string;
  /// The full folder, when it holds source code (a pom.xml, package.json…).
  dir?: string;
  /// What the source is, from those files: Java, Node, Python…
  source?: string;
  /// Everything it serves, specs included, needs signing in (401/403).
  needsAuth?: boolean;
  kind: 'json' | 'html' | 'http';
  status: number;
  /// A web page's <title>, or the spec's title.
  title?: string;
  /// A spec found at one of the usual paths, with the base URL it gives.
  spec?: { url: string; title: string; baseUrl?: string; tools: number };
}

/// macOS's own listeners (AirPlay on 5000/7000, Handoff…) answer HTTP but
/// are never what anyone means.
const SYSTEM = /^(ControlCenter|rapportd|sharingd|AirPlayXPCHelper|identityservicesd|launchd|remoted|WiFiAgent|UniversalControl|Spotify|Dropbox|com\.docker\.backend|stable)$/i;
/// Databases and caches: not HTTP, and a GET would only confuse them.
const NOT_HTTP = new Set([3306, 3307, 5432, 5433, 6379, 27017, 9200 + 100, 11211, 2181, 9092, 1433, 1521]);
export const SPEC_PATHS = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/api-docs', '/openapi.yaml', '/docs/openapi.json', '/api/openapi.json', '/swagger/v1/swagger.json'];

const SOURCE_MARKERS: [string, string][] = [
  ['pom.xml', 'Java'],
  ['build.gradle', 'Java'],
  ['build.gradle.kts', 'Kotlin'],
  ['package.json', 'Node'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['manage.py', 'Python'],
  ['go.mod', 'Go'],
  ['Gemfile', 'Ruby'],
  ['composer.json', 'PHP'],
  ['Cargo.toml', 'Rust'],
];

/// What kind of source a folder holds, if any.
export function sourceKind(dir: string, exists: (f: string) => boolean = fs.existsSync): string | undefined {
  for (const [file, kind] of SOURCE_MARKERS) if (exists(path.join(dir, file))) return kind;
  try {
    if (fs.readdirSync(dir).some((f) => /\.(csproj|sln)$/.test(f))) return '.NET';
  } catch {
    // Unreadable: no source.
  }
  return undefined;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ''))));
}

/// lsof -F output: `p<pid>`, `c<command>`, `n<host:port>` lines.
export function parseLsofListen(out: string): { pid: number; process: string; port: number }[] {
  const rows: { pid: number; process: string; port: number }[] = [];
  let pid = 0;
  let proc = '';
  const seen = new Set<number>();
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) proc = line.slice(1);
    else if (line.startsWith('n')) {
      const m = line.match(/:(\d+)$/);
      if (!m) continue;
      const port = Number(m[1]);
      if (seen.has(port)) continue;
      seen.add(port);
      rows.push({ pid, process: proc, port });
    }
  }
  return rows;
}

/// lsof -d cwd -F output: `p<pid>`, then `n<directory>`.
export function parseLsofCwd(out: string): Map<number, string> {
  const m = new Map<number, string>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) m.set(pid, line.slice(1));
  }
  return m;
}

async function get(url: string, ms: number): Promise<{ status: number; type: string; text: string } | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: 'manual', headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.5' } });
    const text = (await r.text()).slice(0, 200_000);
    return { status: r.status, type: r.headers.get('content-type') ?? '', text };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probe(row: { pid: number; process: string; port: number }, cwd: string | undefined, skipPorts: number[]): Promise<LocalServer | null> {
  if (NOT_HTTP.has(row.port) || skipPorts.includes(row.port) || SYSTEM.test(row.process)) return null;
  const base = `http://127.0.0.1:${row.port}`;
  const root = await get(`${base}/`, 700);
  if (!root) return null;
  const kind: LocalServer['kind'] = /json/i.test(root.type) || /^\s*[[{]/.test(root.text) ? 'json' : /html/i.test(root.type) ? 'html' : 'http';
  const title = kind === 'html' ? root.text.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim() : undefined;
  let spec: LocalServer['spec'];
  const answers = await Promise.all(SPEC_PATHS.map((p) => get(base + p, 800).then((r) => (r ? { p, r } : null))));
  const found = answers.map((a) => (a && a.r.status < 300 ? a : null));
  for (const f of found) {
    if (!f) continue;
    try {
      const project = importText(f.r.text, base + f.p);
      spec = { url: base + f.p, title: project.title, baseUrl: project.envs[0]?.baseUrl || undefined, tools: project.tools.length };
      break;
    } catch {
      // Not a spec after all.
    }
  }
  const locked = (n: number) => n === 401 || n === 403;
  const needsAuth = !spec && (locked(root.status) || answers.some((a) => a && locked(a.r.status)));
  const folder = cwd && cwd !== '/' ? path.basename(cwd) : undefined;
  const source = cwd && cwd !== '/' ? sourceKind(cwd) : undefined;
  return { port: row.port, pid: row.pid, process: row.process, folder, ...(source ? { dir: cwd, source } : {}), ...(needsAuth ? { needsAuth } : {}), kind, status: root.status, title: spec?.title ?? title, spec };
}

export async function findLocalServers(opts: { skipPorts?: number[] } = {}): Promise<LocalServer[]> {
  const rows = parseLsofListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  const pids = [...new Set(rows.map((r) => r.pid))].filter(Boolean);
  const cwds = pids.length ? parseLsofCwd(await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])) : new Map<number, string>();
  const results = await Promise.all(
    // System listeners and databases out first, so a busy Mac's real
    // servers aren't cut off by the cap.
    rows
      .filter((r) => !NOT_HTTP.has(r.port) && !SYSTEM.test(r.process) && !(opts.skipPorts ?? []).includes(r.port))
      .slice(0, 200)
      .map((r) => probe(r, cwds.get(r.pid), opts.skipPorts ?? [])),
  );
  const rank = (s: LocalServer) => (s.spec ? 0 : s.kind === 'json' ? 1 : s.kind === 'http' ? 2 : 3);
  return results.filter((s): s is LocalServer => !!s).sort((a, b) => rank(a) - rank(b) || a.port - b.port);
}
