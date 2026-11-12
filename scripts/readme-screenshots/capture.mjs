// Regenerates the README screenshots in docs/screenshots/.
//
// Runs the built app against a throwaway HOME (fictional acme-* APIs and a
// workspace, see seed.mjs) and its own --user-data-dir, so nothing from your
// real projects, history or keychain can end up in an image. The one
// response shown comes from examples/acme-orders-server.mjs, started here on
// localhost: no request leaves the machine.
//
//   npm run build
//   npm i --no-save playwright-core
//   node scripts/readme-screenshots/capture.mjs [scene ...]
//
// Framing needs Python 3 with Pillow (`pip3 install pillow`).

import { _electron } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..', '..');
const work = path.join(fs.realpathSync(os.tmpdir()), 'overapi-readme-shots');
const raw = path.join(work, 'raw');
const userData = path.join(work, 'user-data');
const only = process.argv.slice(2);

/// 4010, as in the README, when it's free; any free port otherwise.
async function freePort(preferred) {
  const tryPort = (p) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(null));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(s.address()?.port ?? p)));
    });
  return (await tryPort(preferred)) ?? (await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  }));
}

async function startStub(port) {
  const child = spawn('node', [path.join(repo, 'examples', 'acme-orders-server.mjs')], { env: { ...process.env, PORT: String(port), ACME_ORDERS_TOKEN: 'dev-token' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('Acme Orders on') && resolve());
    child.once('exit', (c) => reject(new Error(`stub server exited (${c})`)));
  });
  return child;
}

/// The environment the app gets: no dev-server URL or npm/overcli leftovers
/// from whatever shell this runs in, so the built renderer is what loads.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k === 'VITE_DEV_SERVER_URL' || k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('npm_') || k.startsWith('OVERCLI_')) delete env[k];
  return env;
}

async function launch(home) {
  const app = await _electron.launch({
    executablePath: path.join(repo, 'node_modules', '.bin', 'electron'),
    args: [path.join(here, 'main.cjs'), '--force-device-scale-factor=2', `--user-data-dir=${userData}`],
    cwd: repo,
    env: cleanEnv({ HOME: home }),
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  // The app opens maximized once it's ready: wait for that, then size it.
  try {
    await page.waitForSelector('header', { timeout: 30000 });
  } catch (e) {
    app.process().kill('SIGKILL');
    throw e;
  }
  await page.waitForTimeout(800);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(1600, 1000);
    w.center();
  });
  await page.waitForTimeout(1500);
  return { app, page };
}

// Rewrites the sandbox HOME to `~` in the DOM and drops hover titles, so
// no temp path shows up in a header or tooltip.
const tidy = (page, home) =>
  page.evaluate((home) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) if (n.nodeValue.includes(home)) n.nodeValue = n.nodeValue.split(home).join('~');
    document.querySelectorAll('input, textarea').forEach((e) => {
      if (e.value.includes(home)) e.value = e.value.split(home).join('~');
    });
    document.querySelectorAll('[title]').forEach((e) => (e.title = ''));
  }, home);

async function session(theme, scenes) {
  const port = await freePort(4010);
  execFileSync('node', [path.join(here, 'seed.mjs'), work, userData, String(port), theme], { stdio: 'inherit' });
  const ids = JSON.parse(fs.readFileSync(path.join(work, 'seed-ids.json'), 'utf8'));
  const stub = await startStub(port);
  const { app, page } = await launch(ids.home);
  // The seed sets the theme too; this makes sure the renderer agrees.
  await page.emulateMedia({ colorScheme: theme });
  try {
    const shot = async (name, wait = 1200) => {
      if (only.length && !only.includes(name)) return;
      await page.mouse.move(5, 995);
      await page.waitForTimeout(wait);
      await tidy(page, ids.home);
      await page.screenshot({ path: path.join(raw, `${name}.png`) });
      console.log('  ', name);
    };
    await scenes(page, shot, ids);
  } catch (e) {
    // Leave the scene as it was, to see what went wrong.
    await page.screenshot({ path: path.join(work, 'failed.png') }).catch(() => {});
    fs.writeFileSync(path.join(work, 'failed.txt'), await page.evaluate(() => document.body.innerText).catch(() => ''));
    throw e;
  } finally {
    await app.close();
    stub.kill();
  }
}

const esc = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
};

/// The sidebar row for an API or workspace, by its title.
const openSide = async (page, title) => {
  await page.locator('aside [role="button"]').filter({ hasText: title }).first().click();
  await page.waitForTimeout(900);
};

fs.rmSync(raw, { recursive: true, force: true });
fs.mkdirSync(raw, { recursive: true });

await session('dark', async (page, shot) => {
  // Room for the params pane, so the status choices sit on one line.
  await page.evaluate(() => {
    localStorage.setItem('overapi.width.requests.list', '290');
    localStorage.setItem('overapi.width.requests.response', '520');
  });
  await page.reload();
  await page.waitForSelector('header');
  await page.waitForTimeout(1500);

  // The workbench: list_orders?status=open sent to the local stub.
  await openSide(page, 'Acme Orders');
  await page.getByRole('button', { name: /^Send to local/ }).click();
  await shot('workbench', 2000);

  // Try as an agent › Call a tool: the same call through the API's own MCP server.
  await page.getByRole('button', { name: /^MCP server/ }).click();
  await page.getByRole('button', { name: /Try as an agent/ }).click();
  await page.getByRole('tab', { name: 'Call a tool' }).click();
  await page.waitForTimeout(1500);
  await page.locator('select').filter({ hasText: 'shipped' }).first().selectOption('open');
  await page.getByRole('button', { name: 'Call list_orders' }).click();
  await shot('try-as-agent', 2500);

  // Publish: this Mac, the team, a file.
  await page.getByRole('button', { name: /^Publish/ }).click();
  await shot('publish');
  await esc(page);

  // Make it agent-ready on a raw recording: the rule-based steps, no AI run.
  await openSide(page, 'Acme Support');
  await page.getByRole('button', { name: /^MCP server/ }).click();
  await page.getByRole('button', { name: 'Make it agent-ready' }).first().click();
  await page.getByRole('button', { name: /Steps 1/ }).click();
  await shot('agent-ready');
  await esc(page);

  // A workspace: three APIs, one sign-in, where each runs.
  await openSide(page, 'Acme Storefront');
  await shot('workspace');

  // A teammate's project: secrets held back until it's reviewed.
  await openSide(page, 'Acme Billing');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /2 secrets/ }).click();
  await shot('review-secrets');
});

execFileSync('python3', [path.join(here, 'frame.py'), raw, path.join(repo, 'docs', 'screenshots')], { stdio: 'inherit' });
fs.rmSync(userData, { recursive: true, force: true });
