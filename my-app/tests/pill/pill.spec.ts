/**
 * Unit tests for pill.ts — main-process pill BrowserWindow lifecycle.
 * D1 (TDD): these tests are written before implementation.
 *
 * Tests run outside Electron context via electron-mock.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock electron before importing pill
// ---------------------------------------------------------------------------
vi.mock('electron', () => {
  const mockWin = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    isVisible: vi.fn().mockReturnValue(false),
    isDestroyed: vi.fn().mockReturnValue(false),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 560, height: 72 }),
    webContents: {
      send: vi.fn(),
      once: vi.fn(),
      openDevTools: vi.fn(),
    },
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  const BrowserWindow = vi.fn().mockImplementation(function () { return mockWin; });
  // Expose mockWin so tests can assert on it
  (BrowserWindow as unknown as { _mockWin: typeof mockWin })._mockWin = mockWin;

  return {
    BrowserWindow,
    app: {
      getPath: (name: string) => `/tmp/test-userData`,
      isReady: vi.fn().mockReturnValue(true),
    },
    screen: {
      getPrimaryDisplay: vi.fn().mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workAreaSize: { width: 1920, height: 1080 },
      }),
      getDisplayNearestPoint: vi.fn().mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workAreaSize: { width: 1920, height: 1080 },
      }),
      getCursorScreenPoint: vi.fn().mockReturnValue({ x: 960, y: 540 }),
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// We test the pill module's exported functions directly
// ---------------------------------------------------------------------------
import type { BrowserWindow as BW } from 'electron';
import { BrowserWindow, screen } from 'electron';

// Shape of the mock BrowserWindow instance assigned inside vi.mock().
// Typed here so call-site assertions (.isVisible, .show, .webContents, etc.)
// resolve to real Mock instances rather than a single opaque Mock.
interface MockBrowserWindow {
  loadURL: Mock;
  loadFile: Mock;
  show: Mock;
  hide: Mock;
  focus: Mock;
  isVisible: Mock;
  isDestroyed: Mock;
  setVisibleOnAllWorkspaces: Mock;
  setAlwaysOnTop: Mock;
  setBounds: Mock;
  getBounds: Mock;
  webContents: {
    send: Mock;
    once: Mock;
    openDevTools: Mock;
  };
  on: Mock;
  once: Mock;
  removeAllListeners: Mock;
}

// Resolve mock window for assertions
const getMockWin = (): MockBrowserWindow =>
  (BrowserWindow as unknown as { _mockWin: MockBrowserWindow })._mockWin;

describe('PillWindowManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset isVisible to false before each test
    getMockWin().isVisible.mockReturnValue(false);
    getMockWin().isDestroyed.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test: pill window is created with correct options
  // -------------------------------------------------------------------------
  it('creates pill window with correct frameless opaque options', async () => {
    // Pill is intentionally opaque as of commit 80d10f4 ("style(pill): opaque
    // dark window, no more transparent rectangle"). The rounded-corner look is
    // provided by `roundedCorners: true` + a fixed backgroundColor, not by
    // `transparent: true`.
    const { createPillWindow } = await import('../../src/main/pill');

    createPillWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 480,
        height: 56,
        transparent: false,
        frame: false,
        alwaysOnTop: true,
        hasShadow: true,
        resizable: false,
        skipTaskbar: true,
        show: false,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test: showPill shows the window and measures latency
  // -------------------------------------------------------------------------
  it('showPill calls window.show() and returns within 150ms', async () => {
    const { createPillWindow, showPill } = await import('../../src/main/pill');

    createPillWindow();
    getMockWin().isVisible.mockReturnValue(false);

    const t0 = performance.now();
    showPill();
    const elapsed = performance.now() - t0;

    expect(getMockWin().show).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(150);
  });

  // -------------------------------------------------------------------------
  // Test: hidePill hides the window
  // -------------------------------------------------------------------------
  it('hidePill calls window.hide()', async () => {
    const { createPillWindow, hidePill } = await import('../../src/main/pill');

    createPillWindow();
    hidePill();

    expect(getMockWin().hide).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test: togglePill shows when hidden
  // -------------------------------------------------------------------------
  it('togglePill shows window when currently hidden', async () => {
    const { createPillWindow, togglePill } = await import('../../src/main/pill');

    createPillWindow();
    getMockWin().isVisible.mockReturnValue(false);

    togglePill();

    expect(getMockWin().show).toHaveBeenCalledTimes(1);
    expect(getMockWin().hide).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test: togglePill hides when visible
  // -------------------------------------------------------------------------
  it('togglePill hides window when currently visible', async () => {
    const { createPillWindow, togglePill } = await import('../../src/main/pill');

    createPillWindow();
    getMockWin().isVisible.mockReturnValue(true);

    togglePill();

    expect(getMockWin().hide).toHaveBeenCalledTimes(1);
    expect(getMockWin().show).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test: isPillVisible delegates to window.isVisible()
  // -------------------------------------------------------------------------
  it('isPillVisible returns window visibility state', async () => {
    const { createPillWindow, isPillVisible } = await import('../../src/main/pill');

    createPillWindow();

    getMockWin().isVisible.mockReturnValue(false);
    expect(isPillVisible()).toBe(false);

    getMockWin().isVisible.mockReturnValue(true);
    expect(isPillVisible()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: sendToPill forwards events via webContents.send
  // -------------------------------------------------------------------------
  it('sendToPill sends event to pill webContents', async () => {
    const { createPillWindow, sendToPill } = await import('../../src/main/pill');

    createPillWindow();
    sendToPill('pill:event', { event: 'task_started', task_id: 'test-123', started_at: new Date().toISOString(), version: '1.0' });

    expect(getMockWin().webContents.send).toHaveBeenCalledWith(
      'pill:event',
      expect.objectContaining({ event: 'task_started', task_id: 'test-123' }),
    );
  });

  // -------------------------------------------------------------------------
  // Test: getPillWindow returns the created window
  // -------------------------------------------------------------------------
  it('getPillWindow returns the BrowserWindow instance', async () => {
    const { createPillWindow, getPillWindow } = await import('../../src/main/pill');

    const win = createPillWindow();
    expect(getPillWindow()).toBe(win);
  });
});
