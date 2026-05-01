import { beforeEach, describe, expect, test, vi } from 'vitest';

const { appOn, browserWindowState, logger, notifications, notificationHandlers, MockNotification } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const appOn = vi.fn();
  const notifications: MockNotification[] = [];
  const notificationHandlers = new Map<string, () => void>();
  const browserWindowState = {
    focusedWindow: null as MockWindow | null,
    allWindows: [] as MockWindow[],
  };

  class MockWindow {
    destroyed = false;
    focused = false;
    minimized = false;
    webContents = { send: vi.fn() };

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isFocused(): boolean {
      return this.focused;
    }

    isMinimized(): boolean {
      return this.minimized;
    }

    restore = vi.fn(() => {
      this.minimized = false;
    });
    show = vi.fn();
    focus = vi.fn();
  }

  class MockNotification {
    static supported = true;
    show = vi.fn();
    on = vi.fn((event: string, handler: () => void) => {
      notificationHandlers.set(event, handler);
    });

    constructor(public opts: Record<string, unknown>) {
      notifications.push(this);
    }

    static isSupported(): boolean {
      return MockNotification.supported;
    }
  }

  return { appOn, browserWindowState, logger, notifications, notificationHandlers, MockNotification };
});

vi.mock('electron', () => ({
  app: {
    name: 'Browser Use',
    on: appOn,
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => browserWindowState.focusedWindow),
    getAllWindows: vi.fn(() => browserWindowState.allWindows),
  },
  Notification: MockNotification,
}));

vi.mock('../../src/main/logger', () => ({
  mainLogger: logger,
}));

async function importNotifications(): Promise<typeof import('../../src/main/notifications')> {
  vi.resetModules();
  return import('../../src/main/notifications');
}

describe('sendSessionNotification', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    MockNotification.supported = true;
    notifications.length = 0;
    notificationHandlers.clear();
    browserWindowState.focusedWindow = null;
    browserWindowState.allWindows = [];
  });

  test('suppresses native notifications while an app window is focused', async () => {
    const { sendSessionNotification } = await importNotifications();
    browserWindowState.focusedWindow = {
      isDestroyed: () => false,
    } as unknown as typeof browserWindowState.focusedWindow;

    sendSessionNotification({
      title: 'Session done',
      body: 'done',
      sessionId: 's1',
      shellWindow: null,
    });

    expect(notifications).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith('notifications.suppressed_in_app', {
      sessionId: 's1',
      reason: 'focused-window',
    });
  });

  test('suppresses notifications immediately after in-app focus even if no window is focused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { sendSessionNotification } = await importNotifications();
    const focusHandler = appOn.mock.calls.find(([event]) => event === 'browser-window-focus')?.[1] as (() => void) | undefined;
    expect(focusHandler).toBeDefined();

    focusHandler?.();
    vi.setSystemTime(12_000);

    sendSessionNotification({
      title: 'Task started',
      body: 'started',
      sessionId: 's1',
      shellWindow: null,
    });

    expect(notifications).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith('notifications.suppressed_in_app', {
      sessionId: 's1',
      reason: 'recent-focus',
    });
  });

  test('sends when notifications are supported and the app is not active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const { sendSessionNotification } = await importNotifications();

    sendSessionNotification({
      title: 'Session done',
      body: 'done',
      sessionId: 's1',
      shellWindow: null,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].opts).toMatchObject({
      title: 'Session done',
      subtitle: 'Browser Use',
      body: 'done',
      sound: 'default',
    });
    expect(notifications[0].show).toHaveBeenCalled();
  });
});
