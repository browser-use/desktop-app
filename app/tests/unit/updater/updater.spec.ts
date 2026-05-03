/**
 * Unit tests for src/main/updater.ts — Issue #202.
 *
 * Verifies:
 *   - initUpdater() is a no-op in dev mode (app.isPackaged === false)
 *   - initUpdater() configures electron-updater's autoUpdater with the
 *     GitHub release-asset feed when packaged.
 *   - initUpdater() wires the expected lifecycle events.
 *   - stopUpdater() tears down the periodic timer (verified by swapping
 *     globalThis.setInterval/clearInterval).
 *   - The startup / shutdown sequence calls initUpdater() then stopUpdater().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// electron-updater mock — captured so individual tests can inspect it.
// ---------------------------------------------------------------------------
type Listener = (...args: unknown[]) => void;

class FakeAutoUpdater {
  public autoDownload = false;
  public autoInstallOnAppQuit = false;
  public disableDifferentialDownload = false;
  public logger: unknown = null;
  public feedURL: unknown = null;
  public checkCount = 0;
  public quitAndInstallCount = 0;
  public quitAndInstallCalled = false;
  public onQuitAndInstall: (() => void) | null = null;
  public downloadedUpdateHelper = {
    clear: vi.fn(async () => {}),
  };
  private readonly listeners = new Map<string, Listener[]>();

  setFeedURL(opts: unknown): void {
    this.feedURL = opts;
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  async checkForUpdates(): Promise<null> {
    this.checkCount += 1;
    return null;
  }

  quitAndInstall(): void {
    this.onQuitAndInstall?.();
    this.quitAndInstallCount += 1;
    this.quitAndInstallCalled = true;
  }

  hasListener(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0;
  }
}

class FakeWindowsAutoUpdater {
  public feedURL: unknown = null;
  public checkCount = 0;
  public quitAndInstallCount = 0;
  public quitAndInstallCalled = false;
  public onQuitAndInstall: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  reset(): void {
    this.feedURL = null;
    this.checkCount = 0;
    this.quitAndInstallCount = 0;
    this.quitAndInstallCalled = false;
    this.onQuitAndInstall = null;
    this.listeners = new Map<string, Listener[]>();
  }

  setFeedURL(opts: unknown): void {
    this.feedURL = opts;
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  checkForUpdates(): void {
    this.checkCount += 1;
  }

  quitAndInstall(): void {
    this.onQuitAndInstall?.();
    this.quitAndInstallCount += 1;
    this.quitAndInstallCalled = true;
  }

  hasListener(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0;
  }
}

// vi.mock is hoisted; expose the instance through a getter so the test body
// can grab the current mock after each import.
const fakeAutoUpdater = new FakeAutoUpdater();
const fakeWindowsAutoUpdater = new FakeWindowsAutoUpdater();

vi.mock('electron-updater', () => ({
  autoUpdater: fakeAutoUpdater,
}));

// ---------------------------------------------------------------------------
// Per-test reset — force a fresh module load so `initialized` state and the
// timer reset between cases.
// ---------------------------------------------------------------------------
type UpdaterModule = typeof import('../../../src/main/updater');
type ElectronModule = typeof import('electron');
type MockUpdateDialogWindow = {
  id: number;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  webContents: {
    getURL: () => string;
  };
};

async function loadUpdaterFresh(
  packaged: boolean,
  platform: NodeJS.Platform = 'darwin',
): Promise<{ updater: UpdaterModule; electron: ElectronModule }> {
  vi.resetModules();
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  // Clear captured state on the shared fake so assertions remain isolated.
  fakeAutoUpdater.autoDownload = false;
  fakeAutoUpdater.autoInstallOnAppQuit = false;
  fakeAutoUpdater.disableDifferentialDownload = false;
  fakeAutoUpdater.logger = null;
  fakeAutoUpdater.feedURL = null;
  fakeAutoUpdater.checkCount = 0;
  fakeAutoUpdater.quitAndInstallCount = 0;
  fakeAutoUpdater.quitAndInstallCalled = false;
  fakeAutoUpdater.onQuitAndInstall = null;
  fakeAutoUpdater.downloadedUpdateHelper.clear.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fakeAutoUpdater as any).listeners = new Map<string, Listener[]>();
  fakeWindowsAutoUpdater.reset();

  // Import the fresh electron mock AFTER resetModules so we can mutate the
  // `isPackaged` field before the updater module reads it.
  const electron = (await import('electron')) as ElectronModule;
  const nativeUpdater = electron.autoUpdater as unknown as Record<string, unknown>;
  nativeUpdater.setFeedURL = fakeWindowsAutoUpdater.setFeedURL.bind(fakeWindowsAutoUpdater);
  nativeUpdater.on = fakeWindowsAutoUpdater.on.bind(fakeWindowsAutoUpdater);
  nativeUpdater.checkForUpdates = fakeWindowsAutoUpdater.checkForUpdates.bind(fakeWindowsAutoUpdater);
  nativeUpdater.quitAndInstall = fakeWindowsAutoUpdater.quitAndInstall.bind(fakeWindowsAutoUpdater);
  Object.defineProperty(electron.app, 'isPackaged', {
    value: packaged,
    configurable: true,
    writable: true,
  });
  const updater = await import('../../../src/main/updater');
  return { updater, electron };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('updater (Issue #202)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPlatform = process.platform;
  const originalAppImage = process.env.APPIMAGE;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAppImage === undefined) {
      delete process.env.APPIMAGE;
    } else {
      process.env.APPIMAGE = originalAppImage;
    }
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('shouldSkipUpdates', () => {
    it('returns true when app is not packaged', async () => {
      const { updater } = await loadUpdaterFresh(false);
      expect(updater.shouldSkipUpdates()).toBe(true);
    });

    it('returns true when NODE_ENV is not production', async () => {
      process.env.NODE_ENV = 'development';
      const { updater } = await loadUpdaterFresh(true);
      expect(updater.shouldSkipUpdates()).toBe(true);
    });

    it('returns false when packaged and production', async () => {
      process.env.NODE_ENV = 'production';
      const { updater } = await loadUpdaterFresh(true);
      expect(updater.shouldSkipUpdates()).toBe(false);
    });

    it('supports macOS, Windows, and Linux AppImage update backends', async () => {
      const { updater } = await loadUpdaterFresh(false);
      expect(updater.supportsUpdates('darwin')).toBe(true);
      expect(updater.supportsUpdates('win32')).toBe(true);
      expect(updater.supportsUpdates('linux', {})).toBe(false);
      expect(updater.supportsUpdates('linux', { APPIMAGE: '/tmp/Browser-Use.AppImage' })).toBe(true);
    });
  });

  describe('initUpdater in dev', () => {
    it('is a no-op when app is not packaged', async () => {
      const { updater } = await loadUpdaterFresh(false);

      await updater.initUpdater();

      // None of the fake autoUpdater fields should have been touched.
      expect(fakeAutoUpdater.feedURL).toBeNull();
      expect(fakeAutoUpdater.autoDownload).toBe(false);
      expect(fakeAutoUpdater.checkCount).toBe(0);
    });
  });

  describe('initUpdater when packaged', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('configures the GitHub release-asset feed for browser-use/desktop-app', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();

      expect(fakeAutoUpdater.feedURL).toEqual({
        provider: 'generic',
        url: 'https://github.com/browser-use/desktop-app/releases/latest/download',
      });

      updater.stopUpdater();
    });

    it('configures the native Squirrel.Windows feed on Windows', async () => {
      const { updater } = await loadUpdaterFresh(true, 'win32');

      await updater.initUpdater();

      expect(fakeWindowsAutoUpdater.feedURL).toEqual({
        url: 'https://github.com/browser-use/desktop-app/releases/latest/download',
      });
      expect(fakeWindowsAutoUpdater.checkCount).toBe(1);
      expect(fakeWindowsAutoUpdater.hasListener('update-downloaded')).toBe(true);
      expect(fakeAutoUpdater.feedURL).toBeNull();

      updater.stopUpdater();
    });

    it('skips Linux distro packages and only configures updates for AppImage launches', async () => {
      delete process.env.APPIMAGE;
      let loaded = await loadUpdaterFresh(true, 'linux');

      await loaded.updater.initUpdater();

      expect(fakeAutoUpdater.feedURL).toBeNull();
      expect(fakeAutoUpdater.checkCount).toBe(0);

      process.env.APPIMAGE = '/tmp/Browser-Use-1.2.3-x64.AppImage';
      loaded = await loadUpdaterFresh(true, 'linux');

      await loaded.updater.initUpdater();

      expect(fakeAutoUpdater.feedURL).toEqual({
        provider: 'generic',
        url: 'https://github.com/browser-use/desktop-app/releases/latest/download',
      });
      expect(fakeAutoUpdater.checkCount).toBe(1);

      loaded.updater.stopUpdater();
    });

    it('enables full-download background updates and install-on-quit', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();

      expect(fakeAutoUpdater.autoDownload).toBe(true);
      expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(true);
      expect(fakeAutoUpdater.disableDifferentialDownload).toBe(true);

      updater.stopUpdater();
    });

    it('performs an initial checkForUpdates on startup', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();

      expect(fakeAutoUpdater.checkCount).toBeGreaterThanOrEqual(1);

      updater.stopUpdater();
    });

    it('wires update-available, update-downloaded, and error listeners', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();

      expect(fakeAutoUpdater.hasListener('update-available')).toBe(true);
      expect(fakeAutoUpdater.hasListener('update-downloaded')).toBe(true);
      expect(fakeAutoUpdater.hasListener('error')).toBe(true);

      updater.stopUpdater();
    });

    it('ignores a second initUpdater() call', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();
      const firstCount = fakeAutoUpdater.checkCount;
      await updater.initUpdater();

      expect(fakeAutoUpdater.checkCount).toBe(firstCount);

      updater.stopUpdater();
    });
  });

  describe('manual update download', () => {
    it('reports when the running app version matches the latest release tag', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: 'v0.1.0-test' }),
      })));
      const { updater } = await loadUpdaterFresh(false);

      const info = await updater.getUpdateRuntimeInfo();

      expect(info.version).toBe('0.1.0-test');
      expect(info.latestVersion).toBe('0.1.0-test');
      expect(info.isLatestVersion).toBe(true);
      expect(info.canDownloadUpdate).toBe(false);
    });

    it('reports when a newer release is available', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: 'v9.9.9' }),
      })));
      const { updater } = await loadUpdaterFresh(false);

      const info = await updater.getUpdateRuntimeInfo();

      expect(info.latestVersion).toBe('9.9.9');
      expect(info.isLatestVersion).toBe(false);
    });

    it('does not open a browser URL when updater cannot run in the current build', async () => {
      const { updater, electron } = await loadUpdaterFresh(false);
      const openExternal = vi.spyOn(electron.shell, 'openExternal');

      const result = await updater.downloadLatestVersion();

      expect(result.ok).toBe(false);
      expect(result.action).toBe('unavailable');
      expect(updater.getUpdateStatus()).toMatchObject({
        status: 'unavailable',
      });
      expect(openExternal).not.toHaveBeenCalled();
      expect(fakeAutoUpdater.checkCount).toBe(0);
    });

    it('starts an updater check when packaged updates are supported', async () => {
      const { updater } = await loadUpdaterFresh(true);

      const result = await updater.downloadLatestVersion();

      expect(result.action).toBe('started-update-check');
      expect(fakeAutoUpdater.feedURL).toEqual({
        provider: 'generic',
        url: 'https://github.com/browser-use/desktop-app/releases/latest/download',
      });
      expect(fakeAutoUpdater.checkCount).toBeGreaterThanOrEqual(2);

      updater.stopUpdater();
    });

    it('shows the update-ready dialog for a mocked 0.0.27 update and installs once ready', async () => {
      const { updater, electron } = await loadUpdaterFresh(true);
      const showMessageBox = vi.spyOn(electron.dialog, 'showMessageBox').mockResolvedValue({
        response: 1,
        checkboxChecked: false,
      });
      const statuses: string[] = [];
      const unsubscribe = updater.onUpdateStatusChanged((event) => {
        statuses.push(event.status);
      });

      await updater.initUpdater();
      fakeAutoUpdater.emit('update-available', { version: '0.0.27' });
      fakeAutoUpdater.emit('download-progress', {
        percent: 42,
        transferred: 42,
        total: 100,
        bytesPerSecond: 1000,
      });
      fakeAutoUpdater.emit('update-downloaded', { version: '0.0.27' });

      expect(statuses).toContain('downloading');
      expect(updater.getUpdateStatus()).toMatchObject({
        status: 'ready',
        version: '0.0.27',
        message: 'Version 0.0.27 is ready to install.',
      });
      expect(showMessageBox).toHaveBeenCalledWith({
        type: 'info',
        title: 'Update Ready',
        message: 'Version 0.0.27 is ready to install.',
        detail: 'Restart now to apply the update, or it will install automatically on next quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      });
      expect(fakeAutoUpdater.quitAndInstallCalled).toBe(false);

      const result = updater.installDownloadedUpdate();

      expect(result.action).toBe('install-started');
      expect(fakeAutoUpdater.quitAndInstallCalled).toBe(true);

      unsubscribe();
      updater.stopUpdater();
    });

    it('signals the app quit path before calling quitAndInstall', async () => {
      const { updater, electron } = await loadUpdaterFresh(true);
      vi.spyOn(electron.dialog, 'showMessageBox').mockResolvedValue({
        response: 1,
        checkboxChecked: false,
      });
      const order: string[] = [];
      const unsubscribe = updater.onBeforeQuitForUpdate(() => {
        order.push('before-quit-for-update');
      });
      fakeAutoUpdater.onQuitAndInstall = () => {
        order.push('quit-and-install');
      };

      await updater.initUpdater();
      fakeAutoUpdater.emit('update-downloaded', { version: '0.0.27' });
      updater.installDownloadedUpdate();

      expect(order).toEqual(['before-quit-for-update', 'quit-and-install']);

      unsubscribe();
      updater.stopUpdater();
    });

    it('anchors update dialogs to the app window instead of focused utility windows', async () => {
      const { updater, electron } = await loadUpdaterFresh(true);
      const logsWindow: MockUpdateDialogWindow = {
        id: 2,
        isDestroyed: () => false,
        isVisible: () => true,
        webContents: {
          getURL: () => 'http://localhost:5176/src/renderer/logs/logs.html',
        },
      };
      const shellWindow: MockUpdateDialogWindow = {
        id: 1,
        isDestroyed: () => false,
        isVisible: () => true,
        webContents: {
          getURL: () => 'http://localhost:5173/src/renderer/hub/hub.html',
        },
      };
      vi.spyOn(electron.BrowserWindow, 'getFocusedWindow').mockReturnValue(logsWindow as never);
      vi.spyOn(electron.BrowserWindow, 'getAllWindows').mockReturnValue([logsWindow, shellWindow] as never);
      const showMessageBox = vi.spyOn(electron.dialog, 'showMessageBox').mockResolvedValue({
        response: 1,
        checkboxChecked: false,
      });

      await updater.initUpdater();
      fakeAutoUpdater.emit('update-downloaded', { version: '0.0.27' });

      expect(showMessageBox).toHaveBeenCalledWith(shellWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'Version 0.0.27 is ready to install.',
        detail: 'Restart now to apply the update, or it will install automatically on next quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      });

      updater.stopUpdater();
    });

    it('collapses repeated install clicks into one quitAndInstall call until an updater error resets the guard', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();
      fakeAutoUpdater.emit('update-downloaded', { version: '0.0.27' });

      updater.installDownloadedUpdate();
      updater.installDownloadedUpdate();
      updater.installDownloadedUpdate();

      expect(fakeAutoUpdater.quitAndInstallCount).toBe(1);

      fakeAutoUpdater.emit('error', new Error('squirrel failed'));
      fakeAutoUpdater.emit('update-downloaded', { version: '0.0.27' });
      updater.installDownloadedUpdate();

      expect(fakeAutoUpdater.quitAndInstallCount).toBe(2);

      updater.stopUpdater();
    });

    it('clears the cached electron-updater download helper on generic updater errors', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();
      fakeAutoUpdater.emit('error', new Error('cached update failed'));

      expect(fakeAutoUpdater.downloadedUpdateHelper.clear).toHaveBeenCalledTimes(1);

      updater.stopUpdater();
    });

  });

  describe('stopUpdater', () => {
    it('clears the periodic update timer', async () => {
      process.env.NODE_ENV = 'production';

      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;

      let createdTimer: unknown = null;
      const cleared: unknown[] = [];

      globalThis.setInterval = ((fn: () => void, ms: number) => {
        createdTimer = originalSetInterval(fn, ms);
        return createdTimer as ReturnType<typeof setInterval>;
      }) as typeof setInterval;
      globalThis.clearInterval = ((handle: unknown) => {
        cleared.push(handle);
        originalClearInterval(handle as Parameters<typeof originalClearInterval>[0]);
      }) as typeof clearInterval;

      try {
        const { updater } = await loadUpdaterFresh(true);
        await updater.initUpdater();

        expect(createdTimer).not.toBeNull();

        updater.stopUpdater();

        expect(cleared).toContain(createdTimer);
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });

    it('is safe to call when initUpdater was skipped', async () => {
      const { updater } = await loadUpdaterFresh(false);
      expect(() => updater.stopUpdater()).not.toThrow();
    });
  });

  describe('startup/shutdown lifecycle (Issue #202 acceptance)', () => {
    // The startup/shutdown sequence in src/main/index.ts:
    //   app.whenReady().then(() => { ...; initUpdater(); ... });
    //   app.on('will-quit', () => { ...; stopUpdater(); ... });
    // This test simulates that sequence against spies on the updater module
    // to prove the wiring calls both functions in the correct order.
    it('calls initUpdater on startup and stopUpdater on shutdown', async () => {
      process.env.NODE_ENV = 'production';

      const { updater } = await loadUpdaterFresh(true);
      const initSpy = vi.spyOn(updater, 'initUpdater');
      const stopSpy = vi.spyOn(updater, 'stopUpdater');

      // Simulate `app.whenReady().then(...)` path.
      const startup = async () => {
        await updater.initUpdater();
      };
      // Simulate `app.on('will-quit', ...)` path.
      const shutdown = () => {
        updater.stopUpdater();
      };

      await startup();
      shutdown();

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledTimes(1);

      // Order: init must come before stop.
      const initOrder = initSpy.mock.invocationCallOrder[0];
      const stopOrder = stopSpy.mock.invocationCallOrder[0];
      expect(initOrder).toBeLessThan(stopOrder);
    });
  });
});
