// Discovery: documentation in, a draft project out.
//
// For the API whose only description is prose — a PDF from a vendor, a
// wiki export, a docs site, a README. The model is asked for one thing it
// is good at and that can be checked: an OpenAPI 3 document describing
// only what the documentation says. That document then goes through the
// same importer as any spec, so everything downstream (naming, safety,
// auth as variable names, the readiness check) is the same code, and the
// model never writes the project file itself.
//
// What comes out is a draft: every tool is marked as drafted from docs,
// and everything starts read-only, like every other import.

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/project';
import { importOpenApi, isOpenApi } from './import/openapi';
import { importText } from './import';

/// Files read as text. PDFs are left to claude's Read tool, which reads
/// them natively; everything else is skipped and said so.
export const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.rst', '.adoc', '.html', '.htm', '.json', '.yaml', '.yml', '.xml', '.wsdl', '.csv', '.graphql'];
export const DOC_EXTENSIONS = [...TEXT_EXTENSIONS, '.pdf'];

/// Plenty for a long reference; past this an inline prompt stops being
/// reliable and the person should hand over fewer files.
export const INLINE_LIMIT = 600_000;

const RULES = [
  'Write ONE OpenAPI 3.0 document, as JSON, describing the endpoints this documentation describes.',
  'Rules:',
  '- Only endpoints, parameters and fields the documentation actually states. Never invent one. If something is ambiguous, still include it and begin its description with "Unclear:" saying what is unclear.',
  '- Every operation gets an operationId in camelCase that says what it does (listOrders, cancelOrder), a one-line summary, and a description saying what it returns and when to use it.',
  '- Every parameter and body property gets a description, its type, and any enum or format the documentation gives.',
  '- Request bodies under application/json with a full schema. Success responses with a schema of the returned fields, when the documentation shows them.',
  '- servers: every base URL the documentation names, each with a description such as "Production" or "Sandbox".',
  '- components.securitySchemes: how the API authenticates (bearer, apiKey with its header or query name, or basic), and a top-level security entry using it.',
  '- Put anything an agent should know that no single endpoint says (id formats, paging, rate limits, units, ordering of calls) in info.description.',
  '- If a call says it deletes, voids or irreversibly changes data, add "x-overapi-safety": "destructive" to it.',
  '',
  'Answer with the JSON document only, in a single ```json fenced block, and nothing after it.',
];

/// Reading a running service's own source: its routes are the truth, and
/// the code says what no reference page does — the context path, the DTOs,
/// how it checks who is calling.
export function sourcePrompt(opts: { baseUrl?: string; source?: string; notes?: string }): string {
  const lines = [
    'You are documenting an existing HTTP API so that AI agents can call it as tools.',
    `The source code of the service is in the current folder${opts.source ? ` (${opts.source})` : ''}. Read it to find every HTTP endpoint it serves. Work with Grep and Glob first — find the route definitions, then read only the files that hold them and the types they use. Do not read the whole tree.`,
    'Where routes live: Spring @RestController/@Controller with @RequestMapping/@GetMapping/@PostMapping…; JAX-RS @Path; Express/Fastify/Nest router calls and decorators; FastAPI/Flask/Django urls and views; Go http.HandleFunc, chi, gin, echo; ASP.NET controllers; Rails routes.rb.',
    'The base path matters: look in application.yml/.properties (server.servlet.context-path, spring.mvc.servlet.path), app prefixes, router mounts, and class-level mappings, and put the full path on each operation.',
    'Request bodies and responses come from the DTO / model classes the handlers take and return — read them for the fields. Path variables, query params (@RequestParam and the like, with defaults and required) and headers the handlers read.',
    'Authentication: find how the service checks callers (a JWT/bearer filter, an API-key header, a session cookie, basic) and describe it in securitySchemes.',
    'Leave out framework plumbing nobody would call as a tool: actuator/health/metrics, error controllers, swagger/api-docs routes, static files.',
    'Only endpoints the code actually serves — never invent one. Endpoint descriptions should say what the endpoint does for the caller (from the code and any javadoc/comments), not how it is implemented.',
    '',
    ...RULES,
  ];
  if (opts.baseUrl) lines.push('', `The service is running at ${opts.baseUrl}. Make the first server that address plus any context path you found.`);
  if (opts.notes?.trim()) lines.push('', 'Notes from the person:', opts.notes.trim());
  return lines.join('\n');
}

