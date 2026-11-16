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
// A fresh directory of our own each run (mkdtemp: unpredictable name,
// readable only by you), never a fixed name another process could have
// made or pointed elsewhere first.
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'overapi-readme-shots-'));
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

async function startStub(port, file = 'acme-orders-server.mjs', ready = 'Acme Orders on') {
  const child = spawn('node', [path.join(repo, 'examples', file)], { env: { ...process.env, PORT: String(port), ACME_ORDERS_TOKEN: 'dev-token' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes(ready) && resolve());
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
  // The web app the recording scene browses: a page and its private API.
  const webPort = await freePort(4030);
  const webapp = await startStub(webPort, 'acme-support-app.mjs', 'Acme Support web app on');
  ids.webapp = `http://localhost:${webPort}`;
  const { app, page } = await launch(ids.home);
  // The seed sets the theme too; this makes sure the renderer agrees.
  await page.emulateMedia({ colorScheme: theme });
  try {
    ids.app = app;
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
    console.error(`Failed — the scene as it was is in ${work} (failed.png, failed.txt).`);
    throw e;
  } finally {
    await app.close();
    stub.kill();
    webapp.kill();
  }
}

/// Runs script in the recording browser's page (the site, not overapi).
const inSite = (app, site, code) =>
  app.evaluate(
    async ({ webContents }, { site, code }) => {
      for (let i = 0; i < 50; i++) {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(site));
        if (wc && !wc.isLoading()) return wc.executeJavaScript(code);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`no recording browser on ${site}`);
    },
    { site, code },
  );

/// The recording browser as one image: overapi's bar over the site, each
/// captured from its own view and stacked (raw/<name>.png).
async function shootBrowser(app, site, name) {
  if (only.length && !only.includes(name)) return;
  const parts = await app.evaluate(async ({ BaseWindow, webContents }, site) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents?.getURL().startsWith(site)));
    win.setContentSize(1600, 1000);
    await new Promise((r) => setTimeout(r, 1200));
    const views = [...win.contentView.children].sort((a, b) => a.getBounds().y - b.getBounds().y);
    // Room on the bar for the traffic lights frame.py draws.
    await views[0].webContents.executeJavaScript(`document.querySelector('.bar').style.paddingLeft = '84px'`);
    await new Promise((r) => setTimeout(r, 300));
    const out = [];
    for (const v of views) out.push((await v.webContents.capturePage()).toPNG().toString('base64'));
    return out;
  }, site);
  const files = parts.map((b64, i) => {
    const f = path.join(work, `${name}.part${i}.png`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    return f;
  });
  execFileSync('python3', ['-c', STACK, path.join(raw, `${name}.png`), ...files]);
  console.log('  ', name);
}
const STACK = `import sys
from PIL import Image
ims = [Image.open(f).convert('RGBA') for f in sys.argv[2:]]
W = max(i.width for i in ims); out = Image.new('RGBA', (W, sum(i.height for i in ims)))
y = 0
for i in ims: out.paste(i, (0, y)); y += i.height
out.save(sys.argv[1])`;

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

await session('dark', async (page, shot, ids) => {
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
  await esc(page);

  // Record a web app: open Acme Support in overapi's browser, sign in, look
  // at a few tickets — then what was recorded, and how the calls connect.
  const site = ids.webapp;
  await openSide(page, 'Acme Support');
  await page.locator('aside button').filter({ hasText: 'Record traffic' }).click();
  await page.getByRole('tab', { name: 'Browser' }).click();
  await page.getByPlaceholder('https://app.acme.example').fill(site);
  await page.getByRole('button', { name: 'Open and record' }).click();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = (cond) => inSite(ids.app, site, `new Promise((ok, no) => { let n = 0; const t = setInterval(() => { if (${cond}) { clearInterval(t); ok(true) } else if (++n > 60) { clearInterval(t); no(new Error('timed out: ${cond.replace(/'/g, '')}')) } }, 100) })`);
  await until(`document.getElementById('login')`);
  await inSite(ids.app, site, `document.querySelector('#login button').click()`);
  await until(`document.querySelectorAll('.row').length > 0`);
  for (const id of ['T-4819', 'T-4808', 'T-4821']) {
    await inSite(ids.app, site, `document.querySelector('.row[data-id="${id}"]').click()`);
    await until(`document.querySelector('.who-card') && document.querySelector('#detail .id').textContent === '${id}'`);
    await wait(500);
  }
  await inSite(ids.app, site, `document.querySelector('nav button[data-view="pending"]').click()`);
  await until(`document.querySelector('.list h2').textContent.startsWith('Pending')`);
  await inSite(ids.app, site, `document.querySelector('.row[data-id="T-4815"]').click()`);
  await until(`document.querySelector('.who-card')`);
  await inSite(ids.app, site, `document.querySelector('nav button[data-view="open"]').click()`);
  await until(`document.querySelector('.list h2').textContent.startsWith('Open')`);
  await inSite(ids.app, site, `document.querySelector('.row[data-id="T-4821"]').click()`);
  await until(`document.querySelectorAll('.c').length === 3`);
  await wait(800);
  await shootBrowser(ids.app, site, 'record-browse');

  // Back in overapi: the calls, one picked, and the request graph.
  await page.bringToFront();
  await page.locator('main button').filter({ hasText: /tickets\/T-4821\/comments/ }).first().click();
  await shot('record', 2500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

execFileSync('python3', [path.join(here, 'frame.py'), raw, path.join(repo, 'docs', 'screenshots')], { stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });
