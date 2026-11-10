// A project from a WSDL: one request per SOAP operation, its arguments
// from the XML schema, and the envelope details (SOAPAction, namespace,
// SOAP version) kept on the request so overapi can build the call.
//
// Document/literal (by far the most common) and rpc style; SOAP 1.1 and
// 1.2 bindings; schema types inline in the WSDL. Imported schemas
// (xsd:import from another URL) aren't fetched: their elements become
// loosely typed arguments.

import type { JsonSchema, ParamDef, Project, ToolDef } from '../../shared/project';
import { emptyProject } from '../../shared/project';
import { child, kids, parseXml, type XmlNode } from '../../shared/xml';
import { soapSafety } from '../../shared/soap';
import { distinctNames, snake } from '../../shared/naming';

const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';

export function isWsdl(text: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<([\w-]+:)?definitions[\s>/]/.test(text);
}

const local = (qname: string | undefined) => (qname ?? '').replace(/^[^:]*:/, '');

export function importWsdl(text: string, ref?: string): Project {
  const defs = parseXml(text);
  if (defs.local !== 'definitions') throw new Error('That XML is not a WSDL (no <definitions>).');
  const tns = defs.attrs.targetNamespace ?? '';

  // Schema: top-level elements and named complex types, by local name.
  const schemas = kids(child(defs, 'types'), 'schema');
  const elements = new Map<string, { node: XmlNode; ns: string; qualified: boolean }>();
  const types = new Map<string, XmlNode>();
  for (const s of schemas) {
    const ns = s.attrs.targetNamespace ?? tns;
    const qualified = s.attrs.elementFormDefault === 'qualified';
    for (const e of kids(s, 'element')) if (e.attrs.name) elements.set(e.attrs.name, { node: e, ns, qualified });
    for (const t of [...kids(s, 'complexType'), ...kids(s, 'simpleType')]) if (t.attrs.name) types.set(t.attrs.name, t);
  }

  const doc = (n: XmlNode | undefined) => (child(n, 'documentation') ?? child(child(n, 'annotation'), 'documentation'))?.text.trim().replace(/\s+/g, ' ');

  /// An XSD type as JSON Schema — scalars mapped, complex types expanded a
  /// few levels deep.
  const schemaOf = (node: XmlNode, depth = 0): JsonSchema => {
    const many = node.attrs.maxOccurs === 'unbounded' || Number(node.attrs.maxOccurs ?? 1) > 1;
    const base = scalarOrComplex(node, depth);
    const d = doc(node);
    const one = d ? { ...base, description: d } : base;
    return many ? { type: 'array', items: one } : one;
  };
  const scalarOrComplex = (node: XmlNode, depth: number): JsonSchema => {
    const inline = child(node, 'complexType');
    if (inline) return complex(inline, depth);
    const t = local(node.attrs.type);
    const named = types.get(t);
    if (named) return named.local === 'simpleType' ? simple(named) : complex(named, depth);
    return xsdScalar(t);
  };
  const complex = (ct: XmlNode, depth: number): JsonSchema => {
    if (depth > 4) return { type: 'object' };
    const seq = child(ct, 'sequence') ?? child(ct, 'all') ?? child(ct, 'choice') ?? child(child(child(ct, 'complexContent'), 'extension'), 'sequence');
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const e of kids(seq, 'element')) {
      const name = e.attrs.name ?? local(e.attrs.ref);
      if (!name) continue;
      properties[name] = schemaOf(e.attrs.ref ? elements.get(local(e.attrs.ref))?.node ?? e : e, depth + 1);
      if (e.attrs.minOccurs !== '0' && e.attrs.nillable !== 'true') required.push(name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  };
  const simple = (st: XmlNode): JsonSchema => {
    const r = child(st, 'restriction');
    const values = kids(r, 'enumeration').map((x) => x.attrs.value);
    return { ...xsdScalar(local(r?.attrs.base)), ...(values.length ? { enum: values } : {}) };
  };

  // Messages, port type, binding, address.
  const messages = new Map(kids(defs, 'message').map((m) => [m.attrs.name, kids(m, 'part')]));
  const portType = child(defs, 'portType');
  const binding = child(defs, 'binding');
  const version: '1.1' | '1.2' = binding?.children.some((c) => c.ns === SOAP12) ? '1.2' : '1.1';
  const style = binding?.children.find((c) => c.local === 'binding')?.attrs.style ?? 'document';
  const actions = new Map(kids(binding, 'operation').map((o) => [o.attrs.name, o.children.find((c) => c.local === 'operation')?.attrs.soapAction]));
  const address = kids(child(defs, 'service'), 'port').map((p) => child(p, 'address')?.attrs.location).find(Boolean);

  let baseUrl = '';
  let path = '/';
  if (address) {
    try {
      const u = new URL(address, ref && /^https?:/.test(ref) ? ref : undefined);
      baseUrl = u.origin;
      path = u.pathname || '/';
    } catch {
      /* no usable address: the person sets the base URL */
    }
  }

  const tools: ToolDef[] = [];
  for (const op of kids(portType, 'operation')) {
    const name = op.attrs.name;
    if (!name) continue;
    const parts = messages.get(local(child(op, 'input')?.attrs.message)) ?? [];
    let params: ParamDef[] = [];
    let namespace = tns;
    let qualified = true;
    let operation = name;
    if (style === 'rpc') {
      // rpc: the operation is the wrapper element; parts are its children.
      params = parts.map((p) => ({ name: p.attrs.name, in: 'body' as const, required: true, schema: p.attrs.type ? xsdScalar(local(p.attrs.type)) : { type: 'object' } }));
      qualified = false;
    } else {
      // document/literal: the one part names the element that is the Body's child.
      const el = elements.get(local(parts[0]?.attrs.element));
      if (el) {
        operation = el.node.attrs.name;
        namespace = el.ns;
        qualified = el.qualified;
        const shape = scalarOrComplex(el.node, 0);
        const props = (shape.properties ?? {}) as Record<string, JsonSchema>;
        params = Object.entries(props).map(([k, s]) => ({ name: k, in: 'body' as const, required: (shape.required ?? []).includes(k), description: s.description, schema: s }));
      }
    }
    tools.push({
      id: `POST ${path}#${operation}`,
      name: snake(name),
      description: doc(op) ?? `The ${name} operation.`,
      enabled: true,
      safety: soapSafety(name),
      method: 'POST',
      path,
      params,
      bodyMode: 'soap',
      soap: { operation, action: actions.get(name) || undefined, namespace, version, qualified },
      origin: { operationId: name, summary: doc(op) },
    });
  }
  if (!tools.length) throw new Error('The WSDL has no operations overapi could read.');

  const title = defs.attrs.name ?? child(defs, 'service')?.attrs.name ?? 'SOAP service';
  const project = emptyProject(title.replace(/([a-z])([A-Z])/g, '$1 $2'));
  project.description = doc(defs) ?? `Imported from a WSDL: ${tools.length} SOAP operation${tools.length === 1 ? '' : 's'}.`;
  project.source = { kind: 'wsdl', ref, importedAt: new Date().toISOString() };
  project.envs = [{ name: 'default', baseUrl, auth: { type: 'none' }, allowWrites: false }];
  const names = distinctNames(tools.map((t) => ({ name: t.name, path: t.path })));
  project.tools = tools.map((t, i) => ({ ...t, name: names[i] }));
  return project;
}

function xsdScalar(t: string): JsonSchema {
  if (/^(int|integer|long|short|byte|unsigned\w*|positiveInteger|nonNegativeInteger|negativeInteger|nonPositiveInteger)$/.test(t)) return { type: 'integer' };
  if (/^(decimal|float|double)$/.test(t)) return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'dateTime') return { type: 'string', format: 'date-time' };
  if (t === 'date') return { type: 'string', format: 'date' };
  return { type: 'string' };
}
