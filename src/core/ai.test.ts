// The AI runners without running any AI: child_process is replaced with a
// fake child the test drives (stdout, stderr, exit code, errors).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinWritten = '';
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => {
      this.stdinWritten += s;
      return true;
    },
    end: vi.fn(),
  });
  killed: string[] = [];
  killThrows = false;
  kill(sig: string) {
    if (this.killThrows) throw new Error('already gone');
    this.killed.push(sig);
    return true;
  }
}

const spawned: { cmd: string; args: string[]; opts: Record<string, unknown>; child: FakeChild }[] = [];
let spawnImpl: (cmd: string, args: string[]) => FakeChild = () => new FakeChild();

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const child = spawnImpl(cmd, args);
    spawned.push({ cmd, args, opts, child });
    return child;
  },
}));

const ai = await import('./ai');

beforeEach(() => {
  spawned.length = 0;
  spawnImpl = () => new FakeChild();
});
afterEach(() => vi.useRealTimers());

const out = (c: FakeChild, s: string) => c.stdout.emit('data', Buffer.from(s, 'utf-8'));
const err = (c: FakeChild, s: string) => c.stderr.emit('data', Buffer.from(s, 'utf-8'));
const last = () => spawned[spawned.length - 1].child;

describe('probe and detectTools', () => {
  it('is true only when the command exits 0', async () => {
    const p = ai.probe('claude');
    expect(spawned[0].args).toEqual(['--version']);
    last().emit('close', 0);
    expect(await p).toBe(true);
    const q = ai.probe('codex');
    last().emit('close', 2);
    expect(await q).toBe(false);
  });

  it('is false when the command is missing, and settles once', async () => {
    const p = ai.probe('nope');
    last().emit('error', new Error('ENOENT'));
    last().emit('close', 0);
    expect(await p).toBe(false);
  });

  it('is false when spawn itself throws', async () => {
    spawnImpl = () => {
      throw new Error('spawn EACCES');
    };
    expect(await ai.probe('claude')).toBe(false);
  });

  it('checks both tools', async () => {
    spawnImpl = (cmd) => {
      const c = new FakeChild();
      setTimeout(() => c.emit('close', cmd === 'claude' ? 0 : 1));
      return c;
    };
    expect(await ai.detectTools()).toEqual({ claude: true, codex: false });
    expect(spawned.map((s) => s.cmd).sort()).toEqual(['claude', 'codex']);
  });
});

