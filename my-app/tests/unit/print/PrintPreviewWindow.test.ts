/**
 * PrintPreviewWindow.ts unit tests.
 *
 * Tests cover:
 *   - getPrintPreviewWindow returns null before any window is opened
 *   - openPrintPreviewWindow creates a BrowserWindow and returns it
 *   - openPrintPreviewWindow is idempotent — focuses existing window on second call
 *   - openPrintPreviewWindow loads the file path (no dev server in tests)
 *   - closePrintPreviewWindow calls close() when window exists
 *   - closePrintPreviewWindow is a no-op when no window exists
 *   - getPrintPreviewWindow returns the window after openPrintPreviewWindow
 *   - print-preview:get-page-info IPC returns title and url
 *   - print-preview:close IPC calls close on the window
 *   - print-preview:get-printers returns [] when window is destroyed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    default: { ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) },
    join: vi.fn((...parts: string[]) => parts.join('/')),
  };
});

// IPC handler capture
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, ((...args: unknown[]) => void)[]>();

const { MockBrowserWindowClass, getLastMockWin } = vi.hoisted(() => {
  class MockBrowserWindowClass {
    static last: MockBrowserWindowClass | null = null;
    id = 99;
    _destroyed = false;
    _closed = false;
    _visible = false;
    webContents = {
      send: vi.fn(),
      on: vi.fn(),
      getURL: vi.fn(() => 'about:blank'),
      openDevTools: vi.fn(),
      getPrintersAsync: vi.fn(async () => []),
    };
    loadURL = vi.fn(async () => {});
    loadFile = vi.fn(async () => {});
    isDestroyed = vi.fn(() => this._destroyed);
    isVisible = vi.fn(() => this._visible);
    close = vi.fn(() => { this._closed = true; });
    focus = vi.fn();
    show = vi.fn(() => { this._visible = true; });
    on = vi.fn();
    once = vi.fn((event: string, handler: () => void) => {
      // Don't auto-fire; let tests control
    });
    constructor(_opts?: unknown) {
      MockBrowserWindowClass.last = this;
    }
  }
  return { MockBrowserWindowClass, getLastMockWin: () => MockBrowserWindowClass.last };
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindowClass,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      if (!ipcListeners.has(channel)) ipcListeners.set(channel, []);
      ipcListeners.get(channel)!.push(handler);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      ipcListeners.delete(channel);
    }),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
}));

import {
  openPrintPreviewWindow,
  closePrintPreviewWindow,
  getPrintPreviewWindow,
} from '../../../src/main/print/PrintPreviewWindow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No handler for: ${channel}`);
  return handler({} /* event */, ...args);
}

function fireListener(channel: string, ...args: unknown[]): void {
  ipcListeners.get(channel)?.forEach((h) => h({} as never, ...args));
}

// ---------------------------------------------------------------------------
// Tests — before any window is opened
// ---------------------------------------------------------------------------

describe('PrintPreviewWindow — before openPrintPreviewWindow', () => {
  it('getPrintPreviewWindow returns null before any window is opened', () => {
    expect(getPrintPreviewWindow()).toBeNull();
  });

  it('closePrintPreviewWindow is a no-op when no window exists', () => {
    expect(() => closePrintPreviewWindow()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — after openPrintPreviewWindow
// ---------------------------------------------------------------------------

describe('PrintPreviewWindow — after openPrintPreviewWindow', () => {
  let win: InstanceType<typeof MockBrowserWindowClass>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create the window the first time; subsequent beforeEach runs reuse it
    if (getPrintPreviewWindow() === null) {
      openPrintPreviewWindow(1, 'Test Page', 'https://example.com');
    }
    win = getLastMockWin()!;
    win.isDestroyed.mockReturnValue(false);
  });

  describe('openPrintPreviewWindow()', () => {
    it('returns a BrowserWindow instance', () => {
      const result = openPrintPreviewWindow(1, 'Page', 'https://a.com');
      expect(result).toBeDefined();
    });

    it('is idempotent — focuses the existing window on second call', () => {
      const first = openPrintPreviewWindow(1, 'Page', 'https://a.com');
      const existing = getLastMockWin()!;
      existing.isDestroyed.mockReturnValue(false);

      const second = openPrintPreviewWindow(2, 'Page2', 'https://b.com');
      expect(second).toBe(first);
      expect(existing.focus).toHaveBeenCalled();
    });
  });

  describe('getPrintPreviewWindow()', () => {
    it('returns the window after it has been opened', () => {
      expect(getPrintPreviewWindow()).not.toBeNull();
    });

    it('returns null if the window has been destroyed', () => {
      win.isDestroyed.mockReturnValue(true);
      expect(getPrintPreviewWindow()).toBeNull();
    });
  });

  describe('closePrintPreviewWindow()', () => {
    it('calls close() on the window', () => {
      closePrintPreviewWindow();
      expect(win.close).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // IPC: print-preview:get-page-info
  // ---------------------------------------------------------------------------

  describe('print-preview:get-page-info', () => {
    it('returns the title and url passed to openPrintPreviewWindow', async () => {
      // Re-open to ensure a fresh window with known values
      openPrintPreviewWindow(10, 'My Title', 'https://mysite.com');
      const result = await invokeHandler('print-preview:get-page-info') as { title: string; url: string };
      expect(result.title).toBe('My Title');
      expect(result.url).toBe('https://mysite.com');
    });
  });

  // ---------------------------------------------------------------------------
  // IPC: print-preview:close
  // ---------------------------------------------------------------------------

  describe('print-preview:close (ipcMain.on)', () => {
    it('calls closePrintPreviewWindow when the close event fires', () => {
      openPrintPreviewWindow(10, 'Title', 'https://url.com');
      const winAfter = getLastMockWin()!;
      winAfter.isDestroyed.mockReturnValue(false);
      fireListener('print-preview:close');
      expect(winAfter.close).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // IPC: print-preview:get-printers
  // ---------------------------------------------------------------------------

  describe('print-preview:get-printers', () => {
    it('returns [] when the print preview window is destroyed', async () => {
      win.isDestroyed.mockReturnValue(true);
      const result = await invokeHandler('print-preview:get-printers') as unknown[];
      expect(result).toEqual([]);
    });

    it('calls getPrintersAsync on the window webContents', async () => {
      win.isDestroyed.mockReturnValue(false);
      win.webContents.getPrintersAsync.mockResolvedValue([{ name: 'PDF Printer' }]);
      const result = await invokeHandler('print-preview:get-printers') as unknown[];
      expect(result).toHaveLength(1);
    });
  });
});
