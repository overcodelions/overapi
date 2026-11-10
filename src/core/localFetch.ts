// fetch, except that a server on this machine may use a self-signed
// certificate — the norm for a dev server on https://localhost. Anywhere
// else, certificates are checked as usual: this never applies off-machine.

import https from 'node:https';

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

export function isLocalHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && LOCAL.test(u.hostname);
  } catch {
    return false;
  }
}

export const localFetch: typeof fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!isLocalHttps(url)) return fetch(input, init);
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req = https.request(url, { method: init?.method ?? 'GET', headers, rejectUnauthorized: false, signal: init?.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
        const status = res.statusCode ?? 0;
        const empty = status === 204 || status === 304 || (init?.method ?? 'GET').toUpperCase() === 'HEAD';
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: h }));
      });
    });
    req.on('error', reject);
    if (init?.body !== undefined && init?.body !== null) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer));
    req.end();
  });
};
