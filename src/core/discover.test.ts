import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoveryPrompt, extractJson, htmlToText, projectFromReply, specUrlsFromReply, stageDocs } from './discover';
import { readerArgs } from './ai';

const reply = `Here it is.

\`\`\`json
{
  "openapi": "3.0.3",
  "info": { "title": "Acme Ledger", "version": "1", "description": "Amounts are in cents." },
  "servers": [{ "url": "https://ledger.acme.example/v2", "description": "Production" }],
  "components": { "securitySchemes": { "k": { "type": "apiKey", "in": "header", "name": "X-Ledger-Key" } } },
  "security": [{ "k": [] }],
  "paths": {
    "/entries": { "get": { "operationId": "listEntries", "summary": "List ledger entries", "responses": { "200": { "description": "ok" } } } },
    "/entries/{id}/void": { "post": { "operationId": "voidEntry", "summary": "Void an entry", "x-overapi-safety": "destructive",
      "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": {} } }
  }
}
\`\`\``;

describe('discovery', () => {
  it('turns a model reply into a draft project through the OpenAPI importer', () => {
    const p = projectFromReply(reply, 'ledger.pdf');
    expect(p.source).toMatchObject({ kind: 'docs', ref: 'ledger.pdf' });
    expect(p.envs[0]).toMatchObject({ name: 'production', baseUrl: 'https://ledger.acme.example/v2', allowWrites: false });
    expect(p.envs[0].auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-Ledger-Key', valueVar: 'ACME_LEDGER_API_KEY' });
    expect(p.tools.map((t) => [t.name, t.safety])).toEqual([
      ['list_entries', 'read'],
      ['void_entry', 'destructive'],
    ]);
    expect(p.tools[0].origin?.tags).toContain('drafted from docs');
  });

  it('says plainly when the reply is not a spec', () => {
    expect(() => projectFromReply('I could not find any endpoints.', 'x')).toThrow(/JSON document/);
    expect(() => projectFromReply('```json\n{"hello": 1}\n```', 'x')).toThrow(/not with an OpenAPI/);
  });

  it('extracts the largest fenced block, or bare braces', () => {
    expect(extractJson('```json\n{"a":1}\n```\n```json\n{"a":1,"b":2}\n```')).toEqual({ a: 1, b: 2 });
    expect(extractJson('noise {"x": [1]} trailing')).toEqual({ x: [1] });
  });

  it('asks only for what the docs state, and inlines documents when asked', () => {
    const prompt = discoveryPrompt({ inline: [{ name: 'a.md', text: 'GET /x' }], notes: 'v2 only' });
    expect(prompt).toMatch(/Never invent/);
    expect(prompt).toContain('=== DOCUMENT a.md ===\nGET /x');
    expect(prompt).toContain('v2 only');
    expect(discoveryPrompt({ folder: true })).toMatch(/current folder/);
  });

  it('reads spec links a browsing model found', () => {
    expect(specUrlsFromReply('Found these:\n```spec-urls\nhttps://d.example/a.yaml\nhttps://d.example/b.json\nnot-a-url\n```')).toEqual(['https://d.example/a.yaml', 'https://d.example/b.json']);
    expect(specUrlsFromReply('```json\n{}\n```')).toEqual([]);
    expect(discoveryPrompt({ web: 'https://docs.acme.example' })).toMatch(/Start at https:\/\/docs.acme.example[\s\S]*spec-urls/);
  });

  it('lets claude fetch on one domain only when browsing', () => {
    const args = readerArgs(undefined, 'docs.acme.example');
    expect(args).toContain('--tools=Read,Grep,Glob,WebFetch');
    expect(args).toContain('--allowedTools=WebFetch(domain:docs.acme.example)');
    expect(args).toContain('--permission-mode=dontAsk');
    expect(readerArgs().join(' ')).not.toMatch(/WebFetch/);
  });

  it('holds claude to reading files: no shell, no MCP, no prompts', () => {
    const args = readerArgs();
    expect(args).toContain('--tools=Read,Grep,Glob');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--permission-mode=dontAsk');
    expect(args.join(' ')).not.toMatch(/Bash|WebFetch/);
  });
});

describe('stageDocs', () => {
  it('copies documents into a folder, converts HTML, and short-circuits a real spec', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-stage-'));
    const s = stageDocs(path.join(dir, 'docs'), [
      { name: 'guide.html', text: '<html><body><nav>menu</nav><h2>Orders</h2><p>GET /orders lists orders.</p></body></html>' },
      { name: 'spec.json', text: JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/a': { get: { responses: {} } } } }) },
      { name: 'logo.png', text: undefined, path: '/nope' },
    ]);
    expect(s.inline.map((d) => d.name)).toEqual(['guide.md']);
    expect(s.inline[0].text).toBe('## Orders\nGET /orders lists orders.');
    expect(s.direct?.tools).toHaveLength(1);
    expect(s.skipped).toEqual(['logo.png']);
    expect(fs.readdirSync(path.join(dir, 'docs'))).toEqual(['guide.md']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns HTML into readable text', () => {
    expect(htmlToText('<ul><li>a</li><li>b &amp; c</li></ul><script>x()</script>')).toBe('- a\n- b & c');
  });
});
