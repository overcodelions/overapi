// "Ask": a question in plain words, answered by the person's own claude
// using this API's MCP server — the same tools Claude Code would get — so
// you see whether an agent can really do it, step by step.
//
// The server runs here in the app (so secrets come from the keychain), on
// 127.0.0.1 with a one-time key, read-only whatever the environment
// allows. claude gets that server and nothing else: no files, no shell, no
// other MCP servers, nothing that prompts.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type ServeOptions } from '../core/server';

export type AskEvent =
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'result'; id: string; text: string; isError: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'done'; answer: string; ms: number; turns?: number; tokens?: number; cost?: number }
  | { kind: 'error'; text: string };

/// This API's MCP server over HTTP, for one ask.
export async function startAskServer(opts: Omit<ServeOptions, 'readOnly'>): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomUUID();
  const server = createServer({ ...opts, readOnly: true, watchMs: 0 });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  const httpServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || !req.url?.startsWith('/mcp')) {
      res.writeHead(401).end();
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => {
      void server.close();
      httpServer.close();
    },
  };
}

const SERVER = 'api';

export function runAsk(opts: { bin: string; question: string; title: string; url: string; token: string; model?: string; onEvent: (e: AskEvent) => void }): { done: Promise<void>; stop: () => void } {
  const mcp = JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: opts.url, headers: { Authorization: `Bearer ${opts.token}` } } } });
  const args = [
    '-p',
    '-',
    '--output-format=stream-json',
    '--verbose',
    '--mcp-config',
    mcp,
    '--strict-mcp-config',
    '--tools=',
    `--allowedTools=mcp__${SERVER}`,
    '--permission-mode=dontAsk',
    '--no-session-persistence',
    ...(opts.model ? ['--model', opts.model] : []),
  ];
  const prompt = `Answer this question using the ${opts.title} tools you have. Call the tools you need — look things up rather than guessing — and when a tool needs an id, find it with another tool first. Then answer briefly and plainly, with the facts you found.\n\nQuestion: ${opts.question}`;
  const child = spawn(opts.bin, args, { env: process.env });
  const started = Date.now();
  let pending = '';
  let stderr = '';
  let finished = false;
  const strip = (name: string) => name.replace(`mcp__${SERVER}__`, '');
  const handle = (line: string) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'tool_use') opts.onEvent({ kind: 'tool', id: c.id, name: strip(c.name), input: c.input });
        else if (c.type === 'text' && c.text?.trim()) opts.onEvent({ kind: 'text', text: c.text.trim() });
      }
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join('\n');
        opts.onEvent({ kind: 'result', id: c.tool_use_id, text: text.slice(0, 4000), isError: !!c.is_error });
      }
    } else if (m.type === 'result') {
      finished = true;
      const usage = m.usage ?? {};
      const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (m.is_error || m.subtype !== 'success') opts.onEvent({ kind: 'error', text: m.result || 'claude stopped before answering.' });
      else opts.onEvent({ kind: 'done', answer: String(m.result ?? '').trim(), ms: Date.now() - started, turns: m.num_turns, tokens: tokens || undefined, cost: m.total_cost_usd });
    }
  };
  child.stdout.on('data', (b) => {
    pending += b.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) handle(l);
  });
  child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
  child.stdin.on('error', () => undefined);
  child.stdin.write(prompt);
  child.stdin.end();
  const done = new Promise<void>((resolve) => {
    child.on('error', () => {
      opts.onEvent({ kind: 'error', text: 'claude is not installed or not on your PATH.' });
      resolve();
    });
    child.on('close', () => {
      if (pending) handle(pending);
      if (!finished) opts.onEvent({ kind: 'error', text: stderr.trim().split('\n').slice(-2).join(' ') || 'claude stopped before answering.' });
      resolve();
    });
  });
  return {
    done,
    stop: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    },
  };
}
