/**
 * ClearDataController — narrow clears for "Clear browsing data" dialog.
 *
 * IMPORTANT: each DataType maps to its OWN Electron API. We DO NOT funnel
 * all checkboxes into one blanket `session.clearStorageData({ storages: [...] })`
 * call — that would cause checking "history" alone to also wipe cookies and
 * cache. Each clear is independent; failures are captured per-type.
 *
 * Issue #200 fix: `passwords` and `downloads` used to be no-ops despite
 * being exposed as working checkboxes. They now delete app-local stores:
 *   - passwords → `PasswordStore.deleteAllPasswords()` + `session.clearAuthCache`
 *   - downloads → `DownloadManager.clearAll()` (history list only — the
 *                  downloaded files on disk are not touched)
 *
 * The `hostedApp` checkbox used to map to a silent no-op. It has been
 * removed from the renderer AND from the public DataType union so no
 * caller can request it and get a false-positive "cleared" receipt.
 */

import { session } from 'electron';
import { mainLogger } from '../logger';
import { clearAutofillData } from '../autofill/ipc';
import type { PasswordStore } from '../passwords/PasswordStore';
import type { DownloadManager } from '../downloads/DownloadManager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DATA_TYPES = [
  'history',
  'cookies',
  'cache',
  'downloads',
  'passwords',
  'autofill',
  'siteSettings',
] as const;

export type DataType = typeof DATA_TYPES[number];

export interface ClearDataRequest {
  types: DataType[];
  /**
   * Milliseconds in the past to clear from. 0 = all time (no startTime filter).
   * Only honoured by APIs that accept `startTime` (clearStorageData).
   * clearCache / clearHistory / clearAuthCache ignore the range and always
   * clear everything — this is an Electron API limitation.
   */
  timeRangeMs: number;
  /** Optional stores injected by the caller (main process). */
  passwordStore?: PasswordStore;
  downloadManager?: DownloadManager;
}

