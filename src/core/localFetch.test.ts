import { describe, expect, it } from 'vitest';
import { isLocalHttps, localFetch } from './localFetch';

describe('local https', () => {
  it('only relaxes certificates for this machine', () => {
    expect(isLocalHttps('https://localhost:4200/api')).toBe(true);
    expect(isLocalHttps('https://127.0.0.1/x')).toBe(true);
    expect(isLocalHttps('http://localhost:4200/api')).toBe(false);
    expect(isLocalHttps('https://api.acme.example/x')).toBe(false);
    expect(isLocalHttps('https://localhost.acme.example/x')).toBe(false);
  });

  it('reaches a self-signed local https server', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const https = await import('node:https');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const srv = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body: b, cookie: req.headers.cookie }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      await expect(fetch(`https://localhost:${port}/`)).rejects.toThrow();
      const res = await localFetch(`https://localhost:${port}/x`, { method: 'POST', headers: { cookie: 'sid=1' }, body: '{"a":1}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ method: 'POST', body: '{"a":1}', cookie: 'sid=1' });
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
