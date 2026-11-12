import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import type { HistoryEntry, Published } from '../shared/ipc';
import type { ScenarioRun } from '../shared/scenario';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-appstate-'));
let tmpDir = root;

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));

// recordSeen loads ../shared/seen with a plain require() (fine in the
// built CommonJS app). Under vitest that is Node's own require, which
// can't load .ts — so, for this file only, teach it to.
const esbuild = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
const exts = (Module as unknown as { _extensions: Record<string, (m: any, f: string) => void> })._extensions;
const hadTs = '.ts' in exts;
if (!hadTs) {
  exts['.ts'] = (m, filename) => {
    m._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code, filename);
  };
}

const s = await import('./appState');

let n = 0;
beforeEach(() => {
  tmpDir = path.join(root, `case-${n++}`);
});
afterAll(() => {
  if (!hadTs) delete exts['.ts'];
  fs.rmSync(root, { recursive: true, force: true });
});

const entry = (i: number): HistoryEntry => ({ id: `h${i}`, at: new Date(i * 1000).toISOString(), toolId: 'GET /teams', toolName: 'teams', env: 'staging', args: {}, ok: true, method: 'GET' });

describe('settings', () => {
  it('starts from the defaults', () => {
    expect(s.getSettings()).toEqual(s.DEFAULT_SETTINGS);
    expect(s.DEFAULT_SETTINGS.projectsDir).toBe(path.join(os.homedir(), 'overapi'));
    // Load testing can hurt a real API: it starts hidden.
    expect(s.DEFAULT_SETTINGS.loadTesting).toBe(false);
  });

  it('merges a patch and keeps it', () => {
    const next = s.setSettings({ theme: 'dark', aiModel: 'acme-model' });
    expect(next).toMatchObject({ theme: 'dark', aiModel: 'acme-model', timeoutSec: 30 });
    expect(s.getSettings()).toEqual(next);
    s.setSettings({ toured: true });
    expect(s.getSettings()).toMatchObject({ theme: 'dark', toured: true });
  });

  it.each([
    [0, 30],
    [-5, 1],
    [0.5, 1],
    [45, 45],
    [301, 300],
    [9999, 300],
    [Number.NaN, 30],
    ['12' as unknown as number, 12],
    ['abc' as unknown as number, 30],
  ])('clamps timeoutSec %s → %s', (given, kept) => {
    expect(s.setSettings({ timeoutSec: given }).timeoutSec).toBe(kept);
  });

  it('falls back to the defaults when the file is corrupt', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{not json');
    expect(s.getSettings()).toEqual(s.DEFAULT_SETTINGS);
  });

  it('writes atomically (no .tmp left behind)', () => {
    s.setSettings({ theme: 'light' });
    expect(fs.readdirSync(tmpDir)).toEqual(['settings.json']);
  });
});

describe('projects and systems', () => {
  it('remembers projects newest first, without duplicates', () => {
    expect(s.listProjects()).toEqual([]);
    s.rememberProject('/p/a');
    s.rememberProject('/p/b');
    s.rememberProject('/p/a');
    expect(s.listProjects()).toEqual(['/p/a', '/p/b']);
    s.forgetProject('/p/a');
    expect(s.listProjects()).toEqual(['/p/b']);
    s.forgetProject('/p/nope');
    expect(s.listProjects()).toEqual(['/p/b']);
  });

  it('keeps systems apart from projects', () => {
    s.rememberProject('/p/a');
    s.rememberSystem('/s/one');
    s.rememberSystem('/s/two');
    s.rememberSystem('/s/one');
    expect(s.listSystems()).toEqual(['/s/one', '/s/two']);
    expect(s.listProjects()).toEqual(['/p/a']);
    s.forgetSystem('/s/one');
    expect(s.listSystems()).toEqual(['/s/two']);
  });

  it('ignores junk in state.json', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projects: ['/ok', 3, null, { x: 1 }], systems: 'nope' }));
    expect(s.listProjects()).toEqual(['/ok']);
    expect(s.listSystems()).toEqual([]);
    expect(s.publishedFor('/ok')).toBeNull();
    expect(s.installedFor('/ok')).toEqual({});
  });

  it('keeps the other parts of state when one changes', () => {
    s.rememberProject('/p/a');
    s.markPublished('/p/a', { at: 't', env: 'prod', id: 'pub1' });
    s.markInstalled('/p/a', { at: 't1', env: 'prod', name: 'acme' });
    s.rememberSystem('/s/x');
    s.forgetProject('/p/a');
    expect(s.publishedFor('/p/a')).toEqual({ at: 't', env: 'prod', id: 'pub1' });
    expect(s.installedFor('/p/a')).toEqual({ prod: { at: 't1', name: 'acme' } });
    expect(s.listSystems()).toEqual(['/s/x']);
  });
});

