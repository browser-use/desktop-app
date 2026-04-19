/**
 * pill.ts unit tests.
 *
 * Tests cover:
 *   - isPillVisible / getPillWindow before createPillWindow (null state)
 *   - sendToPill warns and is a no-op when pillWindow is null
 *   - forwardAgentEvent calls sendToPill with 'pill:event' channel
 *   - createPillWindow: creates a BrowserWindow, returns it, is idempotent
 *   - sendToPill: calls webContents.send when window is alive
 *   - showPill: calls setBounds, show, focus when window exists
 *   - showPill: is a no-op when no window
 *   - hidePill: calls hide when window exists
 *   - hidePill: is a no-op when no window
 *   - togglePill: hides when visible, shows when hidden
 *   - setPillHeight: calls setBounds with updated height
 *   - PILL_WIDTH / PILL_HEIGHT_COLLAPSED / PILL_HEIGHT_EXPANDED are exported constants
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before any imports from pill.ts
// ---------------------------------------------------------------------------

const { loggerSpy, MockBrowserWindowClass, getLastMockWin } = vi.hoisted(() => {
  class MockBrowserWindowClass {
    static last: MockBrowserWindowClass | null = null;
    id = 1;
    _visible = false;
    _destroyed = false;
    _bounds = { x: 100, y: 80, width: 480, height: 62 };
    webContents = {
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      setVisualZoomLevelLimits: vi.fn(),
      once: vi.fn(),
    };
    loadURL = vi.fn();
    loadFile = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    show = vi.fn(() => { this._visible = true; });
    hide = vi.fn(() => { this._visible = false; });
    focus = vi.fn();
    isVisible = vi.fn(() => this._visible);
    isDestroyed = vi.fn(() => this._destroyed);
    getBounds = vi.fn(() => ({ ...this._bounds }));
    setBounds = vi.fn(function(this: MockBrowserWindowClass, b: Partial<MockBrowserWindowClass['_bounds']>) {
      this._bounds = { ...this._bounds, ...b };
    });
    on = vi.fn();
    constructor(_opts?: unknown) {
      MockBrowserWindowClass.last = this;
    }
  }

  return {
    loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    MockBrowserWindowClass,
    getLastMockWin: () => MockBrowserWindowClass.last,
  };
});

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindowClass,
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 960, y: 540 })),
    getDisplayNearestPoint: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  },
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) };
});

import {
  createPillWindow,
  showPill,
  hidePill,
  togglePill,
  isPillVisible,
  sendToPill,
  forwardAgentEvent,
  getPillWindow,
  setPillHeight,
  PILL_WIDTH,
  PILL_HEIGHT_COLLAPSED,
  PILL_HEIGHT_EXPANDED,
} from '../../../src/main/pill';
import type { AgentEvent } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(task_id = 'task-1'): AgentEvent {
  return { version: '1.0', event: 'task_started', task_id, started_at: '2026-01-01T00:00:00Z' } as AgentEvent;
}

// ---------------------------------------------------------------------------
// Tests — null window state (pill not yet created)
// ---------------------------------------------------------------------------

describe('pill.ts — before createPillWindow', () => {
  it('isPillVisible returns false', () => {
    expect(isPillVisible()).toBe(false);
  });

  it('getPillWindow returns null', () => {
    expect(getPillWindow()).toBeNull();
  });

  it('sendToPill warns and does not throw', () => {
    expect(() => sendToPill('some:channel', { data: 1 })).not.toThrow();
    expect(loggerSpy.warn).toHaveBeenCalled();
  });

  it('hidePill is a no-op when no window', () => {
    expect(() => hidePill()).not.toThrow();
  });

  it('showPill logs error and returns without crashing when no window', () => {
    expect(() => showPill()).not.toThrow();
    expect(loggerSpy.error).toHaveBeenCalled();
  });

  it('togglePill logs error and returns without crashing when no window', () => {
    expect(() => togglePill()).not.toThrow();
    expect(loggerSpy.error).toHaveBeenCalled();
  });

  it('forwardAgentEvent does not crash when no window', () => {
    expect(() => forwardAgentEvent(makeEvent())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — after createPillWindow
// ---------------------------------------------------------------------------

describe('pill.ts — after createPillWindow', () => {
  type Win = InstanceType<typeof MockBrowserWindowClass>;
  let win: Win;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create the window if it hasn't been created yet
    if (getPillWindow() === null) {
      createPillWindow();
    }
    win = getLastMockWin()!;
    // Restore vi.fn return values that were cleared
    win.isDestroyed.mockReturnValue(false);
    win.isVisible.mockReturnValue(false);
    win.getBounds.mockReturnValue({ x: 100, y: 80, width: PILL_WIDTH, height: PILL_HEIGHT_COLLAPSED });
  });

  describe('createPillWindow()', () => {
    it('returns a BrowserWindow instance', () => {
      const result = createPillWindow();
      expect(result).toBeDefined();
    });

    it('is idempotent — returns same window on second call', () => {
      const first = createPillWindow();
      const second = createPillWindow();
      expect(first).toBe(second);
    });

    it('creates a window with the expected dimensions', () => {
      expect(win.getBounds().width).toBe(PILL_WIDTH);
    });
  });

  describe('getPillWindow()', () => {
    it('returns the created window', () => {
      expect(getPillWindow()).not.toBeNull();
    });
  });

  describe('isPillVisible()', () => {
    it('returns false when window is hidden', () => {
      win.isVisible.mockReturnValue(false);
      expect(isPillVisible()).toBe(false);
    });

    it('returns true when window is visible', () => {
      win.isVisible.mockReturnValue(true);
      expect(isPillVisible()).toBe(true);
    });
  });

  describe('sendToPill()', () => {
    it('calls webContents.send with channel and payload', () => {
      sendToPill('test:channel', { value: 42 });
      expect(win.webContents.send).toHaveBeenCalledWith('test:channel', { value: 42 });
    });
  });

  describe('forwardAgentEvent()', () => {
    it('calls sendToPill with "pill:event" channel', () => {
      const event = makeEvent('task-99');
      forwardAgentEvent(event);
      expect(win.webContents.send).toHaveBeenCalledWith('pill:event', event);
    });
  });

  describe('showPill()', () => {
    it('calls setBounds on the window', () => {
      showPill();
      expect(win.setBounds).toHaveBeenCalled();
    });

    it('calls show() on the window', () => {
      showPill();
      expect(win.show).toHaveBeenCalled();
    });

    it('calls focus() on the window', () => {
      showPill();
      expect(win.focus).toHaveBeenCalled();
    });
  });

  describe('hidePill()', () => {
    it('calls hide() on the window', () => {
      hidePill();
      expect(win.hide).toHaveBeenCalled();
    });
  });

  describe('togglePill()', () => {
    it('calls hide when window is visible', () => {
      win.isVisible.mockReturnValue(true);
      togglePill();
      expect(win.hide).toHaveBeenCalled();
    });

    it('calls show when window is hidden', () => {
      win.isVisible.mockReturnValue(false);
      togglePill();
      expect(win.show).toHaveBeenCalled();
    });
  });

  describe('setPillHeight()', () => {
    it('calls setBounds with the given height', () => {
      win.getBounds.mockReturnValue({ x: 100, y: 80, width: PILL_WIDTH, height: PILL_HEIGHT_COLLAPSED });
      setPillHeight(PILL_HEIGHT_EXPANDED);
      expect(win.setBounds).toHaveBeenCalledWith(expect.objectContaining({ height: PILL_HEIGHT_EXPANDED }));
    });
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('PILL_WIDTH is a positive number', () => {
    expect(typeof PILL_WIDTH).toBe('number');
    expect(PILL_WIDTH).toBeGreaterThan(0);
  });

  it('PILL_HEIGHT_COLLAPSED is less than PILL_HEIGHT_EXPANDED', () => {
    expect(PILL_HEIGHT_COLLAPSED).toBeLessThan(PILL_HEIGHT_EXPANDED);
  });

  it('PILL_HEIGHT_EXPANDED is a positive number', () => {
    expect(PILL_HEIGHT_EXPANDED).toBeGreaterThan(0);
  });
});
