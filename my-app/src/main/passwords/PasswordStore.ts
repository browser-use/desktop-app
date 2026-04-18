/**
 * PasswordStore — encrypted credential storage.
 *
 * Stores saved website credentials in userData/passwords.json, encrypted
 * via Electron's safeStorage API. Each entry contains origin, username,
 * and an encrypted password buffer (base64-encoded).
 *
 * Also maintains a "never save" list of origins the user has opted out of.
 *
 * Follows the BookmarkStore pattern: debounced atomic writes, in-memory state.
 */

import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
// eslint-disable-next-line import/no-unresolved
import { v4 as uuidv4 } from 'uuid';
import { mainLogger } from '../logger';

const PASSWORDS_FILE_NAME = 'passwords.json';
const DEBOUNCE_MS = 300;

export interface SavedCredential {
  id: string;
  origin: string;
  username: string;
  passwordEncrypted: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedPasswords {
  version: 1;
  credentials: SavedCredential[];
  neverSaveOrigins: string[];
}

function makeEmpty(): PersistedPasswords {
  return {
    version: 1,
    credentials: [],
    neverSaveOrigins: [],
  };
}

function getPasswordsPath(): string {
  return path.join(app.getPath('userData'), PASSWORDS_FILE_NAME);
}

export class PasswordStore {
  private state: PersistedPasswords;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.state = this.load();
    mainLogger.info('PasswordStore.init', {
      credentialCount: this.state.credentials.length,
      neverSaveCount: this.state.neverSaveOrigins.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): PersistedPasswords {
    try {
      const raw = fs.readFileSync(getPasswordsPath(), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedPasswords;
      if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) {
        mainLogger.warn('PasswordStore.load.invalid', { msg: 'Resetting passwords store' });
        return makeEmpty();
      }
      mainLogger.info('PasswordStore.load.ok', {
        credentialCount: parsed.credentials.length,
        neverSaveCount: parsed.neverSaveOrigins?.length ?? 0,
      });
      return parsed;
    } catch {
      mainLogger.info('PasswordStore.load.fresh', { msg: 'No passwords.json — starting fresh' });
      return makeEmpty();
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushSync(), DEBOUNCE_MS);
  }

  flushSync(): void {
    if (!this.dirty) return;
    try {
      fs.writeFileSync(
        getPasswordsPath(),
        JSON.stringify(this.state, null, 2),
        'utf-8',
      );
      mainLogger.info('PasswordStore.flushSync.ok');
    } catch (err) {
      mainLogger.error('PasswordStore.flushSync.failed', {
        error: (err as Error).message,
      });
    }
    this.dirty = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Encryption helpers
  // ---------------------------------------------------------------------------

  private encryptPassword(plaintext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      mainLogger.warn('PasswordStore.encryptPassword.unavailable', {
        msg: 'safeStorage encryption not available, storing base64 only',
      });
      return Buffer.from(plaintext, 'utf-8').toString('base64');
    }
    const encrypted = safeStorage.encryptString(plaintext);
    return encrypted.toString('base64');
  }

  private decryptPassword(encrypted: string): string {
    const buf = Buffer.from(encrypted, 'base64');
    if (!safeStorage.isEncryptionAvailable()) {
      mainLogger.warn('PasswordStore.decryptPassword.unavailable', {
        msg: 'safeStorage encryption not available, reading base64 only',
      });
      return buf.toString('utf-8');
    }
    try {
      return safeStorage.decryptString(buf);
    } catch (err) {
      mainLogger.error('PasswordStore.decryptPassword.failed', {
        error: (err as Error).message,
      });
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Credential CRUD
  // ---------------------------------------------------------------------------

  saveCredential(origin: string, username: string, password: string): SavedCredential {
    const existing = this.state.credentials.find(
      (c) => c.origin === origin && c.username === username,
    );

    if (existing) {
      existing.passwordEncrypted = this.encryptPassword(password);
      existing.updatedAt = Date.now();
      this.schedulePersist();
      mainLogger.info('PasswordStore.saveCredential.updated', {
        id: existing.id,
        origin,
        username,
      });
      return existing;
    }

    const now = Date.now();
    const cred: SavedCredential = {
      id: uuidv4(),
      origin,
      username,
      passwordEncrypted: this.encryptPassword(password),
      createdAt: now,
      updatedAt: now,
    };
    this.state.credentials.push(cred);
    this.schedulePersist();
    mainLogger.info('PasswordStore.saveCredential.created', {
      id: cred.id,
      origin,
      username,
    });
    return cred;
  }

  listCredentials(): Array<Omit<SavedCredential, 'passwordEncrypted'>> {
    return this.state.credentials.map(({ passwordEncrypted, ...rest }) => rest);
  }

  getCredential(id: string): SavedCredential | null {
    return this.state.credentials.find((c) => c.id === id) ?? null;
  }

  revealPassword(id: string): string | null {
    const cred = this.state.credentials.find((c) => c.id === id);
    if (!cred) {
      mainLogger.warn('PasswordStore.revealPassword.notFound', { id });
      return null;
    }
    mainLogger.info('PasswordStore.revealPassword', { id, origin: cred.origin });
    return this.decryptPassword(cred.passwordEncrypted);
  }

  updateCredential(id: string, updates: { username?: string; password?: string }): boolean {
    const cred = this.state.credentials.find((c) => c.id === id);
    if (!cred) {
      mainLogger.warn('PasswordStore.updateCredential.notFound', { id });
      return false;
    }
    if (updates.username !== undefined) {
      cred.username = updates.username;
    }
    if (updates.password !== undefined) {
      cred.passwordEncrypted = this.encryptPassword(updates.password);
    }
    cred.updatedAt = Date.now();
    this.schedulePersist();
    mainLogger.info('PasswordStore.updateCredential.ok', { id, origin: cred.origin });
    return true;
  }

  deleteCredential(id: string): boolean {
    const idx = this.state.credentials.findIndex((c) => c.id === id);
    if (idx === -1) {
      mainLogger.warn('PasswordStore.deleteCredential.notFound', { id });
      return false;
    }
    const removed = this.state.credentials.splice(idx, 1)[0];
    this.schedulePersist();
    mainLogger.info('PasswordStore.deleteCredential.ok', { id, origin: removed.origin });
    return true;
  }

  findCredentialsForOrigin(origin: string): Array<Omit<SavedCredential, 'passwordEncrypted'>> {
    return this.state.credentials
      .filter((c) => c.origin === origin)
      .map(({ passwordEncrypted, ...rest }) => rest);
  }

  // ---------------------------------------------------------------------------
  // "Never save" list
  // ---------------------------------------------------------------------------

  isNeverSave(origin: string): boolean {
    return this.state.neverSaveOrigins.includes(origin);
  }

  addNeverSave(origin: string): void {
    if (this.state.neverSaveOrigins.includes(origin)) return;
    this.state.neverSaveOrigins.push(origin);
    this.schedulePersist();
    mainLogger.info('PasswordStore.addNeverSave', { origin });
  }

  removeNeverSave(origin: string): void {
    const idx = this.state.neverSaveOrigins.indexOf(origin);
    if (idx === -1) return;
    this.state.neverSaveOrigins.splice(idx, 1);
    this.schedulePersist();
    mainLogger.info('PasswordStore.removeNeverSave', { origin });
  }

  listNeverSave(): string[] {
    return [...this.state.neverSaveOrigins];
  }

  // ---------------------------------------------------------------------------
  // Batch reveal (for checkup)
  // ---------------------------------------------------------------------------

  revealAllPasswords(): Array<{ id: string; origin: string; username: string; plaintext: string }> {
    mainLogger.info('PasswordStore.revealAllPasswords', {
      credentialCount: this.state.credentials.length,
    });
    return this.state.credentials.map((c) => ({
      id: c.id,
      origin: c.origin,
      username: c.username,
      plaintext: this.decryptPassword(c.passwordEncrypted),
    }));
  }

  deleteAllPasswords(): void {
    this.state.credentials = [];
    this.state.neverSaveOrigins = [];
    this.schedulePersist();
    mainLogger.info('PasswordStore.deleteAllPasswords');
  }
}
