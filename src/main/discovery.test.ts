import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '../shared/project';
import type { DiscoverRequest } from '../shared/ipc';

// ---- the AI CLIs and the URL importers, faked --------------------------------------

type Result = { ok: boolean; output: string; error?: string };
const ai = {
  have: { claude: true, codex: true },
  result: { ok: true, output: '' } as Result,
  cancel: vi.fn(),
  hold: null as null | Promise<void>,
};
const detectTools = vi.fn(async () => ({ ...ai.have }));
const runClaudeReader = vi.fn((_prompt: string, _o: { cwd: string; onStep?: unknown; timeoutMs?: number; model?: string; webDomain?: string }) => ({
  result: (ai.hold ?? Promise.resolve()).then(() => ai.result),
  cancel: ai.cancel,
}));
const runCodex = vi.fn((_prompt: string, _o?: { timeoutMs?: number; cwd?: string }) => ({ result: Promise.resolve(ai.result), cancel: ai.cancel }));
vi.mock('../core/ai', () => ({
  detectTools: () => detectTools(),
  runClaudeReader: (p: string, o: never) => runClaudeReader(p, o),
  runCodex: (p: string, o?: never) => runCodex(p, o),
}));

const importFromUrl = vi.fn(async (_u: string): Promise<{ project: Project; note?: string }> => {
  throw new Error('not a spec');
});
const probeSpecs = vi.fn(async (_u: string): Promise<{ project: Project; note?: string } | null> => null);
const importSpecUrls = vi.fn(async (_urls: string[], _site: string): Promise<{ project: Project; note?: string }> => ({ project: proj('from-spec-urls') }));
vi.mock('../core/import/fromUrl', () => ({
  importFromUrl: (u: string) => importFromUrl(u),
  probeSpecs: (u: string) => probeSpecs(u),
  importSpecUrls: (urls: string[], site: string) => importSpecUrls(urls, site),
}));

const { discover, cancelDiscovery } = await import('./discovery');

// ---- fixtures -------------------------------------------------------------------------

function proj(name: string, baseUrl = ''): Project {
  return {
    overapi: 1,
    name,
    title: name,
    description: '',
    version: '1',
    envs: [
      { name: 'default', baseUrl, auth: { type: 'none' }, allowWrites: false },
      { name: 'other', baseUrl: '', auth: { type: 'none' }, allowWrites: false },
    ],
    tools: [],
  } as Project;
}

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Acme League', version: '1' },
  paths: { '/teams': { get: { operationId: 'listTeams', summary: 'List teams', responses: { '200': { description: 'ok' } } } } },
};
const reply = (doc: unknown = SPEC) => `Here it is:\n\n\`\`\`json\n${JSON.stringify(doc)}\n\`\`\`\n`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-discovery-test-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function opts(prefer: 'auto' | 'claude' | 'codex' = 'auto', model = '') {
  const phases: string[] = [];
  return { phases, o: { prefer, model, onStep: vi.fn(), onPhase: (t: string) => phases.push(t) } };
}

const req = (r: Partial<DiscoverRequest> = {}): DiscoverRequest => ({ files: [], ...r });

beforeEach(() => {
  vi.clearAllMocks();
  ai.have = { claude: true, codex: true };
  ai.result = { ok: true, output: reply() };
  ai.hold = null;
  importFromUrl.mockImplementation(async () => {
    throw new Error('not a spec');
  });
  probeSpecs.mockImplementation(async () => null);
  vi.unstubAllGlobals();
});

// ---- a URL: spec → usual places → model -----------------------------------------------