describe('published', () => {
  it('is null until published, then the latest entry', () => {
    expect(s.publishedFor('/p/a')).toBeNull();
    const a: Published = { at: '2026-01-01', env: 'staging', id: 'x1' };
    const b: Published = { at: '2026-02-01', env: 'prod', id: 'x2' };
    s.markPublished('/p/a', a);
    s.markPublished('/p/b', a);
    s.markPublished('/p/a', b);
    expect(s.publishedFor('/p/a')).toEqual(b);
    expect(s.publishedFor('/p/b')).toEqual(a);
  });
});

describe('installs', () => {
  it('keeps one entry per environment', () => {
    s.markInstalled('/p/a', { at: 't1', env: 'staging', name: 'acme-staging' });
    s.markInstalled('/p/a', { at: 't2', env: 'prod', name: 'acme' });
    s.markInstalled('/p/a', { at: 't3', env: 'staging', name: 'acme-staging-2' });
    expect(s.installedFor('/p/a')).toEqual({ staging: { at: 't3', name: 'acme-staging-2' }, prod: { at: 't2', name: 'acme' } });
    expect(s.installedFor('/p/other')).toEqual({});
  });

  it('clears one environment', () => {
    s.markInstalled('/p/a', { at: 't1', env: 'staging', name: 'a' });
    s.markInstalled('/p/a', { at: 't2', env: 'prod', name: 'b' });
    s.clearInstalled('/p/a', 'staging');
    expect(s.installedFor('/p/a')).toEqual({ prod: { at: 't2', name: 'b' } });
    s.clearInstalled('/p/a', 'missing');
    expect(s.installedFor('/p/a')).toEqual({ prod: { at: 't2', name: 'b' } });
  });

  it('reads the older single-entry shape, and migrates it on the next write', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ installed: { '/p/a': { claude: { at: 'old', env: 'staging', name: 'legacy' } } } }));
    expect(s.installedFor('/p/a')).toEqual({ staging: { at: 'old', name: 'legacy' } });
    s.markInstalled('/p/a', { at: 'new', env: 'prod', name: 'acme' });
    expect(s.installedFor('/p/a')).toEqual({ staging: { at: 'old', name: 'legacy' }, prod: { at: 'new', name: 'acme' } });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'));
    expect(raw.installed['/p/a'].claude).toBeUndefined();
  });

  it('a newer per-env entry wins over the old single entry', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ installed: { '/p/a': { claude: { at: 'old', env: 'staging', name: 'legacy' }, claudeByEnv: { staging: { at: 'new', name: 'current' } } } } }));
    expect(s.installedFor('/p/a')).toEqual({ staging: { at: 'new', name: 'current' } });
  });

  it('clearing the old single entry removes it', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ installed: { '/p/a': { claude: { at: 'old', env: 'staging', name: 'legacy' } } } }));
    s.clearInstalled('/p/a', 'staging');
    expect(s.installedFor('/p/a')).toEqual({});
  });
});

