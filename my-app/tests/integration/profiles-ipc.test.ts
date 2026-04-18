/**
 * Integration test: profiles IPC handlers.
 *
 * Strategy:
 *   - Mock electron.ipcMain so calls to ipcMain.handle(channel, fn) are captured
 *     in a Map. Tests then invoke the captured handler directly with synthetic
 *     IpcMainInvokeEvent payloads — full create / list / select / delete flow.
 *   - Underlying ProfileStore is real (writes to a temp dir).
 *   - Only the picker-window close hook is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// vi.hoisted ipcMain stub
// ---------------------------------------------------------------------------

const { handlers, mockIpcMain, closePickerSpy, mockApp } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockIpcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const closePickerSpy = vi.fn();
  const mockApp = {
    getPath: vi.fn(() => '/tmp/profiles-ipc-test'),
    relaunch: vi.fn(),
  };
  return { handlers, mockIpcMain, closePickerSpy, mockApp };
});

vi.mock('electron', () => ({
  app: mockApp,
  ipcMain: mockIpcMain,
}));

vi.mock('../../src/main/profiles/ProfilePickerWindow', () => ({
  closeProfilePickerWindow: closePickerSpy,
}));

vi.mock('../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

import { ProfileStore, PROFILE_COLORS } from '../../src/main/profiles/ProfileStore';
import { registerProfileHandlers, unregisterProfileHandlers } from '../../src/main/profiles/ipc';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({} as Electron.IpcMainInvokeEvent, ...args) as T;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-ipc-'));
  mockApp.getPath.mockImplementation(() => tmpDir);
  closePickerSpy.mockReset();
  handlers.clear();
});

afterEach(() => {
  unregisterProfileHandlers();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* noop */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('profiles ipc — registration', () => {
  it('register installs all 10 channels; unregister removes them', () => {
    const store = new ProfileStore(tmpDir);
    const onSelect = vi.fn();
    registerProfileHandlers({ profileStore: store, onProfileSelected: onSelect });

    expect(handlers.has('profiles:get-all')).toBe(true);
    expect(handlers.has('profiles:add')).toBe(true);
    expect(handlers.has('profiles:remove')).toBe(true);
    expect(handlers.has('profiles:select')).toBe(true);
    expect(handlers.has('profiles:browse-as-guest')).toBe(true);
    expect(handlers.has('profiles:get-show-picker')).toBe(true);
    expect(handlers.has('profiles:set-show-picker')).toBe(true);
    expect(handlers.has('profiles:get-colors')).toBe(true);
    expect(handlers.has('profiles:switch-to')).toBe(true);
    expect(handlers.has('profiles:get-current')).toBe(true);

    unregisterProfileHandlers();
    expect(handlers.size).toBe(0);
  });
});

describe('profiles ipc — full create → switch → list → delete flow', () => {
  it('round-trips the full lifecycle of a profile through IPC', () => {
    const store = new ProfileStore(tmpDir);
    const onSelect = vi.fn();
    registerProfileHandlers({ profileStore: store, onProfileSelected: onSelect });

    // 1. Initial list shows the default profile only
    const initial = invoke<{ profiles: { id: string }[]; lastSelectedId: string | null }>(
      'profiles:get-all',
    );
    expect(initial.profiles).toHaveLength(1);
    expect(initial.profiles[0].id).toBe('default');
    expect(initial.lastSelectedId).toBe('default');

    // 2. Add a profile
    const added = invoke<{ id: string; name: string; color: string }>(
      'profiles:add',
      { name: 'Work', color: PROFILE_COLORS[1] },
    );
    expect(added.id).toBeTruthy();
    expect(added.name).toBe('Work');

    // 3. List again — now two profiles
    const listed = invoke<{ profiles: { id: string }[] }>('profiles:get-all');
    expect(listed.profiles).toHaveLength(2);

    // 4. Select the new profile (closes picker, fires callback, persists)
    invoke('profiles:select', { id: added.id });
    expect(closePickerSpy).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(added.id);
    expect(store.getLastSelectedProfileId()).toBe(added.id);

    // 5. Remove the new profile
    expect(invoke<boolean>('profiles:remove', { id: added.id })).toBe(true);
    expect(store.getProfiles()).toHaveLength(1);
    expect(store.getProfiles()[0].id).toBe('default');
  });
});

