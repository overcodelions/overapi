import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendToOvercli } from './overcli';
import type { Project } from '../shared/project';

const project: Project = {
  overapi: 1,
  name: 'acme',
  title: 'Acme',
  description: '',
  version: '1',
  envs: [{ name: 'staging', baseUrl: 'https://staging.acme.example', auth: { type: 'none' }, allowWrites: false }],
  tools: [{ id: 'GET /a', name: 'a', description: '', enabled: true, safety: 'read', method: 'GET', path: '/a', params: [], bodyMode: 'none' }],
};

describe('sendToOvercli', () => {
  it('never creates the inbox: no folder means no overcli to read it', () => {
    const dir = path.join(os.tmpdir(), `overapi-none-${Date.now()}`);
    const r = sendToOvercli(project, 'staging', { dir });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('writes one whole .json file, never a partial one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-inbox-'));
    const r = sendToOvercli(project, 'staging', { dir, id: 'id1', now: 0 });
    expect(r).toEqual({ ok: true, id: 'id1' });
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['1970-01-01T00-00-00-000Z-id1.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))).toMatchObject({ kind: 'overapi-project', env: 'staging' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
