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
import type { KeychainStore } from './KeychainStore';

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

/**
 * App-local stores that hold copies of data the user might consider "synced".
 * When the user picks "Clear data" at sign-out we wipe these in addition to
 * the Electron session storage / cache / auth caches — otherwise the user's
 * bookmarks, history, passwords and autofill entries stay on disk and the
 * dialog copy ("Remove local copies of synced data") lies to them.
 * Tracked as #216.
 */
export interface AppLocalStores {
  bookmarkStore?: { deleteAll(): void };
  historyStore?: { clearAll(): void };
  passwordStore?: { deleteAllPasswords(): void };
  autofillStore?: { deleteAll(): void };
}

// ---------------------------------------------------------------------------
// Sign-out implementation
// ---------------------------------------------------------------------------

export async function performSignOut(
  mode: SignOutMode,
  accountStore: AccountStore,
  keychainStore: KeychainStore,
  stores?: AppLocalStores,
): Promise<SignOutResult> {
  mainLogger.info('SignOutController.performSignOut.start', {
    mode,
    hasStores: !!stores,
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
    const sessionCleared = await clearSyncedData();
    const localCleared = clearLocalStores(stores, result.errors);
    result.dataCleared = sessionCleared && localCleared;
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

  // Mark sync as disabled in account data while keeping the Google association
  const updated = { ...account, sync_enabled: false } as typeof account & { sync_enabled: boolean };
  accountStore.save(updated);

  mainLogger.info('SignOutController.turnOffSync.complete', {
    email: account.email,
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

/**
 * Wipe app-local copies of synced data (bookmarks, history, saved
 * passwords, autofill). Returns true iff every provided store was cleared
 * without throwing. Missing stores are silently skipped so the controller
 * stays usable from backward-compatible call sites and unit tests.
 *
 * Implementation fixes Issue #216: before this, signing out with
 * "Clear data" only wiped Electron session caches, leaving bookmarks.json /
 * history.json / passwords.json / autofill.json on disk.
 */
function clearLocalStores(stores: AppLocalStores | undefined, errors: string[]): boolean {
  if (!stores) {
    mainLogger.info('SignOutController.clearLocalStores.skipped', {
      msg: 'No app-local stores provided',
    });
    return true;
  }

  let allOk = true;

  const attempts: Array<[keyof AppLocalStores, string, () => void]> = [
    ['bookmarkStore',  'bookmarks',  () => stores.bookmarkStore?.deleteAll()],
    ['historyStore',   'history',    () => stores.historyStore?.clearAll()],
    ['passwordStore',  'passwords',  () => stores.passwordStore?.deleteAllPasswords()],
    ['autofillStore',  'autofill',   () => stores.autofillStore?.deleteAll()],
  ];

  for (const [key, label, fn] of attempts) {
    if (!stores[key]) continue;
    try {
      fn();
      mainLogger.info('SignOutController.clearLocalStores.ok', { store: label });
    } catch (err) {
      allOk = false;
      const msg = `${label}: ${(err as Error).message}`;
      errors.push(msg);
      mainLogger.error('SignOutController.clearLocalStores.failed', {
        store: label,
        error: (err as Error).message,
      });
    }
  }

  mainLogger.info('SignOutController.clearLocalStores.complete', { allOk });
  return allOk;
}

async function clearSyncedData(): Promise<boolean> {
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
