import { describe, expect, it } from 'vitest';
import { bodyJson, buildEnvelope, looksLikeXml, readEnvelope, readXml, soapRequest, soapSafety, type SoapInfo } from './soap';

const S11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const S12 = 'http://www.w3.org/2003/05/soap-envelope';

describe('buildEnvelope', () => {
  const info: SoapInfo = { operation: 'GetItem', action: 'urn:acme/GetItem', namespace: 'urn:acme', version: '1.1' };

  it('builds a 1.1 envelope with the SOAPAction header and qualified elements', () => {
    const r = buildEnvelope(info, { id: 7, tags: ['a', 'b'], owner: { name: 'Wile & Co' }, skip: undefined, none: null, blank: '', list: [null, 'x'] });
    expect(r.headers).toEqual({ 'content-type': 'text/xml; charset=utf-8', soapaction: '"urn:acme/GetItem"', accept: 'text/xml, application/soap+xml, */*;q=0.5' });
    expect(r.body).toContain(`<soap:Envelope xmlns:soap="${S11}" xmlns:tns="urn:acme">`);
    expect(r.body).toContain('<soap:Body><tns:GetItem><tns:id>7</tns:id><tns:tags>a</tns:tags><tns:tags>b</tns:tags><tns:owner><tns:name>Wile &amp; Co</tns:name></tns:owner><tns:list>x</tns:list></tns:GetItem></soap:Body>');
    expect(r.body).not.toContain('skip');
    expect(r.body).not.toContain('none');
    expect(r.body).not.toContain('blank');
    expect(r.body).not.toContain('Header');
  });

  it('sends an empty SOAPAction when there is none, and unqualified children when asked', () => {
    const r = buildEnvelope({ ...info, action: undefined, qualified: false }, { id: 1 });
    expect(r.headers.soapaction).toBe('""');
    expect(r.body).toContain('<tns:GetItem><id>1</id></tns:GetItem>');
  });

  it('puts the 1.2 action in the content type', () => {
    expect(buildEnvelope({ ...info, version: '1.2' }, {}).headers['content-type']).toBe('application/soap+xml; charset=utf-8; action="urn:acme/GetItem"');
    expect(buildEnvelope({ ...info, version: '1.2', action: undefined }, {}).headers['content-type']).toBe('application/soap+xml; charset=utf-8');
    expect(buildEnvelope({ ...info, version: '1.2' }, {}).body).toContain(`xmlns:soap="${S12}"`);
  });

  it('adds a WS-Security header, escaped', () => {
    const r = buildEnvelope(info, {}, { user: 'wile', password: 'p<w>"d' });
    expect(r.body).toContain('<soap:Header><wsse:Security');
    expect(r.body).toContain('<wsse:Username>wile</wsse:Username>');
    expect(r.body).toContain('>p&lt;w&gt;&quot;d</wsse:Password>');
  });

  it('round-trips through soapRequest', () => {
    const r = buildEnvelope(info, { id: '7', owner: { name: 'x' } });
    const s = soapRequest(r.headers, r.body);
    expect(s).toEqual({ operation: 'GetItem', action: 'urn:acme/GetItem', namespace: 'urn:acme', version: '1.1', args: { id: '7', owner: { name: 'x' } }, qualified: true });
  });
});

describe('readEnvelope', () => {
  it('gives the Body as JSON', () => {
    const r = readEnvelope(`<soap:Envelope xmlns:soap="${S11}"><soap:Body><GetItemResponse><Item><Id>7</Id></Item></GetItemResponse></soap:Body></soap:Envelope>`);
    expect(r).toEqual({ json: { GetItemResponse: { Item: { Id: '7' } } } });
  });

  it('is an empty object for an empty Body', () => {
    expect(readEnvelope(`<soap:Envelope xmlns:soap="${S11}"><soap:Body/></soap:Envelope>`)).toEqual({ json: {} });
    expect(readEnvelope(`<soap:Envelope xmlns:soap="${S11}"/>`)).toEqual({ json: {} });
  });

  it('reads a 1.1 Fault', () => {
    const r = readEnvelope(`<soap:Envelope xmlns:soap="${S11}"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring> No such item </faultstring></soap:Fault></soap:Body></soap:Envelope>`);
    expect(r?.fault).toEqual({ code: 'soap:Client', message: 'No such item' });
    expect(r?.json).toEqual({ Fault: { faultcode: 'soap:Client', faultstring: 'No such item' } });
  });

  it('reads a 1.2 Fault', () => {
    const r = readEnvelope(`<env:Envelope xmlns:env="${S12}"><env:Body><env:Fault><env:Code><env:Value>env:Sender</env:Value></env:Code><env:Reason><env:Text xml:lang="en">Bad id</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`);
    expect(r?.fault).toEqual({ code: 'env:Sender', message: 'Bad id' });
  });

  it('says something even for a bare Fault', () => {
    expect(readEnvelope(`<s:Envelope xmlns:s="${S11}"><s:Body><s:Fault/></s:Body></s:Envelope>`)?.fault).toEqual({ code: 'Fault', message: 'The service answered with a SOAP Fault.' });
  });

  it('is undefined for XML that is not an envelope, or not XML', () => {
    expect(readEnvelope('<Item/>')).toBeUndefined();
    expect(readEnvelope('not xml')).toBeUndefined();
  });
});

