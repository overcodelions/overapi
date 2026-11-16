// Latency and errors across recorded calls, per endpoint. Calls to the same
// route with different ids (/orders/1042, /orders/1043) count as one
// endpoint, so the numbers describe the API, not individual requests.
//
// Pure: the recorder page computes it live as calls arrive.

import type { RecordedCall } from './recording';

export interface EndpointStats {
  key: string;
  method: string;
  route: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  /// Typical response size, bytes (median).
  bytes: number;
  /// The slowest call, to open.
  slowestId: string;
}

export interface Summary {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
}

/// Ids in a path become {id}: numbers, UUIDs, long hex, opaque mixed tokens.
export function routeOf(path: string): string {
  const pathname = path.split('?')[0];
  return (
    pathname
      .split('/')
      .map((s) =>
        /^\d+$/.test(s) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
        /^[0-9a-f]{16,}$/i.test(s) ||
        (/^[A-Za-z0-9_-]{8,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) ||
        // A short prefixed id: T-4821, INV-20931, PO_1042. Three digits at
        // least, so v2, s3 and oauth2 stay words.
        /^[A-Za-z]{1,5}[-_]?\d{3,}$/.test(s)
          ? '{id}'
          : s,
      )
      .join('/') || '/'
  );
}

/// Nearest-rank percentile of an ascending list.
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const failed = (c: RecordedCall) => !!c.error || c.status >= 400;

export function summarize(calls: RecordedCall[]): Summary {
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  return { count: calls.length, errors: calls.filter(failed).length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms[ms.length - 1] ?? 0 };
}

/// Per endpoint, slowest (by p95) first.
export function endpointStats(calls: RecordedCall[]): EndpointStats[] {
  const groups = new Map<string, RecordedCall[]>();
  for (const c of calls) {
    const key = `${c.method.toUpperCase()} ${routeOf(c.path)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const ms = list.map((c) => c.ms).sort((a, b) => a - b);
      const sizes = list.map((c) => c.bytes).sort((a, b) => a - b);
      const slowest = list.reduce((a, b) => (b.ms > a.ms ? b : a));
      const [method, ...rest] = key.split(' ');
      return {
        key,
        method,
        route: rest.join(' '),
        count: list.length,
        errors: list.filter(failed).length,
        p50: percentile(ms, 50),
        p95: percentile(ms, 95),
        max: ms[ms.length - 1],
        bytes: percentile(sizes, 50),
        slowestId: slowest.id,
      };
    })
    .sort((a, b) => b.p95 - a.p95 || b.count - a.count);
}
