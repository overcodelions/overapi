// Running discovery from the app. See src/core/discover.ts for the approach
// and src/core/ai.ts for how the CLIs are held to reading only.
//
// A docs URL escalates, cheapest and most exact first:
//   1. the URL is a spec, or a page that links to specs   → import, no model
//   2. a spec sits at one of the usual places on that site → import, no model
//   3. claude browses the site (that one domain only):
//        finds spec files → their URLs come back and are imported exactly
//        finds none       → it reads the reference and drafts a spec
// Files and pasted text skip 1–2 and go straight to the model (unless a
// file is itself a spec).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiscoverRequest } from '../shared/ipc';
import type { Project } from '../shared/project';
import { detectTools, runClaudeReader, runCodex, type AiRun } from '../core/ai';
import { discoveryPrompt, sourcePrompt, htmlToText, INLINE_LIMIT, projectFromReply, specUrlsFromReply, stageDocs } from '../core/discover';
import { importFromUrl, importSpecUrls, probeSpecs } from '../core/import/fromUrl';

let running: AiRun | null = null;

export function cancelDiscovery(): void {
  running?.cancel();
  running = null;
}

type Opts = { prefer: 'auto' | 'claude' | 'codex'; model: string; onStep: (t: string) => void; onPhase: (t: string) => void };

function finish(project: Project, req: DiscoverRequest): Project {
  if (req.title?.trim()) project.title = req.title.trim();
  if (req.baseUrl && project.envs.every((e) => !e.baseUrl)) project.envs = project.envs.map((e, i) => (i === 0 ? { ...e, baseUrl: req.baseUrl! } : e));
  return project;
}

/// Reads a service's source folder, read-only, and drafts its API.
async function fromSource(req: DiscoverRequest & { sourceDir: string }, opts: Opts): Promise<Project> {
  const have = await detectTools();
  const tool = opts.prefer === 'claude' || (opts.prefer === 'auto' && have.claude) ? 'claude' : 'codex';
  if (!have[tool]) throw new Error(have.claude || have.codex ? `${tool} is not installed. Pick the other one in Settings.` : 'Reading code uses your own claude or codex CLI, and neither is installed. Install one and sign in, then try again.');
  if (!fs.existsSync(req.sourceDir)) throw new Error(`${req.sourceDir} isn’t there any more.`);
  const prompt = sourcePrompt({ baseUrl: req.baseUrl, source: req.source, notes: req.notes });
  opts.onPhase(`${tool} is reading the code in ${path.basename(req.sourceDir)} (read-only)`);
  // A whole service is more to read than a few documents.
  running = tool === 'claude' ? runClaudeReader(prompt, { cwd: req.sourceDir, onStep: opts.onStep, model: opts.model || undefined, timeoutMs: 15 * 60_000 }) : runCodex(prompt, { cwd: req.sourceDir, timeoutMs: 15 * 60_000 });
  const result = await running.result;
  running = null;
  if (!result.ok) throw new Error(result.error ?? `${tool} did not answer.`);
  opts.onPhase('Building the API from the answer');
  return finish(projectFromReply(result.output, `source code in ${path.basename(req.sourceDir)}`), req);
}

