// A recorded call as something to run again: the headers worth sending a
// second time, and the same request as cURL, fetch, Python or HTTPie.
// These carry the real values — cookies and tokens included — because a
// replay needs them; they go to the person's clipboard, nowhere else.

import type { RecordedCall } from './recording';

export interface Replayable {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/// Headers that belong to one connection or one browser, not to the request.
const DROP = /^(:|host$|content-length$|connection$|keep-alive$|transfer-encoding$|accept-encoding$|proxy-|te$|upgrade$|sec-(ch|fetch)-|priority$)/i;

export function replayHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => !DROP.test(k)));
}

export function replayable(c: RecordedCall, base?: string): Replayable {
  const url = c.url ?? `${(base ?? '').replace(/\/+$/, '')}${c.path}`;
  const sendsBody = c.requestBody !== undefined && c.method !== 'GET' && c.method !== 'HEAD';
  return { method: c.method, url, headers: replayHeaders(c.requestHeaders), body: sendsBody ? c.requestBody : undefined };
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function asCurl(r: Replayable): string {
  const lines = [`curl${r.method === 'GET' ? '' : ` -X ${r.method}`} ${sh(r.url)}`];
  for (const [k, v] of Object.entries(r.headers)) lines.push(`  -H ${sh(`${k}: ${v}`)}`);
  if (r.body !== undefined) lines.push(`  --data-raw ${sh(r.body)}`);
  return lines.join(' \\\n');
}

export function asFetch(r: Replayable): string {
  const init: Record<string, unknown> = { method: r.method, headers: r.headers };
  if (r.body !== undefined) init.body = r.body;
  return `const res = await fetch(${JSON.stringify(r.url)}, ${JSON.stringify(init, null, 2)});\nconsole.log(res.status, await res.text());`;
}

export function asPython(r: Replayable): string {
  const lines = ['import requests', '', `res = requests.request(`, `    ${JSON.stringify(r.method)},`, `    ${JSON.stringify(r.url)},`, `    headers=${JSON.stringify(r.headers, null, 4).replace(/\n/g, '\n    ')},`];
  if (r.body !== undefined) lines.push(`    data=${JSON.stringify(r.body)},`);
  lines.push(')', 'print(res.status_code, res.text)');
  return lines.join('\n');
}

export function asHttpie(r: Replayable): string {
  const parts = [`http${r.body !== undefined ? ` --raw ${sh(r.body)}` : ''} ${r.method} ${sh(r.url)}`];
  for (const [k, v] of Object.entries(r.headers)) parts.push(`  ${sh(`${k}:${v}`)}`);
  return parts.join(' \\\n');
}

export const SNIPPETS = [
  { id: 'curl', label: 'cURL', make: asCurl },
  { id: 'fetch', label: 'fetch (JavaScript)', make: asFetch },
  { id: 'python', label: 'Python requests', make: asPython },
  { id: 'httpie', label: 'HTTPie', make: asHttpie },
] as const;
