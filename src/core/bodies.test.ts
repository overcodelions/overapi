import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRequest, send } from './http';
import { toMcpTool } from './server';
import { asCurl, asFetch, asHttpie, asPython } from '../shared/snippets';
import type { EnvDef, ToolDef } from '../shared/project';

const env: EnvDef = { name: 'local', baseUrl: 'http://localhost:4010', auth: { type: 'none' }, allowWrites: true };
const none = () => undefined;

const upload: ToolDef = {
  id: 'POST /files',
  name: 'upload_file',
  description: '',
  enabled: true,
  safety: 'write',
  method: 'POST',
  path: '/files',
  bodyMode: 'multipart',
  params: [
    { name: 'file', in: 'body', required: true, schema: { type: 'string', format: 'binary' } },
    { name: 'note', in: 'body', required: false, schema: { type: 'string' } },
  ],
};

/// A fetch that keeps what it was sent.
function capture(answer = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) {
  const got: { headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    got.push({ headers: init!.headers as Record<string, string>, body: Buffer.from(init!.body as Uint8Array).toString('utf8') });
    return answer();
  }) as typeof fetch;
  return { got, fetchImpl };
}

describe('multipart', () => {
  it('sends fields and a file given as content, and shows the file by name', async () => {
    const r = buildRequest(upload, env, { file: { base64: Buffer.from('hello acme').toString('base64'), filename: 'note.txt', contentType: 'text/plain' }, note: 'first' }, none);
    expect(r.body).toBeUndefined();
    const { got, fetchImpl } = capture();
    const res = await send(r, { fetchImpl });
    expect(got[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(got[0].body).toContain('filename="note.txt"');
    expect(got[0].body).toContain('Content-Type: text/plain');
    expect(got[0].body).toContain('hello acme');
    expect(got[0].body).toContain('name="note"');
    expect(res.request.parts).toEqual([
      { name: 'file', file: 'note.txt' },
      { name: 'note', value: 'first' },
    ]);
    expect(res.request.body).toBe('file=@note.txt\nnote=first');
  });

  it('reads a file from a path only for the person, never for an agent', async () => {
    expect(() => buildRequest(upload, env, { file: '@/etc/hosts' }, none)).toThrow("overapi doesn't read files from this machine for agents");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-upload-'));
    const file = path.join(dir, 'invoice.csv');
    fs.writeFileSync(file, 'id,total\n1,42\n');
    const { got, fetchImpl } = capture();
    await send(buildRequest(upload, env, { file: `@${file}` }, none, undefined, { files: true }), { fetchImpl });
    expect(got[0].body).toContain('filename="invoice.csv"');
    expect(got[0].body).toContain('1,42');
    await expect(send(buildRequest(upload, env, { file: `@${dir}/gone.csv` }, none, undefined, { files: true }), { fetchImpl })).rejects.toThrow(/^Could not read .*gone\.csv: ENOENT/);
  });

  it('offers agents a file as its content, not a path', () => {
    const schema = toMcpTool(upload).inputSchema as { properties: Record<string, { type: string; required?: string[] }>; required: string[] };
    expect(schema.properties.file.type).toBe('object');
    expect(schema.properties.file.required).toEqual(['base64']);
    expect(schema.required).toEqual(['file']);
  });

  it('copies as curl -F, Python files= and HTTPie --multipart', () => {
    const r = {
      method: 'POST',
      url: 'http://localhost:4010/files',
      headers: {},
      parts: [
        { name: 'file', file: 'note.txt' },
        { name: 'note', value: 'first' },
      ],
    };
    expect(asCurl(r)).toContain(`-F 'file=@note.txt'`);
    expect(asCurl(r)).toContain(`-F 'note=first'`);
    expect(asPython(r)).toContain('files={"file": open("note.txt", "rb")}');
    expect(asHttpie(r)).toMatch(/^http --multipart POST/);
    const js = asFetch(r);
    expect(js).toContain('const form = new FormData();');
    expect(js).toContain('form.append("file", new Blob([/* the file\'s bytes */]), "note.txt");');
    expect(js).toContain('form.append("note", "first");');
    expect(js).toContain('body: form');
  });
});

describe('GraphQL', () => {
  const order: ToolDef = {
    id: 'POST /graphql#query.order',
    name: 'order',
    description: '',
    enabled: true,
    safety: 'read',
    method: 'POST',
    path: '/graphql',
    bodyMode: 'graphql',
    graphql: { query: 'query Order($id: ID!) { order(id: $id) { id } }', operationName: 'Order' },
    params: [{ name: 'id', in: 'body', required: true, schema: { type: 'string' } }],
  };

  it('sends the query with its body params as variables', () => {
    const r = buildRequest(order, env, { id: 'ord_1' }, none);
    expect(JSON.parse(r.body!)).toEqual({ query: order.graphql!.query, operationName: 'Order', variables: { id: 'ord_1' } });
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('counts errors with no data as a failure, whatever the status', async () => {
    const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const failed = await send(buildRequest(order, env, { id: 'x' }, none), { fetchImpl: capture(json({ data: null, errors: [{ message: 'Order not found' }] })).fetchImpl });
    expect([failed.ok, failed.statusText]).toEqual([false, 'GraphQL error: Order not found']);
    const partial = await send(buildRequest(order, env, { id: 'x' }, none), { fetchImpl: capture(json({ data: { order: null }, errors: [{ message: 'Partial' }] })).fetchImpl });
    expect(partial.ok).toBe(true);
  });
});

describe('client certificates', () => {
  const get: ToolDef = { id: 'GET /ping', name: 'ping', description: '', enabled: true, safety: 'read', method: 'GET', path: '/ping', params: [], bodyMode: 'none' };
  const tlsEnv: EnvDef = {
    ...env,
    baseUrl: 'https://api.acme.test',
    tls: { certFile: '${CERT_DIR}/client.pem', keyFile: '~/acme/client.key', caFile: '{{ca}}', passphraseVar: 'CERT_PASS' },
    vars: { ca: '/etc/acme/ca.pem' },
  };
  const tlsVars = (n: string) => ({ CERT_DIR: '/etc/acme', CERT_PASS: 'open-sesame' })[n];

  it('resolves the files from ${VARS}, {{vars}} and ~, and scrubs the passphrase', () => {
    const r = buildRequest(get, tlsEnv, {}, tlsVars);
    expect(r.tls).toEqual({ cert: '/etc/acme/client.pem', key: path.join(os.homedir(), 'acme/client.key'), pfx: undefined, ca: '/etc/acme/ca.pem', passphrase: 'open-sesame' });
    expect(r.secrets).toContain('open-sesame');
    expect(buildRequest(get, { ...tlsEnv, baseUrl: 'http://api.acme.test' }, {}, tlsVars).tls).toBeUndefined();
  });

  it('says which file it could not read', async () => {
    const r = buildRequest(get, { ...tlsEnv, tls: { certFile: '/nonexistent/acme.pem' } }, {}, tlsVars);
    await expect(send(r)).rejects.toThrow("Could not read the client certificate at /nonexistent/acme.pem: ENOENT. Check the environment's client certificate.");
  });
});
