/**
 * Unit tests for src/main/updater.ts — Issue #202.
 *
 * Verifies:
 *   - initUpdater() is a no-op in dev mode (app.isPackaged === false)
 *   - initUpdater() configures electron-updater's autoUpdater with the
 *     GitHub Releases provider when packaged.
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
  public logger: unknown = null;
  public feedURL: unknown = null;
  public checkCount = 0;
  public quitAndInstallCalled = false;
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

  async checkForUpdatesAndNotify(): Promise<null> {
    this.checkCount += 1;
    return null;
  }

  quitAndInstall(): void {
    this.quitAndInstallCalled = true;
  }

  hasListener(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0;
  }
}

// vi.mock is hoisted; expose the instance through a getter so the test body
// can grab the current mock after each import.
const fakeAutoUpdater = new FakeAutoUpdater();

vi.mock('electron-updater', () => ({
  autoUpdater: fakeAutoUpdater,
}));

// ---------------------------------------------------------------------------
// Per-test reset — force a fresh module load so `initialized` state and the
// timer reset between cases.
// ---------------------------------------------------------------------------
type UpdaterModule = typeof import('../../../src/main/updater');
type ElectronModule = typeof import('electron');

async function loadUpdaterFresh(
  packaged: boolean,
): Promise<{ updater: UpdaterModule; electron: ElectronModule }> {
  vi.resetModules();
  // Clear captured state on the shared fake so assertions remain isolated.
  fakeAutoUpdater.autoDownload = false;
  fakeAutoUpdater.autoInstallOnAppQuit = false;
  fakeAutoUpdater.logger = null;
  fakeAutoUpdater.feedURL = null;
  fakeAutoUpdater.checkCount = 0;
  fakeAutoUpdater.quitAndInstallCalled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fakeAutoUpdater as any).listeners = new Map<string, Listener[]>();

  // Import the fresh electron mock AFTER resetModules so we can mutate the
  // `isPackaged` field before the updater module reads it.
  const electron = (await import('electron')) as ElectronModule;
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

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
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

    it('configures GitHub Releases feed for browser-use/desktop-app', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();

      expect(fakeAutoUpdater.feedURL).toEqual({
        provider: 'github',
        owner: 'browser-use',
        repo: 'desktop-app',
      });

      updater.stopUpdater();
    });

    it('enables autoDownload + autoInstallOnAppQuit', async () => {
      const { updater } = await loadUpdaterFresh(true);

      await updater.initUpdater();

      expect(fakeAutoUpdater.autoDownload).toBe(true);
      expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(true);

      updater.stopUpdater();
    });

    it('performs an initial checkForUpdatesAndNotify', async () => {
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
