/**
 * updater.ts — electron-updater integration.
 *
 * Uses electron-updater with the GitHub Releases provider to check for
 * updates against https://github.com/browser-use/desktop-app/releases. The
 * release.yml workflow uploads DMGs + SHA256SUMS.txt to the tagged Release,
 * which is exactly the feed format electron-updater's `github` provider
 * expects.
 *
 * Flow:
 *   1. App becomes ready → initUpdater() schedules an initial check +
 *      a periodic check every hour.
 *   2. `update-available`  → electron-updater downloads in the background.
 *   3. `update-downloaded` → user is prompted to restart; dismissing falls
 *      through to `autoInstallOnAppQuit`.
 *   4. App is quitting    → stopUpdater() clears the periodic timer.
 *
 * Dev-mode guard: electron-updater refuses to run when `app.isPackaged` is
 * false (and also when NODE_ENV !== 'production'); initUpdater() short-
 * circuits in that case so `npm run dev` stays fast and offline.
 *
 * Signing / notarization: auto-update on macOS requires the DMG to be signed
 * by the same Developer ID that signed the currently running app; the
 * release workflow handles that when the Apple secrets are present.
 */

import { app, dialog } from 'electron';
import type { AppUpdater } from 'electron-updater';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// GitHub Releases provider — see forge.config.ts / release.yml. Using a
// static options object (vs. reading `publish` from package.json) keeps the
// feed config colocated with the code that consumes it and avoids needing
// an electron-builder-style config block in package.json.
const GITHUB_OWNER = 'browser-use';
const GITHUB_REPO = 'desktop-app';

let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

/**
 * Return true when auto-update should be skipped (dev / non-packaged /
 * non-production). Exported for tests.
 */
export function shouldSkipUpdates(): boolean {
  if (!app.isPackaged) return true;
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'production') return true;
  return false;
}

/**
 * Configure the electron-updater autoUpdater instance. Split out for tests
 * so the lifecycle wiring can be verified without a real AppUpdater.
 */
export function configureAutoUpdater(autoUpdater: AppUpdater): void {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
  });

  // Verbose diagnostics — electron-updater's logger interface is compatible
  // with the global console (info/warn/error).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (autoUpdater as any).logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for update');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update available:', info.version, 'current:', app.getVersion());
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] No update available. Current version is latest:', info.version);
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = typeof progress.percent === 'number' ? progress.percent.toFixed(1) : '?';
    console.log(
      `[updater] Download progress: ${pct}%`,
      `(${progress.transferred}/${progress.total} bytes)`,
      `speed: ${progress.bytesPerSecond} B/s`,
    );
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] Update downloaded:', info.version);
    // Prompt the user. If they dismiss, autoInstallOnAppQuit handles it on
    // the next natural quit, so we never block an update forever.
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} is ready to install.`,
        detail: 'Restart now to apply the update, or it will install automatically on next quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch((err: unknown) => {
        console.warn('[updater] Failed to show update dialog:', (err as Error)?.message ?? err);
      });
  });

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] Auto-update error:', err.message);
    // Non-fatal — log and continue. Do not crash the app on update errors.
  });
}

/**
 * Initialize auto-updater. Call once from app.whenReady().
 *
 * In dev mode (`!app.isPackaged` or `NODE_ENV !== 'production'`) update
 * checks are skipped — electron-updater itself throws in dev, and we never
 * want to surface those errors to local contributors.
 */
export async function initUpdater(): Promise<void> {
  if (initialized) {
    console.warn('[updater] initUpdater called twice — ignoring');
    return;
  }
  if (shouldSkipUpdates()) {
    console.log('[updater] Skipping auto-update init — dev mode / not packaged');
    return;
  }

  // Dynamic import so that pulling this module into a renderer bundle or
  // into a test harness without electron-updater installed doesn't fail at
  // require time. The dep is a real `dependency` in package.json, so in a
  // packaged app this resolves synchronously out of node_modules.
  let autoUpdater: AppUpdater;
  try {
    const mod = await import('electron-updater');
    autoUpdater = mod.autoUpdater;
  } catch (err) {
    console.warn('[updater] electron-updater failed to load — auto-update disabled:', (err as Error)?.message ?? err);
    return;
  }

  configureAutoUpdater(autoUpdater);
  initialized = true;

  // Initial check on startup.
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.warn('[updater] Initial update check failed:', (err as Error)?.message ?? err);
  }

  // Periodic check every hour.
  updateCheckTimer = setInterval(async () => {
    try {
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (err) {
      console.warn('[updater] Periodic update check failed:', (err as Error)?.message ?? err);
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic update check timer. Call from the will-quit handler.
 *
 * Safe to call even if initUpdater was never invoked (dev / skipped).
 */
export function stopUpdater(): void {
  if (updateCheckTimer !== null) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
    console.log('[updater] Stopped periodic update check timer');
  }
  initialized = false;
}

/**
 * Test helper — reset module state between test cases.
 *
 * NOT exported from the public surface by convention; tests import the
 * symbol directly.
 */
export function __resetUpdaterForTests(): void {
  if (updateCheckTimer !== null) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  initialized = false;
}
