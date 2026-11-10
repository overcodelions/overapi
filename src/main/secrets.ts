// Secrets typed into the app, kept in the OS keychain's protection
// (Electron safeStorage) — the Insomnia-without-a-cloud part: nothing
// leaves the machine, and nothing lands in the project file.
//
// Stored per project file, by variable name, encrypted at rest in
// userData/secrets.json. Only this app's binary can decrypt them, which is
// why a client pointed at the packaged app's `serve` gets them and one
// pointed at plain `node` does not (it uses its env block or .env).

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

type Store = Record<string, Record<string, string>>;

const file = () => path.join(app.getPath('userData'), 'secrets.json');

function read(): Store {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Store;
  } catch {
    return {};
  }
}

function write(s: Store): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export function keychainAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function getSecret(project: string, name: string): string | undefined {
  const enc = read()[project]?.[name];
  if (!enc || !keychainAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return undefined;
  }
}

/// An empty value removes it.
export function setSecret(project: string, name: string, value: string): { ok: boolean; error?: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: `${name} is not a variable name.` };
  const s = read();
  if (!value) {
    if (s[project]) delete s[project][name];
    write(s);
    return { ok: true };
  }
  if (!keychainAvailable()) return { ok: false, error: 'The system keychain is not available, so the secret was not saved. Set it in a .env beside the project instead.' };
  s[project] = { ...(s[project] ?? {}), [name]: safeStorage.encryptString(value).toString('base64') };
  write(s);
  return { ok: true };
}

/// Forgets every secret saved for a project — when it is deleted.
export function clearSecrets(project: string): void {
  const s = read();
  if (!s[project]) return;
  delete s[project];
  write(s);
}

export function keychainSource(project: string): (name: string) => string | undefined {
  return (name) => getSecret(project, name);
}
