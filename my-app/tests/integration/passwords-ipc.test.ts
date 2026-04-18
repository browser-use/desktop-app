/**
 * Integration test: passwords IPC handlers.
 *
 * Strategy: capture handlers from a mocked ipcMain, drive them with synthetic
 * payloads, and use a real PasswordStore underneath. The biometric gate is
 * mocked at the BiometricAuth module boundary so we can assert it is invoked
 * on reveal/update/autofill but not on save/list/delete.
 *
 * Coverage:
 *   - register/unregister installs/removes all 12 channels
 *   - save → list → reveal → delete full flow via IPC
 *   - reveal invokes requireBiometric() (biometric gate)
 *   - update invokes requireBiometric()
 *   - autofill invokes requireBiometric()
 *   - save / list / delete do NOT invoke requireBiometric
 *   - never-save list IPC round-trip
 *   - delete-all wipes everything
 *   - **No plaintext password ever appears in log calls**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.hoisted: ipcMain stub + safeStorage stub + biometric stub --------------
const {
  handlers,
  mockIpcMain,
  safeStorageStub,
  biometricSpy,
  loggerSpy,
  mockApp,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockIpcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  };
  const safeStorageStub = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => {
      const s = b.toString('utf-8');
      return s.startsWith('enc:') ? s.slice(4) : s;
    }),
  };
  const biometricSpy = vi.fn((_reason: string): Promise<void> => Promise.resolve());
  const loggerSpy = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  const mockApp = { getPath: vi.fn(() => '/tmp/passwords-ipc-test') };
  return { handlers, mockIpcMain, safeStorageStub, biometricSpy, loggerSpy, mockApp };
});

vi.mock('electron', () => ({
  app: mockApp,
  ipcMain: mockIpcMain,
  safeStorage: safeStorageStub,
}));

vi.mock('../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('../../src/main/passwords/BiometricAuth', () => ({
  requireBiometric: biometricSpy,
  promptBiometric: vi.fn(() => Promise.resolve(true)),
  isBiometricAvailable: vi.fn(() => true),
  isBiometricEnabled: vi.fn(() => false),
}));

import { PasswordStore } from '../../src/main/passwords/PasswordStore';
import { registerPasswordHandlers, unregisterPasswordHandlers } from '../../src/main/passwords/ipc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invoke<T = unknown>(channel: string, ...args: unknown[]): T | Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}`);
  return h({} as Electron.IpcMainInvokeEvent, ...args) as T | Promise<T>;
}

function collectLogPayload(): string {
  return JSON.stringify([
    ...loggerSpy.debug.mock.calls,
    ...loggerSpy.info.mock.calls,
    ...loggerSpy.warn.mock.calls,
    ...loggerSpy.error.mock.calls,
  ]);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passwords-ipc-'));
  mockApp.getPath.mockImplementation(() => tmpDir);
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true);
  safeStorageStub.encryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`, 'utf-8'));
  safeStorageStub.decryptString.mockImplementation((b: Buffer) => {
    const s = b.toString('utf-8');
    return s.startsWith('enc:') ? s.slice(4) : s;
  });
  biometricSpy.mockReset();
  biometricSpy.mockImplementation(() => Promise.resolve());
  loggerSpy.debug.mockReset();
  loggerSpy.info.mockReset();
  loggerSpy.warn.mockReset();
  loggerSpy.error.mockReset();
  handlers.clear();
});

afterEach(() => {
  unregisterPasswordHandlers();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('passwords ipc — registration', () => {
  it('register installs all channels; unregister removes them', () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const expected = [
      'passwords:save',
      'passwords:list',
      'passwords:reveal',
      'passwords:update',
      'passwords:delete',
      'passwords:find-for-origin',
      'passwords:add-never-save',
      'passwords:remove-never-save',
      'passwords:list-never-save',
      'passwords:is-never-save',
      'passwords:delete-all',
      'passwords:autofill',
    ];
    for (const ch of expected) expect(handlers.has(ch)).toBe(true);

    unregisterPasswordHandlers();
    expect(handlers.size).toBe(0);
  });
});

describe('passwords ipc — save → list → reveal → delete flow', () => {
  it('round-trips a credential through IPC', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string; origin: string; username: string }>(
      'passwords:save',
      { origin: 'https://example.com', username: 'alice', password: 'hunter2' },
    ) as Promise<{ id: string; origin: string; username: string }>);
    expect(saved.id).toBeTruthy();
    expect(saved.origin).toBe('https://example.com');
    // Returned object should NOT include the encrypted blob
    expect((saved as Record<string, unknown>).passwordEncrypted).toBeUndefined();

    const list = await (invoke<Array<{ id: string }>>('passwords:list') as Promise<Array<{ id: string }>>);
    expect(list).toHaveLength(1);
    expect((list[0] as Record<string, unknown>).passwordEncrypted).toBeUndefined();

    const revealed = await (invoke<string>('passwords:reveal', saved.id) as Promise<string>);
    expect(revealed).toBe('hunter2');

    const ok = await (invoke<boolean>('passwords:delete', saved.id) as Promise<boolean>);
    expect(ok).toBe(true);
    expect(await (invoke<Array<unknown>>('passwords:list') as Promise<Array<unknown>>)).toHaveLength(0);
  });

  it('reveal invokes requireBiometric()', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string }>('passwords:save', {
      origin: 'https://x.com', username: 'a', password: 'p',
    }) as Promise<{ id: string }>);

    biometricSpy.mockClear();
    await (invoke('passwords:reveal', saved.id) as Promise<unknown>);
    expect(biometricSpy).toHaveBeenCalledTimes(1);
    expect(biometricSpy.mock.calls[0][0]).toMatch(/reveal/i);
  });

  it('update invokes requireBiometric()', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string }>('passwords:save', {
      origin: 'https://x.com', username: 'a', password: 'p1',
    }) as Promise<{ id: string }>);

    biometricSpy.mockClear();
    await (invoke('passwords:update', { id: saved.id, password: 'p2' }) as Promise<unknown>);
    expect(biometricSpy).toHaveBeenCalledTimes(1);
    expect(biometricSpy.mock.calls[0][0]).toMatch(/edit/i);
  });

  it('autofill invokes requireBiometric() and returns the plaintext', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string }>('passwords:save', {
      origin: 'https://x.com', username: 'a', password: 'fillme',
    }) as Promise<{ id: string }>);

    biometricSpy.mockClear();
    const filled = await (invoke<string>('passwords:autofill', saved.id) as Promise<string>);
    expect(biometricSpy).toHaveBeenCalledTimes(1);
    expect(filled).toBe('fillme');
  });

  it('save / list / delete do NOT invoke requireBiometric', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string }>('passwords:save', {
      origin: 'https://x.com', username: 'a', password: 'p',
    }) as Promise<{ id: string }>);
    await (invoke('passwords:list') as Promise<unknown>);
    await (invoke('passwords:delete', saved.id) as Promise<unknown>);
    expect(biometricSpy).not.toHaveBeenCalled();
  });

  it('reveal is BLOCKED when requireBiometric throws', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string }>('passwords:save', {
      origin: 'https://x.com', username: 'a', password: 'pw',
    }) as Promise<{ id: string }>);

    biometricSpy.mockRejectedValueOnce(new Error('Biometric authentication required'));
    await expect(
      invoke('passwords:reveal', saved.id) as Promise<unknown>,
    ).rejects.toThrow(/Biometric/);
  });
});

describe('passwords ipc — never-save list', () => {
  it('add / list / is / remove via IPC', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    expect(await (invoke<boolean>('passwords:is-never-save', 'https://x.com') as Promise<boolean>)).toBe(false);
    await (invoke('passwords:add-never-save', 'https://x.com') as Promise<unknown>);
    expect(await (invoke<string[]>('passwords:list-never-save') as Promise<string[]>)).toContain('https://x.com');
    expect(await (invoke<boolean>('passwords:is-never-save', 'https://x.com') as Promise<boolean>)).toBe(true);

    await (invoke('passwords:remove-never-save', 'https://x.com') as Promise<unknown>);
    expect(await (invoke<boolean>('passwords:is-never-save', 'https://x.com') as Promise<boolean>)).toBe(false);
  });
});

describe('passwords ipc — find-for-origin', () => {
  it('returns only credentials matching the origin (no passwordEncrypted)', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    await (invoke('passwords:save', { origin: 'https://a.com', username: 'u1', password: 'p1' }) as Promise<unknown>);
    await (invoke('passwords:save', { origin: 'https://b.com', username: 'u2', password: 'p2' }) as Promise<unknown>);

    const matches = await (invoke<Array<{ origin: string }>>('passwords:find-for-origin', 'https://a.com') as Promise<Array<{ origin: string }>>);
    expect(matches).toHaveLength(1);
    expect(matches[0].origin).toBe('https://a.com');
    expect((matches[0] as Record<string, unknown>).passwordEncrypted).toBeUndefined();
  });
});

describe('passwords ipc — delete-all', () => {
  it('clears credentials and never-save list', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    await (invoke('passwords:save', { origin: 'https://a.com', username: 'u', password: 'p' }) as Promise<unknown>);
    await (invoke('passwords:add-never-save', 'https://b.com') as Promise<unknown>);

    await (invoke('passwords:delete-all') as Promise<unknown>);
    expect(await (invoke<Array<unknown>>('passwords:list') as Promise<Array<unknown>>)).toHaveLength(0);
    expect(await (invoke<string[]>('passwords:list-never-save') as Promise<string[]>)).toHaveLength(0);
  });
});

describe('passwords ipc — input validation', () => {
  it('save throws when origin is missing', () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });
    expect(() => invoke('passwords:save', { username: 'a', password: 'p' })).toThrow(
      /origin must be a string/,
    );
  });

  it('reveal throws when id is not a string', async () => {
    const store = new PasswordStore();
    registerPasswordHandlers({ store });
    // reveal handler is async, so the validation throw becomes a rejection
    await expect(invoke('passwords:reveal', 123) as Promise<unknown>).rejects.toThrow(
      /id must be a string/,
    );
  });
});

describe('passwords ipc — D2: no plaintext password in logs', () => {
  it('save / reveal / update / delete never log the plaintext password', async () => {
    const SECRET = 'INTEGRATION_SECRET_42!';
    const store = new PasswordStore();
    registerPasswordHandlers({ store });

    const saved = await (invoke<{ id: string }>('passwords:save', {
      origin: 'https://example.com', username: 'alice', password: SECRET,
    }) as Promise<{ id: string }>);
    await (invoke('passwords:reveal', saved.id) as Promise<unknown>);
    await (invoke('passwords:update', { id: saved.id, password: SECRET + '_v2' }) as Promise<unknown>);
    await (invoke('passwords:delete', saved.id) as Promise<unknown>);

    const allLogs = collectLogPayload();
    expect(allLogs).not.toContain(SECRET);
    expect(allLogs).not.toContain(SECRET + '_v2');
  });
});
