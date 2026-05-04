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

import { EventEmitter } from 'node:events';
import { app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { AppUpdater } from 'electron-updater';
import { mainLogger } from './logger';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Generic GitHub release-asset feed — see release.yml. The explicit
// /releases/latest/download URL makes electron-updater fetch latest-mac.yml or
// latest-linux.yml directly from the published release assets and avoids
// depending on electron-builder's GitHub provider metadata generation.
const UPDATE_FEED_URL = 'https://github.com/browser-use/desktop/releases/latest/download';
const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/browser-use/desktop/releases/latest';

let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let activeCheckForUpdates: UpdateCheck | null = null;
let activeInstallUpdate: (() => void) | null = null;
let installInProgress = false;
let updateQuitInProgress = false;

type UpdateCheck = () => Promise<void>;

type WindowsAutoUpdater = {
  setFeedURL(opts: { url: string }): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): void;
  quitAndInstall(): void;
};

type AppUpdaterWithDownloadedUpdateHelper = AppUpdater & {
  downloadedUpdateHelper?: {
    clear?: () => Promise<void>;
  } | null;
};

type BeforeQuitForUpdateEmitter = {
  on(event: 'before-quit-for-update', listener: () => void): unknown;
};

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unavailable';

export type UpdateStatusEvent = {
  status: UpdateStatus;
  version?: string;
  message?: string;
  error?: string;
  progress?: {
    percent: number | null;
    transferred: number | null;
    total: number | null;
    bytesPerSecond: number | null;
  };
};

const updateStatusEmitter = new EventEmitter();
const updateQuitEmitter = new EventEmitter();
let currentUpdateStatus: UpdateStatusEvent = { status: 'idle' };

function logInfo(message: string, extra?: Record<string, unknown>): void {
  mainLogger.info(`updater.${message}`, extra);
}

function logWarn(message: string, extra?: Record<string, unknown>): void {
  mainLogger.warn(`updater.${message}`, extra);
}

function logError(message: string, extra?: Record<string, unknown>): void {
  mainLogger.error(`updater.${message}`, extra);
}

function emitUpdateStatus(event: UpdateStatusEvent): void {
  currentUpdateStatus = event;
  logInfo('status', event as Record<string, unknown>);
  updateStatusEmitter.emit('status', event);
}

async function clearCachedUpdate(autoUpdater: AppUpdater, reason: string): Promise<void> {
  const helper = (autoUpdater as AppUpdaterWithDownloadedUpdateHelper).downloadedUpdateHelper;
  if (!helper?.clear) return;
  try {
    await helper.clear();
    logInfo('cacheCleared', { reason });
  } catch (err) {
    logWarn('cacheClearFailed', { reason, error: (err as Error)?.message ?? String(err) });
  }
}

function runInstallUpdate(action: () => void): void {
  if (installInProgress) {
    logInfo('install.duplicateIgnored');
    return;
  }
  installInProgress = true;
  action();
}

function isUpdateDialogOwnerCandidate(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  const url = win.webContents.getURL();
  if (url.includes('/logs/') || url.endsWith('/logs.html')) return false;
  if (url.includes('/pill/') || url.endsWith('/pill.html')) return false;
  return true;
}

function getUpdateDialogOwner(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && isUpdateDialogOwnerCandidate(focused)) return focused;

  const candidates = BrowserWindow.getAllWindows().filter(isUpdateDialogOwnerCandidate);
  return candidates.find((win) => win.isVisible()) ?? candidates[0] ?? null;
}

function showNativeMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const owner = getUpdateDialogOwner();
  if (owner) {
    logInfo('dialog.owner', { windowId: owner.id, url: owner.webContents.getURL() });
    return dialog.showMessageBox(owner, options);
  }
  logInfo('dialog.owner', { windowId: null });
  return dialog.showMessageBox(options);
}

export function getUpdateStatus(): UpdateStatusEvent {
  return currentUpdateStatus;
}

export function onUpdateStatusChanged(listener: (event: UpdateStatusEvent) => void): () => void {
  updateStatusEmitter.on('status', listener);
  return () => updateStatusEmitter.off('status', listener);
}

