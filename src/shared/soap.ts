// SOAP: XML envelopes POSTed to one address, the operation named by a
// SOAPAction header and the Body's first element. overapi treats each
// operation as its own request (and tool), builds the envelope from the
// arguments, and hands agents JSON — the response body converted, a Fault
// turned into an error with its message.

import { child, escapeXml, parseXml, xmlToJson, type XmlNode } from './xml';

export interface SoapInfo {
  /// The operation, as the Body's element is named: GetItem.
  operation: string;
  /// The SOAPAction (1.1 header; 1.2 content-type parameter).
  action?: string;
  /// The namespace the operation element (and, if qualified, its children) is in.
  namespace: string;
  version: '1.1' | '1.2';
  /// Child elements carry the namespace too (elementFormDefault="qualified").
  qualified?: boolean;
}

const ENV_NS = { '1.1': 'http://schemas.xmlsoap.org/soap/envelope/', '1.2': 'http://www.w3.org/2003/05/soap-envelope' };
const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PASSWORD_TEXT = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

/// Arguments as child elements: objects nest, arrays repeat the element,
/// absent values are left out.
function elements(value: Record<string, unknown>, prefix: string): string {
  let out = '';
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === '') continue;
    const tag = `${prefix}${k}`;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item === undefined || item === null) continue;
      out += typeof item === 'object' ? `<${tag}>${elements(item as Record<string, unknown>, prefix)}</${tag}>` : `<${tag}>${escapeXml(String(item))}</${tag}>`;
    }
  }
  return out;
}

export function buildEnvelope(soap: SoapInfo, args: Record<string, unknown>, security?: { user: string; password: string }): { body: string; headers: Record<string, string> } {
  const header = security
    ? `<soap:Header><wsse:Security xmlns:wsse="${WSSE_NS}" soap:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${escapeXml(security.user)}</wsse:Username><wsse:Password Type="${PASSWORD_TEXT}">${escapeXml(security.password)}</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header>`
    : '';
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${ENV_NS[soap.version]}" xmlns:tns="${escapeXml(soap.namespace)}">${header}` +
    `<soap:Body><tns:${soap.operation}>${elements(args, soap.qualified === false ? '' : 'tns:')}</tns:${soap.operation}></soap:Body></soap:Envelope>`;
  const headers: Record<string, string> =
    soap.version === '1.2'
      ? { 'content-type': `application/soap+xml; charset=utf-8${soap.action ? `; action="${soap.action}"` : ''}` }
      : { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${soap.action ?? ''}"` };
  return { body, headers: { ...headers, accept: 'text/xml, application/soap+xml, */*;q=0.5' } };
}

export interface SoapReply {
  /// The Body's content as JSON: { GetItemResponse: { … } }.
  json: unknown;
  fault?: { code: string; message: string };
}

/// A SOAP envelope's Body as JSON; a Fault as an error. Undefined when the
/// text isn't a SOAP envelope.
export function readEnvelope(text: string): SoapReply | undefined {
  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch {
    return undefined;
  }
  if (root.local !== 'Envelope') return undefined;
  const body = child(root, 'Body');
  const first = body?.children[0];
  if (!first) return { json: {} };
  if (first.local === 'Fault') {
    // 1.1: faultcode/faultstring. 1.2: Code/Value, Reason/Text.
    const code = child(first, 'faultcode')?.text.trim() ?? child(child(first, 'Code'), 'Value')?.text.trim() ?? 'Fault';
    const message = child(first, 'faultstring')?.text.trim() ?? child(child(first, 'Reason'), 'Text')?.text.trim() ?? 'The service answered with a SOAP Fault.';
    return { json: { Fault: xmlToJson(first) }, fault: { code, message } };
  }
  return { json: { [first.local]: xmlToJson(first) } };
}

/// Any XML document as JSON, keyed by its root element.
export function readXml(text: string): unknown {
  try {
    const root = parseXml(text);
    return { [root.local]: xmlToJson(root) };
  } catch {
    return undefined;
  }
}

export const looksLikeXml = (text: string | undefined) => !!text && text.trimStart().startsWith('<');

/// A response or request body as JSON, whatever it was: JSON, a SOAP
/// envelope (its Body), or other XML.
export function bodyJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (t.startsWith('<')) return readEnvelope(t)?.json ?? readXml(t);
  return undefined;
}

/// Which SOAP operation a request is: its SOAPAction, else the Body's first
/// element. Undefined when it isn't SOAP.
export function soapRequest(headers: Record<string, string>, body: string | undefined): { operation: string; action?: string; namespace: string; version: '1.1' | '1.2'; args: Record<string, unknown>; qualified: boolean } | undefined {
  if (!looksLikeXml(body)) return undefined;
  let root: XmlNode;
  try {
    root = parseXml(body!);
  } catch {
    return undefined;
  }
  if (root.local !== 'Envelope') return undefined;
  const op = child(root, 'Body')?.children[0];
  if (!op) return undefined;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const ct = h['content-type'] ?? '';
  const version = /soap\+xml/i.test(ct) || root.ns === ENV_NS['1.2'] ? '1.2' : '1.1';
  const action = (h.soapaction ?? /action="?([^";]+)"?/i.exec(ct)?.[1] ?? '').replace(/^"|"$/g, '') || undefined;
  const args = xmlToJson(op);
  return {
    operation: op.local,
    action,
    namespace: op.ns,
    version,
    args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
    qualified: op.children.length === 0 || op.children.some((c) => c.ns === op.ns && c.ns !== ''),
  };
}

/// Read-only by its name — GetItem, ListOrders, FindCustomer — or not.
export function soapSafety(operation: string): 'read' | 'write' | 'destructive' {
  if (/^(get|list|find|search|query|read|fetch|lookup|check|validate|count|describe|retrieve|ping)/i.test(operation)) return 'read';
  if (/^(delete|remove|purge|cancel|void|terminate)/i.test(operation)) return 'destructive';
  return 'write';
}
