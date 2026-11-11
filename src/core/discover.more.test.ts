import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoveryPrompt, extractJson, htmlToText, projectFromReply, sourcePrompt, specUrlsFromReply, stageDocs } from './discover';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-disc-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const openapi = (paths: Record<string, unknown>) => JSON.stringify({ openapi: '3.0.0', info: { title: 'Acme Fleet', version: '1' }, servers: [{ url: 'https://fleet.acme.example' }], paths });

describe('sourcePrompt', () => {
  it('asks for routes from the code, with the general rules', () => {
    const p = sourcePrompt({});
    expect(p).toMatch(/The source code of the service is in the current folder\. Read it/);
    expect(p).toMatch(/@RestController/);
    expect(p).toMatch(/Never invent one/);
    expect(p).not.toMatch(/is running at/);
    expect(p).not.toMatch(/Notes from the person/);
  });

  it('adds the source, the running address and the notes', () => {
    const p = sourcePrompt({ source: 'acme-fleet-service', baseUrl: 'http://localhost:8080', notes: '  only v2  ' });
    expect(p).toContain('current folder (acme-fleet-service)');
    expect(p).toContain('The service is running at http://localhost:8080.');
    expect(p.endsWith('Notes from the person:\nonly v2')).toBe(true);
  });

  it('leaves out blank notes', () => {
    expect(sourcePrompt({ notes: '   ' })).not.toMatch(/Notes from/);
  });
});

describe('discoveryPrompt', () => {
  it('passes a base URL on', () => {
    expect(discoveryPrompt({ baseUrl: 'https://fleet.acme.example' })).toContain('The person says the API lives at https://fleet.acme.example.');
    expect(discoveryPrompt({ notes: ' ' })).not.toMatch(/Notes from/);
  });
});

describe('extractJson', () => {
  it('falls back from a block that does not parse to the next', () => {
    expect(extractJson('```json\n{"a": 1, "longer": [1,2,3]\n```\n```\n{"b": 2}\n```')).toEqual({ b: 2 });
  });

  it('throws plainly when nothing parses', () => {
    expect(() => extractJson('```json\n{nope}\n```')).toThrow(/did not answer with a JSON document/);
    expect(() => extractJson('no braces here')).toThrow(/did not answer with a JSON document/);
  });
});

describe('specUrlsFromReply', () => {
  it('de-duplicates and ignores case of the fence', () => {
    expect(specUrlsFromReply('```SPEC-URLS\nhttps://a.example/x.yaml http://a.example/y.json\nhttps://a.example/x.yaml\n```')).toEqual(['https://a.example/x.yaml', 'http://a.example/y.json']);
  });
});

describe('projectFromReply', () => {
  it('refuses a spec with no endpoints', () => {
    expect(() => projectFromReply('```json\n' + openapi({}) + '\n```', 'x')).toThrow(/did not describe any endpoints/);
  });

  it('keeps existing tags and adds the draft tag', () => {
    const p = projectFromReply(openapi({ '/trucks': { get: { operationId: 'listTrucks', tags: ['Trucks'], responses: {} } } }), 'fleet.md');
    expect(p.tools[0].origin?.tags).toEqual(['Trucks', 'drafted from docs']);
    expect(p.tools[0].origin?.summary).toBeDefined();
    expect(p.source?.kind).toBe('docs');
  });
});

describe('htmlToText', () => {
  it('drops chrome, keeps headings and decodes entities', () => {
    const html = '<header>top</header><h1>Fleet</h1><p>A&nbsp;&lt;b&gt; &quot;q&quot; &#39;s&#39;</p><footer>f</footer><style>p{}</style><br/>  \n\n\n\nend';
    expect(htmlToText(html)).toBe('# Fleet\nA <b> "q" \'s\'\n\nend');
  });
});

describe('stageDocs', () => {
  it('copies PDFs, reads text from paths, de-duplicates names and sanitises them', () => {
    const src = tmp();
    const pdf = path.join(src, 'manual.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4 fake');
    const md = path.join(src, 'guide.md');
    fs.writeFileSync(md, 'GET /trucks lists trucks.');
    const out = path.join(tmp(), 'staged');
    const s = stageDocs(out, [
      { name: 'manual.pdf', path: pdf },
      { name: 'guide.md', path: md },
      { name: 'guide.md', text: 'POST /trucks adds one.' },
      { name: 'my notes (v2).txt', text: 'Trucks have ids like T-123.' },
      { name: 'odd.bin', text: 'Some text given as text.' },
    ]);
    expect(s.dir).toBe(out);
    expect(s.pdfs).toEqual(['manual.pdf']);
    expect(s.inline.map((d) => d.name)).toEqual(['guide.md', '2-guide.md', 'my_notes__v2_.txt', 'odd.bin']);
    expect(s.inline[0].text).toBe('GET /trucks lists trucks.');
    expect(s.skipped).toEqual([]);
    expect(s.direct).toBeUndefined();
    expect(fs.readdirSync(out).sort()).toEqual(['2-guide.md', 'guide.md', 'manual.pdf', 'my_notes__v2_.txt', 'odd.bin']);
    expect(fs.readFileSync(path.join(out, 'manual.pdf'), 'utf8')).toBe('%PDF-1.4 fake');
  });

  it('skips a PDF given without a path, and converts HTML found in a .txt', () => {
    const s = stageDocs(path.join(tmp(), 'staged'), [
      { name: 'scan.pdf' },
      { name: 'page.txt', text: '<!DOCTYPE html><html><body><h2>Trucks</h2></body></html>' },
    ]);
    expect(s.skipped).toEqual(['scan.pdf']);
    expect(s.inline).toEqual([{ name: 'page.txt.md', text: '## Trucks' }]);
  });

  it('takes only the first spec as direct, and passes a second on as text', () => {
    const spec = openapi({ '/trucks': { get: { responses: {} } } });
    const s = stageDocs(path.join(tmp(), 'staged'), [
      { name: 'a.json', text: spec },
      { name: 'b.json', text: spec },
    ]);
    expect(s.direct?.tools).toHaveLength(1);
    expect(s.inline.map((d) => d.name)).toEqual(['b.json']);
  });

  it('names a file with nothing usable in its name', () => {
    const s = stageDocs(path.join(tmp(), 'staged'), [{ name: '', text: 'plain words' }]);
    expect(s.inline.map((d) => d.name)).toEqual(['doc']);
  });
});
