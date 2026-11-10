#!/usr/bin/env node
// overapi on the command line. Everything the app does to a project file,
// without the app: import, check, try a call, serve, and print the line
// that installs it in a client.
//
// `serve` is the one that matters most: it is what every client runs, so
// it must work on a machine that has Node and the project file and
// nothing else.

import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { importText } from '../core/import';
import { buildRequest, send, shown } from '../core/http';
import { createServer, pickEnv, type SystemSource } from '../core/server';
import type { Peer } from '../core/flow';
import { isSystemFile } from '../shared/system';
import { liveProject, readProject, writeProject } from '../core/projectFile';
import { varSource, type VarSource } from '../core/vars';
import { checkProject } from '../shared/check';
import { snippets, type ClientId, type ServeCommand } from '../shared/install';
import { envVars, offered, varPrefix } from '../shared/project';
import { forEnv, scanProject, type Severity } from '../shared/scan';
import { runLoad, runScenario, LOAD_LIMITS } from '../core/scenario';
import type { ScenarioRun } from '../shared/scenario';

const VERSION = '0.1.0';

const HELP = `overapi ${VERSION} — turn an existing API into MCP tools

Usage:
  overapi import <spec|capture|collection|url> [-o <dir>]
      OpenAPI 3, Swagger 2, a HAR capture or a Postman v2 collection.
      Writes <dir>/overapi.json (default ./<name>/overapi.json).
  overapi tools <overapi.json>              List tools and what each environment offers.
  overapi check <overapi.json>              Agent-readiness: what will trip an agent up.
  overapi call <overapi.json> <tool> [--env <name>] [--args '<json>'] [--yes]
      Make one real call, as an agent would. Writes need --yes.
  overapi serve <overapi.json> [--env <name>]
      Run as an MCP server over stdio. This is what clients run.
  overapi install <overapi.json> [--env <name>] [--client claude|codex|json]
      Print the config that adds this server to a client.
  overapi test <overapi.json> [--env <name>] [--scenario <name>] [--writes] [--junit <file>]
      Run the test scenarios. Checks status and response shape; exits 1 on a failure.
      Steps that change data run only with --writes, where the environment allows.
  overapi scan <overapi.json> [--env <name>] [--fail-on critical|high|medium|low]
      The security scan: leaked secrets, what agents can reach, prompt injection,
      personal data. Exits 1 on a finding at or above --fail-on (default high).
  overapi load <overapi.json> --scenario <name> [--env <name>] [--users 10] [--duration 30] [--ramp 5]
      Load-test a scenario's reads. Never sends writes.

Secrets are read from the environment, or a .env beside overapi.json.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function die(msg: string): never {
  process.stderr.write(`overapi: ${msg}\n`);
  process.exit(1);
}

async function readSource(ref: string): Promise<string> {
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { headers: { accept: 'application/json, application/yaml, text/yaml, */*' } });
    if (!res.ok) die(`${ref} answered ${res.status} ${res.statusText}`);
    return res.text();
  }
  try {
    return fs.readFileSync(ref, 'utf8');
  } catch (e) {
    die(`cannot read ${ref}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

