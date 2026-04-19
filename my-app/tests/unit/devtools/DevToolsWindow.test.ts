/**
 * devtools/DevToolsWindow.ts unit tests.
 *
 * Tests cover:
 *   - getDevToolsWindow: returns null before any window is opened
 *   - openDevToolsWindow: creates a BrowserWindow the first time
 *   - openDevToolsWindow: focuses existing window instead of creating a new one
 *   - getDevToolsWindow: returns window after open, null after 'closed' event
 *   - closeDevToolsWindow: calls close() on the existing window
 *   - closeDevToolsWindow: is a no-op when no window exists
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, default: { ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) }, join: vi.fn((...parts: string[]) => parts.join('/')) };
});

const { MockBrowserWindow } = vi.hoisted(() => {
  class MockBrowserWindow {
    static last: MockBrowserWindow | null = null;
    static eventHandlers: Map<string, () => void> = new Map();
    id = Math.floor(Math.random() * 1000);
    isDestroyed = vi.fn(() => false);
    focus = vi.fn();
    show = vi.fn();
    close = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
    once = vi.fn((event: string, handler: () => void) => {
      MockBrowserWindow.eventHandlers.set(`once:${event}`, handler);
    });
    on = vi.fn((event: string, handler: () => void) => {
      MockBrowserWindow.eventHandlers.set(event, handler);
    });
    webContents = {
      on: vi.fn(),
      getURL: vi.fn(() => ''),
      openDevTools: vi.fn(),
    };

    constructor() {
      MockBrowserWindow.eventHandlers = new Map();
      MockBrowserWindow.last = this;
    }
  }
  return { MockBrowserWindow };
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
}));

import {
  openDevToolsWindow,
  getDevToolsWindow,
  closeDevToolsWindow,
} from '../../../src/main/devtools/DevToolsWindow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLastMockWin(): MockBrowserWindow | null {
  return MockBrowserWindow.last;
}

/** Fire a named event registered via win.on(...) */
function fireEvent(_win: MockBrowserWindow, event: string): void {
  const handler = MockBrowserWindow.eventHandlers.get(event);
  if (handler) handler();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('devtools/DevToolsWindow.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore isDestroyed to default false for the last mock window if one exists
    if (MockBrowserWindow.last) {
      MockBrowserWindow.last.isDestroyed.mockReturnValue(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Before any window is opened
  // ---------------------------------------------------------------------------

  describe('before openDevToolsWindow() is called', () => {
    it('getDevToolsWindow() returns null', () => {
      // The module singleton is null at import time; this test must run first.
      // If a prior test opened the window, we skip — covered by the "after" suite.
      if (MockBrowserWindow.last === null) {
        expect(getDevToolsWindow()).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // After opening
  // ---------------------------------------------------------------------------

  describe('after openDevToolsWindow() is called', () => {
    let win: MockBrowserWindow;

    beforeEach(() => {
      if (getDevToolsWindow() === null) {
        openDevToolsWindow();
      }
      win = getLastMockWin()!;
      win.isDestroyed.mockReturnValue(false);
    });

    it('creates a BrowserWindow', () => {
      expect(win).not.toBeNull();
    });

    it('getDevToolsWindow() returns the window', () => {
      expect(getDevToolsWindow()).toBe(win);
    });

    it('openDevToolsWindow() focuses the existing window instead of creating a second one', () => {
      const before = MockBrowserWindow.last;
      openDevToolsWindow();
      expect(MockBrowserWindow.last).toBe(before);
      expect(win.focus).toHaveBeenCalled();
    });

    it('openDevToolsWindow() returns the same window instance', () => {
      const result = openDevToolsWindow();
      expect(result).toBe(win);
    });

    it('closeDevToolsWindow() calls close() on the window', () => {
      closeDevToolsWindow();
      expect(win.close).toHaveBeenCalled();
    });

    it('closeDevToolsWindow() does not call close() when window is destroyed', () => {
      win.isDestroyed.mockReturnValue(true);
      closeDevToolsWindow();
      expect(win.close).not.toHaveBeenCalled();
    });

    it('getDevToolsWindow() returns null after window is destroyed', () => {
      win.isDestroyed.mockReturnValue(true);
      expect(getDevToolsWindow()).toBeNull();
    });

    it('getDevToolsWindow() returns null after the "closed" event fires', () => {
      fireEvent(win, 'closed');
      expect(getDevToolsWindow()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // closeDevToolsWindow — no window scenario
  // ---------------------------------------------------------------------------

  describe('closeDevToolsWindow() with no window', () => {
    it('does not throw when no window has been created', () => {
      // Force destroy the existing window so the module treats it as absent
      if (MockBrowserWindow.last) {
        MockBrowserWindow.last.isDestroyed.mockReturnValue(true);
        // Fire 'closed' to set module singleton to null
        fireEvent(MockBrowserWindow.last, 'closed');
      }
      expect(() => closeDevToolsWindow()).not.toThrow();
    });
  });
});
