import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-secrets-'));
let tmpDir = root;
const keychain = { available: true, failDecrypt: false };

// A stand-in for safeStorage: reversible, but not plain text on disk.
vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from(`enc:${[...s].reverse().join('')}`, 'utf8'),
    decryptString: (b: Buffer) => {
      if (keychain.failDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return [...b.toString('utf8').replace(/^enc:/, '')].reverse().join('');
    },
  },
}));

const s = await import('./secrets');

let n = 0;
beforeEach(() => {
  tmpDir = path.join(root, `case-${n++}`);
  keychain.available = true;
  keychain.failDecrypt = false;
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const file = () => path.join(tmpDir, 'secrets.json');

describe('secrets', () => {
  it('saves and reads back a secret, encrypted at rest with owner-only permissions', () => {
    expect(s.setSecret('/p/acme.json', 'ACME_TOKEN', 'hunter2')).toEqual({ ok: true });
    expect(s.getSecret('/p/acme.json', 'ACME_TOKEN')).toBe('hunter2');
    const raw = fs.readFileSync(file(), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(JSON.parse(raw)['/p/acme.json'].ACME_TOKEN).toBe(Buffer.from('enc:2retnuh').toString('base64'));
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tmpDir)).toEqual(['secrets.json']);
  });

  it('keeps secrets per project and per name', () => {
    s.setSecret('/p/a', 'KEY', 'one');
    s.setSecret('/p/a', 'OTHER', 'two');
    s.setSecret('/p/b', 'KEY', 'three');
    expect(s.getSecret('/p/a', 'KEY')).toBe('one');
    expect(s.getSecret('/p/a', 'OTHER')).toBe('two');
    expect(s.getSecret('/p/b', 'KEY')).toBe('three');
    expect(s.getSecret('/p/b', 'OTHER')).toBeUndefined();
    expect(s.getSecret('/p/c', 'KEY')).toBeUndefined();
  });

  it.each(['1KEY', 'MY-KEY', 'has space', '', 'a.b'])('refuses %j as a variable name', (name) => {
    expect(s.setSecret('/p/a', name, 'x')).toEqual({ ok: false, error: `${name} is not a variable name.` });
    expect(fs.existsSync(file())).toBe(false);
  });

  it.each(['_KEY', 'key', 'Key_2'])('accepts %j as a variable name', (name) => {
    expect(s.setSecret('/p/a', name, 'x').ok).toBe(true);
  });

  it('an empty value removes the secret, even with no keychain', () => {
    s.setSecret('/p/a', 'KEY', 'one');
    keychain.available = false;
    expect(s.setSecret('/p/a', 'KEY', '')).toEqual({ ok: true });
    keychain.available = true;
    expect(s.getSecret('/p/a', 'KEY')).toBeUndefined();
    expect(s.setSecret('/p/never', 'KEY', '')).toEqual({ ok: true });
  });

  it('refuses to save without a keychain, and reads nothing', () => {
    s.setSecret('/p/a', 'KEY', 'one');
    keychain.available = false;
    expect(s.keychainAvailable()).toBe(false);
    const r = s.setSecret('/p/a', 'NEW', 'two');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/keychain is not available/);
    expect(s.getSecret('/p/a', 'KEY')).toBeUndefined();
    keychain.available = true;
    expect(s.getSecret('/p/a', 'NEW')).toBeUndefined();
  });

  it('a secret that will not decrypt reads as missing', () => {
    s.setSecret('/p/a', 'KEY', 'one');
    keychain.failDecrypt = true;
    expect(s.getSecret('/p/a', 'KEY')).toBeUndefined();
  });

  it('a corrupt file reads as empty', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file(), 'not json');
    expect(s.getSecret('/p/a', 'KEY')).toBeUndefined();
    expect(s.setSecret('/p/a', 'KEY', 'v').ok).toBe(true);
    expect(s.getSecret('/p/a', 'KEY')).toBe('v');
  });

  it('clearSecrets forgets one project only, and does nothing for an unknown one', () => {
    s.setSecret('/p/a', 'KEY', 'one');
    s.setSecret('/p/b', 'KEY', 'two');
    s.clearSecrets('/p/a');
    expect(s.getSecret('/p/a', 'KEY')).toBeUndefined();
    expect(s.getSecret('/p/b', 'KEY')).toBe('two');
    const before = fs.statSync(file()).mtimeMs;
    s.clearSecrets('/p/none');
    expect(fs.statSync(file()).mtimeMs).toBe(before);
  });

  it('keychainSource reads a project’s secrets by name', () => {
    s.setSecret('/p/a', 'KEY', 'one');
    const get = s.keychainSource('/p/a');
    expect(get('KEY')).toBe('one');
    expect(get('NOPE')).toBeUndefined();
  });
});
