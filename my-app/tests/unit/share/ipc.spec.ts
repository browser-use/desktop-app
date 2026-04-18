/**
 * Share IPC handler regression tests — issue #205.
 *
 * The share handlers used to capture `tabManager` / `shellWindow` by value at
 * registration time. Because `registerShareHandlers` runs during
 * `app.whenReady()`, BEFORE `openShellAndWire()` creates the shell/tab refs,
 * every share IPC call silently resolved to `null`.
 *
 * These tests pin down the new lazy-getter contract: the handlers must read
 * the *current* refs at invocation time, so registering before shell startup
 * is safe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Electron mock — captures ipcMain.handle callbacks so we can invoke them
// directly from the test and observe the handler's return value.
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  },
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  registerShareHandlers,
  unregisterShareHandlers,
} from '../../../src/main/share/ipc';
import type { TabManager } from '../../../src/main/tabs/TabManager';
import type { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Fake TabManager / WebContents / BrowserWindow
// ---------------------------------------------------------------------------

interface FakeWebContents {
  getTitle: () => string;
  savePage: (path: string, kind: string) => Promise<void>;
}

function makeFakeTabManager(url: string | null, title: string): TabManager {
  const wc: FakeWebContents | null = url
    ? {
        getTitle: () => title,
        savePage: vi.fn(async () => undefined),
      }
    : null;
  return {
    getActiveTabUrl: () => url,
    getActiveWebContents: () => wc,
  } as unknown as TabManager;
}

function makeFakeShellWindow(): BrowserWindow {
  return {} as unknown as BrowserWindow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('share IPC — lazy ref resolution (issue #205)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  afterEach(() => {
    unregisterShareHandlers();
    vi.clearAllMocks();
  });

  it('returns null from share:get-page-info when registered before shell startup', async () => {
    // Simulate the real app-ready flow: register BEFORE the shell is created.
    let tabManager: TabManager | null = null;
    let shellWindow: BrowserWindow | null = null;

    registerShareHandlers({
      getTabManager: () => tabManager,
      getShellWindow: () => shellWindow,
    });

    const handler = handlers.get('share:get-page-info')!;
    expect(handler).toBeDefined();

    // Before shell startup — no refs — handler must degrade gracefully.
    expect(await handler()).toBeNull();

    // Simulate openShellAndWire() finishing.
    tabManager = makeFakeTabManager('https://example.com/hello', 'Example Page');
    shellWindow = makeFakeShellWindow();

    // Same handler — now returns the live active tab info.
    expect(await handler()).toEqual({
      url: 'https://example.com/hello',
      title: 'Example Page',
    });
  });

  it('share:get-page-info tracks tab changes without re-registration', async () => {
    let tabManager: TabManager | null = makeFakeTabManager('https://first.test/', 'First');
    const shellWindow: BrowserWindow = makeFakeShellWindow();

    registerShareHandlers({
      getTabManager: () => tabManager,
      getShellWindow: () => shellWindow,
    });

    const handler = handlers.get('share:get-page-info')!;
    expect(await handler()).toEqual({
      url: 'https://first.test/',
      title: 'First',
    });

    // Swap the tab manager (e.g. after profile switch / guest shell open).
    tabManager = makeFakeTabManager('https://second.test/path', 'Second');
    expect(await handler()).toEqual({
      url: 'https://second.test/path',
      title: 'Second',
    });
  });

  it('share:copy-link copies the active tab URL when the tab manager is live', async () => {
    const { clipboard } = await import('electron');
    const tabManager = makeFakeTabManager('https://copy.example/', 'Copy Me');
    const shellWindow = makeFakeShellWindow();

    registerShareHandlers({
      getTabManager: () => tabManager,
      getShellWindow: () => shellWindow,
    });

    const handler = handlers.get('share:copy-link')!;
    const ok = await handler();

    expect(ok).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('https://copy.example/');
  });

  it('share:copy-link returns false when no tab manager is available', async () => {
    registerShareHandlers({
      getTabManager: () => null,
      getShellWindow: () => null,
    });

    const handler = handlers.get('share:copy-link')!;
    expect(await handler()).toBe(false);
  });

  it('unregisterShareHandlers clears all four channels', () => {
    registerShareHandlers({
      getTabManager: () => null,
      getShellWindow: () => null,
    });

    expect(handlers.size).toBe(4);
    unregisterShareHandlers();
    expect(handlers.size).toBe(0);
  });
});
