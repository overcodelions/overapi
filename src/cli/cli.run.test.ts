// The CLI in-process, through its exported `run()` — the same entry the app
// binary uses for `Overapi serve …`. cli.e2e.test.ts covers the real
// process (exit codes, stdio, a real MCP client); this file drives the same
// paths in-process so coverage sees them, and covers what only `run()`
// takes: the serve command override and the keychain variable source.
//
// process.exit is replaced by a throw, stdout/stderr are captured, and the
// stdio server transport is swapped for an in-memory pair so `serve` can be
// driven by an MCP client in this process.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const linked = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  class StdioServerTransport {
    constructor() {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      linked.client = clientSide;
      return serverSide as unknown as StdioServerTransport;
    }
  }
  return { StdioServerTransport };
});

import { run } from './index';

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const TOKEN = 'acme-run-token';

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let out = '';
let err = '';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], command?: Parameters<typeof run>[1], extraVars?: Parameters<typeof run>[2]): Promise<Ran> {
  out = '';
  err = '';
  process.exitCode = undefined;
  let code: number | undefined;
  try {
    await run(args, command, extraVars);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code ?? 0;
  }
  const result = { code: code ?? Number(process.exitCode ?? 0), stdout: out, stderr: err };
  process.exitCode = undefined;
  return result;
}

let tmp: string;
let ordersPort: number;
let ordersProc: ChildProcess;
let inventory: http.Server;
let inventoryPort: number;

type Json = Record<string, any>;
const readJson = (f: string): Json => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
};
const env = (p: Json, name: string) => p.envs.find((e: Json) => e.name === name);

let base: Json;
function variant(dir: string, edit: (p: Json) => void = () => undefined): string {
  const p = structuredClone(base);
  edit(p);
  const file = path.join(tmp, dir, 'overapi.json');
  writeJson(file, p);
  return file;
}