describe('readerArgs', () => {
  it('passes a model when given', () => {
    const args = ai.readerArgs('sonnet');
    expect(args.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(args.slice(0, 2)).toEqual(['-p', '-']);
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--output-format=stream-json');
  });
});

describe('stepsFromLine', () => {
  const line = (content: unknown[], type = 'assistant') => JSON.stringify({ type, message: { content } });

  it('says what each tool call does, with paths relative to the folder', () => {
    const steps = ai.stepsFromLine(
      line([
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/work/docs/a.md' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/elsewhere/b.md' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'orders' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.pdf' } },
        { type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.acme.example/api' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } },
      ]),
      '/work/docs',
    );
    expect(steps).toEqual(['Reading a.md', 'Reading /elsewhere/b.md', 'Searching for "orders"', 'Listing **/*.pdf', 'Fetching https://docs.acme.example/api']);
  });

  it('copes with missing inputs', () => {
    expect(ai.stepsFromLine(line([{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep', input: {} }, { type: 'tool_use', name: 'Glob', input: {} }, { type: 'tool_use', name: 'WebFetch', input: {} }]), '/w')).toEqual([
      'Reading ',
      'Searching for ""',
      'Listing ',
      'Fetching ',
    ]);
  });

  it('ignores other events and lines that are not JSON', () => {
    expect(ai.stepsFromLine('not json', '/w')).toEqual([]);
    expect(ai.stepsFromLine(line([{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }], 'user'), '/w')).toEqual([]);
    expect(ai.stepsFromLine(JSON.stringify({ type: 'assistant', message: { content: 'text' } }), '/w')).toEqual([]);
    expect(ai.stepsFromLine(JSON.stringify({ type: 'assistant' }), '/w')).toEqual([]);
  });
});

describe('finalResult', () => {
  it('takes the last result event', () => {
    const stdout = [JSON.stringify({ type: 'result', result: 'old' }), JSON.stringify({ type: 'assistant' }), JSON.stringify({ type: 'result', result: 'final answer' }), '{"partial'].join('\n');
    expect(ai.finalResult(stdout)).toEqual({ ok: true, text: 'final answer' });
  });

  it('marks an error result, and a non-string result as empty', () => {
    expect(ai.finalResult(JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance too low' }))).toEqual({ ok: false, text: 'Credit balance too low' });
    expect(ai.finalResult(JSON.stringify({ type: 'result', result: { x: 1 } }))).toEqual({ ok: true, text: '' });
  });

  it('is null without a result event', () => {
    expect(ai.finalResult('')).toBeNull();
    expect(ai.finalResult('garbage\n{"type":"assistant"}')).toBeNull();
  });
});

describe('runClaudeReader', () => {
  it('sends the prompt on stdin, reports steps across split chunks, and returns the result', async () => {
    const steps: string[] = [];
    const run = ai.runClaudeReader('Describe the API.', { cwd: '/work', onStep: (s) => steps.push(s), model: 'opus', webDomain: 'docs.acme.example' });
    const c = last();
    expect(spawned[0].cmd).toBe('claude');
    expect(spawned[0].opts.cwd).toBe('/work');
    expect(spawned[0].args).toContain('--allowedTools=WebFetch(domain:docs.acme.example)');
    expect(spawned[0].args).toContain('opus');
    expect(c.stdinWritten).toBe('Describe the API.');
    expect(c.stdin.end).toHaveBeenCalled();
    const toolLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/guide.md' } }] } });
    out(c, toolLine.slice(0, 20));
    expect(steps).toEqual([]);
    out(c, `${toolLine.slice(20)}\n`);
    expect(steps).toEqual(['Reading guide.md']);
    out(c, `${JSON.stringify({ type: 'result', result: '```json\n{}\n```' })}\n`);
    c.emit('close', 0);
    expect(await run.result).toEqual({ ok: true, output: '```json\n{}\n```' });
  });

  it('works without an onStep handler', async () => {
    const run = ai.runClaudeReader('p', { cwd: '/w' });
    const c = last();
    out(c, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '*' } }] } })}\n`);
    out(c, JSON.stringify({ type: 'result', result: 'done' }));
    c.emit('close', 0);
    expect(await run.result).toEqual({ ok: true, output: 'done' });
  });

  it('fails with stderr, else the result text, else the exit code', async () => {
    let run = ai.runClaudeReader('p', { cwd: '/w' });
    err(last(), '  Not logged in  \n');
    last().emit('close', 1);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'Not logged in' });

    run = ai.runClaudeReader('p', { cwd: '/w' });
    out(last(), JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached' }));
    last().emit('close', 0);
    expect(await run.result).toEqual({ ok: false, output: 'Usage limit reached', error: 'Usage limit reached' });

    run = ai.runClaudeReader('p', { cwd: '/w' });
    last().emit('close', 3);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'claude exited with 3' });
  });

  it('fails plainly when claude is not installed', async () => {
    const run = ai.runClaudeReader('p', { cwd: '/w' });
    last().emit('error', new Error('spawn claude ENOENT'));
    last().emit('close', -2);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'claude is not installed or not on PATH.' });
  });

  it('stops after the timeout and kills the process', async () => {
    vi.useFakeTimers();
    const run = ai.runClaudeReader('p', { cwd: '/w', timeoutMs: 120_000 });
    vi.advanceTimersByTime(120_001);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'claude took longer than 2 minutes — stopped.' });
    expect(last().killed).toEqual(['SIGTERM']);
  });

  it('cancels, even if the process is already gone, and ignores a stdin error', async () => {
    const run = ai.runClaudeReader('p', { cwd: '/w' });
    const c = last();
    c.stdin.emit('error', new Error('EPIPE'));
    c.killThrows = true;
    run.cancel();
    c.emit('close', 0);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'Stopped.' });
  });
});

describe('runCodex', () => {
  it('runs read-only and keeps only the codex part of the transcript', async () => {
    const run = ai.runCodex('Describe it.', { cwd: '/w' });
    const c = last();
    expect(spawned[0].cmd).toBe('codex');
    expect(spawned[0].args).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']);
    expect(c.stdinWritten).toBe('Describe it.');
    out(c, '[2026-11-10T10:00:00] OpenAI Codex v1\n[2026-11-10T10:00:01] user\nDescribe it.\n');
    out(c, '[2026-11-10T10:00:02] codex\n{"brief": "B"}\n[2026-11-10T10:00:03] tokens_used\n1234\n');
    c.emit('close', 0);
    expect(await run.result).toEqual({ ok: true, output: '{"brief": "B"}' });
  });

  it('falls back to the whole output when there are no markers', async () => {
    const run = ai.runCodex('p');
    out(last(), '  plain answer  \n');
    last().emit('close', 0);
    expect(await run.result).toEqual({ ok: true, output: 'plain answer' });
  });

  it('fails with the last three lines of stderr, or the exit code', async () => {
    let run = ai.runCodex('p');
    err(last(), 'one\ntwo\nthree\nfour\n');
    last().emit('close', 1);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'two\nthree\nfour' });

    run = ai.runCodex('p');
    last().emit('close', 9);
    expect(await run.result).toEqual({ ok: false, output: '', error: 'codex exited with 9' });
  });

  it('fails plainly when codex is not installed', async () => {
    const run = ai.runCodex('p');
    last().emit('error', new Error('ENOENT'));
    expect(await run.result).toEqual({ ok: false, output: '', error: 'codex is not installed or not on PATH.' });
  });

  it('times out and can be cancelled', async () => {
    vi.useFakeTimers();
    const slow = ai.runCodex('p', { timeoutMs: 60_000 });
    const c = last();
    vi.advanceTimersByTime(60_001);
    expect(await slow.result).toEqual({ ok: false, output: '', error: 'codex took longer than 1 minutes — stopped.' });
    expect(c.killed).toEqual(['SIGTERM']);
    vi.useRealTimers();

    const run = ai.runCodex('p');
    last().killThrows = true;
    last().stdin.emit('error', new Error('EPIPE'));
    run.cancel();
    run.cancel();
    expect(await run.result).toEqual({ ok: false, output: '', error: 'Stopped.' });
  });
});
