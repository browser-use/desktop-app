/**
 * AccountStore — persists account + agent metadata to userData/account.json.
 *
 * Write is atomic: data is written to a .tmp file then renamed, so a crash
 * mid-write never produces a corrupt account.json.
 *
 * File location: ${app.getPath('userData')}/account.json
 *
 * Shape: { agent_name, email, created_at, onboarding_completed_at?, sync_enabled? }
 *
 * D2 logging: save/load/isComplete transitions logged at debug level.
 * PII policy: email is logged for debugging; no passwords or tokens.
 */

import fs from 'node:fs';
import path from 'node:path';
import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACCOUNT_FILE_NAME = 'account.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountData {
  agent_name: string;
  email: string;
  /** ISO 8601 — set once on first save, never overwritten */
  created_at?: string;
  /** ISO 8601 — set when the user completes onboarding */
  onboarding_completed_at?: string;
  /**
   * When false, background sync with the user's Google account is disabled.
   * Defaults to true (sync on) if absent, matching Chrome's behaviour.
   * Set to false by SignOutController.turnOffSync().
   * Gate any sync-related behaviour on `getSyncEnabled(account)`.
   */
  sync_enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns whether sync is enabled for the given account.
 *
 * Treats `undefined` as true so that existing accounts that predate the
 * sync_enabled field behave as if sync is on (Chrome parity: sync is on by
 * default once the user signs in).
 *
 * Usage:
 *   const account = accountStore.load();
 *   if (getSyncEnabled(account)) { ... }
 */
export function getSyncEnabled(account: AccountData | null | undefined): boolean {
  return account?.sync_enabled !== false;
}

// ---------------------------------------------------------------------------
// AccountStore
// ---------------------------------------------------------------------------

export class AccountStore {
  private readonly filePath: string;
  private readonly tmpPath: string;

  constructor(userDataPath?: string) {
    const dir = userDataPath ?? (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron') as typeof import('electron');
        return app.getPath('userData');
      } catch {
        return '/tmp/agentic-browser';
      }
    })();

    this.filePath = path.join(dir, ACCOUNT_FILE_NAME);
    this.tmpPath = path.join(dir, `account.tmp.${process.pid}`);

    mainLogger.debug('AccountStore.init', {
      filePath: this.filePath,
    });
  }

  /**
   * Load account data from disk.
   * Returns null if account.json does not exist or cannot be parsed.
   */
  load(): AccountData | null {
    mainLogger.debug('AccountStore.load', { filePath: this.filePath });

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as AccountData;
      mainLogger.debug('AccountStore.load.ok', {
        agentName: data.agent_name,
        email: data.email,
        hasCompletedAt: !!data.onboarding_completed_at,
      });
      return data;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        mainLogger.debug('AccountStore.load.notFound', { filePath: this.filePath });
      } else {
        mainLogger.warn('AccountStore.load.parseError', {
          filePath: this.filePath,
          error: (err as Error).message,
        });
      }
      return null;
    }
  }

  /**
   * Save account data atomically (write to .tmp then rename).
   * Preserves created_at from any existing file if not explicitly provided.
   */
  save(data: AccountData): void {
    mainLogger.debug('AccountStore.save', {
      agentName: data.agent_name,
      email: data.email,
      hasCompletedAt: !!data.onboarding_completed_at,
    });

    // Preserve created_at if not provided
    let created_at = data.created_at;
    if (!created_at) {
      const existing = this.load();
      created_at = existing?.created_at ?? new Date().toISOString();
    }

    const toWrite: AccountData = {
      ...data,
      created_at,
    };

    const serialised = JSON.stringify(toWrite, null, 2);

    try {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Write to tmp file
      fs.writeFileSync(this.tmpPath, serialised, 'utf-8');
      // Atomic rename
      fs.renameSync(this.tmpPath, this.filePath);

      mainLogger.debug('AccountStore.save.ok', {
        agentName: toWrite.agent_name,
        email: toWrite.email,
        filePath: this.filePath,
      });
    } catch (err) {
      mainLogger.error('AccountStore.save.failed', {
        error: (err as Error).message,
        stack: (err as Error).stack,
        filePath: this.filePath,
      });
      throw err;
    }
  }

  /**
   * Returns true if account.json exists and has onboarding_completed_at set.
   * Used by main/index.ts to decide whether to show onboarding or shell.
   */
  isOnboardingComplete(): boolean {
    const data = this.load();
    const complete = !!(data?.onboarding_completed_at);
    mainLogger.debug('AccountStore.isOnboardingComplete', { complete });
    return complete;
  }
}
