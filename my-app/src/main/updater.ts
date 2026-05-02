/**
 * updater.ts — auto-update integration.
 *
 * macOS uses electron-updater with a generic GitHub release-asset feed. The
 * release workflow uploads latest-mac.yml plus a Squirrel.Mac update ZIP to
 * the tagged Release; DMGs remain available for first installs and manual
 * downloads.
 *
 * Windows uses Electron's native autoUpdater against the same GitHub release
 * asset directory. Squirrel.Windows expects RELEASES + .nupkg assets, not the
 * electron-updater YAML manifests used by macOS and Linux.
 *
 * Linux uses electron-updater only for the AppImage channel. Distro packages
 * (.deb/.rpm) stay manual/package-manager style and must not attempt to
 * rewrite themselves from inside the app.
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

import { app, autoUpdater as electronAutoUpdater, dialog } from 'electron';
import type { AppUpdater } from 'electron-updater';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Generic GitHub release-asset feed — see release.yml. The explicit
// /releases/latest/download URL makes electron-updater fetch latest-mac.yml or
// latest-linux.yml directly from the published release assets and avoids
// depending on electron-builder's GitHub provider metadata generation.
const UPDATE_FEED_URL = 'https://github.com/browser-use/desktop-app/releases/latest/download';

let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

type UpdateCheck = () => Promise<void>;

type WindowsAutoUpdater = {
  setFeedURL(opts: { url: string }): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): void;
  quitAndInstall(): void;
};

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
function configureGenericAutoUpdater(autoUpdater: AppUpdater): UpdateCheck {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED_URL,
  });

  // Verbose diagnostics — electron-updater's logger interface is compatible
  // with the global console (info/warn/error).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (autoUpdater as any).logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // The release workflow publishes full update ZIPs, not .blockmap files.
  autoUpdater.disableDifferentialDownload = true;

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
          autoUpdater.quitAndInstall(false, true);
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

  return async () => {
    await autoUpdater.checkForUpdatesAndNotify();
  };
}

function configureWindowsAutoUpdater(autoUpdater: WindowsAutoUpdater): UpdateCheck {
  autoUpdater.setFeedURL({ url: UPDATE_FEED_URL });

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for Windows update');
  });

  autoUpdater.on('update-available', (...args) => {
    console.log('[updater] Windows update available:', ...args);
  });

  autoUpdater.on('update-not-available', (...args) => {
    console.log('[updater] No Windows update available:', ...args);
  });

  autoUpdater.on('update-downloaded', (...args) => {
    console.log('[updater] Windows update downloaded:', ...args);
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: 'An update is ready to install.',
        detail: 'Restart now to apply the update, or install it the next time you quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch((err: unknown) => {
        console.warn('[updater] Failed to show Windows update dialog:', (err as Error)?.message ?? err);
      });
  });

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] Windows auto-update error:', err.message);
  });

  return async () => {
    autoUpdater.checkForUpdates();
  };
}

export function supportsUpdates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  return false;
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
  if (!supportsUpdates(process.platform, process.env)) {
    console.log(`[updater] Skipping auto-update init — unsupported platform/channel: ${process.platform}`);
    return;
  }

  let checkForUpdates: UpdateCheck;
  if (process.platform === 'win32') {
    if (!electronAutoUpdater) {
      console.warn('[updater] Electron native autoUpdater unavailable — Windows auto-update disabled');
      return;
    }
    checkForUpdates = configureWindowsAutoUpdater(electronAutoUpdater as WindowsAutoUpdater);
  } else {
    // Dynamic import so that pulling this module into a renderer bundle or
    // into a test harness without electron-updater installed doesn't fail at
    // require time. The dep is a real `dependency` in package.json, so in a
    // packaged app this resolves synchronously out of node_modules.
    let autoUpdater: AppUpdater;
    try {
      // CommonJS interop: depending on the bundler, `await import(...)` returns
      // either { autoUpdater } (named) or { default: { autoUpdater } }
      // (default-wrapped). Handle both so production builds don't end up with
      // an undefined autoUpdater that throws on .setFeedURL.
      const mod = (await import('electron-updater')) as { autoUpdater?: AppUpdater; default?: { autoUpdater?: AppUpdater } };
      autoUpdater = (mod.autoUpdater ?? mod.default?.autoUpdater) as AppUpdater;
      if (!autoUpdater) {
        console.warn('[updater] electron-updater loaded but exposed no autoUpdater — auto-update disabled');
        return;
      }
    } catch (err) {
      console.warn('[updater] electron-updater failed to load — auto-update disabled:', (err as Error)?.message ?? err);
      return;
    }
    checkForUpdates = configureGenericAutoUpdater(autoUpdater);
  }

  initialized = true;

  // Initial check on startup.
  try {
    await checkForUpdates();
  } catch (err) {
    console.warn('[updater] Initial update check failed:', (err as Error)?.message ?? err);
  }

  // Periodic check every hour.
  updateCheckTimer = setInterval(async () => {
    try {
      await checkForUpdates();
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
