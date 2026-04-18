/**
 * SignOutController — handles user sign-out with optional data clearing.
 *
 * Two modes:
 *   1. "clear"  — revoke OAuth tokens + delete local copies of synced data
 *   2. "keep"   — revoke OAuth tokens but retain bookmarks/history/passwords locally
 *
 * Also supports "turn off sync" which disables sync but keeps Google account
 * association (distinct from full sign-out per Chrome parity).
 *
 * D2 logging: every state transition is logged. Tokens are NEVER logged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, session } from 'electron';
import { mainLogger } from '../logger';
import type { AccountStore } from './AccountStore';
import { getSyncEnabled } from './AccountStore';
import type { KeychainStore } from './KeychainStore';
import type { BookmarkStore } from '../bookmarks/BookmarkStore';
import type { HistoryStore } from '../history/HistoryStore';
import type { PasswordStore } from '../passwords/PasswordStore';
import type { AutofillStore } from '../autofill/AutofillStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICES = [
  'com.agenticbrowser.oauth',
  'com.agenticbrowser.anthropic',
  'com.agenticbrowser.refresh',
] as const;

const SYNCED_DATA_STORAGES = [
  'cookies',
  'localstorage',
  'indexdb',
  'websql',
  'serviceworkers',
  'cachestorage',
  'shadercache',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignOutMode = 'clear' | 'keep';

export interface SignOutResult {
  success: boolean;
  mode: SignOutMode;
  tokenRevoked: boolean;
  dataCleared: boolean;
  errors: string[];
}

/** On-disk local stores that hold sensitive user data to be wiped on 'clear' sign-out. */
export interface LocalDataStores {
  bookmarkStore?: BookmarkStore | null;
  historyStore?: HistoryStore | null;
  passwordStore?: PasswordStore | null;
  autofillStore?: AutofillStore | null;
}

// ---------------------------------------------------------------------------
// Sign-out implementation
// ---------------------------------------------------------------------------

