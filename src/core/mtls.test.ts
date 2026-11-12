// A real mutual-TLS handshake: a throwaway CA, a server that demands a
// client certificate, and overapi presenting one — or not.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls, { type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRequest, send } from './http';
import type { EnvDef, TlsDef, ToolDef } from '../shared/project';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('client certificates, for real', () => {
  let dir = '';
  let server: https.Server | undefined;
  let port = 0;
  /// macOS's own openssl (LibreSSL) writes .p12 bundles with a cipher Node's
  /// OpenSSL 3 won't load: those tests skip there rather than fail.
  let p12Loads = false;
  const file = (f: string) => path.join(dir, f);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-mtls-'));
    const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Acme Test CA');
    fs.writeFileSync(file('san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    for (const [name, cn] of [
      ['server', 'localhost'],
      ['client', 'acme-client'],
    ]) {
      run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', ...(name === 'server' ? ['-extfile', 'san.ext'] : []));
    }
    run('pkcs12', '-export', '-out', 'client.p12', '-inkey', 'client.key', '-in', 'client.pem', '-passout', 'pass:acme-pass');
    try {
      tls.createSecureContext({ pfx: fs.readFileSync(file('client.p12')), passphrase: 'acme-pass' });
      p12Loads = true;
    } catch {
      p12Loads = false;
    }
    server = https.createServer(
      { key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.pem')), ca: fs.readFileSync(file('ca.pem')), requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        const peer = (req.socket as TLSSocket).getPeerCertificate();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ client: peer.subject?.CN }));
      },
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(() => {
    server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const whoami: ToolDef = { id: 'GET /whoami', name: 'whoami', description: '', enabled: true, safety: 'read', method: 'GET', path: '/whoami', params: [], bodyMode: 'none' };
  const env = (tls?: TlsDef): EnvDef => ({ name: 'local', baseUrl: `https://127.0.0.1:${port}`, auth: { type: 'none' }, allowWrites: false, tls });

  it('presents a certificate and key, and the server knows who is calling', async () => {
    const r = await send(buildRequest(whoami, env({ certFile: file('client.pem'), keyFile: file('client.key') }), {}, () => undefined));
    expect([r.status, r.json]).toEqual([200, { client: 'acme-client' }]);
  });

  it('presents a .p12 bundle, unlocked by its passphrase from the keychain', async (ctx) => {
    if (!p12Loads) ctx.skip();
    const r = await send(buildRequest(whoami, env({ pfxFile: file('client.p12'), passphraseVar: 'ACME_CERT_PASS' }), {}, (n) => (n === 'ACME_CERT_PASS' ? 'acme-pass' : undefined)));
    expect([r.status, r.json]).toEqual([200, { client: 'acme-client' }]);
  });

  it('is turned away without one', async () => {
    await expect(send(buildRequest(whoami, env(), {}, () => undefined))).rejects.toThrow(/^Could not reach https:\/\/127\.0\.0\.1:\d+/);
  });

  it('says so when the passphrase is wrong', async (ctx) => {
    if (!p12Loads) ctx.skip();
    await expect(send(buildRequest(whoami, env({ pfxFile: file('client.p12'), passphraseVar: 'P' }), {}, () => 'wrong-pass'))).rejects.toThrow(/^Could not reach .*: /);
  });
});
