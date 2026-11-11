import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AskEvent } from './ask';

// ---- a fake claude process ------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written = '';
  ended = false;
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => {
      this.written += s;
      return true;
    },
    end: () => {
      this.ended = true;
    },
  });
  kill = vi.fn((_sig?: string) => true);
  out(...lines: unknown[]) {
    this.stdout.emit('data', Buffer.from(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'));
  }
}

const spawned: { bin: string; args: string[]; opts: unknown; child: FakeChild }[] = [];
vi.mock('node:child_process', () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const child = new FakeChild();
    spawned.push({ bin, args, opts, child });
    return child;
  }),
}));

const connect = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);
const createServer = vi.fn((_o: unknown) => ({ connect, close }));
vi.mock('../core/server', () => ({ createServer: (o: unknown) => createServer(o) }));

const { runAsk, startAskServer } = await import('./ask');

function ask(over: Partial<Parameters<typeof runAsk>[0]> = {}) {
  const events: AskEvent[] = [];
  const r = runAsk({ bin: '/usr/local/bin/claude', question: 'Which teams are in the league?', title: 'Acme League', url: 'http://127.0.0.1:1234/mcp', token: 'tok-1', onEvent: (e) => events.push(e), ...over });
  const { child, args, bin, opts } = spawned.at(-1)!;
  return { ...r, events, child, args, bin, opts };
}

beforeEach(() => {
  spawned.length = 0;
});

describe('runAsk: arguments', () => {
  it('runs claude with only this API server, no other tools, and nothing that prompts', () => {
    const { args, bin, opts } = ask();
    expect(bin).toBe('/usr/local/bin/claude');
    expect(args.slice(0, 4)).toEqual(['-p', '-', '--output-format=stream-json', '--verbose']);
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    expect(mcp).toEqual({ mcpServers: { api: { type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer tok-1' } } } });
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--tools=');
    expect(args).toContain('--allowedTools=mcp__api');
    expect(args).toContain('--permission-mode=dontAsk');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--model');
    expect(opts).toEqual({ env: process.env });
  });

  it('passes a model when one is chosen', () => {
    const { args } = ask({ model: 'acme-large' });
    expect(args.slice(-2)).toEqual(['--model', 'acme-large']);
  });

  it('sends the question on stdin, not as an argument', () => {
    const { child, args } = ask();
    expect(child.written).toContain('Question: Which teams are in the league?');
    expect(child.written).toContain('using the Acme League tools');
    expect(child.ended).toBe(true);
    expect(args.join(' ')).not.toContain('Which teams');
  });
});

describe('runAsk: stream-json events', () => {
  it('reports tool calls (prefix stripped), their results, text and the answer', async () => {
    const { child, events, done } = ask();
    child.out(
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '  Let me look.  ' }, { type: 'text', text: '   ' }, { type: 'tool_use', id: 't1', name: 'mcp__api__list_teams', input: { season: 2024 } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '[{"name":"Acme FC"}]' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], is_error: true }, { type: 'text', text: 'ignored' }] } },
      { type: 'result', subtype: 'success', result: '  Acme FC and Acme Rovers.\n', num_turns: 3, total_cost_usd: 0.012, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 } },
    );
    child.emit('close', 0);
    await done;
    expect(events.slice(0, 4)).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool', id: 't1', name: 'list_teams', input: { season: 2024 } },
      { kind: 'result', id: 't1', text: '[{"name":"Acme FC"}]', isError: false },
      { kind: 'result', id: 't2', text: 'a\n\nb', isError: true },
    ]);
    expect(events[4]).toMatchObject({ kind: 'done', answer: 'Acme FC and Acme Rovers.', turns: 3, tokens: 116, cost: 0.012 });
    expect((events[4] as { ms: number }).ms).toBeGreaterThanOrEqual(0);
    expect(events).toHaveLength(5);
  });

  it('caps a tool result at 4000 characters', async () => {
    const { child, events } = ask();
    child.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5000) }] } });
    expect((events[0] as { text: string }).text).toHaveLength(4000);
  });

  it('leaves tokens undefined when there is no usage, and answer empty when there is no result text', async () => {
    const { child, events } = ask();
    child.out({ type: 'result', subtype: 'success' });
    expect(events[0]).toMatchObject({ kind: 'done', answer: '', tokens: undefined });
  });

  it('reports an error result', () => {
    const a = ask();
    a.child.out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Hit the turn limit' });
    expect(a.events).toEqual([{ kind: 'error', text: 'Hit the turn limit' }]);
    const b = ask();
    b.child.out({ type: 'result', subtype: 'error_during_execution' });
    expect(b.events).toEqual([{ kind: 'error', text: 'claude stopped before answering.' }]);
  });

  it('reassembles lines split across chunks, and skips lines that are not JSON', () => {
    const { child, events } = ask();
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    child.stdout.emit('data', Buffer.from('warning: not json\n' + line.slice(0, 10)));
    expect(events).toEqual([]);
    child.stdout.emit('data', Buffer.from(line.slice(10) + '\n'));
    expect(events).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('handles a last line without a newline on close', async () => {
    const { child, events, done } = ask();
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })));
    child.emit('close', 0);
    await done;
    expect(events).toEqual([expect.objectContaining({ kind: 'done', answer: 'ok' })]);
  });

  it('ignores messages with no content', () => {
    const { child, events } = ask();
    child.out({ type: 'assistant' }, { type: 'user', message: {} }, { type: 'assistant', message: { content: null } });
    expect(events).toEqual([]);
  });
});