/// How a client should start this same CLI: the Node running it now and
/// the absolute path of this script.
function selfCommand(): ServeCommand {
  return selfCommandOverride ?? { command: process.execPath, prefix: [path.resolve(__filename)] };
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const cmd = args.shift();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (cmd === 'import') {
    const out = flag(args, '-o') ?? flag(args, '--out');
    const ref = args[0] ?? die('import needs a file or URL');
    const project = importText(await readSource(ref), ref);
    const dir = out ?? path.join(process.cwd(), project.name);
    const file = dir.endsWith('.json') ? dir : path.join(dir, 'overapi.json');
    if (fs.existsSync(file)) die(`${file} already exists. Pass -o to write somewhere else.`);
    writeProject(file, project);
    const reads = project.tools.filter((t) => t.safety === 'read').length;
    process.stdout.write(
      `Wrote ${file}\n  ${project.tools.length} tools (${reads} read, ${project.tools.length - reads} write), ${project.envs.length} environment${project.envs.length === 1 ? '' : 's'}: ${project.envs.map((e) => `${e.name} ${e.baseUrl || '(no base URL)'}`).join(', ')}\n` +
        `Next: overapi check ${path.relative(process.cwd(), file) || file}\n`,
    );
    return;
  }

  const file = args.shift() ?? die(`${cmd} needs an overapi.json`);
  // A system file: its members, served as one server.
  if (cmd === 'serve' && isSystemFile(readJsonQuiet(file))) {
    const envName = flag(args, '--env') ?? 'local';
    const log = (line: string) => process.stderr.write(`overapi: ${line}\n`);
    const system = () => loadSystem(file);
    const first = system();
    const server = createServer({ project: () => first.members[0].project, system, envName, vars: varsFor(file), log, peer: peerFinder(file) });
    await server.connect(new StdioServerTransport());
    process.stdin.on('close', () => process.exit(0));
    log(`serving workspace ${first.name} (${envName}) — ${first.members.length} APIs`);
    return;
  }
  const project = readProject(file);

  if (cmd === 'tools') {
    for (const t of project.tools) {
      const mark = t.enabled ? (t.safety === 'read' ? 'R' : t.safety === 'write' ? 'W' : 'D') : '-';
      process.stdout.write(`${mark}  ${t.name.padEnd(36)} ${t.method.padEnd(6)} ${t.path}\n`);
    }
    process.stdout.write(`\nR read  W write  D destructive  - off\n`);
    for (const env of project.envs) {
      process.stdout.write(`${env.name}: ${project.tools.filter((t) => offered(t, env)).length} offered${env.allowWrites ? '' : ' (read-only)'}\n`);
    }
    return;
  }

  if (cmd === 'check') {
    const vars = varsFor(file);
    const names = [...new Set(project.envs.flatMap(envVars))];
    const result = checkProject(project, Object.fromEntries(names.map((n) => [n, !!vars(n)])));
    process.stdout.write(`Agent-readiness ${result.score}/100\n\n`);
    for (const i of result.issues) process.stdout.write(`${i.level === 'error' ? '✗' : i.level === 'warn' ? '!' : '·'} ${i.message}\n`);
    if (!result.issues.length) process.stdout.write('Nothing to fix.\n');
    process.exitCode = result.issues.some((i) => i.level === 'error') ? 1 : 0;
    return;
  }

  if (cmd === 'call') {
    const envName = flag(args, '--env');
    const raw = flag(args, '--args') ?? '{}';
    const yes = bool(args, '--yes');
    const name = args[0] ?? die('call needs a tool name');
    const env = pickEnv(project, envName);
    const tool = project.tools.find((t) => t.name === name) ?? die(`no tool named ${name}`);
    if (tool.safety !== 'read' && !yes) die(`${name} is a ${tool.safety} tool. Pass --yes to really send it.`);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      die(`--args is not JSON: ${(e as Error).message}`);
    }
    const built = buildRequest(tool, env, parsed, varsFor(file));
    const r = shown(built);
    process.stderr.write(`→ ${r.method} ${r.url}\n`);
    const result = await send(built, { limit: tool.responseLimit });
    process.stderr.write(`← ${result.status} ${result.statusText} in ${result.durationMs} ms\n`);
    process.stdout.write(`${result.body}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (cmd === 'serve') {
    const envName = flag(args, '--env');
    const log = (line: string) => process.stderr.write(`overapi: ${line}\n`);
    const env = pickEnv(project, envName);
    const server = createServer({ project: liveProject(file, log), envName: env.name, vars: varsFor(file), log, peer: peerFinder(file) });
    await server.connect(new StdioServerTransport());
    // The client closing stdin is the end of the session. Under Node that
    // would end the process anyway; inside the app binary it would not.
    process.stdin.on('close', () => process.exit(0));
    log(`serving ${project.name} (${env.name}, ${env.baseUrl}) — ${project.tools.filter((t) => offered(t, env)).length} tools`);
    return;
  }

  if (cmd === 'install') {
    const envName = flag(args, '--env');
    const client = (flag(args, '--client') ?? 'claude') as ClientId;
    const env = pickEnv(project, envName);
    const all = snippets(project, env, path.resolve(file), selfCommand());
    const s = all.find((x) => x.client === client) ?? die(`unknown client ${client}; use claude, codex or json`);
    process.stderr.write(`# ${s.label}: ${s.where}\n`);
    process.stdout.write(`${s.text}\n`);
    return;
  }

  if (cmd === 'test') {
    const env = pickEnv(project, flag(args, '--env'));
    const only = flag(args, '--scenario');
    const junit = flag(args, '--junit');
    const writes = bool(args, '--writes');
    const scenarios = (project.scenarios ?? []).filter((s) => !only || s.name === only);
    if (!scenarios.length) die(only ? `no scenario named ${only}` : 'this API has no test scenarios yet. Record traffic in the app and save it as a test.');
    const runs: { name: string; run: ScenarioRun }[] = [];
    for (const sc of scenarios) {
      process.stdout.write(`\n${sc.name} — ${env.name} (${env.baseUrl})\n`);
      const run = await runScenario(project, sc, env, {
        vars: varsFor(file), peer: peerFinder(file),
        allowWrites: writes,
        onStep: (r) => {
          const mark = r.skipped ? '-' : r.ok ? '✓' : '✗';
          process.stdout.write(`  ${mark} ${r.method.padEnd(6)} ${r.name.padEnd(32)} ${r.skipped ? `skipped: ${r.skipped}` : `${r.status ?? ''} ${r.ms ?? ''} ms`}\n`);
          for (const p of r.problems) process.stdout.write(`      ${p}\n`);
        },
      });
      process.stdout.write(`  ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped in ${(run.ms / 1000).toFixed(1)} s\n`);
      runs.push({ name: sc.name, run });
    }
    if (junit) fs.writeFileSync(junit, toJunit(runs));
    process.exitCode = runs.some((r) => r.run.failed) ? 1 : 0;
    return;
  }

  if (cmd === 'scan') {
    const envName = flag(args, '--env');
    const failOn = (flag(args, '--fail-on') ?? 'high') as Severity;
    const order: Severity[] = ['critical', 'high', 'medium', 'low'];
    let r = scanProject(project, varPrefix(project.name));
    if (envName) r = forEnv(r, pickEnv(project, envName));
    process.stdout.write(`Security ${r.score}/100 (${r.grade})${envName ? ` on ${envName}` : ''}\n\n`);
    for (const f of r.findings) {
      process.stdout.write(`${f.severity.toUpperCase().padEnd(9)} ${f.title}\n          ${f.detail}\n          Fix: ${f.fix}\n`);
    }
    if (!r.findings.length) process.stdout.write('Nothing found.\n');
    if (r.accepted.length) process.stdout.write(`\n${r.accepted.length} accepted: ${r.accepted.map((f) => `${f.title} (“${f.accepted.reason}”)`).join('; ')}\n`);
    process.exitCode = r.findings.some((f) => order.indexOf(f.severity) <= order.indexOf(failOn)) ? 1 : 0;
    return;
  }

  if (cmd === 'load') {
    const env = pickEnv(project, flag(args, '--env'));
    const name = flag(args, '--scenario') ?? die('load needs --scenario <name>');
    const sc = (project.scenarios ?? []).find((s) => s.name === name) ?? die(`no scenario named ${name}`);
    const users = Number(flag(args, '--users') ?? 10);
    const durationSec = Number(flag(args, '--duration') ?? 30);
    const rampSec = Number(flag(args, '--ramp') ?? 0);
    if (users > LOAD_LIMITS.users || durationSec > LOAD_LIMITS.durationSec) die(`at most ${LOAD_LIMITS.users} users for ${LOAD_LIMITS.durationSec} s`);
    process.stdout.write(`Load: ${sc.name} on ${env.name} (${env.baseUrl}) — ${users} users, ${durationSec} s, reads only\n`);
    const out = await runLoad(project, sc, env, {
      vars: varsFor(file), peer: peerFinder(file),
      onTick: (s) => {
        const last = s.timeline[s.timeline.length - 2] ?? s.timeline[s.timeline.length - 1];
        if (!s.done) process.stdout.write(`  ${s.elapsedSec.toFixed(0).padStart(4)} s  ${String(s.total).padStart(6)} requests  ${String(last?.requests ?? 0).padStart(4)}/s  p95 ${last?.p95 ?? 0} ms  errors ${s.errors}\n`);
      },
    }, { users, durationSec, rampSec });
    process.stdout.write(`\n${'request'.padEnd(32)} ${'count'.padStart(7)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'errors'.padStart(7)}\n`);
    for (const s of out.steps) process.stdout.write(`${s.name.padEnd(32)} ${String(s.count).padStart(7)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(7)} ${String(s.p99).padStart(7)} ${String(s.errors).padStart(7)}\n`);
    process.stdout.write(`\n${out.total} requests, ${(out.total / Math.max(1, out.elapsedSec)).toFixed(1)}/s, ${out.errors} errors\n`);
    for (const e of out.sampleErrors) process.stdout.write(`  ${e}\n`);
    process.exitCode = out.errors ? 1 : 0;
    return;
  }

  die(`unknown command ${cmd}. Run overapi --help.`);
}

