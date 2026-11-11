import { Fragment, useMemo, useState } from 'react';
import { JsonView } from './JsonView';

/// Where a response's list is: the root, else the list under a key that
/// means "the results" (content, data, items…) — even when it is empty —
/// else the biggest list of objects one or two levels in. Paging and sort
/// settings (`pageable`, `sort`) are never the results.
const RESULTS = /^(content|data|items|results|records|rows|list|values|elements|entries|hits|_embedded)$/i;
const NOT_RESULTS = /^(pageable|sort|sorts|links|_links|meta|errors|warnings)$/i;

export function findList(json: unknown): { path: string; rows: Record<string, unknown>[] } | null {
  const isObjs = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (isObjs(json) && json.length) return { path: '', rows: json };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const top = json as Record<string, unknown>;
  for (const [k, v] of Object.entries(top)) if (RESULTS.test(k) && isObjs(v)) return { path: k, rows: v };
  let best: { path: string; rows: Record<string, unknown>[] } | null = null;
  const look = (obj: Record<string, unknown>, at: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      if (NOT_RESULTS.test(k)) continue;
      const p = at ? `${at}.${k}` : k;
      if (isObjs(v) && v.length) {
        if (!best || v.length > best.rows.length) best = { path: p, rows: v };
      } else if (depth < 2 && v && typeof v === 'object' && !Array.isArray(v)) look(v as Record<string, unknown>, p, depth + 1);
    }
  };
  look(top, '', 0);
  return best;
}

const LABEL = /^(name|title|label|displayName|display_name|fullName|full_name|username|email|subject|summary)$/i;
const TIME = /(date|time|At|timestamp)$/;

/// A row with its nested objects opened up, two levels deep:
/// { playerMetadata: { name } } → { "playerMetadata.name": … }.
export function flatten(row: Record<string, unknown>, at = '', depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(row)) {
    const key = at ? `${at}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flatten(v as Record<string, unknown>, key, depth + 1, out);
    else out[key] = v;
  }
  return out;
}

const last = (k: string) => k.split('.').pop()!;

/// The columns worth a glance: a name first, then the fields the request
/// sorted by, then ids and short fields — those from small objects before
/// a 70-field stats block — with times last and long text left out. Nested
/// fields count: a row made only of objects still gets a table.
export function tableColumns(rows: Record<string, unknown>[], prefer: string[] = []): string[] {
  const flat = rows.slice(0, 50).map((r) => flatten(r));
  const keys = new Map<string, { n: number; long: number; nested: number; nulls: number }>();
  for (const r of flat)
    for (const [k, v] of Object.entries(r)) {
      const s = keys.get(k) ?? { n: 0, long: 0, nested: 0, nulls: 0 };
      s.n++;
      if (v === null || v === undefined || v === '') s.nulls++;
      else if (typeof v === 'object') s.nested++;
      else if (String(v).length > 48) s.long++;
      keys.set(k, s);
    }
  // How many fields share each parent: small objects describe the row.
  const siblings = new Map<string, number>();
  for (const k of keys.keys()) {
    const parent = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '';
    siblings.set(parent, (siblings.get(parent) ?? 0) + 1);
  }
  const wanted = new Set(prefer.map((x) => x.toLowerCase()));
  const order = [...keys.keys()];
  const usable = [...keys.entries()].filter(([, s]) => s.nested < s.n / 2 && s.long < s.n / 2 && s.nulls < s.n).map(([k]) => k);
  const score = (k: string) => {
    const name = last(k);
    const parent = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '';
    if (LABEL.test(name)) return 0 + k.split('.').length * 0.01;
    if (wanted.has(name.toLowerCase())) return 1;
    if (/^(id|_id|uuid|key|code)$/i.test(name)) return 2 + k.split('.').length * 0.01;
    if (TIME.test(name)) return 5;
    return (siblings.get(parent) ?? 0) <= 12 ? 3 : 4;
  };
  const picked: string[] = [];
  for (const k of usable.sort((a, b) => score(a) - score(b) || order.indexOf(a) - order.indexOf(b))) {
    // One name per object — a player's and their team's both count — and
    // no first/last name once there's a full one.
    const parent = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '';
    const sameParent = (p: string) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') === parent;
    if (LABEL.test(last(k)) && picked.some((p) => sameParent(p) && LABEL.test(last(p)))) continue;
    if (/^(first|last|given|family|middle)_?name$/i.test(last(k)) && usable.some((p) => sameParent(p) && LABEL.test(last(p)))) continue;
    picked.push(k);
    if (picked.length === 7) break;
  }
  return picked;
}

/// A column's heading: its field name, or two parts when two would read the same.
const heading = (k: string, all: string[]) => (all.filter((x) => last(x) === last(k)).length > 1 ? k.split('.').slice(-2).join('.') : last(k));

/// "order lines" from list_order_lines; "items" when it can't tell.
export function nounFor(toolName: string, path: string): string {
  const m = toolName.match(/^(list|search|find|get|query)_(.+)$/);
  const from = m ? m[2] : path.split('.').pop() || 'items';
  return (
    from
      .replace(/_/g, ' ')
      .replace(/\b(for|by|in|of)\b.*$/, '')
      .trim() || 'items'
  );
}

/// A one-line read of a response: how many, and which page.
export function summarize(json: unknown, toolName: string): string | null {
  const list = findList(json);
  if (!list) return null;
  const noun = nounFor(toolName, list.path);
  const parts = [`${list.rows.length.toLocaleString()} ${list.rows.length === 1 ? noun.replace(/s$/, '') : noun}`];
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    const total = o.totalElements ?? o.total ?? o.totalCount ?? o.total_count ?? o.count;
    if (typeof total === 'number' && total > list.rows.length) parts[0] += ` of ${total.toLocaleString()}`;
    const page = typeof o.number === 'number' ? o.number + 1 : typeof o.page === 'number' ? o.page : undefined;
    const pages = o.totalPages ?? o.total_pages ?? o.pages;
    if (page !== undefined && typeof pages === 'number' && pages > 1) parts.push(`page ${page} of ${pages}`);
  }
  return parts.join(' · ');
}

const cell = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '✓' : '✗') : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} items` : '{…}') : String(v);
const looksTime = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);

