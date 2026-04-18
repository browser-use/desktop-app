/**
 * PasswordStore unit tests.
 *
 * Tests cover:
 *   - Encrypted round-trip via safeStorage (encryptString → decryptString)
 *   - safeStorage fallback path when isEncryptionAvailable() is false
 *     (base64 only, but data still round-trips)
 *   - Unique key on (origin, username) — second save updates instead of duplicating
 *   - listCredentials never returns the encrypted password
 *   - revealPassword returns the decrypted plaintext
 *   - updateCredential / deleteCredential happy path + missing-id path
 *   - Never-save list add / remove / list / isNeverSave
 *   - deleteAllPasswords wipes both lists
 *   - Persistence round-trip via flushSync
 *   - **Security**: no log call (info / warn / error / debug) ever contains the
 *     plaintext password during save / reveal / update / delete operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.hoisted: mutable safeStorage stub shared between tests + the mock factory
const { safeStorageStub, loggerSpy, mockApp } = vi.hoisted(() => {
  const safeStorageStub = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => {
      const s = b.toString('utf-8');
      return s.startsWith('enc:') ? s.slice(4) : s;
    }),
  };
  const loggerSpy = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockApp = {
    getPath: vi.fn(() => os.tmpdir()),
  };
  return { safeStorageStub, loggerSpy, mockApp };
});

vi.mock('electron', () => ({
  app: mockApp,
  safeStorage: safeStorageStub,
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: loggerSpy,
}));

import { PasswordStore } from '../../../src/main/passwords/PasswordStore';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passwordstore-'));
  mockApp.getPath.mockImplementation(() => tmpDir);
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true);
  safeStorageStub.encryptString.mockImplementation((s: string) =>
    Buffer.from(`enc:${s}`, 'utf-8'),
  );
  safeStorageStub.decryptString.mockImplementation((b: Buffer) => {
    const s = b.toString('utf-8');
    return s.startsWith('enc:') ? s.slice(4) : s;
  });
  loggerSpy.debug.mockReset();
  loggerSpy.info.mockReset();
  loggerSpy.warn.mockReset();
  loggerSpy.error.mockReset();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectLogPayload(): string {
  const calls = [
    ...loggerSpy.debug.mock.calls,
    ...loggerSpy.info.mock.calls,
    ...loggerSpy.warn.mock.calls,
    ...loggerSpy.error.mock.calls,
  ];
  return JSON.stringify(calls);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PasswordStore — encrypted round-trip', () => {
  it('saves a credential and round-trips the password via safeStorage', () => {
    const store = new PasswordStore();
    const cred = store.saveCredential('https://example.com', 'alice', 'hunter2');

    expect(cred.id).toBeTruthy();
    expect(cred.origin).toBe('https://example.com');
    expect(cred.username).toBe('alice');
    // Stored payload is encrypted (not equal to plaintext)
    expect(cred.passwordEncrypted).not.toBe('hunter2');
    expect(safeStorageStub.encryptString).toHaveBeenCalledWith('hunter2');

    const revealed = store.revealPassword(cred.id);
    expect(revealed).toBe('hunter2');
  });

  it('listCredentials never returns the encrypted password field', () => {
    const store = new PasswordStore();
    store.saveCredential('https://a.com', 'u1', 'p1');
    store.saveCredential('https://b.com', 'u2', 'p2');

    const list = store.listCredentials();
    expect(list).toHaveLength(2);
    for (const entry of list) {
      expect((entry as Record<string, unknown>).passwordEncrypted).toBeUndefined();
    }
  });

  it('findCredentialsForOrigin filters and excludes encrypted password', () => {
    const store = new PasswordStore();
    store.saveCredential('https://a.com', 'u1', 'p1');
    store.saveCredential('https://b.com', 'u2', 'p2');

    const a = store.findCredentialsForOrigin('https://a.com');
    expect(a).toHaveLength(1);
    expect(a[0].username).toBe('u1');
    expect((a[0] as Record<string, unknown>).passwordEncrypted).toBeUndefined();
  });
});

describe('PasswordStore — unique on (origin, username)', () => {
  it('second save with the same origin+username updates instead of duplicating', () => {
    const store = new PasswordStore();
    const first = store.saveCredential('https://example.com', 'alice', 'pw1');
    const second = store.saveCredential('https://example.com', 'alice', 'pw2');

    expect(second.id).toBe(first.id);
    expect(store.listCredentials()).toHaveLength(1);
    expect(store.revealPassword(first.id)).toBe('pw2');
  });

  it('different usernames at the same origin produce distinct entries', () => {
    const store = new PasswordStore();
    const a = store.saveCredential('https://x.com', 'alice', 'p1');
    const b = store.saveCredential('https://x.com', 'bob',   'p2');
    expect(a.id).not.toBe(b.id);
    expect(store.listCredentials()).toHaveLength(2);
  });

  it('different origins with the same username produce distinct entries', () => {
    const store = new PasswordStore();
    const a = store.saveCredential('https://a.com', 'alice', 'p1');
    const b = store.saveCredential('https://b.com', 'alice', 'p2');
    expect(a.id).not.toBe(b.id);
    expect(store.listCredentials()).toHaveLength(2);
  });
});

describe('PasswordStore — safeStorage fallback', () => {
  it('falls back to base64 when isEncryptionAvailable() is false', () => {
    safeStorageStub.isEncryptionAvailable.mockReturnValue(false);
    const store = new PasswordStore();

    const cred = store.saveCredential('https://x.com', 'alice', 'plain-secret');
    // Without safeStorage we expect base64-encoded plaintext (still not the
    // raw plaintext bytes, so a leak past `passwordEncrypted` is still a bug)
    expect(cred.passwordEncrypted).not.toBe('plain-secret');
    expect(Buffer.from(cred.passwordEncrypted, 'base64').toString('utf-8')).toBe('plain-secret');

    const revealed = store.revealPassword(cred.id);
    expect(revealed).toBe('plain-secret');
  });

  it('decryptPassword returns empty string when safeStorage decryption throws', () => {
    const store = new PasswordStore();
    const cred = store.saveCredential('https://x.com', 'alice', 'pw');

    safeStorageStub.decryptString.mockImplementationOnce(() => {
      throw new Error('decrypt boom');
    });
    expect(store.revealPassword(cred.id)).toBe('');
  });
});

describe('PasswordStore — update / delete', () => {
  it('updateCredential changes username + password + bumps updatedAt', () => {
    const store = new PasswordStore();
    const cred = store.saveCredential('https://x.com', 'alice', 'pw1');
    const before = cred.updatedAt;
    // Pause a tick so updatedAt strictly differs
    vi.useFakeTimers();
    vi.setSystemTime(before + 5_000);

    const ok = store.updateCredential(cred.id, { username: 'alice2', password: 'pw2' });
    expect(ok).toBe(true);
    const reloaded = store.getCredential(cred.id);
    expect(reloaded?.username).toBe('alice2');
    expect(reloaded?.updatedAt).toBeGreaterThan(before);
    expect(store.revealPassword(cred.id)).toBe('pw2');

    vi.useRealTimers();
  });

  it('updateCredential returns false for a missing id', () => {
    const store = new PasswordStore();
    expect(store.updateCredential('missing-id', { password: 'x' })).toBe(false);
  });

  it('deleteCredential removes an existing entry and returns true', () => {
    const store = new PasswordStore();
    const cred = store.saveCredential('https://x.com', 'alice', 'pw');
    expect(store.deleteCredential(cred.id)).toBe(true);
    expect(store.getCredential(cred.id)).toBeNull();
  });

  it('deleteCredential returns false for a missing id', () => {
    const store = new PasswordStore();
    expect(store.deleteCredential('missing-id')).toBe(false);
  });

  it('revealPassword returns null for a missing id', () => {
    const store = new PasswordStore();
    expect(store.revealPassword('missing-id')).toBeNull();
  });
});

describe('PasswordStore — never-save list', () => {
  it('addNeverSave / isNeverSave / listNeverSave round-trip', () => {
    const store = new PasswordStore();
    expect(store.isNeverSave('https://x.com')).toBe(false);

    store.addNeverSave('https://x.com');
    expect(store.isNeverSave('https://x.com')).toBe(true);
    expect(store.listNeverSave()).toContain('https://x.com');
  });

  it('addNeverSave is idempotent', () => {
    const store = new PasswordStore();
    store.addNeverSave('https://x.com');
    store.addNeverSave('https://x.com');
    expect(store.listNeverSave()).toHaveLength(1);
  });

  it('removeNeverSave removes the entry', () => {
    const store = new PasswordStore();
    store.addNeverSave('https://x.com');
    store.removeNeverSave('https://x.com');
    expect(store.isNeverSave('https://x.com')).toBe(false);
  });

  it('removeNeverSave is a no-op for an unknown origin', () => {
    const store = new PasswordStore();
    expect(() => store.removeNeverSave('https://nope.com')).not.toThrow();
  });
});

describe('PasswordStore — bulk delete', () => {
  it('deleteAllPasswords clears credentials AND never-save', () => {
    const store = new PasswordStore();
    store.saveCredential('https://a.com', 'u', 'p');
    store.addNeverSave('https://b.com');

    store.deleteAllPasswords();
    expect(store.listCredentials()).toHaveLength(0);
    expect(store.listNeverSave()).toHaveLength(0);
  });
});

describe('PasswordStore — persistence', () => {
  it('flushSync writes to passwords.json and a fresh instance reloads it', () => {
    const store = new PasswordStore();
    store.saveCredential('https://x.com', 'alice', 'pw');
    store.addNeverSave('https://nope.com');
    store.flushSync();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'passwords.json'), 'utf-8'),
    );
    expect(onDisk.credentials).toHaveLength(1);
    expect(onDisk.neverSaveOrigins).toEqual(['https://nope.com']);

    const reload = new PasswordStore();
    expect(reload.listCredentials()).toHaveLength(1);
    expect(reload.listNeverSave()).toEqual(['https://nope.com']);
  });

  it('reload falls back to empty when passwords.json is corrupt', () => {
    fs.writeFileSync(path.join(tmpDir, 'passwords.json'), 'not-json{', 'utf-8');
    const store = new PasswordStore();
    expect(store.listCredentials()).toHaveLength(0);
  });

  it('reload falls back when version mismatches', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'passwords.json'),
      JSON.stringify({ version: 99, credentials: [], neverSaveOrigins: [] }),
      'utf-8',
    );
    const store = new PasswordStore();
    expect(store.listCredentials()).toHaveLength(0);
  });
});

describe('PasswordStore — security: no plaintext password in logs (D2)', () => {
  it('save / reveal / update / delete never log the plaintext password', () => {
    const SECRET = 'CORRECT_HORSE_BATTERY_STAPLE_42';
    const store = new PasswordStore();

    const cred = store.saveCredential('https://example.com', 'alice', SECRET);
    store.revealPassword(cred.id);
    store.updateCredential(cred.id, { password: SECRET + '!' });
    store.deleteCredential(cred.id);

    const allLogs = collectLogPayload();
    expect(allLogs).not.toContain(SECRET);
    expect(allLogs).not.toContain(SECRET + '!');
  });

  it('encrypted ciphertext is never logged either', () => {
    const SECRET = 'PLAINTEXT-PASSWORD-9001';
    const store = new PasswordStore();
    const cred = store.saveCredential('https://example.com', 'alice', SECRET);
    store.revealPassword(cred.id);

    const allLogs = collectLogPayload();
    expect(allLogs).not.toContain(cred.passwordEncrypted);
  });
});