describe('runAsk: ending', () => {
  it('closing without a result reports the last two lines of stderr', async () => {
    const { child, events, done } = ask();
    child.stderr.emit('data', Buffer.from('one\ntwo\n'));
    child.stderr.emit('data', Buffer.from('Error: not signed in\n'));
    child.emit('close', 1);
    await done;
    expect(events).toEqual([{ kind: 'error', text: 'two Error: not signed in' }]);
  });

  it('closing without a result or stderr says claude stopped', async () => {
    const { child, events, done } = ask();
    child.emit('close', 1);
    await done;
    expect(events).toEqual([{ kind: 'error', text: 'claude stopped before answering.' }]);
  });

  it('a spawn error means claude is not installed', async () => {
    const { child, events, done } = ask();
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await done;
    expect(events).toEqual([{ kind: 'error', text: 'claude is not installed or not on your PATH.' }]);
  });

  it('a stdin error (claude gone early) does not throw', () => {
    const { child } = ask();
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('stop() sends SIGTERM and swallows a kill failure', () => {
    const { child, stop } = ask();
    stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(() => stop()).not.toThrow();
  });
});

// ---- the ask server's door ------------------------------------------------------

describe('startAskServer', () => {
  let srv: Awaited<ReturnType<typeof startAskServer>>;
  beforeEach(async () => {
    createServer.mockClear();
    srv = await startAskServer({ project: { name: 'acme' } } as never);
  });
  afterEach(() => srv.close());

  const call = (path: string, init: { method?: string; auth?: string; body?: string } = {}) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(srv.url);
      const req = http.request({ host: u.hostname, port: u.port, path, method: init.method ?? 'GET', headers: init.auth ? { authorization: init.auth, 'content-type': 'application/json' } : {} }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(init.body);
    });

  it('listens on 127.0.0.1 with a one-time key, always read-only', () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(srv.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true, watchMs: 0 }));
    expect(connect).toHaveBeenCalled();
  });

  it('a read-only flag passed in cannot be turned off', async () => {
    srv.close();
    createServer.mockClear();
    srv = await startAskServer({ readOnly: false } as never);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  it('turns away requests without the key, with the wrong key, or off /mcp', async () => {
    expect(await call('/mcp', { method: 'POST', body: '{}' })).toBe(401);
    expect(await call('/mcp', { method: 'POST', auth: 'Bearer wrong', body: '{}' })).toBe(401);
    expect(await call('/other', { auth: `Bearer ${srv.token}` })).toBe(401);
  });

  it('rejects a POST body that is not JSON', async () => {
    expect(await call('/mcp', { method: 'POST', auth: `Bearer ${srv.token}`, body: '{nope' })).toBe(400);
  });

  it('close() shuts the MCP server', () => {
    srv.close();
    expect(close).toHaveBeenCalled();
    srv = { close: () => undefined } as never;
  });
});