const SCENARIO = {
  id: 'sc-browse',
  name: 'browse orders',
  createdAt: '2026-11-01T00:00:00.000Z',
  steps: [
    { id: 's1', toolId: 'GET /orders', args: {}, saves: [{ var: 'orderId', from: 'body', path: '[0].id' }], expect: { status: '2xx', shape: { t: 'array' } }, enabled: true },
    { id: 's2', toolId: 'GET /orders/{orderId}', args: { orderId: '{{orderId}}' }, saves: [], expect: { status: 200 }, enabled: true },
    { id: 's3', toolId: 'POST /orders/{orderId}/cancel', args: { orderId: 1003 }, saves: [], expect: { status: '2xx' }, enabled: true, write: true },
  ],
};
const BROKEN = {
  id: 'sc-broken',
  name: 'a <broken> & "quoted" one',
  createdAt: '2026-11-01T00:00:00.000Z',
  steps: [{ id: 'b1', toolId: 'GET /customers/{customerId}', args: { customerId: 999 }, saves: [], expect: { status: '2xx' }, enabled: true }],
};

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

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-cli-run-')));
  ordersPort = await freePort();
  ordersProc = await new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(EXAMPLES, 'acme-orders-server.mjs')], {
      env: { ...process.env, PORT: String(ordersPort), ACME_ORDERS_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const timer = setTimeout(() => reject(new Error(`orders server did not start: ${text}`)), 10_000);
    child.stdout!.on('data', (c) => {
      text += c;
      if (text.includes('Acme Orders on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
  const mod = await import(pathToFileURL(path.join(EXAMPLES, 'acme-inventory-soap-server.mjs')).href);
  inventory = mod.createInventoryServer() as http.Server;
  await new Promise<void>((r) => inventory.listen(0, '127.0.0.1', () => r()));
  inventoryPort = (inventory.address() as net.AddressInfo).port;
}, 30_000);

afterAll(async () => {
  ordersProc?.kill();
  await new Promise<void>((r) => (inventory ? inventory.close(() => r()) : r()));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => {
    out += String(s);
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => {
    err += String(s);
    return true;
  }) as never);
  vi.stubEnv('ACME_ORDERS_TOKEN', TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('run(): help, version, import', () => {
  it('help and version', async () => {
    expect((await cli([])).stdout).toContain('Usage:');
    expect((await cli(['-h'])).stdout).toContain('overapi load <overapi.json> --scenario <name>');
    expect(await cli(['--version'])).toMatchObject({ code: 0, stdout: '0.1.0\n' });
  });

  it('a command with --help prints help instead of reading a file called --help', async () => {
    for (const argv of [['import', '--help'], ['serve', '-h'], ['call', 'x.json', '--help']]) {
      expect(await cli(argv)).toMatchObject({ code: 0, stdout: expect.stringContaining('Usage:') });
    }
    expect((await cli(['--help'])).stdout).toContain('a WSDL');
  });

  it('imports a spec, then the project every later test uses', async () => {
    const r = await cli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '-o', path.join(tmp, 'imported')]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('7 tools (4 read, 3 write), 3 environments');
    base = readJson(path.join(tmp, 'imported', 'overapi.json'));
    env(base, 'local').baseUrl = `http://127.0.0.1:${ordersPort}/api/v1`;
  });

  it('import: a .json -o is the file itself; existing, missing and unreadable sources fail', async () => {
    const file = path.join(tmp, 'single', 'acme.json');
    expect((await cli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '--out', file])).code).toBe(0);
    expect(fs.existsSync(file)).toBe(true);

    const again = await cli(['import', path.join(EXAMPLES, 'acme-orders.openapi.yaml'), '-o', file]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');

    const none = await cli(['import']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('import needs a file or URL');

    const missing = await cli(['import', path.join(tmp, 'missing.yaml')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read');

    const notFound = await cli(['import', `http://127.0.0.1:${inventoryPort}/nothing`]);
    expect(notFound.code).toBe(1);
    expect(notFound.stderr).toContain('answered 404 Not Found');
  });

  it('imports a WSDL over HTTP', async () => {
    const r = await cli(['import', `http://127.0.0.1:${inventoryPort}/soap/inventory?wsdl`, '-o', path.join(tmp, 'inventory')]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 environment: default');
  });

  it('a project command needs a file, and unknown commands fail', async () => {
    expect((await cli(['scan'])).stderr).toContain('scan needs an overapi.json');
    const r = await cli(['frobnicate', variant('unknown')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command frobnicate');
  });

  it('a thrown error becomes a one-line message and exit 1', async () => {
    const r = await cli(['tools', path.join(tmp, 'nowhere', 'overapi.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^overapi: /);
  });
});

describe('run(): tools, check, install', () => {
  it('tools', async () => {
    const r = await cli(['tools', variant('tools', (p) => {
      env(p, 'staging').allowWrites = true;
      p.tools[0].enabled = false;
    })]);
    expect(r.stdout).toMatch(/^- {2}list_orders/m);
    expect(r.stdout).toMatch(/^W {2}create_order/m);
    expect(r.stdout).toMatch(/^D {2}delete_order/m);
    expect(r.stdout).toContain('local: 3 offered (read-only)');
    expect(r.stdout).toContain('staging: 6 offered\n');
  });

  it('check: warnings, errors and the all-clear', async () => {
    vi.stubEnv('ACME_ORDERS_TOKEN', '');
    const warn = await cli(['check', variant('check')]);
    expect(warn.stdout).toContain('! "local" reads ACME_ORDERS_TOKEN');
    expect(warn.code).toBe(0);

    const bad = await cli(['check', variant('check-bad', (p) => (p.envs = [{ name: 'local', baseUrl: '', auth: { type: 'none' }, allowWrites: false }]))]);
    expect(bad.stdout).toContain('✗ ');
    expect(bad.code).toBe(1);

    vi.stubEnv('ACME_ORDERS_TOKEN', TOKEN);
    const clean = await cli(['check', variant('check-clean', (p) => {
      p.envs = [env(p, 'local')];
      p.tools = p.tools.filter((t: Json) => t.safety === 'read');
    })]);
    expect(clean.stdout).toMatch(/Agent-readiness \d+\/100/);
    if (!/[✗!·] /.test(clean.stdout)) expect(clean.stdout).toContain('Nothing to fix.');
  });

  it('install: each client, an unknown one, and the app binary’s own serve command', async () => {
    const file = variant('install');
    const claude = await cli(['install', file]);
    expect(claude.code).toBe(0);
    expect(claude.stdout).toContain(path.resolve(file));

    const codex = await cli(['install', file, '--client', 'codex']);
    expect(codex.stdout).toContain('[mcp_servers.');

    const bad = await cli(['install', file, '--client', 'emacs']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('unknown client emacs');

    const json = await cli(['install', file, '--client', 'json', '--env', 'staging'], { command: '/Applications/Acme.app/Contents/MacOS/Acme', prefix: [] });
    const entry = Object.values(JSON.parse(json.stdout).mcpServers)[0] as { command: string; args: string[] };
    expect(entry.command).toBe('/Applications/Acme.app/Contents/MacOS/Acme');
    expect(entry.args).toEqual(['serve', path.resolve(file), '--env', 'staging']);
  });
});

describe('run(): call', () => {
  it('reads, errors, writes and argument checks', async () => {
    const file = variant('call');
    const ok = await cli(['call', file, 'get_order', '--args', '{"orderId":1001}']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stderr).toMatch(/← 200 OK in \d+ ms/);
    expect(JSON.parse(ok.stdout).id).toBe(1001);

    const notFound = await cli(['call', file, 'get_order', '--args', '{"orderId":4242}']);
    expect(notFound.code).toBe(1);

    expect((await cli(['call', file, 'cancel_order', '--args', '{"orderId":1002}'])).stderr).toContain('Pass --yes');
    const sent = await cli(['call', file, 'cancel_order', '--args', '{"orderId":1002}', '--yes', '--env', 'local']);
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).status).toBe('cancelled');

    expect((await cli(['call', file])).stderr).toContain('call needs a tool name');
    expect((await cli(['call', file, 'nope'])).stderr).toContain('no tool named nope');
    expect((await cli(['call', file, 'list_orders', '--args', '[oops'])).stderr).toContain('--args is not JSON');
  });
});

describe('run(): serve', () => {
  async function serve(args: string[]): Promise<Client> {
    // Leave the real stdin alone: the CLI listens for it closing.
    const realOn = process.stdin.on.bind(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation(((ev: string, fn: (...a: unknown[]) => void) => (ev === 'close' ? process.stdin : realOn(ev, fn))) as never);
    const r = await cli(['serve', ...args]);
    expect(r.code, r.stderr).toBe(0);
    const client = new Client({ name: 'acme-run', version: '1.0.0' });
    await client.connect(linked.client as Transport);
    return client;
  }
  const text = (r: Json) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

  it('serves a project', async () => {
    const client = await serve([variant('serve', (p) => (env(p, 'local').allowWrites = true)), '--env', 'local']);
    try {
      expect(err).toContain('overapi: serving acme-orders (local, ');
      expect(err).toContain('— 7 tools');
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      const r = await client.callTool({ name: 'get_customer', arguments: { customerId: 1 } });
      expect(r.isError, text(r)).toBe(false);
      expect(text(r)).toContain('Wile E. Coyote');
      const d = await client.callTool({ name: 'delete_order', arguments: { orderId: 1001 } });
      expect(d.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('serves a workspace, skipping a member it cannot read', async () => {
    variant(path.join('shop', 'orders'));
    const inv = readJson(path.join(tmp, 'inventory', 'overapi.json'));
    inv.envs = [{ name: 'local', baseUrl: `http://127.0.0.1:${inventoryPort}`, auth: { type: 'wsse', userVar: 'ACME_INV_USER', passVar: 'ACME_INV_PASS' }, allowWrites: false }];
    writeJson(path.join(tmp, 'shop', 'inventory', 'overapi.json'), inv);
    fs.writeFileSync(path.join(tmp, 'shop', 'inventory', '.env'), 'ACME_INV_USER=acme\nACME_INV_PASS=s3cret-pass\n');
    const sys = path.join(tmp, 'shop', 'overapi-system.json');
    writeJson(sys, { overapiSystem: 1, name: 'acme-shop', title: 'Acme Shop', members: ['orders/overapi.json', 'inventory/overapi.json', 'gone/overapi.json'] });

    const client = await serve([sys, '--env', 'local']);
    try {
      expect(err).toContain('skipping gone/overapi.json');
      expect(err).toContain('serving workspace acme-shop (local) — 2 APIs');
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['list_orders', 'list_items']));
      const r = await client.callTool({ name: 'get_item', arguments: { Sku: 'DRL-20' } });
      expect(text(r)).toContain('Cordless drill');
    } finally {
      await client.close();
    }
  });

  it('serve on a file that is not there fails cleanly', async () => {
    const r = await cli(['serve', path.join(tmp, 'nowhere', 'overapi.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^overapi: /);
  });

  it('a workspace with no readable member fails', async () => {
    const sys = path.join(tmp, 'empty', 'overapi-system.json');
    writeJson(sys, { overapiSystem: 1, name: 'empty', title: 'Empty Shop', members: ['x/overapi.json'] });
    const r = await cli(['serve', sys]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("None of Empty Shop's APIs could be read.");
  });
});

describe('run(): test', () => {
  it('runs scenarios, writes JUnit with escaped names, exits 1 on a failure', async () => {
    const file = variant('test', (p) => (p.scenarios = [SCENARIO, BROKEN]));
    const junit = path.join(tmp, 'junit.xml');
    const r = await cli(['test', file, '--junit', junit]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('2 passed, 0 failed, 1 skipped');
    expect(r.stdout).toContain('0 passed, 1 failed, 0 skipped');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('<testsuite name="a &lt;broken&gt; &amp; &quot;quoted&quot; one" tests="1" failures="1" skipped="0"');
    expect(xml).toContain('<skipped message="changes data');
    expect(xml).toMatch(/<testcase classname="browse orders" name="GET list_orders" time="[\d.]+"><\/testcase>/);
  });

  it('--writes runs the write step where allowed; one scenario by name', async () => {
    const file = variant('test-rw', (p) => {
      p.scenarios = [SCENARIO, BROKEN];
      env(p, 'local').allowWrites = true;
    });
    const r = await cli(['test', file, '--writes', '--scenario', 'browse orders']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('3 passed, 0 failed, 0 skipped');
  });

  it('no scenarios, and an unknown one', async () => {
    expect((await cli(['test', variant('test-none')])).stderr).toContain('no test scenarios yet');
    expect((await cli(['test', variant('test-x', (p) => (p.scenarios = [SCENARIO])), '--scenario', 'x'])).stderr).toContain('no scenario named x');
  });

  it('a "signed in by another API" environment borrows the sibling API’s sign-in', async () => {
    // peers/acme-auth holds the token; peers/orders signs in through it.
    vi.stubEnv('ACME_ORDERS_TOKEN', '');
    variant(path.join('peers', 'acme-auth'), (p) => {
      p.name = 'acme-auth';
      p.title = 'Acme Auth';
      p.envs = [{ ...env(p, 'local'), auth: { type: 'bearer', tokenVar: 'ACME_AUTH_TOKEN' } }];
      p.tools = p.tools.filter((t: Json) => t.safety === 'read');
    });
    fs.writeFileSync(path.join(tmp, 'peers', 'acme-auth', '.env'), `ACME_AUTH_TOKEN=${TOKEN}\n`);
    const scenario = { ...SCENARIO, steps: SCENARIO.steps.slice(0, 2) };
    // `path` first points at a different API (skipped by name), then the sibling folder is found.
    const ok = variant(path.join('peers', 'orders'), (p) => {
      p.envs = [{ ...env(p, 'local'), auth: { type: 'via', api: 'acme-auth', path: path.join(tmp, 'imported', 'overapi.json') } }];
      p.scenarios = [scenario];
    });
    const r = await cli(['test', ok]);
    expect(r.stdout).toContain('2 passed, 0 failed, 0 skipped');
    expect(r.code, r.stdout).toBe(0);

    const lost = variant(path.join('peers', 'lost'), (p) => {
      p.envs = [{ ...env(p, 'local'), auth: { type: 'via', api: 'acme-nowhere' } }];
      p.scenarios = [scenario];
    });
    const r2 = await cli(['test', lost]);
    expect(r2.code).toBe(1);
    expect(r2.stdout).toContain('Signed in by acme-nowhere');
  });
});

describe('run(): scan', () => {
  it('clean, --fail-on thresholds, --env and accepted findings', async () => {
    const clean = await cli(['scan', variant('scan-clean')]);
    expect(clean).toMatchObject({ code: 0 });
    expect(clean.stdout).toContain('Nothing found.');

    const medium = variant('scan-medium', (p) => (env(p, 'local').allowWrites = true));
    expect((await cli(['scan', medium])).code).toBe(0);
    expect((await cli(['scan', medium, '--fail-on', 'medium'])).code).toBe(1);

    const high = variant('scan-high', (p) => (env(p, 'production').allowWrites = true));
    const h = await cli(['scan', high]);
    expect(h.code).toBe(1);
    expect(h.stdout).toMatch(/^HIGH {6}Agents can change data on production\n {10}/m);
    expect((await cli(['scan', high, '--env', 'local'])).code).toBe(0);

    const accepted = variant('scan-accepted', (p) => {
      env(p, 'production').allowWrites = true;
      p.review = { accepted: { 'reach:prod-writes:production': { reason: 'acme ops approved', at: '2026-11-01T00:00:00.000Z' } } };
    });
    const a = await cli(['scan', accepted, '--env', 'production']);
    expect(a.stdout).toContain('1 accepted: Agents can change data on production (“acme ops approved”)');
    expect(a.code).toBe(0);
  });
});

describe('run(): load', () => {
  const file = () => variant('load', (p) => (p.scenarios = [SCENARIO]));

  it('argument checks and the public-host guard', async () => {
    const f = file();
    expect((await cli(['load', f])).stderr).toContain('load needs --scenario <name>');
    expect((await cli(['load', f, '--scenario', 'x'])).stderr).toContain('no scenario named x');
    expect((await cli(['load', f, '--scenario', 'browse orders', '--users', '500'])).stderr).toContain('at most 100 users for 600 s');

    const pub = await cli(['load', f, '--scenario', 'browse orders', '--env', 'production']);
    expect(pub.code).toBe(1);
    expect(pub.stderr).toContain('https://orders.acme.example/api/v1 is a public host.');

    const capped = await cli(['load', f, '--scenario', 'browse orders', '--env', 'production', '--i-have-permission', '--users', '6', '--duration', '5']);
    expect(capped.code).toBe(1);
    expect(capped.stderr).toContain('on a public host, at most 5 users for 30 s');
  });

  it('runs a short local load with a ramp', async () => {
    const r = await cli(['load', file(), '--scenario', 'browse orders', '--users', '2', '--duration', '1', '--ramp', '1']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('2 users, 1 s, reads only');
    expect(r.stdout).toMatch(/\d+ requests, [\d.]+\/s, 0 errors/);
  }, 15_000);

  it('exits 1 and samples the errors when requests fail', async () => {
    vi.stubEnv('ACME_ORDERS_TOKEN', 'wrong-token');
    const r = await cli(['load', file(), '--scenario', 'browse orders', '--users', '1', '--duration', '1']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('401');
  }, 15_000);
});

// Last: run() keeps the keychain source it was handed for the life of the
// process (the app binary calls it once), so it would leak into later tests.
describe('run(): keychain variables', () => {
  it('check consults the keychain source passed to run() before the environment', async () => {
    vi.stubEnv('ACME_ORDERS_TOKEN', '');
    const file = variant('keychain');
    const seen: string[] = [];
    const r = await cli(['check', file], undefined, (projectPath) => {
      seen.push(projectPath);
      return (name) => (name === 'ACME_ORDERS_TOKEN' ? 'from-keychain' : undefined);
    });
    expect(seen).toContain(path.resolve(file));
    expect(r.stdout).not.toContain('which is not set');
  });
});