describe('history', () => {
  it('is empty at first, newest first after, and per project', () => {
    expect(s.history('/p/a')).toEqual([]);
    s.addHistory('/p/a', entry(1));
    s.addHistory('/p/a', entry(2));
    s.addHistory('/p/b', entry(3));
    expect(s.history('/p/a').map((e) => e.id)).toEqual(['h2', 'h1']);
    expect(s.history('/p/b').map((e) => e.id)).toEqual(['h3']);
  });

  it('caps at 200 entries, dropping the oldest', () => {
    for (let i = 0; i < 205; i++) s.addHistory('/p/a', entry(i));
    const h = s.history('/p/a');
    expect(h).toHaveLength(200);
    expect(h[0].id).toBe('h204');
    expect(h[199].id).toBe('h5');
  });

  it('keeps the file name free of the project path', () => {
    s.addHistory('/Users/someone/acme/secret project.json', entry(1));
    const files = fs.readdirSync(path.join(tmpDir, 'history'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it('clearHistory empties history and the values seen', () => {
    s.addHistory('/p/a', entry(1));
    s.recordSeen('/p/a', 'staging', 'GET /teams', { 'data[].id': [{ v: 1, label: 'Acme FC' }] });
    s.addHistory('/p/b', entry(2));
    s.clearHistory('/p/a');
    expect(s.history('/p/a')).toEqual([]);
    expect(s.seenFor('/p/a')).toEqual({});
    expect(s.history('/p/b')).toHaveLength(1);
  });
});

describe('values seen', () => {
  it('is empty at first, and ignores an empty record', () => {
    expect(s.seenFor('/p/a')).toEqual({});
    s.recordSeen('/p/a', 'staging', 'GET /teams', {});
    expect(fs.existsSync(path.join(tmpDir, 'seen'))).toBe(false);
  });

  it('keeps values per environment and per request', () => {
    s.recordSeen('/p/a', 'staging', 'GET /teams', { 'data[].id': [{ v: 1 }] });
    s.recordSeen('/p/a', 'prod', 'GET /teams', { 'data[].id': [{ v: 9 }] });
    s.recordSeen('/p/a', 'staging', 'GET /players', { 'id': [{ v: 'p1' }] });
    expect(s.seenFor('/p/a')).toEqual({
      staging: { 'GET /teams': { 'data[].id': [{ v: 1 }] }, 'GET /players': { id: [{ v: 'p1' }] } },
      prod: { 'GET /teams': { 'data[].id': [{ v: 9 }] } },
    });
  });

  it('merges new values first, keeps older ones not seen again, and caps each path at 50', () => {
    s.recordSeen('/p/a', 'staging', 'GET /teams', { 'data[].id': [{ v: 1 }, { v: 2 }], status: [{ v: 'active' }] });
    s.recordSeen('/p/a', 'staging', 'GET /teams', { 'data[].id': [{ v: 3 }, { v: 1, label: 'Acme FC' }] });
    const t = s.seenFor('/p/a').staging['GET /teams'];
    expect(t['data[].id']).toEqual([{ v: 3 }, { v: 1, label: 'Acme FC' }, { v: 2 }]);
    expect(t.status).toEqual([{ v: 'active' }]);

    s.recordSeen('/p/a', 'staging', 'GET /teams', { 'data[].id': Array.from({ length: 60 }, (_, i) => ({ v: 100 + i })) });
    expect(s.seenFor('/p/a').staging['GET /teams']['data[].id']).toHaveLength(50);
  });

  it('clearSeen empties only that project', () => {
    s.recordSeen('/p/a', 'staging', 'x', { id: [{ v: 1 }] });
    s.recordSeen('/p/b', 'staging', 'x', { id: [{ v: 2 }] });
    s.clearSeen('/p/a');
    expect(s.seenFor('/p/a')).toEqual({});
    expect(s.seenFor('/p/b')).toEqual({ staging: { x: { id: [{ v: 2 }] } } });
  });
});

describe('test runs', () => {
  const run = (id: string, passed: number): ScenarioRun =>
    ({
      scenarioId: id,
      env: 'staging',
      at: '2026-01-01T00:00:00Z',
      ms: 10,
      passed,
      failed: 0,
      skipped: 0,
      results: [{ stepId: 's1', ok: true, status: 200, body: '{"secret":"acme"}' } as never],
    }) as ScenarioRun;

  it('keeps the last run of each scenario, per project, without bodies', () => {
    expect(s.lastRuns('/p/a')).toEqual({});
    s.saveRun('/p/a', run('sc1', 1));
    s.saveRun('/p/a', run('sc2', 2));
    s.saveRun('/p/a', run('sc1', 3));
    s.saveRun('/p/b', run('sc1', 4));
    const a = s.lastRuns('/p/a');
    expect(Object.keys(a).sort()).toEqual(['sc1', 'sc2']);
    expect(a.sc1.passed).toBe(3);
    expect(a.sc1.results[0]).toEqual({ stepId: 's1', ok: true, status: 200 });
    expect('body' in a.sc1.results[0]).toBe(false);
    expect(s.lastRuns('/p/b').sc1.passed).toBe(4);
    expect(fs.readFileSync(path.join(tmpDir, 'test-runs.json'), 'utf8')).not.toContain('secret');
  });
});
