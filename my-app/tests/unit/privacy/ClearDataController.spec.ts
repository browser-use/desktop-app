/**
 * ClearDataController unit tests — Issue #200.
 *
 * Before this fix:
 *   - `passwords` mapped to `session.clearAuthCache()` only, leaving every
 *     saved credential on disk.
 *   - `downloads` was a no-op.
 *   - `hostedApp` was a no-op shown to the user as a working checkbox.
 *
 * After the fix:
 *   - `passwords` → `PasswordStore.deleteAllPasswords()` + `clearAuthCache`.
 *   - `downloads` → wipe the app-local download history list.
 *   - `hostedApp` is removed from the DataType union / UI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  sessionMock,
  autofillMock,
  passwordStoreStub,
  downloadManagerStub,
  loggerSpy,
} = vi.hoisted(() => {
  const sessionMock = {
    defaultSession: {
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      clearAuthCache: vi.fn(async () => undefined),
      clearHistory: vi.fn(async () => undefined),
    },
  };
  const autofillMock = { clearAutofillData: vi.fn() };
  const passwordStoreStub = {
    deleteAllPasswords: vi.fn(),
  };
  const downloadManagerStub = {
    clearAll: vi.fn(),
  };
  const loggerSpy = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    sessionMock,
    autofillMock,
    passwordStoreStub,
    downloadManagerStub,
    loggerSpy,
  };
});

vi.mock('electron', () => ({
  session: sessionMock,
  app: { getPath: () => '/tmp/test' },
}));

vi.mock('../../../src/main/autofill/ipc', () => autofillMock);

vi.mock('../../../src/main/logger', () => ({
  mainLogger: loggerSpy,
}));

import {
  clearBrowsingData,
  setPrivacyStoreDeps,
  DATA_TYPES,
} from '../../../src/main/privacy/ClearDataController';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClearDataController — store wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrivacyStoreDeps({
      passwordStore: passwordStoreStub as never,
      downloadManager: downloadManagerStub as never,
    });
  });

  describe('passwords', () => {
    it("calls PasswordStore.deleteAllPasswords() — not just clearAuthCache", async () => {
      const result = await clearBrowsingData({ types: ['passwords'], timeRangeMs: 0 });

      expect(passwordStoreStub.deleteAllPasswords).toHaveBeenCalledTimes(1);
      expect(sessionMock.defaultSession.clearAuthCache).toHaveBeenCalledTimes(1);
      expect(result.cleared).toContain('passwords');
      expect(result.errors).not.toHaveProperty('passwords');
    });

    it("surfaces an error (not a silent no-op) if the password store is missing", async () => {
      setPrivacyStoreDeps({ passwordStore: null, downloadManager: downloadManagerStub as never });
      const result = await clearBrowsingData({ types: ['passwords'], timeRangeMs: 0 });
      expect(result.errors.passwords).toBeDefined();
    });
  });

  describe('downloads', () => {
    it("calls DownloadManager.clearAll() to wipe the app-local download history", async () => {
      const result = await clearBrowsingData({ types: ['downloads'], timeRangeMs: 0 });

      expect(downloadManagerStub.clearAll).toHaveBeenCalledTimes(1);
      expect(result.cleared).toContain('downloads');
      expect(result.errors).not.toHaveProperty('downloads');
    });

    it("surfaces an error when the download manager is not yet initialised", async () => {
      setPrivacyStoreDeps({ passwordStore: passwordStoreStub as never, downloadManager: null });
      const result = await clearBrowsingData({ types: ['downloads'], timeRangeMs: 0 });
      expect(result.errors.downloads).toBeDefined();
    });
  });

  describe('hostedApp', () => {
    it("is removed from the public DataType list so the renderer cannot request it", () => {
      expect((DATA_TYPES as readonly string[])).not.toContain('hostedApp');
    });
  });

  describe("autofill (sanity check)", () => {
    it("calls clearAutofillData()", async () => {
      const result = await clearBrowsingData({ types: ['autofill'], timeRangeMs: 0 });
      expect(autofillMock.clearAutofillData).toHaveBeenCalledTimes(1);
      expect(result.cleared).toContain('autofill');
    });
  });

  describe("multiple types", () => {
    it("runs each selected wipe independently", async () => {
      const result = await clearBrowsingData({
        types: ['passwords', 'downloads', 'autofill'],
        timeRangeMs: 0,
      });
      expect(passwordStoreStub.deleteAllPasswords).toHaveBeenCalledTimes(1);
      expect(downloadManagerStub.clearAll).toHaveBeenCalledTimes(1);
      expect(autofillMock.clearAutofillData).toHaveBeenCalledTimes(1);
      expect(result.cleared).toEqual(expect.arrayContaining(['passwords', 'downloads', 'autofill']));
    });
  });
});
