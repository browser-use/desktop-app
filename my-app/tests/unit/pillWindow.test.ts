import { describe, expect, test, vi } from 'vitest';

interface MockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const windows: MockBrowserWindow[] = [];

class MockBrowserWindow {
  private bounds: MockBounds;
  private destroyed = false;
  private visible = false;

  webContents = {
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  };

  constructor(opts: { width: number; height: number }) {
    this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height };
    windows.push(this);
  }

  setVisibleOnAllWorkspaces = vi.fn();
  setAlwaysOnTop = vi.fn();
  loadURL = vi.fn();
  loadFile = vi.fn();
  on = vi.fn();
  focus = vi.fn();

  getBounds(): MockBounds {
    return { ...this.bounds };
  }

  setBounds(bounds: MockBounds): void {
    this.bounds = { ...bounds };
  }

  showInactive(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 100, y: 100 })),
    getDisplayNearestPoint: vi.fn(() => ({
      bounds: { x: 20, y: 30, width: 1200, height: 900 },
    })),
  },
}));

vi.mock('../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  rendererLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('pill window sizing', () => {
  test('showPill preserves the last renderer-requested height while repositioning', async () => {
    vi.resetModules();
    windows.length = 0;
    const pill = await import('../../src/main/pill');

    const win = pill.createPillWindow();
    pill.setPillHeight(141);

    expect(win.getBounds().height).toBe(141);

    pill.hidePill();
    pill.showPill();

    expect(win.getBounds()).toEqual({
      x: 320,
      y: 190,
      width: 600,
      height: 141,
    });
  });
});