function toJunit(runs: { name: string; run: ScenarioRun }[]): string {
  const x = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  const suites = runs.map(({ name, run }) => {
    const cases = run.results.map((r) => {
      const inner = r.skipped ? `<skipped message="${x(r.skipped)}"/>` : r.ok ? '' : `<failure message="${x(r.problems[0] ?? 'failed')}">${x(r.problems.join('\n'))}</failure>`;
      return `    <testcase classname="${x(name)}" name="${x(`${r.method} ${r.name}`)}" time="${((r.ms ?? 0) / 1000).toFixed(3)}">${inner}</testcase>`;
    });
    return `  <testsuite name="${x(name)}" tests="${run.results.length}" failures="${run.failed}" skipped="${run.skipped}" time="${(run.ms / 1000).toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}

/// Entry for the app binary: `Overapi serve <project> --env x` runs this
/// with everything from `serve` on.
/// `extraVars`: where the app binary finds secrets saved in the keychain,
/// consulted before the environment and the .env file.
export function run(argv: string[], command?: ServeCommand, extraVars?: (projectPath: string) => VarSource): Promise<void> {
  if (command) selfCommandOverride = command;
  if (extraVars) keychainVars = extraVars;
  return main(argv).catch((e) => die((e as Error).message));
}

let selfCommandOverride: ServeCommand | undefined;
let keychainVars: ((projectPath: string) => VarSource) | undefined;

function varsFor(file: string): VarSource {
  const local = varSource(file);
  const kc = keychainVars?.(path.resolve(file));
  return kc ? (name) => kc(name) ?? local(name) : local;
}

function readJsonQuiet(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/// A system file with its members read fresh — edits reach a running server.
function loadSystem(file: string): SystemSource {
  const def = readJsonQuiet(file);
  if (!isSystemFile(def)) die(`${file} is not an overapi workspace.`);
  const dir = path.dirname(path.resolve(file));
  const members = def.members.flatMap((m) => {
    const p = path.resolve(dir, m);
    try {
      return [{ path: p, project: readProject(p), vars: varsFor(p) }];
    } catch {
      process.stderr.write(`overapi: skipping ${m} — it can't be read\n`);
      return [];
    }
  });
  if (!members.length) die(`None of ${def.title}'s APIs could be read.`);
  return { name: def.name, title: def.title, description: def.description, instructions: def.instructions, members };
}

/// Another API, for "signed in by another API": where it was picked from,
/// else a sibling folder of that name beside this one. One session per
/// process, shared by everything it signs in.
function peerFinder(file: string): (api: string, at?: string) => Peer | undefined {
  const sessions = new Map<string, Record<string, string>>();
  return (api, at) => {
    const root = path.dirname(path.dirname(path.resolve(file)));
    for (const p of [at, path.join(root, api, 'overapi.json')].filter((x): x is string => !!x)) {
      try {
        const project = readProject(p);
        if (project.name !== api) continue;
        if (!sessions.has(p)) sessions.set(p, {});
        return { project, vars: varsFor(p), runtime: sessions.get(p)! };
      } catch {
        // Not there.
      }
    }
    return undefined;
  };
}

if (require.main === module) void run(process.argv.slice(2));