export function onBeforeQuitForUpdate(listener: () => void): () => void {
  updateQuitEmitter.on('before-quit-for-update', listener);
  return () => updateQuitEmitter.off('before-quit-for-update', listener);
}

function emitBeforeQuitForUpdate(): void {
  if (updateQuitInProgress) return;
  updateQuitInProgress = true;
  logInfo('beforeQuitForUpdate');
  updateQuitEmitter.emit('before-quit-for-update');
}

function onElectronBeforeQuitForUpdate(autoUpdater: BeforeQuitForUpdateEmitter): void {
  autoUpdater.on('before-quit-for-update', () => {
    emitBeforeQuitForUpdate();
  });
}

function getVersionFromArgs(args: unknown[]): string | undefined {
  const first = args[0];
  if (first && typeof first === 'object' && 'version' in first) {
    const version = (first as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  }
  return undefined;
}

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

  // Route electron-updater diagnostics into our persistent main.log. Console
  // output is often invisible for packaged apps launched from Finder.
  autoUpdater.logger = {
    info: (message: unknown) => logInfo('electronUpdater.info', { message: String(message) }),
    warn: (message: unknown) => logWarn('electronUpdater.warn', { message: String(message) }),
    error: (message: unknown) => logError('electronUpdater.error', { message: String(message) }),
    debug: (message: unknown) => logInfo('electronUpdater.debug', { message: String(message) }),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // The release workflow publishes full update ZIPs, not .blockmap files.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('checking-for-update', () => {
    logInfo('checking', { platform: process.platform, version: app.getVersion(), feedUrl: UPDATE_FEED_URL });
    emitUpdateStatus({ status: 'checking', message: 'Checking for updates...' });
  });

  autoUpdater.on('update-available', (info) => {
    logInfo('available', { version: info.version, currentVersion: app.getVersion() });
    emitUpdateStatus({
      status: 'downloading',
      version: info.version,
      message: `Downloading version ${info.version}...`,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    logInfo('notAvailable', { version: info.version, currentVersion: app.getVersion() });
    emitUpdateStatus({
      status: 'idle',
      version: info.version,
      message: `Version ${app.getVersion()} is the latest version.`,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = typeof progress.percent === 'number' ? progress.percent.toFixed(1) : '?';
    logInfo('downloadProgress', {
      percent: typeof progress.percent === 'number' ? progress.percent : null,
      transferred: typeof progress.transferred === 'number' ? progress.transferred : null,
      total: typeof progress.total === 'number' ? progress.total : null,
      bytesPerSecond: typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : null,
    });
    emitUpdateStatus({
      status: 'downloading',
      message: `Downloading update (${pct}%)...`,
      progress: {
        percent: typeof progress.percent === 'number' ? progress.percent : null,
        transferred: typeof progress.transferred === 'number' ? progress.transferred : null,
        total: typeof progress.total === 'number' ? progress.total : null,
        bytesPerSecond: typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : null,
      },
    });
  });

  onElectronBeforeQuitForUpdate(autoUpdater as unknown as BeforeQuitForUpdateEmitter);

  autoUpdater.on('update-downloaded', (info) => {
    logInfo('downloaded', { version: info.version });
    installInProgress = false;
    updateQuitInProgress = false;
    activeInstallUpdate = () => {
      runInstallUpdate(() => {
        emitBeforeQuitForUpdate();
        autoUpdater.quitAndInstall(false, true);
      });
    };
    emitUpdateStatus({
      status: 'ready',
      version: info.version,
      message: `Version ${info.version} is ready to install.`,
    });
    // Prompt the user. If they dismiss, autoInstallOnAppQuit handles it on
    // the next natural quit, so we never block an update forever.
    showNativeMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} is ready to install.`,
      detail: 'Restart now to apply the update, or it will install automatically on next quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    })
      .then(({ response }) => {
        if (response === 0) {
          activeInstallUpdate?.();
        }
      })
      .catch((err: unknown) => {
        logWarn('dialogFailed', { error: (err as Error)?.message ?? String(err) });
      });
  });

  autoUpdater.on('error', (err: Error) => {
    installInProgress = false;
    updateQuitInProgress = false;
    logError('error', { error: err.message, stack: err.stack });
    void clearCachedUpdate(autoUpdater, `error: ${err.message}`);
    emitUpdateStatus({ status: 'error', error: err.message, message: 'Failed to check for updates.' });
    // Non-fatal — log and continue. Do not crash the app on update errors.
  });

  return async () => {
    await autoUpdater.checkForUpdates();
  };
}

function configureWindowsAutoUpdater(autoUpdater: WindowsAutoUpdater): UpdateCheck {
  autoUpdater.setFeedURL({ url: UPDATE_FEED_URL });

  autoUpdater.on('checking-for-update', () => {
    logInfo('windows.checking', { version: app.getVersion(), feedUrl: UPDATE_FEED_URL });
    emitUpdateStatus({ status: 'checking', message: 'Checking for updates...' });
  });

  autoUpdater.on('update-available', (...args) => {
    const version = getVersionFromArgs(args);
    logInfo('windows.available', { version, currentVersion: app.getVersion() });
    emitUpdateStatus({
      status: 'downloading',
      version,
      message: version ? `Downloading version ${version}...` : 'Downloading update...',
    });
  });

  autoUpdater.on('update-not-available', (...args) => {
    const version = getVersionFromArgs(args);
    logInfo('windows.notAvailable', { version, currentVersion: app.getVersion() });
    emitUpdateStatus({
      status: 'idle',
      version,
      message: `Version ${app.getVersion()} is the latest version.`,
    });
  });

  autoUpdater.on('update-downloaded', (...args) => {
    const version = getVersionFromArgs(args);
    logInfo('windows.downloaded', { version });
    installInProgress = false;
    updateQuitInProgress = false;
    activeInstallUpdate = () => {
      runInstallUpdate(() => {
        emitBeforeQuitForUpdate();
        autoUpdater.quitAndInstall();
      });
    };
    emitUpdateStatus({
      status: 'ready',
      version,
      message: version ? `Version ${version} is ready to install.` : 'An update is ready to install.',
    });
    showNativeMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'An update is ready to install.',
      detail: 'Restart now to apply the update, or install it the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    })
      .then(({ response }) => {
        if (response === 0) {
          activeInstallUpdate?.();
        }
      })
      .catch((err: unknown) => {
        logWarn('windows.dialogFailed', { error: (err as Error)?.message ?? String(err) });
      });
  });

  autoUpdater.on('error', (err: Error) => {
    installInProgress = false;
    updateQuitInProgress = false;
    logError('windows.error', { error: err.message, stack: err.stack });
    emitUpdateStatus({ status: 'error', error: err.message, message: 'Failed to check for updates.' });
  });

  onElectronBeforeQuitForUpdate(autoUpdater);

  return async () => {
    autoUpdater.checkForUpdates();
  };
}

export function supportsUpdates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  return false;
}

function getUpdateUnavailableMessage(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (shouldSkipUpdates()) {
    return 'In-app updates are available after installing a packaged release build.';
  }
  if (!supportsUpdates(platform, env)) {
    return 'In-app updates are only available for macOS, Windows, and Linux AppImage builds.';
  }
  return 'In-app updates are unavailable in this build.';
}

export type UpdateRuntimeInfo = {
  version: string;
  latestVersion: string | null;
  isLatestVersion: boolean | null;
  platform: NodeJS.Platform;
  packaged: boolean;
  updateSupported: boolean;
  canDownloadUpdate: boolean;
  updateFeedUrl: string;
};

export type ManualUpdateResult = {
  ok: boolean;
  action: 'started-update-check' | 'unavailable';
  message: string;
};

export type InstallUpdateResult = {
  ok: boolean;
  action: 'install-started' | 'not-ready';
  message: string;
};

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

async function fetchLatestReleaseVersion(): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Browser-Use-Desktop-Updater',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    return typeof data.tag_name === 'string' ? normalizeVersion(data.tag_name) : null;
  } catch {
    return null;
  }
}

export async function getUpdateRuntimeInfo(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRuntimeInfo> {
  const version = app.getVersion();
  const latestVersion = await fetchLatestReleaseVersion();
  const updateSupported = supportsUpdates(platform, env);
  const canDownloadUpdate = app.isPackaged && updateSupported && !(env.NODE_ENV && env.NODE_ENV !== 'production');
  return {
    version,
    latestVersion,
    isLatestVersion: latestVersion === null ? null : normalizeVersion(version) === latestVersion,
    platform,
    packaged: app.isPackaged,
    updateSupported,
    canDownloadUpdate,
    updateFeedUrl: UPDATE_FEED_URL,
  };
}

export async function downloadLatestVersion(): Promise<ManualUpdateResult> {
  if (shouldSkipUpdates() || !supportsUpdates(process.platform, process.env)) {
    const message = getUpdateUnavailableMessage();
    emitUpdateStatus({ status: 'unavailable', message });
    return {
      ok: false,
      action: 'unavailable',
      message,
    };
  }

  if (!activeCheckForUpdates) {
    await initUpdater();
  }

  if (!activeCheckForUpdates) {
    const message = 'In-app updates are unavailable in this build.';
    emitUpdateStatus({ status: 'unavailable', message });
    return {
      ok: false,
      action: 'unavailable',
      message,
    };
  }

  emitUpdateStatus({ status: 'checking', message: 'Checking for updates...' });
  await activeCheckForUpdates();
  return {
    ok: true,
    action: 'started-update-check',
    message: 'Checking for updates. If a newer version exists, it will download in the background and prompt when ready.',
  };
}

export function installDownloadedUpdate(): InstallUpdateResult {
  if (!activeInstallUpdate || currentUpdateStatus.status !== 'ready') {
    return {
      ok: false,
      action: 'not-ready',
      message: 'No downloaded update is ready to install.',
    };
  }
  activeInstallUpdate();
  return {
    ok: true,
    action: 'install-started',
    message: 'Restarting to install the update...',
  };
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
    logWarn('init.duplicate', { platform: process.platform, version: app.getVersion() });
    return;
  }
  logInfo('init.start', {
    platform: process.platform,
    version: app.getVersion(),
    packaged: app.isPackaged,
    nodeEnv: process.env.NODE_ENV ?? null,
    feedUrl: UPDATE_FEED_URL,
  });
  if (shouldSkipUpdates()) {
    logInfo('init.skipped', {
      reason: 'dev-or-not-packaged',
      packaged: app.isPackaged,
      nodeEnv: process.env.NODE_ENV ?? null,
    });
    return;
  }
  if (!supportsUpdates(process.platform, process.env)) {
    logInfo('init.skipped', { reason: 'unsupported-platform-or-channel', platform: process.platform });
    return;
  }

  let checkForUpdates: UpdateCheck;
  if (process.platform === 'win32') {
    if (!electronAutoUpdater) {
      logWarn('windows.unavailable', { reason: 'native-autoUpdater-missing' });
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
        logWarn('generic.unavailable', { reason: 'electron-updater-export-missing' });
        return;
      }
    } catch (err) {
      logWarn('generic.unavailable', { reason: 'electron-updater-load-failed', error: (err as Error)?.message ?? String(err) });
      return;
    }
    checkForUpdates = configureGenericAutoUpdater(autoUpdater);
  }

  initialized = true;
  activeCheckForUpdates = checkForUpdates;

  // Initial check on startup.
  try {
    logInfo('startupCheck.start', { platform: process.platform, version: app.getVersion() });
    await checkForUpdates();
    logInfo('startupCheck.started', { platform: process.platform });
  } catch (err) {
    logWarn('startupCheck.failed', { error: (err as Error)?.message ?? String(err) });
  }

  // Periodic check every hour.
  updateCheckTimer = setInterval(async () => {
    try {
      logInfo('periodicCheck.start', { platform: process.platform, version: app.getVersion() });
      await checkForUpdates();
      logInfo('periodicCheck.started', { platform: process.platform });
    } catch (err) {
      logWarn('periodicCheck.failed', { error: (err as Error)?.message ?? String(err) });
    }
  }, UPDATE_CHECK_INTERVAL_MS);
  logInfo('periodicCheck.scheduled', { intervalMs: UPDATE_CHECK_INTERVAL_MS });
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
    logInfo('stopped');
  }
  initialized = false;
  activeCheckForUpdates = null;
  activeInstallUpdate = null;
  installInProgress = false;
  updateQuitInProgress = false;
  currentUpdateStatus = { status: 'idle' };
}
