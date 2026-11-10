// Renders overapi's icons from SVG with Electron itself (no image tools
// needed): the app icon at 1024 px, and the menu bar's template image.
// `npx electron scripts/render-icons.cjs` — then make-icons.sh builds the
// .icns. The SVG here is the source of truth for the mark's look.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = path.resolve(__dirname, '..', 'build');

// The mark on a 64-unit grid: two braces closing on three dots (the menu
// bar's; the app icon's is drawn in build/icon.svg on the same grid).
const BRACES =
  'M20 8 Q 10 8 10 18 L 10 26 Q 10 32 4 32 Q 10 32 10 38 L 10 46 Q 10 56 20 56 M44 8 Q 54 8 54 18 L 54 26 Q 54 32 60 32 Q 54 32 54 38 L 54 46 Q 54 56 44 56';

// App icon: the over-family shell (build/icon.svg — the source of truth,
// shared look with overcli, overdb and overgit), plus its small-size cut.
const appIcon = fs.readFileSync(path.join(out, 'icon.svg'), 'utf8');
const appIconSmall = fs.readFileSync(path.join(out, 'icon-small.svg'), 'utf8');

// Menu bar: a template image — black on transparent; macOS tints it for
// light and dark menu bars. Bolder strokes so it reads at 18 px.
const tray = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <path d="${BRACES}" fill="none" stroke="#000" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="22" cy="32" r="5.2" fill="#000"/><circle cx="32" cy="32" r="5.2" fill="#000"/><circle cx="42" cy="32" r="5.2" fill="#000"/>
</svg>`;

const jobs = [
  ['icon.png', 1024, appIcon],
  ['icon-small.png', 1024, appIconSmall],
  ['trayTemplate@2x.png', 36, tray(36)],
  ['trayTemplate.png', 18, tray(18)],
];

app.disableHardwareAcceleration();
app.dock?.hide();
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  // One window, reused: a fresh window per image trips macOS sandboxing.
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  for (const [file, size, svg] of jobs) {
    win.setContentSize(size, size);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`)}`);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    fs.writeFileSync(path.join(out, file), img.resize({ width: size, height: size, quality: 'best' }).toPNG());
    process.stdout.write(`wrote build/${file}\n`);
  }
  win.destroy();
  app.quit();
});
