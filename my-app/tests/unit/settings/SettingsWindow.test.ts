/**
 * settings/SettingsWindow.ts unit tests.
 *
 * Tests cover:
 *   - getSettingsWindow: returns null before any window is opened
 *   - openSettingsWindow: creates a BrowserWindow the first time
 *   - openSettingsWindow: focuses existing window instead of creating a new one
 *   - getSettingsWindow: returns window after open, null after 'closed' event
 *   - closeSettingsWindow: calls close() on the existing window
 *   - closeSettingsWindow: is a no-op when no window exists or window is destroyed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy, rendererLogger: loggerSpy }));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    default: { ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) },
    join: vi.fn((...parts: string[]) => parts.join('/')),
  };
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
    getPosition = vi.fn(() => [0, 0]);
    getSize = vi.fn(() => [720, 560]);
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
  openSettingsWindow,
  getSettingsWindow,
  closeSettingsWindow,
} from '../../../src/main/settings/SettingsWindow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockWin = InstanceType<typeof MockBrowserWindow>;

function getLastMockWin(): MockWin | null {
  return MockBrowserWindow.last;
}

function fireEvent(_win: MockWin, event: string): void {
  const handler = MockBrowserWindow.eventHandlers.get(event);
  if (handler) handler();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings/SettingsWindow.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (MockBrowserWindow.last) {
      MockBrowserWindow.last.isDestroyed.mockReturnValue(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Before any window is opened
  // ---------------------------------------------------------------------------

  describe('before openSettingsWindow() is called', () => {
    it('getSettingsWindow() returns null', () => {
      if (MockBrowserWindow.last === null) {
        expect(getSettingsWindow()).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // After opening
  // ---------------------------------------------------------------------------

  describe('after openSettingsWindow() is called', () => {
    let win: MockWin;

    beforeEach(() => {
      if (getSettingsWindow() === null) {
        openSettingsWindow();
      }
      win = getLastMockWin()!;
      win.isDestroyed.mockReturnValue(false);
    });

    it('creates a BrowserWindow', () => {
      expect(win).not.toBeNull();
    });

    it('getSettingsWindow() returns the window', () => {
      expect(getSettingsWindow()).toBe(win);
    });

    it('openSettingsWindow() focuses the existing window instead of creating a second one', () => {
      const before = MockBrowserWindow.last;
      openSettingsWindow();
      expect(MockBrowserWindow.last).toBe(before);
      expect(win.focus).toHaveBeenCalled();
    });

    it('openSettingsWindow() returns the same window instance', () => {
      const result = openSettingsWindow();
      expect(result).toBe(win);
    });

    it('closeSettingsWindow() calls close() on the window', () => {
      closeSettingsWindow();
      expect(win.close).toHaveBeenCalled();
    });

    it('closeSettingsWindow() does not call close() when window is destroyed', () => {
      win.isDestroyed.mockReturnValue(true);
      closeSettingsWindow();
      expect(win.close).not.toHaveBeenCalled();
    });

    it('getSettingsWindow() returns null after window is destroyed', () => {
      win.isDestroyed.mockReturnValue(true);
      expect(getSettingsWindow()).toBeNull();
    });

    it('getSettingsWindow() returns null after the "closed" event fires', () => {
      fireEvent(win, 'closed');
      expect(getSettingsWindow()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // closeSettingsWindow — no window scenario
  // ---------------------------------------------------------------------------

  describe('closeSettingsWindow() with no window', () => {
    it('does not throw when no window has been created', () => {
      if (MockBrowserWindow.last) {
        MockBrowserWindow.last.isDestroyed.mockReturnValue(true);
        fireEvent(MockBrowserWindow.last, 'closed');
      }
      expect(() => closeSettingsWindow()).not.toThrow();
    });
  });
});