describe('discover from a URL', () => {
  it('1. imports a URL that is a spec directly, with no model', async () => {
    importFromUrl.mockResolvedValueOnce({ project: proj('direct'), note: 'Imported 2 specs' });
    const { o, phases } = opts();
    const p = await discover(req({ url: 'https://docs.acme.example/api' }), o);
    expect(p.name).toBe('direct');
    expect(phases).toEqual(['Fetching https://docs.acme.example/api', 'Imported 2 specs']);
    expect(probeSpecs).not.toHaveBeenCalled();
    expect(runClaudeReader).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('1. says it imported directly when the importer has no note', async () => {
    importFromUrl.mockResolvedValueOnce({ project: proj('direct') });
    const { o, phases } = opts();
    await discover(req({ url: 'https://docs.acme.example/openapi.json' }), o);
    expect(phases[1]).toBe('That URL is a spec — imported directly, no model needed');
  });

  it('2. then looks at the usual places on the site', async () => {
    probeSpecs.mockResolvedValueOnce({ project: proj('probed') });
    const { o, phases } = opts();
    const p = await discover(req({ url: 'https://docs.acme.example/' }), o);
    expect(p.name).toBe('probed');
    expect(probeSpecs).toHaveBeenCalledWith('https://docs.acme.example/');
    expect(phases).toEqual(['Fetching https://docs.acme.example/', 'Looking for a spec at the usual places on that site', 'Found a spec on the site — imported directly']);
    expect(runClaudeReader).not.toHaveBeenCalled();
  });

  it('3. then lets claude browse that one domain, for longer', async () => {
    const { o, phases } = opts('auto', 'acme-model');
    const p = await discover(req({ url: 'https://docs.acme.example/reference', notes: 'the league API' }), o);
    expect(runClaudeReader).toHaveBeenCalledTimes(1);
    const [prompt, ro] = runClaudeReader.mock.calls[0];
    expect(ro).toMatchObject({ webDomain: 'docs.acme.example', timeoutMs: 15 * 60_000, model: 'acme-model' });
    expect(prompt).toContain('https://docs.acme.example/reference');
    expect(phases.at(-2)).toBe('claude is exploring docs.acme.example');
    expect(phases.at(-1)).toBe('Building the API from the answer');
    expect(p.tools.map((t) => t.method + ' ' + t.path)).toEqual(['GET /teams']);
    expect(p.source).toMatchObject({ kind: 'docs', ref: 'https://docs.acme.example/reference' });
  });

  it('3. imports the spec files claude found, exactly, instead of its draft', async () => {
    ai.result = { ok: true, output: 'Found these:\n```spec-urls\nhttps://docs.acme.example/a.json\nhttps://docs.acme.example/b.yaml\n```\n' };
    importSpecUrls.mockResolvedValueOnce({ project: proj('found'), note: 'Imported 2' });
    const { o, phases } = opts();
    const p = await discover(req({ url: 'https://docs.acme.example/' }), o);
    expect(p.name).toBe('found');
    expect(importSpecUrls).toHaveBeenCalledWith(['https://docs.acme.example/a.json', 'https://docs.acme.example/b.yaml'], 'https://docs.acme.example/');
    expect(phases.slice(-2)).toEqual(['claude found 2 spec files — importing them', 'Imported 2']);
  });

  it('3. with codex, fetches the one page as text and inlines it', async () => {
    ai.have = { claude: false, codex: true };
    const fetchMock = vi.fn(async () => new Response('<html><body><h1>Teams</h1><p>GET /teams lists teams</p><script>x()</script></body></html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { o, phases } = opts();
    await discover(req({ url: 'https://docs.acme.example/ref' }), o);
    expect(fetchMock).toHaveBeenCalledWith('https://docs.acme.example/ref', { headers: { accept: 'text/html, text/plain, */*' } });
    expect(runClaudeReader).not.toHaveBeenCalled();
    const prompt = runCodex.mock.calls[0][0];
    expect(prompt).toContain('# Teams');
    expect(prompt).toContain('GET /teams lists teams');
    expect(prompt).not.toContain('x()');
    expect(phases.at(-2)).toBe('Reading 1 document with codex');
  });

  it('3. with codex, says what the page answered when it fails', async () => {
    ai.have = { claude: false, codex: true };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' })));
    await expect(discover(req({ url: 'https://docs.acme.example/gone' }), opts().o)).rejects.toThrow('https://docs.acme.example/gone answered 404 Not Found.');
  });

  it('prefer claude when only codex is installed: fetches the page, then says claude is missing', async () => {
    ai.have = { claude: false, codex: true };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('plain text docs', { status: 200 })));
    await expect(discover(req({ url: 'https://docs.acme.example/' }), opts('claude').o)).rejects.toThrow('claude is not installed. Pick the other one in Settings.');
  });
});

// ---- files and pasted text ---------------------------------------------------------------

describe('discover from files and pasted text', () => {
  it('needs something to read', async () => {
    await expect(discover(req(), opts().o)).rejects.toThrow('Add at least one document, a URL, or some pasted text.');
    await expect(discover(req({ pasted: '   \n' }), opts().o)).rejects.toThrow('Add at least one document');
  });

  it('a pasted spec imports as it is, no model', async () => {
    const p = await discover(req({ pasted: JSON.stringify(SPEC) }), opts().o);
    expect(p.tools).toHaveLength(1);
    expect(runClaudeReader).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('pasted prose goes to claude, reading a folder', async () => {
    const { o, phases } = opts();
    await discover(req({ pasted: 'The Acme League API lists teams at GET /teams.' }), o);
    const [, ro] = runClaudeReader.mock.calls[0];
    expect(ro.webDomain).toBeUndefined();
    expect(ro.timeoutMs).toBeUndefined();
    expect(ro.model).toBeUndefined();
    expect(phases).toContain('Reading 1 document with claude');
    // The staged folder is removed afterwards.
    expect(fs.existsSync(ro.cwd)).toBe(false);
    expect(path.basename(ro.cwd)).toMatch(/^overapi-docs-/);
  });

  it('counts documents in the phase', async () => {
    const a = path.join(scratch, 'a.md');
    const b = path.join(scratch, 'b.txt');
    fs.writeFileSync(a, '# Acme\nGET /teams');
    fs.writeFileSync(b, 'GET /players');
    const { o, phases } = opts();
    await discover(req({ files: [a, b] }), o);
    expect(phases).toContain('Reading 2 documents with claude');
    expect(runClaudeReader.mock.calls[0][1].cwd).not.toBe(scratch);
  });

  it('says which files could not be read', async () => {
    const f = path.join(scratch, 'notes.docx');
    fs.writeFileSync(f, 'binary');
    await expect(discover(req({ files: [f] }), opts().o)).rejects.toThrow('None of those could be read (notes.docx). Hand over Markdown, HTML, text or PDF.');
  });

  it('with no CLI installed, says to install one', async () => {
    ai.have = { claude: false, codex: false };
    await expect(discover(req({ pasted: 'prose about Acme' }), opts().o)).rejects.toThrow('Discovery uses your own claude or codex CLI, and neither is installed.');
  });

  it('prefer codex when only claude is installed', async () => {
    ai.have = { claude: true, codex: false };
    await expect(discover(req({ pasted: 'prose about Acme' }), opts('codex').o)).rejects.toThrow('codex is not installed. Pick the other one in Settings.');
  });

  it('auto picks codex when claude is missing', async () => {
    ai.have = { claude: false, codex: true };
    await discover(req({ pasted: 'prose about Acme' }), opts('auto').o);
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(runClaudeReader).not.toHaveBeenCalled();
  });

  it('codex cannot read PDFs', async () => {
    ai.have = { claude: false, codex: true };
    const f = path.join(scratch, 'ref.pdf');
    fs.writeFileSync(f, '%PDF-1.4');
    await expect(discover(req({ files: [f] }), opts().o)).rejects.toThrow('codex can’t read PDFs here.');
  });

  it('codex cannot take too much text in one go', async () => {
    ai.have = { claude: false, codex: true };
    await expect(discover(req({ pasted: 'Acme words. '.repeat(60_000) }), opts().o)).rejects.toThrow('That is more text than codex can take in one go.');
  });

  it('passes on the model’s failure, or says it did not answer', async () => {
    ai.result = { ok: false, output: '', error: 'claude timed out' };
    await expect(discover(req({ pasted: 'prose' }), opts().o)).rejects.toThrow('claude timed out');
    ai.result = { ok: false, output: '' };
    await expect(discover(req({ pasted: 'prose' }), opts().o)).rejects.toThrow('claude did not answer.');
  });

  it('a reply that is not OpenAPI is an error', async () => {
    ai.result = { ok: true, output: 'I could not find anything.' };
    await expect(discover(req({ pasted: 'prose' }), opts().o)).rejects.toThrow();
  });

  it('removes the staged folder even when it fails', async () => {
    ai.result = { ok: false, output: '', error: 'boom' };
    await expect(discover(req({ pasted: 'prose' }), opts().o)).rejects.toThrow('boom');
    expect(fs.existsSync(runClaudeReader.mock.calls[0][1].cwd)).toBe(false);
  });
});

// ---- title and base URL -------------------------------------------------------------------

describe('discover: the title and base URL the person gave', () => {
  it('applies the title, and a base URL to the first environment when none has one', async () => {
    importFromUrl.mockResolvedValueOnce({ project: proj('x') });
    const p = await discover(req({ url: 'https://docs.acme.example/', title: '  Acme League  ', baseUrl: 'https://api.acme.example' }), opts().o);
    expect(p.title).toBe('Acme League');
    expect(p.envs.map((e) => e.baseUrl)).toEqual(['https://api.acme.example', '']);
  });

  it('keeps a base URL the import already found, and ignores a blank title', async () => {
    importFromUrl.mockResolvedValueOnce({ project: proj('x', 'https://found.acme.example') });
    const p = await discover(req({ url: 'https://docs.acme.example/', title: '   ', baseUrl: 'https://api.acme.example' }), opts().o);
    expect(p.title).toBe('x');
    expect(p.envs[0].baseUrl).toBe('https://found.acme.example');
  });
});

// ---- a source folder -------------------------------------------------------------------------

describe('discover from source code', () => {
  it('has claude read the folder, read-only, for up to 15 minutes', async () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'acme-service-'));
    const { o, phases } = opts('auto', 'acme-model');
    const p = await discover(req({ sourceDir: dir, source: 'Node', baseUrl: 'https://api.acme.example', url: 'https://ignored.acme.example' }), o);
    const [prompt, ro] = runClaudeReader.mock.calls[0];
    expect(ro).toMatchObject({ cwd: dir, timeoutMs: 15 * 60_000, model: 'acme-model' });
    expect(prompt).toContain('Node');
    expect(importFromUrl).not.toHaveBeenCalled();
    expect(phases).toEqual([`claude is reading the code in ${path.basename(dir)} (read-only)`, 'Building the API from the answer']);
    expect(p.source?.ref).toBe(`source code in ${path.basename(dir)}`);
    expect(p.envs[0].baseUrl).toBe('https://api.acme.example');
    // The folder itself is left alone.
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('uses codex when preferred', async () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'acme-service-'));
    await discover(req({ sourceDir: dir }), opts('codex').o);
    expect(runCodex).toHaveBeenCalledWith(expect.any(String), { cwd: dir, timeoutMs: 15 * 60_000 });
  });

  it('errors: folder gone, tool missing, none installed, no answer', async () => {
    const gone = path.join(scratch, 'nope');
    await expect(discover(req({ sourceDir: gone }), opts().o)).rejects.toThrow(`${gone} isn’t there any more.`);
    ai.have = { claude: true, codex: false };
    await expect(discover(req({ sourceDir: scratch }), opts('codex').o)).rejects.toThrow('codex is not installed. Pick the other one in Settings.');
    ai.have = { claude: false, codex: false };
    await expect(discover(req({ sourceDir: scratch }), opts().o)).rejects.toThrow('Reading code uses your own claude or codex CLI, and neither is installed.');
    ai.have = { claude: true, codex: true };
    ai.result = { ok: false, output: '' };
    await expect(discover(req({ sourceDir: scratch }), opts().o)).rejects.toThrow('claude did not answer.');
  });
});

// ---- cancel -------------------------------------------------------------------------------

describe('cancelDiscovery', () => {
  it('cancels the run in progress, and is harmless with none', async () => {
    cancelDiscovery();
    expect(ai.cancel).not.toHaveBeenCalled();
    let release!: () => void;
    ai.hold = new Promise<void>((r) => (release = r));
    const p = discover(req({ pasted: 'prose' }), opts().o);
    await vi.waitFor(() => expect(runClaudeReader).toHaveBeenCalled());
    cancelDiscovery();
    expect(ai.cancel).toHaveBeenCalledTimes(1);
    release();
    await p;
    cancelDiscovery();
    expect(ai.cancel).toHaveBeenCalledTimes(1);
  });
});
