// A sign-in token printed by a command: `gcloud auth print-access-token`,
// `az account get-access-token --query accessToken -o tsv`, a company's
// SSO tool. One way in to every provider that has a CLI, without overapi
// knowing each one.
//
// The command itself is read from this Mac's keychain only — never the
// environment or a .env, which a shared project can bring with it. The
// project only names it, so opening someone else's project never runs a
// command you didn't save yourself.

import { execFile } from 'node:child_process';
import type { AuthSpec, EnvDef } from '../shared/project';
import type { VarSource, Vars } from './vars';

export type CommandAuth = Extract<AuthSpec, { type: 'command' }>;
export type RunCommand = (command: string, timeoutMs: number) => Promise<string>;

export const commandKey = (env: string) => `__cmd:${env}`;
export const commandAtKey = (env: string) => `__cmd_at:${env}`;

/// Runs it in the person's login shell: an app opened from the Dock has a
/// bare PATH, and gcloud or az live in the one their shell sets up.
export const runShell: RunCommand = (command, timeoutMs) =>
  new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-lc', command], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const said = String(stderr ?? '')
          .trim()
          .split('\n')
          .filter(Boolean)
          .pop();
        reject(new Error((said || (err.killed ? `no answer after ${Math.round(timeoutMs / 1000)} s` : err.message)).slice(0, 300)));
      } else resolve(String(stdout));
    });
  });

/// The token in what the command printed: a line of text, or JSON with an
/// access_token (az, gcloud --format=json, most SSO tools).
export function tokenFrom(out: string): string {
  const text = out.trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const k of ['access_token', 'accessToken', 'token', 'id_token', 'idToken']) if (typeof j[k] === 'string' && j[k]) return j[k] as string;
    } catch {
      // Not JSON after all: the first line, below.
    }
  }
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

export interface CommandDeps {
  vars: VarSource;
  /// The keychain alone; else `vars.keychain` (withKeychain).
  keychain?: VarSource;
  runtime: Record<string, string>;
  now?: () => number;
  timeoutMs?: number;
  run?: RunCommand;
}

/// The token: the kept one while it's fresh, else the command run again.
/// `force`: the API refused the kept one.
export async function commandToken(a: CommandAuth, env: EnvDef, deps: CommandDeps, force = false): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const kept = deps.runtime[commandKey(env.name)];
  const at = Number(deps.runtime[commandAtKey(env.name)] || 0);
  if (!force && kept && now - at < (a.refreshMinutes ?? 15) * 60_000) return kept;
  const command = (deps.keychain ?? (deps.vars as Vars).keychain)?.(a.commandVar);
  if (!command?.trim())
    throw new Error(`The token command (${a.commandVar}) isn't saved in this Mac's keychain. Save it under Environments → Sign-in — a command is only ever read from the keychain.`);
  let out: string;
  try {
    out = await (deps.run ?? runShell)(command, deps.timeoutMs ?? 30_000);
  } catch (e) {
    throw new Error(`The token command failed: ${(e as Error).message}`);
  }
  const token = tokenFrom(out);
  if (!token) throw new Error('The token command printed nothing. It should print the token.');
  deps.runtime[commandKey(env.name)] = token;
  deps.runtime[commandAtKey(env.name)] = String(now);
  return token;
}
