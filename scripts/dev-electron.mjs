// `npm run dev`'s Electron: started once the renderer is up and main is
// built, and RESTARTED whenever the main-process build changes.
//
// Vite hot-reloads the window, but Electron's main process loads its code
// once. Without this, a renderer that calls a new IPC channel talks to a
// main that has never heard of it — the call rejects and the window sits
// on the splash screen. Restarting on every main build keeps the two the
// same age.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const URL = 'http://localhost:5473';
const WATCH = ['main', 'preload', 'core', 'shared', 'cli'].map((d) => path.resolve('dist', d));

async function waitFor() {
  for (;;) {
    const built = fs.existsSync(path.resolve('dist/main/index.js'));
    const up = await fetch(URL).then(() => true, () => false);
    if (built && up) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

let child = null;
let restarting = false;

function start() {
  child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: URL } });
  child.on('exit', (code) => {
    child = null;
    // Closed by the person (not by a restart): end dev like before.
    if (!restarting) process.exit(code ?? 0);
  });
}

function restart() {
  if (!child) return start();
  restarting = true;
  child.once('exit', () => {
    restarting = false;
    start();
  });
  child.kill('SIGTERM');
}

await waitFor();
start();

let timer = null;
for (const dir of WATCH) {
  fs.mkdirSync(dir, { recursive: true });
  fs.watch(dir, { recursive: true }, (_event, file) => {
    if (!file || !String(file).endsWith('.js')) return;
    clearTimeout(timer);
    // tsc writes many files per build; wait for it to finish.
    timer = setTimeout(() => {
      process.stdout.write('\n[overapi] main process changed — restarting Electron\n');
      restart();
    }, 600);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  restarting = true;
  child?.kill('SIGTERM');
  process.exit(0);
});
