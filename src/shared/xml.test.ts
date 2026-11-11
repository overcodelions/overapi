import { describe, expect, it } from 'vitest';
import { child, escapeXml, kids, parseXml, xmlToJson } from './xml';

describe('parseXml', () => {
  it('reads elements, attributes, text and namespaces', () => {
    const root = parseXml(`<?xml version="1.0"?>
<!-- a comment -->
<s:Envelope xmlns:s="urn:env" xmlns="urn:default" id='e1'>
  <s:Body><Item code="A&amp;B">Anvil &lt;heavy&gt; &#65;&#x42;</Item><Empty/></s:Body>
</s:Envelope>`);
    expect(root).toMatchObject({ name: 's:Envelope', local: 'Envelope', ns: 'urn:env', attrs: { 'xmlns:s': 'urn:env', xmlns: 'urn:default', id: 'e1' } });
    const body = child(root, 'Body')!;
    expect(body.ns).toBe('urn:env');
    const item = child(body, 'Item')!;
    expect(item).toMatchObject({ local: 'Item', ns: 'urn:default', attrs: { code: 'A&B' }, text: 'Anvil <heavy> AB' });
    expect(child(body, 'Empty')).toMatchObject({ children: [], text: '' });
  });

  it('keeps CDATA as is, and skips a DOCTYPE without expanding it', () => {
    const root = parseXml(`<!DOCTYPE x [<!ENTITY e "boom">]><x><![CDATA[<b>&e;</b>]]></x>`);
    // The DOCTYPE's internal subset ends at its first ">", so its tail is stray text before the root.
    expect(root.local).toBe('x');
    expect(root.text).toBe('<b>&e;</b>');
  });

  it('leaves unknown entities and bad character references as written', () => {
    expect(parseXml('<x>&nope; &#xZZ; &AMP;</x>').text).toBe('&nope; &#xZZ; &');
  });

  it('finds no namespace for an unbound prefix', () => {
    expect(parseXml('<a:x/>').ns).toBe('');
  });

  it.each([
    ['<x><!-- open', /unclosed comment/],
    ['<x><![CDATA[ open', /unclosed CDATA/],
    ['<?xml version="1.0"', /unclosed declaration/],
    ['<!DOCTYPE x', /unclosed declaration/],
    ['<x></x', /unclosed end tag/],
    ['<x></y>', /doesn't close <x>/],
    ['</x>', /doesn't close <\?>/],
    ['<x>< y</x>', /stray "<"/],
    ['<x a=1></x>', /malformed attribute in <x>/],
    ['<x/><y/>', /more than one root/],
    ['<x><y></y>', /<x> is never closed/],
    ['just text', /no element/],
    ['', /no element/],
  ])('refuses %j', (text, msg) => {
    expect(() => parseXml(text)).toThrow(msg);
  });
});

describe('child and kids', () => {
  const root = parseXml('<r><a>1</a><b/><a>2</a></r>');
  it('find the first, or all, children by local name', () => {
    expect(child(root, 'a')?.text).toBe('1');
    expect(kids(root, 'a').map((n) => n.text)).toEqual(['1', '2']);
    expect(child(root, 'z')).toBeUndefined();
    expect(kids(root, 'z')).toEqual([]);
  });
  it('take undefined', () => {
    expect(child(undefined, 'a')).toBeUndefined();
    expect(kids(undefined, 'a')).toEqual([]);
  });
});

describe('escapeXml', () => {
  it('escapes the five specials', () => expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;'));
});

describe('xmlToJson', () => {
  it('makes text-only elements their text, repeats arrays, attributes "@"', () => {
    const root = parseXml(`<o:Order xmlns:o="urn:o" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" o:id="7" status="open">
      <o:Line>a</o:Line><o:Line>b</o:Line><o:Line>c</o:Line>
      <o:Note xsi:nil="true"/>
      <o:Total> 12.50 </o:Total>
    </o:Order>`);
    expect(xmlToJson(root)).toEqual({ '@id': '7', '@status': 'open', Line: ['a', 'b', 'c'], Note: null, Total: '12.50' });
  });

  it('keeps an element’s text beside its attributes', () => {
    expect(xmlToJson(parseXml('<Price currency="EUR">9.99</Price>'))).toEqual({ '@currency': 'EUR', '#text': '9.99' });
  });

  it('is an empty string for an empty element', () => {
    expect(xmlToJson(parseXml('<x/>'))).toBe('');
  });
});