describe('profiles ipc — show-picker preference', () => {
  it('round-trips the showPickerOnLaunch toggle via IPC', () => {
    const store = new ProfileStore(tmpDir);
    registerProfileHandlers({ profileStore: store, onProfileSelected: vi.fn() });

    expect(invoke<boolean>('profiles:get-show-picker')).toBe(false);
    invoke('profiles:set-show-picker', true);
    expect(invoke<boolean>('profiles:get-show-picker')).toBe(true);
  });
});

describe('profiles ipc — browse as guest', () => {
  it('closes the picker and fires onProfileSelected(null)', () => {
    const store = new ProfileStore(tmpDir);
    const onSelect = vi.fn();
    registerProfileHandlers({ profileStore: store, onProfileSelected: onSelect });

    invoke('profiles:browse-as-guest');
    expect(closePickerSpy).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('profiles ipc — get-current', () => {
  it('returns the active profile id and the matching profile object', () => {
    const store = new ProfileStore(tmpDir);
    const added = store.addProfile('Active', PROFILE_COLORS[2]);
    registerProfileHandlers({
      profileStore: store,
      onProfileSelected: vi.fn(),
      activeProfileId: added.id,
    });

    const current = invoke<{ profileId: string; profile: { id: string; name: string } | null }>(
      'profiles:get-current',
    );
    expect(current.profileId).toBe(added.id);
    expect(current.profile?.name).toBe('Active');
  });

  it('returns null profile when activeProfileId does not match any record', () => {
    const store = new ProfileStore(tmpDir);
    registerProfileHandlers({
      profileStore: store,
      onProfileSelected: vi.fn(),
      activeProfileId: 'phantom',
    });

    const current = invoke<{ profileId: string; profile: unknown | null }>('profiles:get-current');
    expect(current.profileId).toBe('phantom');
    expect(current.profile).toBeNull();
  });
});

describe('profiles ipc — get-colors', () => {
  it('exposes the PROFILE_COLORS palette through IPC', () => {
    const store = new ProfileStore(tmpDir);
    registerProfileHandlers({ profileStore: store, onProfileSelected: vi.fn() });

    const colors = invoke<readonly string[]>('profiles:get-colors');
    expect(colors).toEqual(PROFILE_COLORS);
  });
});

describe('profiles ipc — switch-to', () => {
  it('persists the new active id and calls app.relaunch with --profile-id', () => {
    const store = new ProfileStore(tmpDir);
    const added = store.addProfile('Target', PROFILE_COLORS[3]);
    registerProfileHandlers({ profileStore: store, onProfileSelected: vi.fn() });

    invoke('profiles:switch-to', { id: added.id });
    expect(store.getLastSelectedProfileId()).toBe(added.id);
    expect(mockApp.relaunch).toHaveBeenCalledTimes(1);
    const args = (mockApp.relaunch.mock.calls[0][0] as { args: string[] }).args;
    expect(args.some((a) => a === `--profile-id=${added.id}`)).toBe(true);
  });
});

describe('profiles ipc — input validation', () => {
  it('throws on add with non-string name', () => {
    const store = new ProfileStore(tmpDir);
    registerProfileHandlers({ profileStore: store, onProfileSelected: vi.fn() });
    expect(() => invoke('profiles:add', { name: 123, color: PROFILE_COLORS[0] })).toThrow();
  });

  it('throws on remove with missing id', () => {
    const store = new ProfileStore(tmpDir);
    registerProfileHandlers({ profileStore: store, onProfileSelected: vi.fn() });
    expect(() => invoke('profiles:remove', {})).toThrow();
  });
});
