// Chaining: values kept from one response for the requests after it.
//
// The legacy-API case this exists for: `POST /login` answers with a token,
// and every other call needs it in a header. Mark the token once (a
// capture on the login request) and `{{token}}` fills in everywhere after —
// in the app, and for an agent through MCP, which is what makes a "log in,
// then call" API usable by an agent at all.

import type { Capture, ToolDef } from './project';

/// `data.items[0].id` -> ['data', 'items', 0, 'id']. A leading `$.` is
/// accepted, since people paste JSONPath.
export function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  const src = path.trim().replace(/^\$\.?/, '');
  for (const m of src.matchAll(/([^.[\]]+)|\[(\d+)\]|\[["']([^"']+)["']\]/g)) {
    if (m[2] !== undefined) out.push(Number(m[2]));
    else out.push(m[1] ?? m[3]);
  }
  return out;
}

/// The reverse: segments to the path a person reads and edits.
export function formatPath(segs: (string | number)[]): string {
  return segs
    .map((s, i) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? (i ? `.${s}` : s) : `["${s}"]`))
    .join('');
}

export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of parsePath(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/// What a response yields for a request's captures. Values that are not
/// there are skipped, so a failed login never blanks a token kept earlier.
export function applyCaptures(captures: Capture[] | undefined, json: unknown, headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of captures ?? []) {
    if (!c.var) continue;
    const v = c.from === 'header' ? headers[c.path.toLowerCase()] : getPath(json, c.path);
    if (v === undefined || v === null || v === '') continue;
    out[c.var] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/// The {{names}} a request uses anywhere — its path, headers, example
/// values — so the app can say which earlier response it depends on.
export function varsUsed(t: ToolDef): string[] {
  const text = [t.path, ...Object.values(t.headers ?? {}), JSON.stringify(t.example ?? {})].join(' ');
  return [...new Set([...text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g)].map((m) => m[1]))];
}

/// A shell line that repeats the request, for the person to share or try.
/// Takes the request as SHOWN — secrets already replaced with •••.
export function toCurl(req: { method: string; url: string; headers: Record<string, string>; body?: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${req.method} ${q(req.url)}`];
  for (const [k, v] of Object.entries(req.headers)) parts.push(`  -H ${q(`${k}: ${v}`)}`);
  if (req.body !== undefined) parts.push(`  --data-raw ${q(req.body)}`);
  return parts.join(' \\\n');
}