/// A list response as rows you can scan; a row opens to the whole item.
export function ResponseTable({ json, prefer = [] }: { json: unknown; prefer?: string[] }): JSX.Element | null {
  const list = useMemo(() => findList(json), [json]);
  const cols = useMemo(() => (list ? tableColumns(list.rows, prefer) : []), [list, prefer.join(',')]);
  const [open, setOpen] = useState<number | null>(null);
  if (!list) return null;
  if (!list.rows.length)
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-rule-strong px-4 py-8 text-center">
        <div className="text-[13px] font-medium text-ink">Nothing matched</div>
        <div className="max-w-[340px] text-[12px] text-ink-muted">
          The request worked, and <span className="font-mono">{list.path || 'the list'}</span> came back empty — loosen a filter or a switch and send again.
        </div>
      </div>
    );
  if (!cols.length) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-accent/25 bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-accent/20 bg-accent/[0.08] text-left">
              {cols.map((c) => (
                <th key={c} title={c} className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[10.5px] font-semibold text-accent">
                  {heading(c, cols)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.rows.slice(0, 200).map((row, i) => {
              const r = flatten(row);
              return (
                <Fragment key={i}>
                  <tr onClick={() => setOpen(open === i ? null : i)} className={`cursor-pointer border-b border-rule last:border-b-0 ${open === i ? 'bg-accent/[0.06]' : 'hover:bg-wash'}`}>
                    {cols.map((c, j) => {
                      const v = r[c];
                      return (
                        <td
                          key={c}
                          title={typeof v === 'string' ? v : undefined}
                          className={`max-w-[260px] truncate whitespace-nowrap px-2.5 py-1.5 ${j === 0 && LABEL.test(last(c)) ? 'font-medium text-ink' : /id$/i.test(last(c)) ? 'font-mono text-[11px] text-ink-muted' : typeof v === 'number' ? 'tabular-nums' : v === false ? 'text-ink-faint' : 'text-ink'}`}
                        >
                          {looksTime(v) ? new Date(v as string).toLocaleString() : cell(v)}
                        </td>
                      );
                    })}
                  </tr>
                  {open === i && (
                    <tr className="border-b border-rule bg-canvas">
                      <td colSpan={cols.length} className="px-2.5 py-2">
                        <JsonView text={JSON.stringify(row, null, 2)} compact />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.rows.length > 200 && <div className="border-t border-rule px-2.5 py-1.5 text-[11px] text-ink-faint">First 200 of {list.rows.length.toLocaleString()} — the JSON view has them all.</div>}
    </div>
  );
}
