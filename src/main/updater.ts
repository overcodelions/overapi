// Auto-update from GitHub Releases, via electron-updater. The feed is the
// `build.publish` entry in package.json; release.yml uploads the latest*.yml
// files electron-builder writes next to the installers, and those are what
// this reads to learn a new version exists.
//
// Two settings steer it. Automatic updates: download in the background and
// install at the next quit, so an update never lands in the middle of a
// recording or a load test; off, it only says a new version exists and
// downloads when asked. Channel: stable takes tagged releases (v1.2.3);
// beta also takes prereleases (v1.3.0-beta.1). Nightlies are never offered —
// they're unsigned and sit under one moving `nightly` tag.
//
// Squirrel.Mac refuses an unsigned update, so this only works on the signed,
// notarized builds release.yml makes. That is also why the mac target keeps a
// zip next to the dmg — the zip is what Squirrel installs.

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { MainEvent, Settings } from '../shared/ipc';

let wired = false;

/// Nightly builds stamp their version as x.y.z-nightly.<date>.<sha>; every
/// tagged release is plain x.y.z.
function isNightlyBuild(): boolean {
  return /-nightly\./.test(app.getVersion());
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err));
}

type UpdatePrefs = Pick<Settings, 'autoUpdate' | 'updateChannel'>;

/// Why updates can't run here, if they can't.
function unavailable(): string | null {
  if (!app.isPackaged) return 'Updates only run in the installed app.';
  // A nightly's version isn't one electron-updater can compare.
  if (isNightlyBuild()) return 'Nightly builds don’t update themselves — install a release.';
  return null;
}

/// Applies the settings; safe to call again whenever they change.
export function applyUpdatePrefs(prefs: UpdatePrefs): void {
  if (unavailable()) return;
  autoUpdater.autoDownload = prefs.autoUpdate;
  autoUpdater.autoInstallOnAppQuit = prefs.autoUpdate;
  const beta = prefs.updateChannel === 'beta';
  autoUpdater.allowPrerelease = beta;
  // Always set explicitly. On beta it makes the GitHub feed skip tags that
  // aren't versions (`nightly`, the newest entry most days) and take stable
  // or beta releases, falling back to latest-mac.yml. Back on stable,
  // 'latest' puts the file name back — the setter can't be cleared.
  autoUpdater.channel = beta ? 'beta' : 'latest';
  // The channel setter turns downgrades on; never go back a version
  // (leaving beta waits for a stable release that's newer).
  autoUpdater.allowDowngrade = false;
}

export function initAutoUpdater(emit: (e: MainEvent) => void, prefs: UpdatePrefs): void {
  if (unavailable()) return;

  applyUpdatePrefs(prefs);
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', m),
    warn: (m: unknown) => console.warn('[updater]', m),
    error: (m: unknown) => console.error('[updater]', m),
    debug: () => {},
  };

  autoUpdater.on('update-available', (info) => emit({ type: 'update:available', version: info.version, downloading: autoUpdater.autoDownload }));
  autoUpdater.on('download-progress', (p) => emit({ type: 'update:progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => emit({ type: 'update:downloaded', version: info.version }));
  autoUpdater.on('error', (err) => console.error('[updater] update failed', err));

  wired = true;

  // Shortly after launch so it doesn't compete with the window opening, then
  // every six hours for a window that stays open for days.
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

/// Checks now, for the Settings button. `available` is a newer version on
/// the chosen channel; with automatic updates on, it's already downloading.
export async function checkNow(): Promise<{ ok: true; available: boolean; version?: string } | { ok: false; error: string }> {
  const why = unavailable();
  if (why || !wired) return { ok: false, error: why ?? 'Updates aren’t running.' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, available: !!r?.isUpdateAvailable, version: r?.updateInfo.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/// Downloads the update found, when automatic updates are off.
export function downloadNow(): void {
  if (!wired) return;
  autoUpdater.downloadUpdate().catch((err) => console.error('[updater] download failed', err));
}

/// Install a downloaded update now instead of at the next quit.
export function quitAndInstall(): void {
  if (!wired) return;
  autoUpdater.quitAndInstall();
}