export async function performSignOut(
  mode: SignOutMode,
  accountStore: AccountStore,
  keychainStore: KeychainStore,
  localStores?: LocalDataStores,
): Promise<SignOutResult> {
  mainLogger.info('SignOutController.performSignOut.start', {
    mode,
    hasStores: !!localStores,
  });

  const result: SignOutResult = {
    success: false,
    mode,
    tokenRevoked: false,
    dataCleared: false,
    errors: [],
  };

  const account = accountStore.load();
  const email = account?.email ?? '';

  mainLogger.info('SignOutController.performSignOut.accountLoaded', {
    hasEmail: !!email,
    hasAccount: !!account,
  });

  // 1. Revoke OAuth tokens from keychain
  result.tokenRevoked = await revokeTokens(email, keychainStore);

  // 2. If "clear" mode, wipe synced data (session storage + app-local stores).
  //    Each app-local wipe is independent: one failure must not prevent the
  //    others from running, and must not block the sign-out itself. See #216.
  if (mode === 'clear') {
    result.dataCleared = await clearSyncedData(localStores);
  } else {
    mainLogger.info('SignOutController.performSignOut.keepLocalData', {
      msg: 'Retaining local copies of synced data per user choice',
    });
  }

  // 3. Delete account.json to remove the signed-in identity
  deleteAccountFile(accountStore);

  result.success = true;

  mainLogger.info('SignOutController.performSignOut.complete', {
    mode,
    tokenRevoked: result.tokenRevoked,
    dataCleared: result.dataCleared,
    errorCount: result.errors.length,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Turn off sync (distinct from sign-out)
// ---------------------------------------------------------------------------

/**
 * Return the currently signed-in identity as `{ email, agentName }`, or
 * `null` when no `account.json` exists. Used by the sign-out dialog to
 * show "Signed in as <email>" and by anywhere that wants a redacted view
 * of account.json without directly touching the file. Issue #215.
 */
export function getAccountInfo(
  accountStore: AccountStore,
): { email: string; agentName: string } | null {
  const data = accountStore.load();
  if (!data) {
    mainLogger.debug('SignOutController.getAccountInfo.noAccount');
    return null;
  }
  return {
    email:     data.email ?? '',
    agentName: data.agent_name ?? '',
  };
}

export async function turnOffSync(
  accountStore: AccountStore,
): Promise<{ success: boolean }> {
  mainLogger.info('SignOutController.turnOffSync.start');

  const account = accountStore.load();
  if (!account) {
    mainLogger.warn('SignOutController.turnOffSync.noAccount');
    return { success: false };
  }

  // Mark sync as disabled in account data while keeping the Google association.
  // sync_enabled is now a first-class field on AccountData (no cast needed).
  accountStore.save({ ...account, sync_enabled: false });

  // Verify the flag was persisted correctly.
  const saved = accountStore.load();
  const stillEnabled = getSyncEnabled(saved);
  mainLogger.info('SignOutController.turnOffSync.complete', {
    email: account.email,
    syncEnabled: stillEnabled, // should be false
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function revokeTokens(
  email: string,
  keychainStore: KeychainStore,
): Promise<boolean> {
  mainLogger.info('SignOutController.revokeTokens.start', {
    hasEmail: !!email,
  });

  let revoked = false;

  // Delete from KeychainStore
  if (email) {
    try {
      await keychainStore.deleteToken(email);
      mainLogger.info('SignOutController.revokeTokens.keychainStore.ok', {
        account: email,
      });
      revoked = true;
    } catch (err) {
      mainLogger.warn('SignOutController.revokeTokens.keychainStore.failed', {
        error: (err as Error).message,
      });
    }
  }

  // Also clean up keytar entries across all known service names
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keytar = require('keytar') as {
      findCredentials(s: string): Promise<Array<{ account: string }>>;
      deletePassword(s: string, a: string): Promise<boolean>;
    };

    for (const service of KEYCHAIN_SERVICES) {
      try {
        const creds = await keytar.findCredentials(service);
        for (const cred of creds) {
          await keytar.deletePassword(service, cred.account);
          mainLogger.info('SignOutController.revokeTokens.keytarDeleted', {
            service,
            accountLength: cred.account.length,
          });
        }
        revoked = true;
      } catch (err) {
        mainLogger.warn('SignOutController.revokeTokens.keytarServiceFailed', {
          service,
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    mainLogger.warn('SignOutController.revokeTokens.keytarUnavailable', {
      error: (err as Error).message,
    });
  }

  mainLogger.info('SignOutController.revokeTokens.complete', { revoked });
  return revoked;
}

async function clearSyncedData(localStores?: LocalDataStores): Promise<boolean> {
  mainLogger.info('SignOutController.clearSyncedData.start');

  try {
    // Clear browsing session data (cookies, localStorage, IndexedDB, etc.)
    await session.defaultSession.clearStorageData({
      storages: [...SYNCED_DATA_STORAGES],
    });
    mainLogger.info('SignOutController.clearSyncedData.storageCleared');

    // Clear HTTP cache
    await session.defaultSession.clearCache();
    mainLogger.info('SignOutController.clearSyncedData.cacheCleared');

    // Clear history
    await (
      session.defaultSession as unknown as { clearHistory: () => Promise<void> }
    ).clearHistory();
    mainLogger.info('SignOutController.clearSyncedData.historyCleared');

    // Clear auth cache (saved HTTP auth credentials)
    await session.defaultSession.clearAuthCache();
    mainLogger.info('SignOutController.clearSyncedData.authCacheCleared');

    // Clear app-local on-disk stores (bookmarks, history, passwords, autofill)
    if (localStores?.bookmarkStore) {
      try {
        localStores.bookmarkStore.deleteAll();
        localStores.bookmarkStore.flushSync();
        mainLogger.info('SignOutController.clearSyncedData.bookmarksCleared');
      } catch (err) {
        mainLogger.warn('SignOutController.clearSyncedData.bookmarksClearFailed', {
          error: (err as Error).message,
        });
      }
    }

    if (localStores?.historyStore) {
      try {
        localStores.historyStore.clearAll();
        localStores.historyStore.flushSync();
        mainLogger.info('SignOutController.clearSyncedData.appHistoryCleared');
      } catch (err) {
        mainLogger.warn('SignOutController.clearSyncedData.appHistoryClearFailed', {
          error: (err as Error).message,
        });
      }
    }

    if (localStores?.passwordStore) {
      try {
        localStores.passwordStore.deleteAllPasswords();
        localStores.passwordStore.flushSync();
        mainLogger.info('SignOutController.clearSyncedData.passwordsCleared');
      } catch (err) {
        mainLogger.warn('SignOutController.clearSyncedData.passwordsClearFailed', {
          error: (err as Error).message,
        });
      }
    }

    if (localStores?.autofillStore) {
      try {
        localStores.autofillStore.deleteAll();
        localStores.autofillStore.flushSync();
        mainLogger.info('SignOutController.clearSyncedData.autofillCleared');
      } catch (err) {
        mainLogger.warn('SignOutController.clearSyncedData.autofillClearFailed', {
          error: (err as Error).message,
        });
      }
    }

    mainLogger.info('SignOutController.clearSyncedData.complete');
    return true;
  } catch (err) {
    mainLogger.error('SignOutController.clearSyncedData.failed', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return false;
  }
}

function deleteAccountFile(accountStore: AccountStore): void {
  mainLogger.info('SignOutController.deleteAccountFile.start');

  try {
    const userDataPath = (() => {
      try {
        return app.getPath('userData');
      } catch {
        return '/tmp/agentic-browser';
      }
    })();

    const accountFile = path.join(userDataPath, 'account.json');
    if (fs.existsSync(accountFile)) {
      fs.unlinkSync(accountFile);
      mainLogger.info('SignOutController.deleteAccountFile.ok');
    } else {
      mainLogger.info('SignOutController.deleteAccountFile.notFound');
    }
  } catch (err) {
    mainLogger.warn('SignOutController.deleteAccountFile.failed', {
      error: (err as Error).message,
    });
  }
}
