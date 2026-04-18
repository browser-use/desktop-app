/**
 * updater.ts — electron-updater integration stub.
 *
 * Uses electron-updater to check for updates from a placeholder feed URL.
 * The feed URL must be replaced with a real S3/GH Releases URL before v0.1 ships.
 *
 * TODO (requires update feed setup — not available in this session):
 *   1. Replace FEED_URL with your actual update feed URL.
 *      Options:
 *        - GitHub Releases: https://github.com/your-org/desktop-app/releases/latest/download/
 *        - update.electronjs.org: https://update.electronjs.org/your-org/desktop-app/${process.platform}/${app.getVersion()}
 *        - S3: https://your-bucket.s3.amazonaws.com/releases/
 *   2. Install electron-updater: npm install electron-updater
 *      (listed in .track-F-deps.txt — do NOT run npm install in this session)
 *   3. Configure forge publish config in forge.config.ts to match the feed type.
 *
 * NOTE: utilityProcess is used for the Python daemon (not child_process).
 *       RunAsNode fuse is false; this file runs in the main process only.
 */

import { app, dialog } from 'electron';

// TODO: replace with real update feed URL before shipping v0.1.
const FEED_URL = 'https://TODO_REPLACE_WITH_REAL_UPDATE_FEED_URL/';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let updateCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize auto-updater. Call once from app.whenReady().
 *
 * In dev mode (app.isPackaged === false) update checks are skipped —
 * electron-updater will throw if the app is not packaged.
 */
export async function initUpdater(): Promise<void> {
  if (!app.isPackaged) {
    console.log('[updater] Skipping auto-update init — app is not packaged (dev mode)');
    return;
  }

  // Lazy-import electron-updater so dev builds don't fail if it's not installed yet.
  // The module isn't in package.json (see initUpdater TODO), so the specifier
  // is built as a dynamic expression and typed as `any` — tsc will otherwise
  // fail to resolve `electron-updater`. Remove this workaround once the dep
  // is added to package.json.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let autoUpdater: any;
  try {
    const specifier = 'electron-updater';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ specifier);
    autoUpdater = mod.autoUpdater;
  } catch (err) {
    console.warn('[updater] electron-updater not installed — auto-update disabled');
    console.warn('[updater] Run: npm install electron-updater');
    return;
  }

  autoUpdater.setFeedURL(FEED_URL);

  // Verbose logging for diagnostics (Track H telemetry will wire this up properly).
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for update at', FEED_URL);
  });

  autoUpdater.on('update-available', (info: any) => {
    console.log('[updater] Update available:', info.version, 'current:', app.getVersion());
  });

  autoUpdater.on('update-not-available', (info: any) => {
    console.log('[updater] No update available. Current version is latest:', info.version);
  });

  autoUpdater.on('download-progress', (progress: any) => {
    console.log(
      `[updater] Download progress: ${progress.percent.toFixed(1)}%`,
      `(${progress.transferred}/${progress.total} bytes)`,
      `speed: ${progress.bytesPerSecond} B/s`,
    );
  });

  autoUpdater.on('update-downloaded', (info: any) => {
    console.log('[updater] Update downloaded:', info.version);
    // Notify the user and offer to restart.
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
      });
  });

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] Auto-update error:', err.message);
    // Non-fatal — log and continue. Do not crash the app on update errors.
  });

  // Initial check on startup.
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err: any) {
    console.warn('[updater] Initial update check failed:', err?.message);
  }

  // Periodic check every hour.
  updateCheckTimer = setInterval(async () => {
    try {
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (err: any) {
      console.warn('[updater] Periodic update check failed:', err?.message);
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic update check timer. Call from before-quit handler.
 */
export function stopUpdater(): void {
  if (updateCheckTimer !== null) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
    console.log('[updater] Stopped periodic update check timer');
  }
}
