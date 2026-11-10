// overapi as an MCP *client*: the agent's side of the wire.
//
// Two uses, one session type:
//   * self  — this project's own server for one environment, connected in
//             process. What you see is exactly what an agent gets: the
//             tool list after the safety filter, the schemas, the
//             instructions, the confirm flag, the cut-off responses.
//   * other — any MCP server, started as a command (stdio) or reached by
//             URL (Streamable HTTP), to compare against or just to use.
//
// Electron-free, like the rest of core.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type McpTarget =
  | { kind: 'self'; server: Server; label: string }
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string> };

export interface McpInfo {
  name: string;
  version: string;
  instructions?: string;
  tools: Tool[];
  /// What the tool list costs an agent every turn, roughly.
  approxTokens: number;
}

export interface McpCallResult {
  isError: boolean;
  ms: number;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structured?: unknown;
}

/// ~4 characters per token: rough, and labelled as rough wherever it shows.
export function approxTokens(tools: Tool[]): number {
  return Math.round(JSON.stringify(tools).length / 4);
}

export class McpSession {
  private client: Client;
  private closeExtra: () => Promise<void> = async () => undefined;
  private stderr = '';

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(target: McpTarget, opts: { onToolsChanged?: () => void; timeoutMs?: number } = {}): Promise<McpSession> {
    const client = new Client({ name: 'overapi', version: '0.2.0' });
    const session = new McpSession(client);
    if (opts.onToolsChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => opts.onToolsChanged?.());
    }
    const timeout = opts.timeoutMs ?? 20_000;
    const withTimeout = <T>(p: Promise<T>, what: string) =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${timeout / 1000} s.`)), timeout))]);

    if (target.kind === 'self') {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await target.server.connect(a);
      await client.connect(b);
      session.closeExtra = () => target.server.close();
      return session;
    }
    if (target.kind === 'stdio') {
      if (!target.command.trim()) throw new Error('Give the command that starts the server.');
      const transport = new StdioClientTransport({
        command: target.command,
        args: target.args,
        env: { ...(process.env as Record<string, string>), ...(target.env ?? {}) },
        cwd: target.cwd,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (d: Buffer) => (session.stderr = (session.stderr + d.toString('utf8')).slice(-4000)));
      try {
        await withTimeout(client.connect(transport), 'Starting the server');
      } catch (e) {
        const tail = session.stderr.trim().split('\n').slice(-4).join('\n');
        throw new Error(`${(e as Error).message}${tail ? `\n\nThe server said:\n${tail}` : ''}`);
      }
      return session;
    }
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      throw new Error(`"${target.url}" is not a URL.`);
    }
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: target.headers ?? {} } });
    await withTimeout(client.connect(transport), `Connecting to ${url.origin}`);
    return session;
  }

  async info(): Promise<McpInfo> {
    const v = this.client.getServerVersion();
    const tools = await this.allTools();
    return { name: v?.name ?? 'server', version: v?.version ?? '', instructions: this.client.getInstructions(), tools, approxTokens: approxTokens(tools) };
  }

  /// Every page of tools/list.
  async allTools(): Promise<Tool[]> {
    const out: Tool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      out.push(...page.tools);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const started = Date.now();
    const r = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content?: McpCallResult['content']; structuredContent?: unknown };
    return { isError: !!r.isError, ms: Date.now() - started, content: Array.isArray(r.content) ? r.content : [], structured: r.structuredContent };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.closeExtra().catch(() => undefined);
  }
}