export function discoveryPrompt(opts: { inline?: { name: string; text: string }[]; folder?: boolean; notes?: string; baseUrl?: string; web?: string }): string {
  const lines = [
    'You are documenting an existing HTTP API so that AI agents can call it as tools.',
    ...(opts.web
      ? [
          `Start at ${opts.web} — fetch it with WebFetch and follow links on that site to its API reference. You can only fetch pages on that site.`,
          'FIRST look for machine-readable specs: links to OpenAPI or Swagger files (.json/.yaml), "Download OpenAPI", an /openapi page. If you find any, do not write a spec: answer with ONLY a ```spec-urls fenced block listing each spec file URL, one per line, absolute. Stop there.',
          'Only if there are none, read the reference pages and write the OpenAPI document as described below.',
          '',
        ]
      : []),
    opts.folder
      ? 'The documentation is in the current folder. List it with Glob, then read every file (PDFs included) before answering.'
      : 'The documentation follows, between the DOCUMENT markers.',
    '',
    ...RULES,
  ];
  if (opts.baseUrl) lines.push('', `The person says the API lives at ${opts.baseUrl}. Use it as the first server if the documentation names none.`);
  if (opts.notes?.trim()) lines.push('', 'Notes from the person who uploaded this:', opts.notes.trim());
  for (const d of opts.inline ?? []) lines.push('', `=== DOCUMENT ${d.name} ===`, d.text, `=== END ${d.name} ===`);
  return lines.join('\n');
}

/// The JSON out of a reply: the largest ```json block, else the outermost
/// braces.
export function extractJson(reply: string): unknown {
  const blocks = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]).sort((a, b) => b.length - a.length);
  const candidates = blocks.length ? blocks : [reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // Try the next one.
    }
  }
  throw new Error('The model did not answer with a JSON document. Try again, or hand over fewer or clearer files.');
}

/// Spec file URLs a browsing model found, from a ```spec-urls block.
export function specUrlsFromReply(reply: string): string[] {
  const m = reply.match(/```spec-urls\s*\n([\s\S]*?)```/i);
  if (!m) return [];
  return [...new Set(m[1].split(/\s+/).filter((u) => /^https?:\/\//i.test(u)))];
}

export function projectFromReply(reply: string, ref: string): Project {
  const doc = extractJson(reply);
  if (!isOpenApi(doc)) throw new Error('The model answered, but not with an OpenAPI document. Try again with a note on what the API is.');
  const project = importOpenApi(doc as Record<string, unknown>, ref);
  if (!project.tools.length) throw new Error('The documentation did not describe any endpoints the model could find.');
  project.source = { kind: 'docs', ref, importedAt: new Date().toISOString() };
  project.tools = project.tools.map((t) => ({ ...t, origin: { ...t.origin, summary: t.origin?.summary ?? t.name, tags: [...(t.origin?.tags ?? []), 'drafted from docs'] } }));
  return project;
}

/// A page of HTML as readable text: the content, not the chrome.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|footer|header|svg|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Staged {
  dir: string;
  inline: { name: string; text: string }[];
  pdfs: string[];
  skipped: string[];
  /// When a handed-over file is itself a spec, capture or collection: no
  /// model needed, it imports as it is.
  direct?: Project;
}

/// Copies the documents into a fresh folder (so claude reads those and
/// nothing beside them) and reads the text ones for an inline prompt.
export function stageDocs(dir: string, files: { name: string; text?: string; path?: string }[]): Staged {
  fs.mkdirSync(dir, { recursive: true });
  const staged: Staged = { dir, inline: [], pdfs: [], skipped: [] };
  const used = new Set<string>();
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    let base = path.basename(f.name).replace(/[^A-Za-z0-9._-]/g, '_') || 'doc';
    for (let i = 2; used.has(base); i++) base = `${i}-${base}`;
    used.add(base);
    if (ext === '.pdf' && f.path) {
      fs.copyFileSync(f.path, path.join(dir, base));
      staged.pdfs.push(base);
      continue;
    }
    if (!TEXT_EXTENSIONS.includes(ext) && f.text === undefined) {
      staged.skipped.push(f.name);
      continue;
    }
    let text = f.text ?? fs.readFileSync(f.path!, 'utf8');
    if (!staged.direct) {
      try {
        staged.direct = importText(text, f.name);
        continue;
      } catch {
        // Prose, not a spec: on to the model.
      }
    }
    if (ext === '.html' || ext === '.htm' || /^\s*<!doctype html|^\s*<html/i.test(text)) {
      text = htmlToText(text);
      base = base.replace(/\.html?$/i, '') + '.md';
    }
    fs.writeFileSync(path.join(dir, base), text);
    staged.inline.push({ name: base, text });
  }
  return staged;
}
