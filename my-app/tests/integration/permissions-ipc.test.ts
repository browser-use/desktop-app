/**
 * Integration test: permissions IPC handlers.
 *
 * Strategy: capture handlers from a mocked ipcMain, drive them with synthetic
 * payloads, and use a real PermissionStore + PermissionManager underneath.
 *
 * Coverage:
 *   - register / unregister installs/removes all 10 channels
 *   - grant + check + revoke flow over IPC
 *   - clear-origin via IPC removes every grant for an origin
 *   - tab-close expiry: pending prompts for the tab are auto-denied
 *   - reset-all wipes records
 *   - respond / dismiss IPC handlers route through PermissionManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.hoisted ipcMain stub + electron mocks ----------------------------------
const {
  handlers,
  mockIpcMain,
  systemPreferencesStub,
  setPermissionRequestHandlerSpy,
  setPermissionCheckHandlerSpy,
  defaultSessionStub,
  mockApp,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockIpcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  };
  const setPermissionRequestHandlerSpy = vi.fn();
  const setPermissionCheckHandlerSpy = vi.fn();
  const defaultSessionStub = {
    setPermissionRequestHandler: setPermissionRequestHandlerSpy,
    setPermissionCheckHandler: setPermissionCheckHandlerSpy,
  };
  const systemPreferencesStub = {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    canPromptTouchID: vi.fn(() => true),
    promptTouchID: vi.fn(() => Promise.resolve()),
  };
  const mockApp = { getPath: vi.fn(() => '/tmp/perms-ipc-test') };
  return {
    handlers, mockIpcMain, systemPreferencesStub,
    setPermissionRequestHandlerSpy, setPermissionCheckHandlerSpy,
    defaultSessionStub, mockApp,
  };
});

vi.mock('electron', () => ({
  app: mockApp,
  ipcMain: mockIpcMain,
  BrowserWindow: vi.fn(),
  Session: vi.fn(),
  session: { defaultSession: defaultSessionStub },
  systemPreferences: systemPreferencesStub,
}));

vi.mock('../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PermissionStore } from '../../src/main/permissions/PermissionStore';
import { PermissionManager } from '../../src/main/permissions/PermissionManager';
import {
  registerPermissionHandlers,
  unregisterPermissionHandlers,
} from '../../src/main/permissions/ipc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}`);
  return h({} as Electron.IpcMainInvokeEvent, ...args) as T;
}

function makeWindowStub() {
  return {
    webContents: { send: vi.fn(), isDestroyed: () => false },
    isDestroyed: () => false,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perms-ipc-'));
  mockApp.getPath.mockImplementation(() => tmpDir);
  setPermissionRequestHandlerSpy.mockReset();
  setPermissionCheckHandlerSpy.mockReset();
  systemPreferencesStub.getMediaAccessStatus.mockReturnValue('granted');
  handlers.clear();
});

afterEach(() => {
  unregisterPermissionHandlers();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('permissions ipc — registration', () => {
  it('register installs all 10 channels; unregister removes them', () => {
    const store = new PermissionStore(tmpDir);
    const manager = new PermissionManager({
      store,
      getShellWindow: () => null,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => null });

    const expected = [
      'permissions:respond',
      'permissions:dismiss',
      'permissions:get-site',
      'permissions:set-site',
      'permissions:remove-site',
      'permissions:clear-origin',
      'permissions:get-defaults',
      'permissions:set-default',
      'permissions:get-all',
      'permissions:reset-all',
    ];
    for (const ch of expected) expect(handlers.has(ch)).toBe(true);

    unregisterPermissionHandlers();
    expect(handlers.size).toBe(0);
  });
});

describe('permissions ipc — grant + check + revoke', () => {
  it('set-site → get-site → remove-site round-trip via IPC', () => {
    const store = new PermissionStore(tmpDir);
    const manager = new PermissionManager({
      store,
      getShellWindow: () => null,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => null });

    invoke('permissions:set-site', 'https://x.com', 'camera', 'allow');
    invoke('permissions:set-site', 'https://x.com', 'microphone', 'deny');

    const records = invoke<Array<{ permissionType: string; state: string }>>(
      'permissions:get-site', 'https://x.com',
    );
    expect(records).toHaveLength(2);

    expect(invoke<boolean>('permissions:remove-site', 'https://x.com', 'camera')).toBe(true);
    expect(invoke<Array<unknown>>('permissions:get-site', 'https://x.com')).toHaveLength(1);
  });

  it('clear-origin via IPC removes every record for an origin', () => {
    const store = new PermissionStore(tmpDir);
    const manager = new PermissionManager({
      store,
      getShellWindow: () => null,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => null });

    invoke('permissions:set-site', 'https://x.com', 'camera', 'allow');
    invoke('permissions:set-site', 'https://x.com', 'microphone', 'allow');
    invoke('permissions:set-site', 'https://y.com', 'camera', 'allow');

    invoke('permissions:clear-origin', 'https://x.com');
    expect(invoke<Array<unknown>>('permissions:get-site', 'https://x.com')).toHaveLength(0);
    expect(invoke<Array<unknown>>('permissions:get-site', 'https://y.com')).toHaveLength(1);
  });

  it('reset-all via IPC wipes records (defaults preserved)', () => {
    const store = new PermissionStore(tmpDir);
    const manager = new PermissionManager({
      store,
      getShellWindow: () => null,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => null });

    invoke('permissions:set-site', 'https://x.com', 'camera', 'allow');
    invoke('permissions:set-default', 'camera', 'deny');

    invoke('permissions:reset-all');
    expect(invoke<Array<unknown>>('permissions:get-all')).toHaveLength(0);
    const defaults = invoke<{ camera: string }>('permissions:get-defaults');
    expect(defaults.camera).toBe('deny');
  });
});

describe('permissions ipc — respond + dismiss + tab-close expiry', () => {
  it('respond("allow") via IPC routes through manager and persists the grant', () => {
    const store = new PermissionStore(tmpDir);
    const win = makeWindowStub();
    const manager = new PermissionManager({
      store,
      getShellWindow: () => win as unknown as Electron.BrowserWindow,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => win as unknown as Electron.BrowserWindow });

    // Start a real prompt so we have a promptId to respond to
    const requestHandler = setPermissionRequestHandlerSpy.mock.calls[0][0];
    const cb = vi.fn();
    requestHandler(
      { id: 1, getURL: () => 'https://x.com' },
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    const promptId = (win.webContents.send.mock.calls[0] as [string, { id: string }])[1].id;

    invoke('permissions:respond', promptId, 'allow');
    expect(cb).toHaveBeenCalledWith(true);
    expect(store.getSitePermission('https://x.com', 'geolocation')).toBe('allow');
  });

  it('dismiss via IPC closes a pending prompt', () => {
    const store = new PermissionStore(tmpDir);
    const win = makeWindowStub();
    const manager = new PermissionManager({
      store,
      getShellWindow: () => win as unknown as Electron.BrowserWindow,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => win as unknown as Electron.BrowserWindow });

    const requestHandler = setPermissionRequestHandlerSpy.mock.calls[0][0];
    const cb = vi.fn();
    requestHandler(
      { id: 1, getURL: () => 'https://x.com' },
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    const promptId = (win.webContents.send.mock.calls[0] as [string, { id: string }])[1].id;

    invoke('permissions:dismiss', promptId);
    expect(cb).toHaveBeenCalledWith(false);
  });

  it('tab-close expiry: expireSessionGrants auto-denies pending prompts for that tab', () => {
    const store = new PermissionStore(tmpDir);
    const win = makeWindowStub();
    const manager = new PermissionManager({
      store,
      getShellWindow: () => win as unknown as Electron.BrowserWindow,
      getTabIdForWebContents: () => 'tab-42',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => win as unknown as Electron.BrowserWindow });

    const requestHandler = setPermissionRequestHandlerSpy.mock.calls[0][0];
    const cb = vi.fn();
    requestHandler(
      { id: 1, getURL: () => 'https://x.com' },
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );

    // Tab close
    manager.expireSessionGrants('tab-42');
    expect(cb).toHaveBeenCalledWith(false);
  });
});

describe('permissions ipc — defaults', () => {
  it('get-defaults / set-default round-trip via IPC', () => {
    const store = new PermissionStore(tmpDir);
    const manager = new PermissionManager({
      store,
      getShellWindow: () => null,
      getTabIdForWebContents: () => 'tab-1',
    });
    registerPermissionHandlers({ store, manager, getShellWindow: () => null });

    const original = invoke<Record<string, string>>('permissions:get-defaults');
    expect(original.camera).toBe('ask');

    invoke('permissions:set-default', 'camera', 'deny');
    const updated = invoke<Record<string, string>>('permissions:get-defaults');
    expect(updated.camera).toBe('deny');
  });
});