export async function discover(req: DiscoverRequest, opts: Opts): Promise<Project> {
  if (req.sourceDir) return fromSource({ ...req, sourceDir: req.sourceDir }, opts);
  const dir = path.join(os.tmpdir(), `overapi-docs-${randomUUID()}`);
  try {
    const files: { name: string; text?: string; path?: string }[] = req.files.map((f) => ({ name: path.basename(f), path: f }));
    if (req.pasted?.trim()) files.push({ name: 'pasted.md', text: req.pasted });

    const have = await detectTools();
    const tool = opts.prefer === 'claude' || (opts.prefer === 'auto' && have.claude) ? 'claude' : 'codex';
    let browse: string | undefined;

    if (req.url) {
      // 1. A spec, or a page of spec links.
      opts.onPhase(`Fetching ${req.url}`);
      try {
        const direct = await importFromUrl(req.url);
        opts.onPhase(direct.note ?? 'That URL is a spec — imported directly, no model needed');
        return finish(direct.project, req);
      } catch {
        // Not one; look further.
      }
      // 2. A spec where specs usually live.
      opts.onPhase('Looking for a spec at the usual places on that site');
      const probed = await probeSpecs(req.url);
      if (probed) {
        opts.onPhase(probed.note ?? 'Found a spec on the site — imported directly');
        return finish(probed.project, req);
      }
      // 3. Let the model look. claude browses; codex gets the one page.
      if (tool === 'claude' && have.claude) browse = req.url;
      else {
        const res = await fetch(req.url, { headers: { accept: 'text/html, text/plain, */*' } });
        if (!res.ok) throw new Error(`${req.url} answered ${res.status} ${res.statusText}.`);
        const text = await res.text();
        files.push({ name: 'page.md', text: /^\s*</.test(text) ? htmlToText(text) : text });
      }
    }
    if (!files.length && !browse) throw new Error('Add at least one document, a URL, or some pasted text.');

    const staged = stageDocs(dir, files);
    if (staged.direct && files.length === 1 && !browse) return finish(staged.direct, req);
    if (!browse && !staged.inline.length && !staged.pdfs.length) {
      throw new Error(`None of those could be read${staged.skipped.length ? ` (${staged.skipped.join(', ')})` : ''}. Hand over Markdown, HTML, text or PDF.`);
    }
    if (!have[tool]) {
      throw new Error(have.claude || have.codex ? `${tool} is not installed. Pick the other one in Settings.` : 'Discovery uses your own claude or codex CLI, and neither is installed. Install one and sign in, then try again.');
    }
    if (tool === 'codex' && staged.pdfs.length) throw new Error('codex can’t read PDFs here. Use claude, or export the PDF as text.');

    const ref = [...req.files.map((f) => path.basename(f)), req.url, req.pasted ? 'pasted text' : ''].filter(Boolean).join(', ');
    const docCount = staged.inline.length + staged.pdfs.length;
    if (tool === 'claude') {
      const host = browse ? new URL(browse).hostname : undefined;
      opts.onPhase(browse ? `claude is exploring ${host}${docCount ? ` and reading ${docCount} document${docCount === 1 ? '' : 's'}` : ''}` : `Reading ${docCount} document${docCount === 1 ? '' : 's'} with claude`);
      running = runClaudeReader(discoveryPrompt({ folder: docCount > 0, notes: req.notes, baseUrl: req.baseUrl, web: browse }), {
        cwd: dir,
        onStep: opts.onStep,
        model: opts.model || undefined,
        webDomain: host,
        // Browsing a big docs site takes longer than reading a folder.
        timeoutMs: browse ? 15 * 60_000 : undefined,
      });
    } else {
      const inlineSize = staged.inline.reduce((n, d) => n + d.text.length, 0);
      if (inlineSize > INLINE_LIMIT) throw new Error('That is more text than codex can take in one go. Use claude, or hand over fewer files.');
      opts.onPhase(`Reading ${docCount} document${docCount === 1 ? '' : 's'} with codex`);
      running = runCodex(discoveryPrompt({ inline: staged.inline, notes: req.notes, baseUrl: req.baseUrl }));
    }
    const result = await running.result;
    running = null;
    if (!result.ok) throw new Error(result.error ?? `${tool} did not answer.`);

    // The model found spec files: import those, exactly, rather than trust
    // a spec it would have written from the pages.
    const specUrls = specUrlsFromReply(result.output);
    if (specUrls.length) {
      opts.onPhase(`claude found ${specUrls.length} spec file${specUrls.length === 1 ? '' : 's'} — importing them`);
      const found = await importSpecUrls(specUrls, browse ?? specUrls[0]);
      opts.onPhase(found.note ?? 'Imported');
      return finish(found.project, req);
    }
    opts.onPhase('Building the API from the answer');
    return finish(projectFromReply(result.output, ref || 'documentation'), req);
  } finally {
    running = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
