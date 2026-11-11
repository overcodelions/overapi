// The network half of a recording browser: Chromium's debugging protocol
// (the Network domain) turned into RecordedCalls. Shared by overapi's own
// window (Electron's debugger) and the person's Chrome (a DevTools socket):
// each hands in a way to send commands and feeds events in.
//
// Only the page's own data calls (fetch and XHR) are kept — not pages,
// scripts, images or analytics (isNoise).

import { randomUUID } from 'node:crypto';
import type { RecordedCall } from '../shared/recording';
import { isNoise } from '../shared/recording';

const KEEP_REQUEST = 64 * 1024;
const KEEP_RESPONSE = 256 * 1024;

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

interface Pending {
  call: RecordedCall;
  started: number;
  hasPostData: boolean;
  extra?: Record<string, string>;
}

/// What a call the read-only guard stopped says (shared/readOnlyGuard.ts).
export const NOT_SENT = 'Not sent — overapi was exploring, and only reads leave the browser then.';

export const ENABLE_NETWORK = ['Network.enable', { maxPostDataSize: KEEP_REQUEST }] as const;

export interface Tap {
  handle(method: string, params: any): void;
  stop(): void;
}

export function createTap(send: Send, onCall: (c: RecordedCall) => void): Tap {
  const pending = new Map<string, Pending>();
  let stopped = false;

  const clean = (h: Record<string, unknown> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h ?? {})) if (!k.startsWith(':')) out[k.toLowerCase()] = String(v);
    return out;
  };

  const finish = async (id: string, end: number, error?: string) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const call = p.call;
    if (p.extra) call.requestHeaders = { ...call.requestHeaders, ...p.extra };
    if (p.hasPostData && call.requestBody === undefined) {
      try {
        call.requestBody = (await send<{ postData: string }>('Network.getRequestPostData', { requestId: id })).postData.slice(0, KEEP_REQUEST);
      } catch {
        /* gone already */
      }
    }
    if (error) {
      call.error = error;
    } else {
      try {
        const b = await send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: id });
        const text = b.base64Encoded ? (/json|text|xml/i.test(call.contentType) ? Buffer.from(b.body, 'base64').toString('utf8') : '') : b.body;
        call.bytes ||= Buffer.byteLength(text);
        call.responseBody = text ? text.slice(0, KEEP_RESPONSE) : undefined;
      } catch {
        /* no body (204, redirect) */
      }
    }
    call.ms = Math.max(0, Math.round((end - p.started) * 1000));
    if (!stopped) onCall(call);
  };

  return {
    stop: () => {
      stopped = true;
      pending.clear();
    },
    handle(method, params) {
      if (stopped) return;
      switch (method) {
        case 'Network.requestWillBeSent': {
          if (params.type !== 'XHR' && params.type !== 'Fetch') return;
          const r = params.request;
          if (isNoise(r.url) || !/^(GET|POST|PUT|PATCH|DELETE)$/i.test(r.method)) return;
          const u = new URL(r.url);
          const before = pending.get(params.requestId);
          pending.set(params.requestId, {
            started: params.timestamp,
            hasPostData: !!r.hasPostData,
            extra: before?.extra,
            call: {
              id: randomUUID(),
              at: new Date((params.wallTime ?? Date.now() / 1000) * 1000).toISOString(),
              method: String(r.method).toUpperCase(),
              path: u.pathname + u.search,
              url: r.url,
              status: 0,
              statusText: '',
              ms: 0,
              requestHeaders: clean(r.headers),
              requestBody: typeof r.postData === 'string' ? r.postData.slice(0, KEEP_REQUEST) : undefined,
              responseHeaders: {},
              contentType: '',
              bytes: 0,
            },
          });
          return;
        }
        case 'Network.requestWillBeSentExtraInfo': {
          // The headers as really sent — cookies included. May come first.
          const p = pending.get(params.requestId);
          if (p) p.extra = clean(params.headers);
          return;
        }
        case 'Network.responseReceived': {
          const p = pending.get(params.requestId);
          if (!p) return;
          const r = params.response;
          Object.assign(p.call, { status: r.status, statusText: r.statusText ?? '', responseHeaders: clean(r.headers), contentType: r.mimeType ?? clean(r.headers)['content-type'] ?? '' });
          return;
        }
        case 'Network.loadingFinished': {
          const p = pending.get(params.requestId);
          if (p) p.call.bytes = Number(params.encodedDataLength ?? 0);
          void finish(params.requestId, params.timestamp);
          return;
        }
        case 'Network.loadingFailed': {
          if (params.canceled) {
            pending.delete(params.requestId);
            return;
          }
          void finish(params.requestId, params.timestamp, /BLOCKED_BY_CLIENT/.test(String(params.errorText)) ? NOT_SENT : `The browser could not complete it: ${params.errorText}`);
          return;
        }
      }
    },
  };
}
