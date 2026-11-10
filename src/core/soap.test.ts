// SOAP end to end against the sample service (examples/): import its WSDL,
// call it with WS-Security, get JSON back, see Faults as errors — and
// record it, so one address splits into its operations.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseXml, xmlToJson } from '../shared/xml';
import { buildEnvelope, soapRequest } from '../shared/soap';
import { importText } from './import';
import { callTool } from './flow';
import { startRecorder, callsToHar, type RecordedCall } from './recorder';
import { importHar } from './import/har';
import { requestGraph, toolForCall } from '../shared/graph';
import type { Project } from '../shared/project';

const examples = path.resolve(__dirname, '../../examples');
let server: http.Server;
let base = '';
const secrets: Record<string, string> = { ACME_USER: 'acme', ACME_PASSWORD: 's3cret-pass' };
const vars = (k: string) => secrets[k];

beforeAll(async () => {
  const mod = await import(path.join(examples, 'acme-inventory-soap-server.mjs') as string);
  server = mod.createInventoryServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function fromWsdl(): Project {
  const p = importText(fs.readFileSync(path.join(examples, 'acme-inventory.wsdl'), 'utf8'), 'acme-inventory.wsdl');
  p.envs[0] = { ...p.envs[0], baseUrl: base, auth: { type: 'wsse', userVar: 'ACME_USER', passVar: 'ACME_PASSWORD' } };
  return p;
}
const tool = (p: Project, name: string) => p.tools.find((t) => t.name === name)!;

describe('xml', () => {
  it('reads namespaces, entities, CDATA and repeats', () => {
    const root = parseXml('<?xml version="1.0"?><a:r xmlns:a="urn:x"><a:i n="1">x &amp; y</a:i><a:i>2</a:i><c><![CDATA[<raw>]]></c></a:r>');
    expect([root.local, root.ns]).toEqual(['r', 'urn:x']);
    expect(xmlToJson(root)).toEqual({ i: [{ '@n': '1', '#text': 'x & y' }, '2'], c: '<raw>' });
    expect(() => parseXml('<a><b></a>')).toThrow(/doesn't close/);
  });

  it('builds an envelope that reads back as the same operation and arguments', () => {
    const e = buildEnvelope({ operation: 'GetItem', action: 'urn:acme:inventory/GetItem', namespace: 'urn:acme:inventory', version: '1.1', qualified: true }, { Sku: 'A&B' }, { user: 'u', password: 'p' });
    expect(e.headers).toMatchObject({ 'content-type': 'text/xml; charset=utf-8', soapaction: '"urn:acme:inventory/GetItem"' });
    const back = soapRequest(e.headers, e.body)!;
    expect([back.operation, back.action, back.namespace, back.args]).toEqual(['GetItem', 'urn:acme:inventory/GetItem', 'urn:acme:inventory', { Sku: 'A&B' }]);
  });
});

describe('a WSDL', () => {
  it('becomes one request per operation, typed from the schema', () => {
    const p = importText(fs.readFileSync(path.join(examples, 'acme-inventory.wsdl'), 'utf8'), 'acme-inventory.wsdl');
    expect(p.title).toBe('Acme Inventory');
    expect(p.envs[0].baseUrl).toBe('http://localhost:8089');
    expect(p.tools.map((t) => [t.name, t.safety, t.id])).toEqual([
      ['list_items', 'read', 'POST /soap/inventory#ListItems'],
      ['get_item', 'read', 'POST /soap/inventory#GetItem'],
      ['adjust_stock', 'write', 'POST /soap/inventory#AdjustStock'],
      ['delete_item', 'destructive', 'POST /soap/inventory#DeleteItem'],
    ]);
    const adjust = tool(p, 'adjust_stock');
    expect(adjust.params.map((x) => [x.name, x.required, x.schema.type])).toEqual([
      ['Sku', true, 'string'],
      ['Delta', true, 'integer'],
      ['Reason', false, 'string'],
    ]);
    expect(tool(p, 'list_items').params[0].description).toMatch(/tools, parts or supplies/);
    expect(adjust.soap).toEqual({ operation: 'AdjustStock', action: 'urn:acme:inventory/AdjustStock', namespace: 'urn:acme:inventory', version: '1.1', qualified: true });
  });

  it('calls it with WS-Security and hands back JSON', async () => {
    const p = fromWsdl();
    const list = await callTool(p, tool(p, 'list_items'), p.envs[0], { Category: 'tools' }, { vars, runtime: {} });
    expect(list.result.ok).toBe(true);
    expect((list.result.json as any).ListItemsResponse.Item.map((i: any) => i.Sku)).toEqual(['HAM-16', 'DRL-20']);
    expect(list.result.body).toContain('"ListItemsResponse"');
    expect(JSON.stringify(list.result.request)).not.toContain('s3cret-pass');
    const one = await callTool(p, tool(p, 'get_item'), p.envs[0], { Sku: 'DRL-20' }, { vars, runtime: {} });
    expect((one.result.json as any).GetItemResponse.Item.Quantity).toBe('7');
  });

  it('turns a Fault into an error with its message', async () => {
    const p = fromWsdl();
    const missing = await callTool(p, tool(p, 'get_item'), p.envs[0], { Sku: 'NOPE-1' }, { vars, runtime: {} });
    expect([missing.result.ok, missing.result.statusText]).toEqual([false, 'SOAP Fault: No item with SKU NOPE-1.']);
    const signedOut = await callTool(p, tool(p, 'get_item'), p.envs[0], { Sku: 'DRL-20' }, { vars: () => undefined, runtime: {} });
    expect(signedOut.result.statusText).toMatch(/Not authenticated/);
  });
});

describe('recording a SOAP service', () => {
  it('splits one address into its operations, and links values between them', async () => {
    const calls: RecordedCall[] = [];
    const rec = await startRecorder({ target: base, port: 0, onCall: (c) => calls.push(c) });
    try {
      const p = fromWsdl();
      const env = { ...p.envs[0], baseUrl: `http://127.0.0.1:${rec.port}` };
      await callTool(p, tool(p, 'list_items'), env, {}, { vars, runtime: {} });
      await callTool(p, tool(p, 'get_item'), env, { Sku: 'BLT-M8' }, { vars, runtime: {} });
      await callTool(p, tool(p, 'get_item'), env, { Sku: 'HAM-16' }, { vars, runtime: {} });
      await callTool(p, tool(p, 'adjust_stock'), env, { Sku: 'HAM-16', Delta: -2 }, { vars, runtime: {} });
    } finally {
      await rec.stop();
    }
    const imported = importHar(callsToHar(calls, base), 'rec');
    expect(imported.tools.map((t) => t.id).sort()).toEqual(['POST /soap/inventory#AdjustStock', 'POST /soap/inventory#GetItem', 'POST /soap/inventory#ListItems']);
    expect(imported.envs[0].auth).toEqual({ type: 'wsse', userVar: expect.stringMatching(/_USER$/), passVar: expect.stringMatching(/_PASSWORD$/) });
    const adjust = imported.tools.find((t) => t.soap?.operation === 'AdjustStock')!;
    expect([adjust.safety, adjust.params.map((x) => x.name)]).toEqual(['write', ['Sku', 'Delta']]);
    expect(toolForCall(imported, calls[1], '')?.soap?.operation).toBe('GetItem');
    const links = requestGraph(calls).filter((e) => !e.auth);
    expect(links.some((e) => e.from === calls[0].id && e.to === calls[1].id && e.value === 'BLT-M8')).toBe(true);
    expect(JSON.stringify(imported)).not.toContain('s3cret-pass');
  });
});
