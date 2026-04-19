/**
 * window.ts unit tests.
 *
 * Tests cover:
 *   - loadBounds falls back to defaults when bounds file doesn't exist
 *   - loadBounds falls back to defaults when file contains invalid JSON
 *   - loadBounds returns parsed bounds when on a visible display
 *   - loadBounds falls back to defaults when bounds are off-screen
 *   - loadBounds: bounds with undefined x/y are considered off-screen
 *   - createShellWindow uses loaded bounds for window dimensions
 *   - createShellWindow uses default background color for normal windows
 *   - createShellWindow uses incognito background color for incognito windows
 *   - createShellWindow appends titleSuffix to window title
 *   - createShellWindow does not modify title when no suffix
 *   - createShellWindow registers resize, move, close, closed handlers
 *   - close handler saves bounds for normal windows
 *   - close handler does NOT save bounds for incognito windows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const { mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

const { mockGetAllDisplays } = vi.hoisted(() => ({
  mockGetAllDisplays: vi.fn(),
}));

const { MockBrowserWindowClass } = vi.hoisted(() => {
  class MockBrowserWindowClass {
    static last: MockBrowserWindowClass | null = null;
    id = 42;
    _title = 'The Browser';
    _bounds = { x: 0, y: 0, width: 1280, height: 800 };
    _opts: unknown;
    webContents = {};
    _handlers: Record<string, (() => void)[]> = {};
    setTitle = vi.fn((t: string) => { this._title = t; });
    getTitle = vi.fn(() => this._title);
    getBounds = vi.fn(() => ({ ...this._bounds }));
    setBounds = vi.fn();
    on = vi.fn((event: string, handler: () => void) => {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event].push(handler);
    });
    emit(event: string) { this._handlers[event]?.forEach((h) => h()); }
    constructor(opts: unknown) {
      this._opts = opts;
      MockBrowserWindowClass.last = this;
    }
  }
  return { MockBrowserWindowClass };
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindowClass,
  app: {
    getPath: vi.fn((_k: string) => '/test/userData'),
  },
  screen: {
    getAllDisplays: mockGetAllDisplays,
  },
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { default: { ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) }, ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) };
});

import { createShellWindow } from '../../../src/main/window';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

function makeDisplay(x: number, y: number, w: number, h: number) {
  return { bounds: { x, y, width: w, height: h } };
}

function getWindowOpts(): Record<string, unknown> {
  return MockBrowserWindowClass.last!._opts as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('window.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockBrowserWindowClass.last = null;
    mockGetAllDisplays.mockReturnValue([makeDisplay(0, 0, 1920, 1080)]);
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  });

  // ---------------------------------------------------------------------------
  // loadBounds — via createShellWindow
  // ---------------------------------------------------------------------------

  describe('loadBounds() — via createShellWindow', () => {
    it('uses default dimensions when bounds file does not exist', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      createShellWindow();
      const opts = getWindowOpts();
      expect(opts.width).toBe(DEFAULT_WIDTH);
      expect(opts.height).toBe(DEFAULT_HEIGHT);
    });

    it('uses default dimensions when bounds file contains invalid JSON', () => {
      mockReadFileSync.mockReturnValue('not-json');
      createShellWindow();
      const opts = getWindowOpts();
      expect(opts.width).toBe(DEFAULT_WIDTH);
      expect(opts.height).toBe(DEFAULT_HEIGHT);
    });

    it('uses saved bounds when they are on a visible display', () => {
      const saved = { x: 100, y: 50, width: 1400, height: 900 };
      mockReadFileSync.mockReturnValue(JSON.stringify(saved));
      mockGetAllDisplays.mockReturnValue([makeDisplay(0, 0, 1920, 1080)]);
      createShellWindow();
      const opts = getWindowOpts();
      expect(opts.width).toBe(saved.width);
      expect(opts.height).toBe(saved.height);
      expect(opts.x).toBe(saved.x);
      expect(opts.y).toBe(saved.y);
    });

    it('falls back to defaults when saved bounds are off-screen', () => {
      const offScreen = { x: 5000, y: 5000, width: 1280, height: 800 };
      mockReadFileSync.mockReturnValue(JSON.stringify(offScreen));
      mockGetAllDisplays.mockReturnValue([makeDisplay(0, 0, 1920, 1080)]);
      createShellWindow();
      const opts = getWindowOpts();
      expect(opts.width).toBe(DEFAULT_WIDTH);
      expect(opts.height).toBe(DEFAULT_HEIGHT);
      expect(loggerSpy.warn).toHaveBeenCalled();
    });

    it('falls back to defaults when saved bounds have no x/y (missing position)', () => {
      const noPosition = { width: 1280, height: 800 };
      mockReadFileSync.mockReturnValue(JSON.stringify(noPosition));
      mockGetAllDisplays.mockReturnValue([makeDisplay(0, 0, 1920, 1080)]);
      createShellWindow();
      const opts = getWindowOpts();
      expect(opts.width).toBe(DEFAULT_WIDTH);
      expect(opts.height).toBe(DEFAULT_HEIGHT);
    });
  });

  // ---------------------------------------------------------------------------
  // createShellWindow — window configuration
  // ---------------------------------------------------------------------------

  describe('createShellWindow()', () => {
    it('uses default background color for normal windows', () => {
      createShellWindow();
      const opts = getWindowOpts();
      expect(opts.backgroundColor).toBe('#0d0d0d');
    });

    it('uses incognito background color for incognito windows', () => {
      createShellWindow({ incognito: true });
      const opts = getWindowOpts();
      expect(opts.backgroundColor).toBe('#1a1a2e');
    });

    it('appends titleSuffix to the window title', () => {
      createShellWindow({ titleSuffix: ' — Incognito' });
      const win = MockBrowserWindowClass.last!;
      expect(win.setTitle).toHaveBeenCalledWith(expect.stringMatching(/ — Incognito$/));
    });

    it('does not call setTitle when titleSuffix is empty', () => {
      createShellWindow();
      const win = MockBrowserWindowClass.last!;
      expect(win.setTitle).not.toHaveBeenCalled();
    });

    it('registers resize, move, close, closed event handlers', () => {
      createShellWindow();
      const win = MockBrowserWindowClass.last!;
      expect(win.on).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(win.on).toHaveBeenCalledWith('move', expect.any(Function));
      expect(win.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(win.on).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    it('returns the created BrowserWindow', () => {
      const result = createShellWindow();
      expect(result).toBe(MockBrowserWindowClass.last);
    });
  });

  // ---------------------------------------------------------------------------
  // close handler — saveBounds behavior
  // ---------------------------------------------------------------------------

  describe('close event handler', () => {
    it('saves bounds on close for normal (non-incognito) windows', () => {
      createShellWindow();
      const win = MockBrowserWindowClass.last!;
      win.emit('close');
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('does NOT save bounds on close for incognito windows', () => {
      createShellWindow({ incognito: true });
      const win = MockBrowserWindowClass.last!;
      win.emit('close');
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});