export interface ClearDataResult {
  cleared: DataType[];
  errors: Partial<Record<DataType, string>>;
  notes: Partial<Record<DataType, string>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SITE_SETTINGS_STORAGES = ['indexdb', 'localstorage', 'websql', 'serviceworkers'] as const;
const CACHE_STORAGES         = ['cachestorage', 'shadercache'] as const;
const COOKIE_STORAGES        = ['cookies'] as const;

const NOTE_RANGE_IGNORED_CACHE     = 'time range ignored — clearCache wipes all cache';
const NOTE_RANGE_IGNORED_HISTORY   = 'time range ignored — clearHistory wipes all history';
const NOTE_RANGE_IGNORED_PASSWORDS = 'time range ignored — auth + saved passwords wiped wholesale';
const NOTE_FILES_KEPT_DOWNLOADS    = 'download history cleared; downloaded files on disk are kept';

// ---------------------------------------------------------------------------
// Store dependencies — injected by main/index.ts at app.whenReady() time.
//
// These are module-level rather than passed to `clearBrowsingData()` because
// the existing settings IPC handler already sits between the renderer and the
// controller; threading the stores through every call site would churn more
// surface than the bug warrants. Tests call `setPrivacyStoreDeps(...)`
// directly to inject stubs.
// ---------------------------------------------------------------------------

interface PrivacyStoreDeps {
  passwordStore:   PasswordStore    | null;
  downloadManager: DownloadManager  | null;
}

let _deps: PrivacyStoreDeps = {
  passwordStore:   null,
  downloadManager: null,
};

export function setPrivacyStoreDeps(deps: Partial<PrivacyStoreDeps>): void {
  _deps = { ..._deps, ...deps };
  mainLogger.info('privacy.setPrivacyStoreDeps', {
    hasPasswordStore:   !!_deps.passwordStore,
    hasDownloadManager: !!_deps.downloadManager,
  });
}

// ---------------------------------------------------------------------------
// Per-type clear implementations
// ---------------------------------------------------------------------------

async function clearHistory(): Promise<{ note?: string }> {
  // Session.clearHistory is available at runtime on Electron 30+ but the
  // TypeScript surface bundled with @types/electron in this repo doesn't
  // declare it yet. Cast through unknown to call it without loosening the
  // type of `session.defaultSession` everywhere.
  await (
    session.defaultSession as unknown as { clearHistory: () => Promise<void> }
  ).clearHistory();
  return { note: NOTE_RANGE_IGNORED_HISTORY };
}

async function clearCookies(startTimeMs?: number): Promise<{ note?: string }> {
  const opts: Electron.ClearStorageDataOptions = {
    storages: [...COOKIE_STORAGES],
  };
  if (startTimeMs !== undefined) {
    (opts as Electron.ClearStorageDataOptions & { startTime?: number }).startTime = startTimeMs;
  }
  await session.defaultSession.clearStorageData(opts);
  return {};
}

async function clearCacheAll(): Promise<{ note?: string }> {
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData({ storages: [...CACHE_STORAGES] });
  return { note: NOTE_RANGE_IGNORED_CACHE };
}

async function clearPasswords(): Promise<{ note?: string }> {
  if (!_deps.passwordStore) {
    // Surface rather than silently succeed — the "Passwords" checkbox must
    // not appear to work if the store is not wired.
    throw new Error('PasswordStore not initialised — cannot clear saved passwords');
  }
  // Delete the on-disk credentials + never-save list, then also flush the
  // browser's cached HTTP auth credentials for origins that used basic /
  // digest auth.
  _deps.passwordStore.deleteAllPasswords();
  await session.defaultSession.clearAuthCache();
  mainLogger.info('privacy.clearPasswords.storeCleared');
  return { note: NOTE_RANGE_IGNORED_PASSWORDS };
}

function clearDownloadHistory(): { note?: string } {
  if (!_deps.downloadManager) {
    throw new Error('DownloadManager not initialised — cannot clear download history');
  }
  // NOTE: this wipes the in-memory download list only. Files already saved
  // to disk are deliberately left alone — Chrome behaves the same way.
  _deps.downloadManager.clearAll();
  return { note: NOTE_FILES_KEPT_DOWNLOADS };
}

async function clearSiteSettings(startTimeMs?: number): Promise<{ note?: string }> {
  const opts: Electron.ClearStorageDataOptions = {
    storages: [...SITE_SETTINGS_STORAGES],
  };
  if (startTimeMs !== undefined) {
    (opts as Electron.ClearStorageDataOptions & { startTime?: number }).startTime = startTimeMs;
  }
  await session.defaultSession.clearStorageData(opts);
  return {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function clearBrowsingData(req: ClearDataRequest): Promise<ClearDataResult> {
  const types = Array.from(new Set(req.types));
  const rangeMs = Math.max(0, req.timeRangeMs | 0);
  const startTimeMs = rangeMs > 0 ? Date.now() - rangeMs : undefined;

  mainLogger.info('privacy.clearBrowsingData.start', {
    types,
    timeRangeMs: rangeMs,
    allTime: startTimeMs === undefined,
  });

  const result: ClearDataResult = { cleared: [], errors: {}, notes: {} };

  for (const type of types) {
    try {
      let outcome: { note?: string };
      switch (type) {
        case 'history':
          outcome = await clearHistory();
          break;
        case 'cookies':
          outcome = await clearCookies(startTimeMs);
          break;
        case 'cache':
          outcome = await clearCacheAll();
          break;
        case 'downloads':
          outcome = clearDownloadHistory();
          break;
        case 'passwords':
          outcome = await clearPasswords();
          break;
        case 'autofill':
          clearAutofillData();
          outcome = {};
          break;
        case 'siteSettings':
          outcome = await clearSiteSettings(startTimeMs);
          break;
        default: {
          const _exhaustive: never = type;
          throw new Error(`unknown DataType: ${String(_exhaustive)}`);
        }
      }
      result.cleared.push(type);
      if (outcome.note) result.notes[type] = outcome.note;
      mainLogger.info('privacy.clearBrowsingData.typeOk', { type, note: outcome.note });
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown error';
      result.errors[type] = msg;
      mainLogger.error('privacy.clearBrowsingData.typeFailed', { type, error: msg });
    }
  }

  mainLogger.info('privacy.clearBrowsingData.done', {
    clearedCount: result.cleared.length,
    errorCount: Object.keys(result.errors).length,
    noteCount: Object.keys(result.notes).length,
  });

  return result;
}
