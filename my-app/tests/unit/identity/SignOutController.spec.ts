/**
 * SignOutController unit tests — Issue #216.
 *
 * Verifies that `performSignOut('clear')` deletes app-local copies of synced
 * data — bookmarks, history, passwords, autofill — in addition to session
 * storage / cache / auth. `performSignOut('keep')` must NOT wipe these stores.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — fs (so `deleteAccountFile` is a no-op), logger, keytar
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: loggerSpy,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
}));

// keytar is optional: stub findCredentials to return empty so the revoke path
// doesn't hit the real native module.
vi.mock('keytar', () => ({
  findCredentials: vi.fn(async () => []),
  deletePassword: vi.fn(async () => true),
}));

import { performSignOut } from '../../../src/main/identity/SignOutController';

// ---------------------------------------------------------------------------
// Fake stores — only implement the surfaces SignOutController actually needs
// ---------------------------------------------------------------------------

interface FakeAccountStore {
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

interface FakeKeychainStore {
  deleteToken: ReturnType<typeof vi.fn>;
}

interface Deletable {
  deleteAll: ReturnType<typeof vi.fn>;
}

interface AppLocalStores {
  bookmarkStore: Deletable;
  historyStore: { clearAll: ReturnType<typeof vi.fn> };
  passwordStore: { deleteAllPasswords: ReturnType<typeof vi.fn> };
  autofillStore: Deletable;
}

function makeAccountStore(email: string): FakeAccountStore {
  return {
    load: vi.fn(() => ({ agent_name: 'Atlas', email, created_at: '2024-01-01' })),
    save: vi.fn(),
  };
}

function makeKeychainStore(): FakeKeychainStore {
  return {
    deleteToken: vi.fn(async () => undefined),
  };
}

function makeStores(): AppLocalStores {
  return {
    bookmarkStore: { deleteAll: vi.fn() },
    historyStore: { clearAll: vi.fn() },
    passwordStore: { deleteAllPasswords: vi.fn() },
    autofillStore: { deleteAll: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignOutController.performSignOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clear mode wipes app-local bookmark/history/password/autofill stores", async () => {
    const stores = makeStores();
    const result = await performSignOut(
      'clear',
      makeAccountStore('user@example.com') as never,
      makeKeychainStore() as never,
      stores as never,
    );

    expect(result.success).toBe(true);
    expect(result.mode).toBe('clear');
    expect(result.dataCleared).toBe(true);

    expect(stores.bookmarkStore.deleteAll).toHaveBeenCalledTimes(1);
    expect(stores.historyStore.clearAll).toHaveBeenCalledTimes(1);
    expect(stores.passwordStore.deleteAllPasswords).toHaveBeenCalledTimes(1);
    expect(stores.autofillStore.deleteAll).toHaveBeenCalledTimes(1);
  });

  it("keep mode does NOT touch the app-local stores", async () => {
    const stores = makeStores();
    const result = await performSignOut(
      'keep',
      makeAccountStore('user@example.com') as never,
      makeKeychainStore() as never,
      stores as never,
    );

    expect(result.success).toBe(true);
    expect(result.mode).toBe('keep');
    expect(result.dataCleared).toBe(false);

    expect(stores.bookmarkStore.deleteAll).not.toHaveBeenCalled();
    expect(stores.historyStore.clearAll).not.toHaveBeenCalled();
    expect(stores.passwordStore.deleteAllPasswords).not.toHaveBeenCalled();
    expect(stores.autofillStore.deleteAll).not.toHaveBeenCalled();
  });

  it("clear mode still succeeds when stores are not provided (backward compat)", async () => {
    // Older callers may not pass the stores bag. The controller should not
    // throw — it degrades to clearing only session storage.
    const result = await performSignOut(
      'clear',
      makeAccountStore('user@example.com') as never,
      makeKeychainStore() as never,
    );

    expect(result.success).toBe(true);
    expect(result.mode).toBe('clear');
  });

  it("clear mode tolerates a failing individual store without aborting the sign-out", async () => {
    const stores = makeStores();
    stores.bookmarkStore.deleteAll.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await performSignOut(
      'clear',
      makeAccountStore('user@example.com') as never,
      makeKeychainStore() as never,
      stores as never,
    );

    // Other stores must still have been asked to delete; the sign-out still
    // completes so the user is signed out.
    expect(stores.historyStore.clearAll).toHaveBeenCalledTimes(1);
    expect(stores.passwordStore.deleteAllPasswords).toHaveBeenCalledTimes(1);
    expect(stores.autofillStore.deleteAll).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("revokes OAuth tokens via keychainStore.deleteToken", async () => {
    const keychain = makeKeychainStore();
    await performSignOut(
      'keep',
      makeAccountStore('user@example.com') as never,
      keychain as never,
    );
    expect(keychain.deleteToken).toHaveBeenCalledWith('user@example.com');
  });
});
