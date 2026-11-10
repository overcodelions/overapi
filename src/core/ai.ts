// AI on the user's own CLI login — no API key, no account, nothing sent
// anywhere the person's own `claude` or `codex` would not send it. The
// invocation shapes are overdb's (src/main/ai.ts there), which took them
// from overgit and overcli.
//
// Electron-free, so the CLI could use it too.

import { spawn } from 'node:child_process';

export type AiTool = 'claude' | 'codex';
export const AI_TOOLS: AiTool[] = ['claude', 'codex'];

export function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['--version'], { env: process.env });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

export async function detectTools(): Promise<Record<AiTool, boolean>> {
  const [claude, codex] = await Promise.all(AI_TOOLS.map((t) => probe(t)));
  return { claude, codex };
}

export interface AiResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface AiRun {
  result: Promise<AiResult>;
  cancel(): void;
}

/// claude, reading a folder of documents with file tools only.
///
/// The documents are untrusted — a page fetched from anywhere — so the run
/// gets exactly Read, Grep and Glob: no shell, no web, no MCP servers, no
/// user settings, nothing that prompts. A document that says "run this"
/// has nothing to run it with.
export const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/// `webDomain`: let claude also fetch pages — on that one host only. A
/// docs site is explored by following its own links; anything off-site is
/// refused, since nothing prompts in dontAsk mode.
export function readerArgs(model?: string, webDomain?: string): string[] {
  const tools = webDomain ? [...READ_TOOLS, 'WebFetch'] : [...READ_TOOLS];
  return [
    '-p',
    '-',
    '--output-format=stream-json',
    '--verbose',
    `--tools=${tools.join(',')}`,
    ...(webDomain ? [`--allowedTools=WebFetch(domain:${webDomain})`] : []),
    '--restricted',
    '--strict-mcp-config',
    '--permission-mode=dontAsk',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
}

export function runClaudeReader(prompt: string, opts: { cwd: string; onStep?: (text: string) => void; timeoutMs?: number; model?: string; webDomain?: string }): AiRun {
  const child = spawn('claude', readerArgs(opts.model, opts.webDomain), { cwd: opts.cwd, env: process.env });
  let stdout = '';
  let stderr = '';
  let pending = '';
  let settled = false;
  let resolveResult: (r: AiResult) => void = () => undefined;
  const result = new Promise<AiResult>((r) => (resolveResult = r));
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000;
  const timer = setTimeout(() => {
    kill();
    done({ ok: false, output: '', error: `claude took longer than ${Math.round(timeoutMs / 60_000)} minutes — stopped.` });
  }, timeoutMs);
  function done(r: AiResult) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(r);
  }
  function kill() {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  child.stdout.on('data', (b) => {
    const chunk = b.toString('utf-8');
    stdout += chunk;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) for (const step of stepsFromLine(line, opts.cwd)) opts.onStep?.(step);
  });
  child.stderr.on('data', (b) => (stderr += b.toString('utf-8')));
  child.on('error', () => done({ ok: false, output: '', error: 'claude is not installed or not on PATH.' }));
  child.on('close', (code) => {
    const final = finalResult(stdout);
    if (code === 0 && final?.ok && final.text) done({ ok: true, output: final.text });
    else done({ ok: false, output: final?.text ?? '', error: stderr.trim() || final?.text || `claude exited with ${code}` });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.write(prompt);
  child.stdin.end();
  return {
    result,
    cancel() {
      kill();
      done({ ok: false, output: '', error: 'Stopped.' });
    },
  };
}

/// codex, with the documents inline in the prompt (it has no read-only
/// file mode that is not also a shell, so it gets no folder at all).
export function runCodex(prompt: string, opts: { timeoutMs?: number; cwd?: string } = {}): AiRun {
  const child = spawn('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], { env: process.env, cwd: opts.cwd });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let resolveResult: (r: AiResult) => void = () => undefined;
  const result = new Promise<AiResult>((r) => (resolveResult = r));
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000;
  const timer = setTimeout(() => {
    kill();
    done({ ok: false, output: '', error: `codex took longer than ${Math.round(timeoutMs / 60_000)} minutes — stopped.` });
  }, timeoutMs);
  function done(r: AiResult) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(r);
  }
  function kill() {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  child.stdout.on('data', (b) => (stdout += b.toString('utf-8')));
  child.stderr.on('data', (b) => (stderr += b.toString('utf-8')));
  child.on('error', () => done({ ok: false, output: '', error: 'codex is not installed or not on PATH.' }));
  child.on('close', (code) => {
    const body = codexBody(stdout);
    if (code === 0 && body) done({ ok: true, output: body });
    else done({ ok: false, output: body, error: stderr.trim().split('\n').slice(-3).join('\n') || `codex exited with ${code}` });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.write(prompt);
  child.stdin.end();
  return {
    result,
    cancel() {
      kill();
      done({ ok: false, output: '', error: 'Stopped.' });
    },
  };
}

/// What claude is doing, one line per tool call — which file it read, what
/// it searched for. Never a file's contents.
export function stepsFromLine(line: string, cwd: string): string[] {
  let event: { type?: string; message?: { content?: unknown } };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const rel = (p: unknown) => {
    const s = typeof p === 'string' ? p : '';
    return s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
  };
  const out: string[] = [];
  for (const part of event.message!.content as Array<Record<string, unknown>>) {
    if (part.type !== 'tool_use') continue;
    const input = (part.input ?? {}) as Record<string, unknown>;
    if (part.name === 'Read') out.push(`Reading ${rel(input.file_path)}`);
    else if (part.name === 'Grep') out.push(`Searching for "${String(input.pattern ?? '')}"`);
    else if (part.name === 'Glob') out.push(`Listing ${String(input.pattern ?? '')}`);
    else if (part.name === 'WebFetch') out.push(`Fetching ${String(input.url ?? '')}`);
  }
  return out;
}

export function finalResult(stdout: string): { ok: boolean; text: string } | null {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as { type?: string; result?: unknown; is_error?: boolean };
      if (e.type === 'result') return { ok: !e.is_error, text: typeof e.result === 'string' ? e.result : '' };
    } catch {
      /* partial */
    }
  }
  return null;
}

function codexBody(raw: string): string {
  const parts: string[] = [];
  let inCodex = false;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\[[^\]]+\]\s*([a-z_]+)\s*$/);
    if (m) {
      inCodex = m[1] === 'codex';
      continue;
    }
    if (inCodex) parts.push(line);
  }
  return parts.join('\n').trim() || raw.trim();
}
