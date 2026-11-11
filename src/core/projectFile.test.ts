import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveProject, readProject, writeProject } from './projectFile';
import type { Project } from '../shared/project';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-pf-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const project = (title = 'Acme'): Project => ({ overapi: 1, name: 'acme', title, description: '', version: '1', envs: [], tools: [] });

/// Bumps the file's mtime so a change is seen even inside one clock tick.
function touch(file: string, secondsAhead: number) {
  const t = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, t, t);
}

describe('readProject', () => {
  it('reads a valid project', () => {
    const f = path.join(tmp(), 'overapi.json');
    fs.writeFileSync(f, JSON.stringify(project()));
    expect(readProject(f)).toEqual(project());
  });

  it('names a missing file by its error code', () => {
    const f = path.join(tmp(), 'nope.json');
    expect(() => readProject(f)).toThrow(`Cannot read ${f}: ENOENT`);
  });

  it('says when the file is not JSON', () => {
    const f = path.join(tmp(), 'overapi.json');
    fs.writeFileSync(f, '{ not json');
    expect(() => readProject(f)).toThrow(/is not valid JSON/);
  });

  it('says why a JSON file is not a project', () => {
    const f = path.join(tmp(), 'overapi.json');
    fs.writeFileSync(f, JSON.stringify({ name: 'x' }));
    expect(() => readProject(f)).toThrow(`${f}: missing "overapi": 1`);
  });
});

describe('writeProject', () => {
  it('creates the folder, writes pretty JSON with a newline, and leaves no temp file', () => {
    const d = tmp();
    const f = path.join(d, 'nested', 'deeper', 'overapi.json');
    writeProject(f, project());
    const text = fs.readFileSync(f, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "name": "acme"');
    expect(fs.readdirSync(path.dirname(f))).toEqual(['overapi.json']);
    expect(readProject(f)).toEqual(project());
  });

  it('refuses to save something that is not a project, and writes nothing', () => {
    const f = path.join(tmp(), 'overapi.json');
    expect(() => writeProject(f, { ...project(), tools: 'x' } as unknown as Project)).toThrow('Refusing to save: "tools" must be a list');
    expect(fs.existsSync(f)).toBe(false);
  });

  it('overwrites an existing file', () => {
    const f = path.join(tmp(), 'overapi.json');
    writeProject(f, project('One'));
    writeProject(f, project('Two'));
    expect(readProject(f).title).toBe('Two');
  });
});

describe('liveProject', () => {
  it('throws up front when the file is not readable', () => {
    expect(() => liveProject(path.join(tmp(), 'missing.json'))).toThrow(/Cannot read/);
  });

  it('serves the cached project until the file changes, then re-reads it', () => {
    const f = path.join(tmp(), 'overapi.json');
    writeProject(f, project('One'));
    const get = liveProject(f);
    const first = get();
    expect(first.title).toBe('One');
    expect(get()).toBe(first);
    writeProject(f, project('Two'));
    touch(f, 5);
    expect(get().title).toBe('Two');
  });

  it('keeps the last good version when an edit breaks the file, and says so', () => {
    const f = path.join(tmp(), 'overapi.json');
    writeProject(f, project('Good'));
    const errors: string[] = [];
    const get = liveProject(f, (m) => errors.push(m));
    fs.writeFileSync(f, '{ half a fi');
    touch(f, 5);
    expect(get().title).toBe('Good');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^kept the previous version: .*not valid JSON/);
    // Only once per change.
    get();
    expect(errors).toHaveLength(1);
    writeProject(f, project('Fixed'));
    touch(f, 10);
    expect(get().title).toBe('Fixed');
  });

  it('keeps serving when the file is deleted, without an error handler', () => {
    const f = path.join(tmp(), 'overapi.json');
    writeProject(f, project('Still here'));
    const get = liveProject(f);
    fs.rmSync(f);
    expect(get().title).toBe('Still here');
  });
});
