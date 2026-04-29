import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appOn, loggerSpy, MockBrowserWindow } = vi.hoisted(() => {
  const loggerSpy = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const appOn = vi.fn();

  class MockBrowserWindow {
    static last: MockBrowserWindow | null = null;
    static handlers = new Map<string, () => void>();

    id = 1;
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => false);
    isFullScreen = vi.fn(() => false);
    isSimpleFullScreen = vi.fn(() => false);
    isMaximized = vi.fn(() => false);
    setFullScreen = vi.fn();
    setSimpleFullScreen = vi.fn();
    setFullScreenable = vi.fn();
    setMaximizable = vi.fn();
    setMinimizable = vi.fn();
    unmaximize = vi.fn();
    setMinimumSize = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    setBounds = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 380, height: 220 }));
    showInactive = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
    on = vi.fn((event: string, handler: () => void) => {
      MockBrowserWindow.handlers.set(event, handler);
    });
    webContents = {
      on: vi.fn(),
      send: vi.fn(),
      setVisualZoomLevelLimits: vi.fn(),
      setZoomFactor: vi.fn(),
    };

    constructor(public options: Record<string, unknown>) {
      MockBrowserWindow.last = this;
      MockBrowserWindow.handlers = new Map();
    }
  }

  return { appOn, loggerSpy, MockBrowserWindow };
});

vi.mock('../../src/main/logger', () => ({ mainLogger: loggerSpy, rendererLogger: loggerSpy }));
vi.mock('../../src/main/viteDepStaleHeal', () => ({ registerViteDepStaleHeal: vi.fn() }));

vi.mock('electron', () => ({
  app: { on: appOn },
  BrowserWindow: MockBrowserWindow,
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayMatching: vi.fn(() => ({ id: 1 })),
    getDisplayNearestPoint: vi.fn(() => ({ id: 1 })),
  },
}));

describe('logsPill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    MockBrowserWindow.last = null;
    MockBrowserWindow.handlers = new Map();
  });

  it('creates the logs window as non-fullscreenable and non-maximizable', async () => {
    const { createLogsWindow } = await import('../../src/main/logsPill');

    createLogsWindow();
    const win = MockBrowserWindow.last!;

    expect(win.options).toEqual(expect.objectContaining({
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      resizable: true,
    }));
    expect(win.setFullScreenable).toHaveBeenCalledWith(false);
    expect(win.setMaximizable).toHaveBeenCalledWith(false);
    expect(win.setMinimizable).toHaveBeenCalledWith(false);
  });

  it('leaves disallowed fullscreen and maximize states if Electron enters them', async () => {
    const { createLogsWindow } = await import('../../src/main/logsPill');

    createLogsWindow();
    const win = MockBrowserWindow.last!;
    win.isFullScreen.mockReturnValue(true);
    win.isSimpleFullScreen.mockReturnValue(true);
    win.isMaximized.mockReturnValue(true);

    MockBrowserWindow.handlers.get('enter-full-screen')?.();

    expect(win.setFullScreen).toHaveBeenCalledWith(false);
    expect(win.setSimpleFullScreen).toHaveBeenCalledWith(false);
    expect(win.unmaximize).toHaveBeenCalled();
    expect(win.setFullScreenable).toHaveBeenLastCalledWith(false);
    expect(win.setMaximizable).toHaveBeenLastCalledWith(false);
    expect(win.setMinimizable).toHaveBeenLastCalledWith(false);
  });

  it('reapplies the non-fullscreen policy when switching log display modes', async () => {
    const { createLogsWindow, setLogsMode } = await import('../../src/main/logsPill');

    createLogsWindow();
    const win = MockBrowserWindow.last!;
    vi.clearAllMocks();

    setLogsMode('full');

    expect(win.setFullScreenable).toHaveBeenCalledWith(false);
    expect(win.setMaximizable).toHaveBeenCalledWith(false);
    expect(win.setMinimizable).toHaveBeenCalledWith(false);
  });
});
