// The recorder: a local address that forwards every call to the real API
// and keeps a copy of each exchange — for the API nobody documented. Point
// an app, a script, curl or a test suite at http://localhost:<port>
// instead of the API, use it normally, and every call it makes becomes a
// tool candidate (built through the same importer as a HAR capture, which
// templates ids, infers arguments and keeps no credential).
//
// A reverse proxy, not a browser proxy: HTTPS from a browser can't be read
// in flight without installing a certificate. For a web app, overapi opens
// its own browser window instead (main/browserRecorder.ts) — same calls,
// same RecordedCall, no certificate.
//
// Electron-free; the app wires it to IPC, a test drives it directly.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { localFetch } from './localFetch';

import type { RecordedCall } from '../shared/recording';
export type { RecordedCall };

/// Bodies kept per call: enough to infer shapes, small enough that an
/// afternoon of recording stays in memory comfortably.
const KEEP_REQUEST = 64 * 1024;
const KEEP_RESPONSE = 256 * 1024;
/// Headers that belong to one hop, never forwarded either way.
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'accept-encoding']);

export interface Recorder {
  port: number;
  target: string;
  stop(): Promise<void>;
}

export async function startRecorder(opts: { target: string; port?: number; onCall: (c: RecordedCall) => void; fetchImpl?: typeof fetch }): Promise<Recorder> {
  let target: URL;
  try {
    target = new URL(opts.target);
  } catch {
    throw new Error(`"${opts.target}" is not a URL. Give the API's real address, like https://api.acme.example/v1.`);
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('The API address must start with http:// or https://.');
  const base = target.toString().replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? localFetch;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const requestHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) requestHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    const call: RecordedCall = {
      id: randomUUID(),
      at: new Date().toISOString(),
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      status: 0,
      statusText: '',
      ms: 0,
      requestHeaders,
      requestBody: body.length ? body.subarray(0, KEEP_REQUEST).toString('utf8') : undefined,
      responseHeaders: {},
      contentType: '',
      bytes: 0,
    };
    try {
      const upstream = await doFetch(base + (req.url ?? '/'), {
        method: call.method,
        headers: requestHeaders,
        body: body.length && call.method !== 'GET' && call.method !== 'HEAD' ? body : undefined,
        redirect: 'manual',
      });
      const out = Buffer.from(await upstream.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!HOP.has(k) && k !== 'content-encoding') responseHeaders[k] = v;
      });
      res.writeHead(upstream.status, upstream.statusText, responseHeaders);
      res.end(out);
      Object.assign(call, {
        status: upstream.status,
        statusText: upstream.statusText,
        responseHeaders,
        contentType: upstream.headers.get('content-type') ?? '',
        bytes: out.length,
        responseBody: out.length ? out.subarray(0, KEEP_RESPONSE).toString('utf8') : undefined,
      });
    } catch (e) {
      const reason = (e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
      call.error = `Could not reach ${target.origin}: ${reason}`;
      call.status = 502;
      call.statusText = 'Bad Gateway';
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`overapi recorder: ${call.error}`);
    }
    call.ms = Date.now() - started;
    opts.onCall(call);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'EADDRINUSE' ? `Port ${opts.port} is in use. Pick another.` : e.message)),
    );
    // Loopback only: this forwards credentials, so nothing off this Mac
    // may reach it.
    server.listen(opts.port ?? 4545, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    target: base,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

/// Recorded calls as a HAR document, for the HAR importer: the real API's
/// URLs, the bodies as sent and received.
export function callsToHar(calls: RecordedCall[], target: string): { log: { entries: unknown[] } } {
  const base = target.replace(/\/+$/, '');
  return {
    log: {
      entries: calls
        .filter((c) => !c.error)
        .map((c) => ({
          request: {
            method: c.method,
            url: c.url ?? base + c.path,
            headers: Object.entries(c.requestHeaders).map(([name, value]) => ({ name, value })),
            postData: c.requestBody ? { mimeType: c.requestHeaders['content-type'] ?? '', text: c.requestBody } : undefined,
          },
          response: { status: c.status, content: { mimeType: c.contentType, text: c.responseBody ?? '' } },
        })),
    },
  };
}
