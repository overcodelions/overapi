import { describe, expect, it } from 'vitest';
import { endpointStats, percentile, routeOf, summarize } from './metrics';
import type { RecordedCall } from './recording';

const call = (method: string, path: string, ms: number, status = 200, bytes = 100): RecordedCall => ({
  id: `${method}${path}${ms}`,
  at: '',
  method,
  path,
  status,
  statusText: '',
  ms,
  requestHeaders: {},
  responseHeaders: {},
  contentType: 'application/json',
  bytes,
});

describe('metrics', () => {
  it('folds ids into routes', () => {
    expect(routeOf('/orders/1042?x=1')).toBe('/orders/{id}');
    expect(routeOf('/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301/cart')).toBe('/users/{id}/cart');
    expect(routeOf('/orders/search')).toBe('/orders/search');
    expect(routeOf('/tickets/T-4821/comments')).toBe('/tickets/{id}/comments');
    expect(routeOf('/invoices/INV20931')).toBe('/invoices/{id}');
    expect(routeOf('/api/v2/oauth2/s3')).toBe('/api/v2/oauth2/s3');
  });

  it('takes nearest-rank percentiles', () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });

  it('groups per endpoint, slowest first, counting errors', () => {
    const calls = [
      call('GET', '/orders', 40),
      call('GET', '/orders', 60),
      call('GET', '/orders/1', 300, 200, 900),
      call('GET', '/orders/2', 500, 500, 50),
      call('GET', '/orders/3', 320, 200, 1000),
    ];
    const stats = endpointStats(calls);
    expect(stats.map((s) => [s.key, s.count, s.p50, s.p95, s.errors])).toEqual([
      ['GET /orders/{id}', 3, 320, 500, 1],
      ['GET /orders', 2, 40, 60, 0],
    ]);
    expect(stats[0].slowestId).toBe('GET/orders/2500');
    expect(stats[0].bytes).toBe(900);
    expect(summarize(calls)).toEqual({ count: 5, errors: 1, p50: 300, p95: 500, max: 500 });
  });
});
