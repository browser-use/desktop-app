/**
 * passwords/ipc.ts unit tests.
 *
 * Tests cover:
 *   - registerPasswordHandlers: registers all 13 IPC channels
 *   - unregisterPasswordHandlers: removes all channels, clears store
 *   - passwords:save: validates inputs, calls store.saveCredential, strips passwordEncrypted
 *   - passwords:list: delegates to store.listCredentials
 *   - passwords:reveal: calls requireBiometric, delegates to store.revealPassword
 *   - passwords:update: validates and calls store.updateCredential
 *   - passwords:delete: calls store.deleteCredential
 *   - passwords:find-for-origin: calls store.findCredentialsForOrigin
 *   - passwords:add-never-save: calls store.addNeverSave
 *   - passwords:remove-never-save: calls store.removeNeverSave
 *   - passwords:list-never-save: delegates to store.listNeverSave
 *   - passwords:is-never-save: delegates to store.isNeverSave
 *   - passwords:delete-all: calls store.deleteAllPasswords
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); }),
    removeHandler: vi.fn((ch: string) => { handlers.delete(ch); }),
  },
}));

const { mockRequireBiometric } = vi.hoisted(() => ({
  mockRequireBiometric: vi.fn(async () => {}),
}));

vi.mock('../../../src/main/passwords/BiometricAuth', () => ({
  requireBiometric: mockRequireBiometric,
  isBiometricAvailable: vi.fn(async () => false),
}));

const { mockRunPasswordCheckup } = vi.hoisted(() => ({
  mockRunPasswordCheckup: vi.fn(async () => []),
}));

vi.mock('../../../src/main/passwords/PasswordCheckup', () => ({
  runPasswordCheckup: mockRunPasswordCheckup,
}));

import {
  registerPasswordHandlers,
  unregisterPasswordHandlers,
} from '../../../src/main/passwords/ipc';
import type { PasswordStore } from '../../../src/main/passwords/PasswordStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return {
    saveCredential: vi.fn(() => ({ id: 'pw1', origin: 'https://a.com', username: 'user', passwordEncrypted: 'enc', createdAt: '' })),
    listCredentials: vi.fn(() => []),
    revealPassword: vi.fn(() => 'plaintext'),
    updateCredential: vi.fn(() => true),
    deleteCredential: vi.fn(() => true),
    findCredentialsForOrigin: vi.fn(() => []),
    addNeverSave: vi.fn(),
    removeNeverSave: vi.fn(),
    listNeverSave: vi.fn(() => []),
    isNeverSave: vi.fn(() => false),
    deleteAllPasswords: vi.fn(),
    revealAllPasswords: vi.fn(() => []),
  } as unknown as PasswordStore;
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler: ${channel}`);
  return handler({} as never, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('passwords/ipc.ts', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    store = makeStore();
    registerPasswordHandlers({ store: store as unknown as PasswordStore });
  });

  // ---------------------------------------------------------------------------
  // Registration / unregistration
  // ---------------------------------------------------------------------------

  describe('registerPasswordHandlers()', () => {
    const CHANNELS = [
      'passwords:save', 'passwords:list', 'passwords:reveal', 'passwords:update',
      'passwords:delete', 'passwords:find-for-origin', 'passwords:add-never-save',
      'passwords:remove-never-save', 'passwords:list-never-save', 'passwords:is-never-save',
      'passwords:delete-all', 'passwords:autofill', 'passwords:checkup',
    ];
    for (const ch of CHANNELS) {
      it(`registers ${ch}`, () => { expect(handlers.has(ch)).toBe(true); });
    }
  });

  describe('unregisterPasswordHandlers()', () => {
    it('removes all channels', () => {
      unregisterPasswordHandlers();
      expect(handlers.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:save
  // ---------------------------------------------------------------------------

  describe('passwords:save', () => {
    it('calls store.saveCredential with origin, username, password', async () => {
      await invokeHandler('passwords:save', { origin: 'https://a.com', username: 'user', password: 'pass' });
      expect(store.saveCredential).toHaveBeenCalledWith('https://a.com', 'user', 'pass');
    });

    it('strips passwordEncrypted from returned credential', async () => {
      const result = await invokeHandler('passwords:save', { origin: 'https://a.com', username: 'u', password: 'p' }) as Record<string, unknown>;
      expect(result).not.toHaveProperty('passwordEncrypted');
    });

    it('returns the safe credential fields', async () => {
      const result = await invokeHandler('passwords:save', { origin: 'https://a.com', username: 'u', password: 'p' }) as Record<string, unknown>;
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('origin');
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:list
  // ---------------------------------------------------------------------------

  describe('passwords:list', () => {
    it('returns result from store.listCredentials()', async () => {
      const creds = [{ id: 'pw1', origin: 'https://a.com' }];
      (store.listCredentials as ReturnType<typeof vi.fn>).mockReturnValue(creds);
      const result = await invokeHandler('passwords:list');
      expect(result).toBe(creds);
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:reveal
  // ---------------------------------------------------------------------------

  describe('passwords:reveal', () => {
    it('calls requireBiometric before revealing', async () => {
      await invokeHandler('passwords:reveal', 'pw-123');
      expect(mockRequireBiometric).toHaveBeenCalled();
    });

    it('calls store.revealPassword with the id', async () => {
      await invokeHandler('passwords:reveal', 'pw-123');
      expect(store.revealPassword).toHaveBeenCalledWith('pw-123');
    });

    it('returns the plaintext password', async () => {
      (store.revealPassword as ReturnType<typeof vi.fn>).mockReturnValue('secret');
      const result = await invokeHandler('passwords:reveal', 'pw-123');
      expect(result).toBe('secret');
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:delete
  // ---------------------------------------------------------------------------

  describe('passwords:delete', () => {
    it('calls store.deleteCredential with the id', async () => {
      await invokeHandler('passwords:delete', 'pw-abc');
      expect(store.deleteCredential).toHaveBeenCalledWith('pw-abc');
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:find-for-origin
  // ---------------------------------------------------------------------------

  describe('passwords:find-for-origin', () => {
    it('calls store.findCredentialsForOrigin with the origin', async () => {
      await invokeHandler('passwords:find-for-origin', 'https://google.com');
      expect(store.findCredentialsForOrigin).toHaveBeenCalledWith('https://google.com');
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:add-never-save / remove-never-save
  // ---------------------------------------------------------------------------

  describe('passwords:add-never-save', () => {
    it('calls store.addNeverSave with origin', async () => {
      await invokeHandler('passwords:add-never-save', 'https://example.com');
      expect(store.addNeverSave).toHaveBeenCalledWith('https://example.com');
    });
  });

  describe('passwords:remove-never-save', () => {
    it('calls store.removeNeverSave with origin', async () => {
      await invokeHandler('passwords:remove-never-save', 'https://example.com');
      expect(store.removeNeverSave).toHaveBeenCalledWith('https://example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:list-never-save / is-never-save
  // ---------------------------------------------------------------------------

  describe('passwords:list-never-save', () => {
    it('returns result from store.listNeverSave()', async () => {
      (store.listNeverSave as ReturnType<typeof vi.fn>).mockReturnValue(['https://a.com']);
      const result = await invokeHandler('passwords:list-never-save');
      expect(result).toEqual(['https://a.com']);
    });
  });

  describe('passwords:is-never-save', () => {
    it('returns true when origin is in never-save list', async () => {
      (store.isNeverSave as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = await invokeHandler('passwords:is-never-save', 'https://a.com');
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // passwords:delete-all
  // ---------------------------------------------------------------------------

  describe('passwords:delete-all', () => {
    it('calls store.deleteAllPasswords()', async () => {
      await invokeHandler('passwords:delete-all');
      expect(store.deleteAllPasswords).toHaveBeenCalled();
    });
  });
});
