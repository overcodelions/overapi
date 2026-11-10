// Handing a project to overcli, which publishes it to the org's server
// (overgo). The format and the whole road are described in
// src/shared/overgo.ts.
//
// "Can overcli take it?" is answered by the folder: overcli makes
// ~/.overcli/inbox/apis/ when it can read it, so the folder existing is
// the whole handshake — the same rule overdb uses for connections. This
// never creates the folder; a file nobody reads is worse than a button
// that says why it is greyed out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiPushFileName, buildApiPush } from '../shared/overgo';
import type { Project } from '../shared/project';

export function overcliApisDir(): string {
  return path.join(os.homedir(), '.overcli', 'inbox', 'apis');
}

export function overcliTakesApis(dir = overcliApisDir()): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function sendToOvercli(project: Project, env: string, opts: { dir?: string; now?: number; id?: string } = {}): { ok: true; id: string } | { ok: false; error: string } {
  const dir = opts.dir ?? overcliApisDir();
  if (!overcliTakesApis(dir)) {
    return { ok: false, error: 'overcli isn’t installed here, or is too old to publish APIs. Update overcli and open it once, then try again.' };
  }
  const built = buildApiPush(project, env, { id: opts.id ?? randomUUID(), now: opts.now ?? Date.now() });
  if (!built.ok) return built;
  const final = path.join(dir, apiPushFileName(built.push));
  // Not ending in .json until the rename, so overcli's watcher never reads
  // half a file.
  const tmp = `${final}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(built.push, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, final);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: `Could not write to overcli’s inbox: ${(e as Error).message}` };
  }
  return { ok: true, id: built.push.id };
}
