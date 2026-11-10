// A small XML reader — enough for SOAP envelopes, WSDL and XSD: elements,
// attributes, text, CDATA, comments, entities and namespaces. No DTDs, no
// external entities (so nothing it reads can make it fetch or expand
// anything). Shared, so the app and the recorder read XML the same way.

export interface XmlNode {
  /// As written: `soap:Envelope`.
  name: string;
  /// Without the prefix: `Envelope`.
  local: string;
  /// The namespace URI the prefix resolves to ('' if none).
  ns: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/// Parses a document; throws with a position when it isn't well-formed.
export function parseXml(text: string): XmlNode {
  let i = 0;
  const len = text.length;
  const stack: { node: XmlNode; nsMap: Record<string, string> }[] = [];
  let root: XmlNode | undefined;
  const fail = (msg: string): never => {
    throw new Error(`Not valid XML at character ${i}: ${msg}`);
  };
  while (i < len) {
    const lt = text.indexOf('<', i);
    const chunk = lt === -1 ? text.slice(i) : text.slice(i, lt);
    if (chunk && stack.length) stack[stack.length - 1].node.text += decode(chunk);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) fail('an unclosed comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) fail('an unclosed CDATA section');
      if (stack.length) stack[stack.length - 1].node.text += text.slice(i + 9, end);
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) fail('an unclosed declaration');
      i = end + 2;
    } else if (text.startsWith('<!', i)) {
      // DOCTYPE and the like: skipped, never expanded.
      const end = text.indexOf('>', i + 2);
      if (end === -1) fail('an unclosed declaration');
      i = end + 1;
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end === -1) fail('an unclosed end tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.node.name !== name) fail(`</${name}> doesn't close <${open?.node.name ?? '?'}>`);
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 300));
      if (!m) fail('a stray "<"');
      const name = m![1];
      i += m![0].length;
      const attrs: Record<string, string> = {};
      for (;;) {
        while (i < len && /\s/.test(text[i])) i++;
        if (text[i] === '>' || text.startsWith('/>', i)) break;
        const a = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(text.slice(i, i + 20000));
        if (!a) fail(`a malformed attribute in <${name}>`);
        attrs[a![1]] = decode(a![3] ?? a![4] ?? '');
        i += a![0].length;
      }
      const selfClosing = text.startsWith('/>', i);
      i += selfClosing ? 2 : 1;
      const parentMap = stack[stack.length - 1]?.nsMap ?? {};
      const nsMap = { ...parentMap };
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'xmlns') nsMap[''] = v;
        else if (k.startsWith('xmlns:')) nsMap[k.slice(6)] = v;
      }
      const colon = name.indexOf(':');
      const prefix = colon === -1 ? '' : name.slice(0, colon);
      const node: XmlNode = { name, local: colon === -1 ? name : name.slice(colon + 1), ns: nsMap[prefix] ?? '', attrs, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else if (!root) root = node;
      else fail('more than one root element');
      if (!selfClosing) stack.push({ node, nsMap });
    }
  }
  if (stack.length) throw new Error(`Not valid XML: <${stack[stack.length - 1].node.name}> is never closed.`);
  if (!root) throw new Error('Not valid XML: there is no element in it.');
  return root;
}

export const child = (n: XmlNode | undefined, local: string) => n?.children.find((c) => c.local === local);
export const kids = (n: XmlNode | undefined, local: string) => n?.children.filter((c) => c.local === local) ?? [];

/// An element as plain JSON: text-only elements become their text, repeated
/// children become arrays, attributes become "@name" (namespace
/// declarations dropped), and prefixes are left off.
export function xmlToJson(n: XmlNode): unknown {
  const attrs = Object.entries(n.attrs).filter(([k]) => k !== 'xmlns' && !k.startsWith('xmlns:') && !/^xsi:/.test(k));
  if (!n.children.length && !attrs.length) return n.attrs['xsi:nil'] === 'true' ? null : n.text.trim();
  const out: Record<string, unknown> = {};
  for (const [k, v] of attrs) out[`@${k.includes(':') ? k.slice(k.indexOf(':') + 1) : k}`] = v;
  for (const c of n.children) {
    const v = xmlToJson(c);
    if (c.local in out) {
      const prev = out[c.local];
      out[c.local] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else out[c.local] = v;
  }
  const text = n.text.trim();
  if (text && n.children.length === 0) out['#text'] = text;
  return out;
}