describe('readXml, looksLikeXml, bodyJson', () => {
  it('reads any XML keyed by its root', () => {
    expect(readXml('<Items><Item>a</Item></Items>')).toEqual({ Items: { Item: 'a' } });
    expect(readXml('<broken>')).toBeUndefined();
  });

  it('knows XML by its first character', () => {
    expect(looksLikeXml('  <x/>')).toBe(true);
    expect(looksLikeXml('{"a":1}')).toBe(false);
    expect(looksLikeXml(undefined)).toBe(false);
    expect(looksLikeXml('')).toBe(false);
  });

  it('reads JSON, SOAP, other XML, and gives up on the rest', () => {
    expect(bodyJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(bodyJson('[1,2]')).toEqual([1, 2]);
    expect(bodyJson('{broken')).toBeUndefined();
    expect(bodyJson(`<s:Envelope xmlns:s="${S11}"><s:Body><Ok>1</Ok></s:Body></s:Envelope>`)).toEqual({ Ok: '1' });
    expect(bodyJson('<Ok>1</Ok>')).toEqual({ Ok: '1' });
    expect(bodyJson('<broken')).toBeUndefined();
    expect(bodyJson('plain text')).toBeUndefined();
    expect(bodyJson(undefined)).toBeUndefined();
    expect(bodyJson('')).toBeUndefined();
  });
});

describe('soapRequest', () => {
  const env = (body: string, ns = S11) => `<soap:Envelope xmlns:soap="${ns}"><soap:Body>${body}</soap:Body></soap:Envelope>`;

  it('is undefined for anything that is not a SOAP request', () => {
    expect(soapRequest({}, undefined)).toBeUndefined();
    expect(soapRequest({}, '{"a":1}')).toBeUndefined();
    expect(soapRequest({}, '<broken')).toBeUndefined();
    expect(soapRequest({}, '<Item/>')).toBeUndefined();
    expect(soapRequest({}, env(''))).toBeUndefined();
  });

  it('reads the action from the SOAPAction header, any case, quotes off', () => {
    const s = soapRequest({ SOAPAction: '"urn:acme/ListOrders"' }, env('<a:ListOrders xmlns:a="urn:acme"><a:status>open</a:status></a:ListOrders>'));
    expect(s).toMatchObject({ operation: 'ListOrders', action: 'urn:acme/ListOrders', namespace: 'urn:acme', version: '1.1', args: { status: 'open' }, qualified: true });
  });

  it('reads 1.2 and its action from the content type', () => {
    const s = soapRequest({ 'Content-Type': 'application/soap+xml; charset=utf-8; action="urn:acme/Ping"' }, env('<Ping xmlns="urn:acme"/>'));
    expect(s).toMatchObject({ operation: 'Ping', action: 'urn:acme/Ping', version: '1.2', args: {}, qualified: true });
  });

  it('knows 1.2 by the envelope namespace too', () => {
    expect(soapRequest({}, env('<Ping/>', S12))?.version).toBe('1.2');
  });

  it('has no action when none is given, and unqualified children', () => {
    const s = soapRequest({ 'content-type': 'text/xml' }, env('<a:GetItem xmlns:a="urn:acme"><id>7</id></a:GetItem>'));
    expect(s?.action).toBeUndefined();
    expect(s?.qualified).toBe(false);
    expect(s?.args).toEqual({ id: '7' });
  });

  it('gives empty args for a text-only operation', () => {
    expect(soapRequest({}, env('<Ping>hello</Ping>'))?.args).toEqual({});
  });
});

describe('soapSafety', () => {
  it.each([
    ['GetItem', 'read'],
    ['listOrders', 'read'],
    ['FindCustomer', 'read'],
    ['ValidateAddress', 'read'],
    ['Ping', 'read'],
    ['DeleteItem', 'destructive'],
    ['CancelOrder', 'destructive'],
    ['VoidInvoice', 'destructive'],
    ['CreateOrder', 'write'],
    ['UpdateCustomer', 'write'],
  ] as const)('%s is %s', (op, safety) => expect(soapSafety(op)).toBe(safety));
});
