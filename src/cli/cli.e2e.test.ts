// The CLI as a person and an MCP client meet it: a real process, real exit
// codes, real stdio, real HTTP against the acme example servers.
//
// The CLI is bundled once with esbuild (it ships with vite) into a temp
// folder and run with plain Node, so nothing here depends on a prior
// `npm run build` or on tsx being installed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const TOKEN = 'acme-e2e-token';

let tmp: string;
let cli: string;
let ordersPort: number;
let ordersProc: ChildProcess;
let inventory: http.Server;
let inventoryPort: number;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, ACME_ORDERS_TOKEN: TOKEN, ...opts.env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const child = spawn(process.execPath, [cli, ...args], { cwd: opts.cwd ?? tmp, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`overapi ${args.join(' ')} timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, opts.timeoutMs ?? 15_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function startOrders(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(EXAMPLES, 'acme-orders-server.mjs')], {
      env: { ...process.env, PORT: String(port), ACME_ORDERS_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`orders server did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (c) => {
      out += c;
      if (out.includes('Acme Orders on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

type Json = Record<string, any>;
const readJson = (f: string): Json => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
};

/// A copy of the imported orders project, changed by `edit`, in its own folder.
let ordersBase: Json;
function ordersVariant(dir: string, edit: (p: Json) => void = () => undefined): string {
  const p = structuredClone(ordersBase);
  edit(p);
  const file = path.join(tmp, dir, 'overapi.json');
  writeJson(file, p);
  return file;
}
const env = (p: Json, name: string) => p.envs.find((e: Json) => e.name === name);

const SCENARIO = {
  id: 'sc-browse',
  name: 'browse orders',
  createdAt: '2026-11-01T00:00:00.000Z',
  steps: [
    {
      id: 's1',
      toolId: 'GET /orders',
      args: { status: 'open' },
      saves: [{ var: 'orderId', from: 'body', path: '[0].id' }],
      expect: { status: '2xx', shape: { t: 'array', of: { t: 'object', keys: { id: { t: 'number' }, status: { t: 'string' } } } } },
      enabled: true,
    },
    { id: 's2', toolId: 'GET /orders/{orderId}', args: { orderId: '{{orderId}}' }, saves: [], expect: { status: 200 }, enabled: true },
    { id: 's3', toolId: 'POST /orders/{orderId}/cancel', args: { orderId: '{{orderId}}' }, saves: [], expect: { status: '2xx' }, enabled: true, write: true },
  ],
};
const BROKEN_SCENARIO = {
  id: 'sc-broken',
  name: 'missing customer',
  createdAt: '2026-11-01T00:00:00.000Z',
  steps: [{ id: 'b1', toolId: 'GET /customers/{customerId}', args: { customerId: 999 }, saves: [], expect: { status: '2xx' }, enabled: true }],
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-cli-e2e-'));
  cli = path.join(tmp, 'overapi-cli.cjs');
  await build({
    entryPoints: [path.join(ROOT, 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: cli,
    logLevel: 'silent',
  });

  ordersPort = await freePort();
  ordersProc = await startOrders(ordersPort);

  const mod = await import(pathToFileURL(path.join(EXAMPLES, 'acme-inventory-soap-server.mjs')).href);
  inventory = mod.createInventoryServer() as http.Server;
  await new Promise<void>((r) => inventory.listen(0, '127.0.0.1', () => r()));
  inventoryPort = (inventory.address() as net.AddressInfo).port;

  // The real import, once; every orders project below is a variant of it.
  const imported = await runCli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '-o', path.join(tmp, 'imported')]);
  expect(imported.code, imported.stderr).toBe(0);
  ordersBase = readJson(path.join(tmp, 'imported', 'overapi.json'));
  env(ordersBase, 'local').baseUrl = `http://127.0.0.1:${ordersPort}/api/v1`;
}, 60_000);

afterAll(async () => {
  ordersProc?.kill();
  await new Promise<void>((r) => (inventory ? inventory.close(() => r()) : r()));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('overapi basics', () => {
  it('prints its version', async () => {
    for (const f of ['--version', '-v']) {
      const r = await runCli([f]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('0.1.0');
    }
  });

  it('prints help with no command, help, --help and -h', async () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const r = await runCli(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage:');
      expect(r.stdout).toContain('overapi serve <overapi.json>');
    }
  });

  it('refuses an unknown command given a project file, exit 1', async () => {
    const file = ordersVariant('unknown-cmd');
    const r = await runCli(['frobnicate', file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('overapi: unknown command frobnicate. Run overapi --help.');
    expect(r.stdout).toBe('');
  });

  // BUG: an unknown command with no further arguments is reported as a
  // missing project file ("frobnicate needs an overapi.json"), because main()
  // shifts the file argument and reads the project before it ever checks the
  // command name. Repro: `overapi frobnicate` -> stderr
  // "overapi: frobnicate needs an overapi.json", exit 1. Expected: the
  // "unknown command" message. Same for `overapi frobnicate missing.json`,
  // which reports the unreadable file instead.
  it('refuses an unknown command even with no project file', async () => {
    const r = await runCli(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command frobnicate');
  });

  it('needs a project file for project commands', async () => {
    const r = await runCli(['tools']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('overapi: tools needs an overapi.json');
  });

  it('fails cleanly on a project file that is not there', async () => {
    const r = await runCli(['tools', path.join(tmp, 'nope', 'overapi.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^overapi: /);
    expect(r.stderr).not.toContain('    at '); // no stack trace
  });

  it('fails cleanly on an unknown environment', async () => {
    const r = await runCli(['call', ordersVariant('bad-env'), 'list_orders', '--env', 'moon']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No environment "moon" in acme-orders. It has: local, staging, production.');
  });
});

describe('overapi import', () => {
  it('imported the OpenAPI example with a summary and a next step', async () => {
    const r = await runCli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '-o', path.join(tmp, 'import-check', 'acme.json')]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Wrote ${path.join(tmp, 'import-check', 'acme.json')}`);
    expect(r.stdout).toContain('7 tools (4 read, 3 write), 3 environments: local http://localhost:4010/api/v1, staging');
    expect(r.stdout).toContain('Next: overapi check');
    expect(readJson(path.join(tmp, 'import-check', 'acme.json')).name).toBe('acme-orders');
  });

  it('writes to ./<name>/overapi.json by default, and --out works like -o', async () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    const r = await runCli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml')], { cwd });
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(cwd, 'acme-orders', 'overapi.json'))).toBe(true);
    expect(r.stdout).toContain(`Next: overapi check ${path.join('acme-orders', 'overapi.json')}`);

    const r2 = await runCli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '--out', path.join(cwd, 'other')], { cwd });
    expect(r2.code, r2.stderr).toBe(0);
    expect(fs.existsSync(path.join(cwd, 'other', 'overapi.json'))).toBe(true);
  });

  it('will not overwrite an existing project', async () => {
    const out = path.join(tmp, 'imported');
    const before = fs.readFileSync(path.join(out, 'overapi.json'), 'utf8');
    const r = await runCli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '-o', out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('already exists. Pass -o to write somewhere else.');
    expect(fs.readFileSync(path.join(out, 'overapi.json'), 'utf8')).toBe(before);
  });

  it('needs something to import, and says when it cannot read it', async () => {
    const none = await runCli(['import']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('import needs a file or URL');

    const missing = await runCli(['import', path.join(tmp, 'no-such-spec.yaml')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read');
    expect(missing.stderr).toContain('ENOENT');
  });

  it('imports a WSDL from a live ?wsdl URL', async () => {
    const out = path.join(tmp, 'wsdl-import');
    const r = await runCli(['import', `http://127.0.0.1:${inventoryPort}/soap/inventory?wsdl`, '-o', out]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('4 tools (2 read, 2 write)');
    const p = readJson(path.join(out, 'overapi.json'));
    expect(p.name).toBe('acme-inventory');
    expect(p.tools.map((t: Json) => t.name)).toEqual(['list_items', 'get_item', 'adjust_stock', 'delete_item']);
  });

  // BUG (example server, not the CLI): examples/acme-inventory-soap-server.mjs
  // rewrites the WSDL's address with String.replace, which only replaces the
  // FIRST occurrence of http://localhost:8089/soap/inventory — and that is in
  // the WSDL's leading XML comment, not <soap:address>. So a WSDL fetched from
  // a server on any other port still points at :8089. Repro:
  // `node examples/acme-inventory-soap-server.mjs 18089` then
  // `overapi import 'http://127.0.0.1:18089/soap/inventory?wsdl'` -> the
  // environment's baseUrl is http://localhost:8089. Fix: replaceAll, or a
  // regex on the location attribute.
  it('a WSDL fetched from a live server points at that server', async () => {
    const p = readJson(path.join(tmp, 'wsdl-import', 'overapi.json'));
    expect(p.envs[0].baseUrl).toBe(`http://127.0.0.1:${inventoryPort}`);
  });

  it('says what a URL answered when it is not OK', async () => {
    const r = await runCli(['import', `http://127.0.0.1:${inventoryPort}/not-here.yaml`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`http://127.0.0.1:${inventoryPort}/not-here.yaml answered 404`);
  });
});

describe('overapi tools / check / install', () => {
  it('lists tools with their safety and what each environment offers', async () => {
    const file = ordersVariant('tools', (p) => {
      env(p, 'staging').allowWrites = true;
      p.tools.find((t: Json) => t.name === 'get_customer').enabled = false;
    });
    const r = await runCli(['tools', file]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines.find((l) => l.includes('list_orders'))).toMatch(/^R {2}list_orders\s+GET\s+\/orders$/);
    expect(lines.find((l) => l.includes('create_order'))).toMatch(/^W /);
    expect(lines.find((l) => l.includes('delete_order'))).toMatch(/^D /);
    expect(lines.find((l) => l.includes('get_customer'))).toMatch(/^- /);
    expect(r.stdout).toContain('R read  W write  D destructive  - off');
    expect(r.stdout).toContain('local: 3 offered (read-only)');
    expect(r.stdout).toContain('staging: 6 offered\n');
  });

  it('check warns about an unset secret and exits 0 without errors', async () => {
    const file = ordersVariant('check');
    const unset = await runCli(['check', file], { env: { ACME_ORDERS_TOKEN: undefined } });
    expect(unset.code).toBe(0);
    expect(unset.stdout).toMatch(/^Agent-readiness \d+\/100/);
    expect(unset.stdout).toContain('! "local" reads ACME_ORDERS_TOKEN, which is not set here.');

    const set = await runCli(['check', file]);
    expect(set.code).toBe(0);
    expect(set.stdout).not.toContain('ACME_ORDERS_TOKEN, which is not set');
  });

  it('check reads the secret from a .env beside the project', async () => {
    const file = ordersVariant('check-dotenv');
    fs.writeFileSync(path.join(path.dirname(file), '.env'), `ACME_ORDERS_TOKEN=${TOKEN}\n`);
    const r = await runCli(['check', file], { env: { ACME_ORDERS_TOKEN: undefined } });
    expect(r.stdout).not.toContain('which is not set');
  });

  it('check exits 1 when there is an error-level issue', async () => {
    const file = ordersVariant('check-error', (p) => {
      p.envs = [{ name: 'local', baseUrl: '', auth: { type: 'none' }, allowWrites: false }];
    });
    const r = await runCli(['check', file]);
    expect(r.stdout).toContain('✗ ');
    expect(r.code).toBe(1);
  });

  it('install prints a snippet for each client, and the JSON one really serves', async () => {
    const file = ordersVariant('install');
    const claude = await runCli(['install', file]);
    expect(claude.code).toBe(0);
    expect(claude.stderr).toMatch(/^# .+: /);
    expect(claude.stdout).toContain(path.resolve(file));

    const codex = await runCli(['install', file, '--client', 'codex']);
    expect(codex.code).toBe(0);
    expect(codex.stdout).toContain('[mcp_servers.');

    const bad = await runCli(['install', file, '--client', 'emacs']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('unknown client emacs; use claude, codex or json');

    const json = await runCli(['install', file, '--client', 'json', '--env', 'local']);
    expect(json.code).toBe(0);
    const servers = JSON.parse(json.stdout).mcpServers as Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    const entry = Object.values(servers)[0];
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([fs.realpathSync(cli), 'serve', path.resolve(file), '--env', 'local']);

    // Start it exactly as a client would from the snippet.
    const client = new Client({ name: 'acme-e2e', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...(process.env as Record<string, string>), ACME_ORDERS_TOKEN: TOKEN }, stderr: 'pipe' }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('list_orders');
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe('overapi call', () => {
  it('makes a real read call and prints the body', async () => {
    const r = await runCli(['call', ordersVariant('call'), 'get_order', '--args', '{"orderId":1001}']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain(`→ GET http://127.0.0.1:${ordersPort}/api/v1/orders/1001`);
    expect(r.stderr).toMatch(/← 200 OK in \d+ ms/);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: 1001, status: 'shipped' });
  });

  it('exits 1 when the API answers with an error', async () => {
    const missing = await runCli(['call', ordersVariant('call'), 'get_order', '--args', '{"orderId":99999}']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('← 404');

    const noToken = await runCli(['call', ordersVariant('call'), 'list_orders'], { env: { ACME_ORDERS_TOKEN: undefined } });
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain('← 401');
  });

  it('will not send a write without --yes, and does with it', async () => {
    const file = ordersVariant('call');
    const refused = await runCli(['call', file, 'cancel_order', '--args', '{"orderId":1002}']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('cancel_order is a write tool. Pass --yes to really send it.');

    const destructive = await runCli(['call', file, 'delete_order', '--args', '{"orderId":1002}']);
    expect(destructive.code).toBe(1);
    expect(destructive.stderr).toContain('delete_order is a destructive tool.');

    const sent = await runCli(['call', file, 'cancel_order', '--args', '{"orderId":1002}', '--yes']);
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({ id: 1002, status: 'cancelled' });
  });

  it('rejects a missing tool name, an unknown tool and bad --args', async () => {
    const file = ordersVariant('call');
    const none = await runCli(['call', file]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('call needs a tool name');

    const unknown = await runCli(['call', file, 'launch_rocket']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no tool named launch_rocket');

    const bad = await runCli(['call', file, 'list_orders', '--args', '{nope']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--args is not JSON');
  });
});

describe('overapi serve', () => {
  async function connect(args: string[], extraEnv: Record<string, string> = {}): Promise<{ client: Client; stderr: () => string }> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', ...args],
      env: { ...(process.env as Record<string, string>), ACME_ORDERS_TOKEN: TOKEN, ...extraEnv },
      stderr: 'pipe',
    });
    let err = '';
    transport.stderr?.on('data', (c) => (err += c));
    const client = new Client({ name: 'acme-e2e', version: '1.0.0' });
    await client.connect(transport);
    return { client, stderr: () => err };
  }
  const text = (r: Json) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

  it('serves only reads on a read-only environment', async () => {
    const { client, stderr } = await connect([ordersVariant('serve-ro'), '--env', 'local']);
    try {
      expect(client.getServerVersion()?.name).toBe('acme-orders');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['get_customer', 'get_order', 'list_orders', 'search_orders']);

      const listed = await client.callTool({ name: 'list_orders', arguments: { limit: 2 } });
      expect(listed.isError).toBe(false);
      expect(text(listed)).toMatch(/^HTTP 200/);
      expect(text(listed)).toContain('"customer_id"');

      const write = await client.callTool({ name: 'create_order', arguments: { customer_id: 1, items: [{ sku: 'ANVIL-1', quantity: 1 }] } });
      expect(write.isError).toBe(true);
      expect(text(write)).toContain('create_order changes data, and the "local" environment is read-only.');

      const unknown = await client.callTool({ name: 'launch_rocket', arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain('No tool named launch_rocket.');

      expect(stderr()).toContain('overapi: serving acme-orders (local');
      expect(stderr()).toContain('— 4 tools');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('serves writes where allowed, and destructive tools need confirm: true', async () => {
    const file = ordersVariant('serve-rw', (p) => (env(p, 'local').allowWrites = true));
    const { client } = await connect([file, '--env', 'local']);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      const del = tools.find((t) => t.name === 'delete_order')!;
      expect(del.inputSchema.required).toContain('confirm');

      const unconfirmed = await client.callTool({ name: 'delete_order', arguments: { orderId: 1001 } });
      expect(unconfirmed.isError).toBe(true);
      expect(text(unconfirmed)).toContain('delete_order is destructive. Call it again with confirm: true');

      const created = await client.callTool({ name: 'create_order', arguments: { customer_id: 2, items: [{ sku: 'TNT-CRATE', quantity: 1 }] } });
      expect(created.isError, text(created)).toBe(false);
      expect(text(created)).toMatch(/^HTTP 201/);
      const id = JSON.parse(text(created).split('\n\n')[1]).id as number;

      const deleted = await client.callTool({ name: 'delete_order', arguments: { orderId: id, confirm: true } });
      expect(deleted.isError, text(deleted)).toBe(false);
      expect(text(deleted)).toMatch(/^HTTP 204/);

      const gone = await client.callTool({ name: 'get_order', arguments: { orderId: id } });
      expect(gone.isError).toBe(true);
      expect(text(gone)).toMatch(/^HTTP 404/);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('defaults to the first environment', async () => {
    const { client, stderr } = await connect([ordersVariant('serve-default')]);
    try {
      await client.listTools();
      expect(stderr()).toContain('(local, ');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('exits 1 on an unknown environment', async () => {
    const r = await runCli(['serve', ordersVariant('serve-bad-env'), '--env', 'moon']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No environment "moon"');
  });

  it('serves a workspace of two APIs, REST and SOAP, as one server', async () => {
    ordersVariant(path.join('shop', 'orders'));
    const inv = readJson(path.join(tmp, 'wsdl-import', 'overapi.json'));
    inv.envs = [{ name: 'local', baseUrl: `http://127.0.0.1:${inventoryPort}`, auth: { type: 'wsse', userVar: 'ACME_INV_USER', passVar: 'ACME_INV_PASS' }, allowWrites: false }];
    const invFile = path.join(tmp, 'shop', 'inventory', 'overapi.json');
    writeJson(invFile, inv);
    fs.writeFileSync(path.join(path.dirname(invFile), '.env'), 'ACME_INV_USER=acme\nACME_INV_PASS=s3cret-pass\n');
    const sys = path.join(tmp, 'shop', 'overapi-system.json');
    writeJson(sys, {
      overapiSystem: 1,
      name: 'acme-shop',
      title: 'Acme Shop',
      members: ['orders/overapi.json', 'inventory/overapi.json', 'gone/overapi.json'],
      instructions: 'Orders and stock for the Acme shop.',
    });

    const { client, stderr } = await connect([sys]);
    try {
      expect(client.getServerVersion()?.name).toBe('acme-shop');
      expect(client.getInstructions()).toContain('Orders and stock for the Acme shop.');
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['list_orders', 'get_order', 'list_items', 'get_item']));
      expect(names).not.toContain('delete_item');

      const items = await client.callTool({ name: 'list_items', arguments: {} });
      expect(items.isError, text(items)).toBe(false);
      expect(text(items)).toContain('HAM-16');

      const orders = await client.callTool({ name: 'get_order', arguments: { orderId: 1001 } });
      expect(orders.isError, text(orders)).toBe(false);
      expect(text(orders)).toMatch(/^HTTP 200/);
      expect(text(orders)).toContain('1001');

      expect(stderr()).toContain('overapi: skipping gone/overapi.json');
      expect(stderr()).toContain('serving workspace acme-shop (local) — 2 APIs');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('exits 1 when none of a workspace’s APIs can be read', async () => {
    const sys = path.join(tmp, 'empty-shop', 'overapi-system.json');
    writeJson(sys, { overapiSystem: 1, name: 'empty-shop', title: 'Empty Shop', members: ['a/overapi.json'] });
    const r = await runCli(['serve', sys]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("None of Empty Shop's APIs could be read.");
  });
});

describe('overapi test', () => {
  const withScenarios = (dir: string, edit: (p: Json) => void = () => undefined) =>
    ordersVariant(dir, (p) => {
      p.scenarios = [SCENARIO, BROKEN_SCENARIO];
      edit(p);
    });

  it('runs a scenario, skipping writes without --writes', async () => {
    const r = await runCli(['test', withScenarios('test-ro'), '--scenario', 'browse orders']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`browse orders — local (http://127.0.0.1:${ordersPort}/api/v1)`);
    expect(r.stdout).toMatch(/✓ GET\s+list_orders\s+200/);
    expect(r.stdout).toMatch(/✓ GET\s+get_order\s+200/);
    expect(r.stdout).toMatch(/- POST\s+cancel_order\s+skipped: changes data/);
    expect(r.stdout).toContain('2 passed, 0 failed, 1 skipped');
    expect(r.stdout).not.toContain('missing customer');
  });

  it('exits 1 when any scenario fails, and writes JUnit XML', async () => {
    const junit = path.join(tmp, 'junit.xml');
    const r = await runCli(['test', withScenarios('test-all'), '--junit', junit]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('missing customer');
    expect(r.stdout).toMatch(/✗ GET\s+get_customer\s+404/);
    expect(r.stdout).toContain('answered 404');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites>/);
    expect(xml).toContain('<testsuite name="browse orders" tests="3" failures="0" skipped="1"');
    expect(xml).toContain('<testsuite name="missing customer" tests="1" failures="1" skipped="0"');
    expect(xml).toMatch(/<testcase classname="browse orders" name="POST cancel_order" time="[\d.]+"><skipped message="[^"]+"\/><\/testcase>/);
    expect(xml).toMatch(/<testcase classname="missing customer" name="GET get_customer" time="[\d.]+"><failure message="answered 404/);
  });

  it('runs writes with --writes where the environment allows them', async () => {
    const file = withScenarios('test-rw', (p) => (env(p, 'local').allowWrites = true));
    const r = await runCli(['test', file, '--scenario', 'browse orders', '--writes', '--env', 'local']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/✓ POST\s+cancel_order\s+200/);
    expect(r.stdout).toContain('3 passed, 0 failed, 0 skipped');
  });

  it('never writes on production, even with --writes', async () => {
    const file = withScenarios('test-prod', (p) => {
      env(p, 'production').allowWrites = true;
      env(p, 'production').baseUrl = `http://127.0.0.1:${ordersPort}/api/v1`;
    });
    const r = await runCli(['test', file, '--scenario', 'browse orders', '--writes', '--env', 'production']);
    expect(r.stdout).toContain('skipped: changes data — never on production');
  });

  it('says so when there are no scenarios or no such scenario', async () => {
    const none = await runCli(['test', ordersVariant('test-none')]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('this API has no test scenarios yet');

    const wrong = await runCli(['test', withScenarios('test-wrong'), '--scenario', 'nope']);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('no scenario named nope');
  });
});

describe('overapi scan', () => {
  it('exits 0 with nothing found', async () => {
    const r = await runCli(['scan', ordersVariant('scan-clean')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Security 100\/100 \(A\)/);
    expect(r.stdout).toContain('Nothing found.');
  });

  it('--fail-on decides which findings fail the run', async () => {
    // Local writes on: a medium finding (destructive tools offered), nothing high.
    const file = ordersVariant('scan-medium', (p) => (env(p, 'local').allowWrites = true));
    const byDefault = await runCli(['scan', file]);
    expect(byDefault.stdout).toMatch(/MEDIUM\s+1 destructive tool offered on local/);
    expect(byDefault.stdout).toContain('Fix: ');
    expect(byDefault.code).toBe(0);

    const medium = await runCli(['scan', file, '--fail-on', 'medium']);
    expect(medium.code).toBe(1);
    const low = await runCli(['scan', file, '--fail-on', 'low']);
    expect(low.code).toBe(1);
    const critical = await runCli(['scan', file, '--fail-on', 'critical']);
    expect(critical.code).toBe(0);
  });

  it('a high finding fails by default; --env narrows to one environment', async () => {
    const file = ordersVariant('scan-high', (p) => (env(p, 'production').allowWrites = true));
    const all = await runCli(['scan', file]);
    expect(all.stdout).toMatch(/HIGH\s+Agents can change data on production/);
    expect(all.code).toBe(1);

    const local = await runCli(['scan', file, '--env', 'local']);
    expect(local.stdout).toMatch(/^Security \d+\/100 \([A-F]\) on local/);
    expect(local.stdout).not.toContain('production');
    expect(local.code).toBe(0);
  });

  it('lists accepted findings without failing on them', async () => {
    const file = ordersVariant('scan-accepted', (p) => {
      env(p, 'production').allowWrites = true;
      p.review = { accepted: { 'reach:prod-writes:production': { reason: 'acme ops approved', at: '2026-11-01T00:00:00.000Z' } } };
    });
    const r = await runCli(['scan', file, '--env', 'production']);
    expect(r.stdout).toContain('1 accepted: Agents can change data on production (“acme ops approved”)');
    expect(r.stdout).not.toMatch(/^HIGH/m);
    expect(r.code).toBe(0);
  });
});

describe('overapi load', () => {
  // Lists every order (not just open ones, which earlier tests cancel), so
  // the saved id always exists.
  const LOAD_SCENARIO = { ...SCENARIO, steps: SCENARIO.steps.map((s) => (s.id === 's1' ? { ...s, args: {} } : s)) };
  const withScenario = (dir: string, edit: (p: Json) => void = () => undefined) =>
    ordersVariant(dir, (p) => {
      p.scenarios = [LOAD_SCENARIO];
      edit(p);
    });

  it('needs --scenario, and a scenario that exists', async () => {
    const file = withScenario('load-args');
    const none = await runCli(['load', file]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('load needs --scenario <name>');

    const wrong = await runCli(['load', file, '--scenario', 'nope']);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('no scenario named nope');
  });

  it('caps users and duration', async () => {
    const file = withScenario('load-cap');
    const users = await runCli(['load', file, '--scenario', 'browse orders', '--users', '101']);
    expect(users.code).toBe(1);
    expect(users.stderr).toContain('at most 100 users for 600 s');
    const duration = await runCli(['load', file, '--scenario', 'browse orders', '--duration', '601']);
    expect(duration.code).toBe(1);
  });

  it('refuses a public host without --i-have-permission, and holds it to 5 users for 30 s', async () => {
    const file = withScenario('load-public');
    const refused = await runCli(['load', file, '--scenario', 'browse orders', '--env', 'staging']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('https://orders.staging.acme.example/api/v1 is a public host.');
    expect(refused.stderr).toContain('add --i-have-permission (held to 5 users for 30 s)');
    expect(refused.stdout).toBe('');

    // The default is 10 users, so permission alone is not enough.
    const tooMany = await runCli(['load', file, '--scenario', 'browse orders', '--env', 'staging', '--i-have-permission']);
    expect(tooMany.code).toBe(1);
    expect(tooMany.stderr).toContain('on a public host, at most 5 users for 30 s');

    const tooLong = await runCli(['load', file, '--scenario', 'browse orders', '--env', 'staging', '--i-have-permission', '--users', '5', '--duration', '31']);
    expect(tooLong.code).toBe(1);
    expect(tooLong.stderr).toContain('on a public host, at most 5 users for 30 s');
  });

  // BUG: a non-number for --users or --duration is not rejected. Number('abc')
  // is NaN, every `NaN > limit` comparison is false, so both the general caps
  // and the public-host cap are skipped; runLoad then clamps NaN to NaN and
  // sends nothing. The run reports "NaN users", "0 requests, 0 errors" (or
  // "NaN/s" for --duration) and exits 0 — a silent pass. Repro:
  // `overapi load <file> --scenario s --users abc --duration 1` (also with
  // `--env <public> --i-have-permission`) -> exit 0, 0 requests.
  // Expected: exit 1 with a message that --users/--duration must be numbers.
  it('rejects a non-number for --users or --duration', async () => {
    const file = withScenario('load-nan');
    const users = await runCli(['load', file, '--scenario', 'browse orders', '--users', 'abc', '--duration', '1']);
    expect(users.code).toBe(1);
    expect(users.stdout).not.toContain('NaN');
    const duration = await runCli(['load', file, '--scenario', 'browse orders', '--users', '1', '--duration', 'abc']);
    expect(duration.code).toBe(1);
  });

  it('runs a short load on a local host, reads only', async () => {
    const r = await runCli(['load', withScenario('load-local'), '--scenario', 'browse orders', '--users', '2', '--duration', '1'], { timeoutMs: 20_000 });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Load: browse orders on local (http://127.0.0.1:${ordersPort}/api/v1) — 2 users, 1 s, reads only`);
    expect(r.stdout).toMatch(/request\s+count\s+p50\s+p95\s+p99\s+errors/);
    expect(r.stdout).toMatch(/list_orders\s+\d+/);
    expect(r.stdout).not.toMatch(/cancel_order\s+\d+/);
    expect(r.stdout).toMatch(/\d+ requests, [\d.]+\/s, 0 errors/);
  }, 25_000);

  it('exits 1 when the load run sees errors', async () => {
    const r = await runCli(['load', withScenario('load-401'), '--scenario', 'browse orders', '--users', '1', '--duration', '1'], { env: { ACME_ORDERS_TOKEN: 'wrong' }, timeoutMs: 20_000 });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/ 0 errors\n/);
  }, 25_000);
});
