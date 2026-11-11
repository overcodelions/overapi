// `npm run dev`: build main once, then run Vite, tsc --watch and Electron
// together — and when dev ends, however it ends, take all of them with it.
//
// It replaces `concurrently` with npm: wrappers, which left orphans: killing
// an `npm run` doesn't kill what npm started, so every stopped dev session
// could leave Vite, tsc and Electron running (and Electron holding network
// connections). Here each runs in its own process group, and the whole
// group is killed on exit.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = process.cwd();
const bin = (name) => path.join(repo, 'node_modules/.bin', name);

// Leftovers from an earlier dev session that didn't end cleanly — this
// repo's Vite (which would hold the port), tsc watcher or Electron. Only
// these, matched by this folder's path; nothing else is touched.
function clearLeftovers() {
  let rows = '';
  try {
    // A busy Mac's process list runs to megabytes: room for all of it.
    rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return;
  }
  const mine = [path.join(repo, 'node_modules/.bin/vite'), path.join(repo, 'node_modules/.bin/tsc -p tsconfig.main.json --watch'), path.join(repo, 'node_modules/electron/dist/Electron.app'), path.join(repo, 'scripts/dev-electron.mjs'), path.join(repo, 'node_modules/@esbuild')];
  // And whatever of this repo's holds Vite's port, whatever it looks like.
  let onPort = [];
  try {
    onPort = execFileSync('lsof', ['-nP', '-iTCP:5473', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    /* nothing listening */
  }
  const stale = rows
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[1]) !== process.pid && (mine.some((x) => m[2].includes(x)) || (onPort.includes(Number(m[1])) && m[2].includes(repo))))
    .map((m) => Number(m[1]));
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  if (stale.length) process.stdout.write(`[dev] cleared ${stale.length} process${stale.length === 1 ? '' : 'es'} left over from an earlier dev session\n`);
}

clearLeftovers();
// Clean, then build main once, so Electron starts on a complete build.
spawnSync(process.execPath, [path.join(repo, 'scripts/clean-dist.mjs')], { stdio: 'inherit' });
const build = spawnSync(process.execPath, [bin('tsc'), '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const COLORS = { vite: 36, tsc: 33, electron: 35 };
const procs = [];

function run(name, cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = `\x1b[${COLORS[name]}m[${name}]\x1b[0m `;
  const relay = (stream, out) => {
    let rest = '';
    stream.on('data', (d) => {
      const lines = (rest + d.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => {
    // Electron closed by the person (or anything else ending): dev ends.
    process.stdout.write(`${tag}exited${code === null ? '' : ` with code ${code}`}\n`);
    shutdown(code ?? 0);
  });
  procs.push(child);
}

let ending = false;
function shutdown(code) {
  if (ending) return;
  ending = true;
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Anything that ignored SIGTERM goes now.
  setTimeout(() => {
    for (const p of procs) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    process.exit(code);
  }, 1500).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.on('exit', () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

run('vite', process.execPath, [bin('vite')]);
run('tsc', process.execPath, [bin('tsc'), '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);
run('electron', process.execPath, [path.join(repo, 'scripts/dev-electron.mjs')]);
