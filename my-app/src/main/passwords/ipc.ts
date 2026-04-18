/**
 * passwords/ipc.ts — IPC handlers for password management.
 *
 * Registers all passwords: channels via ipcMain.handle.
 * Call registerPasswordHandlers() once after app.whenReady().
 *
 * Security invariants:
 *   - Plaintext passwords are NEVER logged.
 *   - revealPassword returns decrypted password only on explicit request.
 */

import { ipcMain } from 'electron';
import { mainLogger } from '../logger';
import { assertString } from '../ipc-validators';
import type { PasswordStore } from './PasswordStore';
import { requireBiometric } from './BiometricAuth';
import { runPasswordCheckup } from './PasswordCheckup';
import type { CheckupFlag } from './PasswordCheckup';

// IPC channels
const CH_SAVE        = 'passwords:save';
const CH_LIST        = 'passwords:list';
const CH_REVEAL      = 'passwords:reveal';
const CH_UPDATE      = 'passwords:update';
const CH_DELETE      = 'passwords:delete';
const CH_FIND        = 'passwords:find-for-origin';
const CH_NEVER_SAVE  = 'passwords:add-never-save';
const CH_REMOVE_NEVER = 'passwords:remove-never-save';
const CH_LIST_NEVER  = 'passwords:list-never-save';
const CH_IS_NEVER    = 'passwords:is-never-save';
const CH_DELETE_ALL  = 'passwords:delete-all';
const CH_AUTOFILL    = 'passwords:autofill';
const CH_CHECKUP     = 'passwords:checkup';

let _store: PasswordStore | null = null;

export interface RegisterPasswordHandlersOptions {
  store: PasswordStore;
}

export function registerPasswordHandlers(opts: RegisterPasswordHandlersOptions): void {
  mainLogger.info('passwords.ipc.register');
  _store = opts.store;

  ipcMain.handle(CH_SAVE, (_e, payload: { origin: string; username: string; password: string }) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const origin = assertString(payload?.origin, 'origin', 2048);
    const username = assertString(payload?.username, 'username', 500);
    const password = assertString(payload?.password, 'password', 10000);
    mainLogger.info(CH_SAVE, { origin, usernameLength: username.length });
    const cred = _store.saveCredential(origin, username, password);
    const { passwordEncrypted, ...safe } = cred;
    return safe;
  });

  ipcMain.handle(CH_LIST, () => {
    if (!_store) throw new Error('PasswordStore not initialised');
    mainLogger.info(CH_LIST);
    return _store.listCredentials();
  });

  ipcMain.handle(CH_REVEAL, async (_e, id: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validId = assertString(id, 'id', 100);
    mainLogger.info(CH_REVEAL, { id: validId });
    await requireBiometric('reveal a saved password');
    return _store.revealPassword(validId);
  });

  ipcMain.handle(CH_UPDATE, async (_e, payload: { id: string; username?: string; password?: string }) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const id = assertString(payload?.id, 'id', 100);
    const updates: { username?: string; password?: string } = {};
    if (payload.username !== undefined) {
      updates.username = assertString(payload.username, 'username', 500);
    }
    if (payload.password !== undefined) {
      updates.password = assertString(payload.password, 'password', 10000);
    }
    mainLogger.info(CH_UPDATE, { id, hasUsername: !!updates.username, hasPassword: !!updates.password });
    await requireBiometric('edit a saved password');
    return _store.updateCredential(id, updates);
  });

  ipcMain.handle(CH_DELETE, (_e, id: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validId = assertString(id, 'id', 100);
    mainLogger.info(CH_DELETE, { id: validId });
    return _store.deleteCredential(validId);
  });

  ipcMain.handle(CH_FIND, (_e, origin: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validOrigin = assertString(origin, 'origin', 2048);
    mainLogger.info(CH_FIND, { origin: validOrigin });
    return _store.findCredentialsForOrigin(validOrigin);
  });

  ipcMain.handle(CH_NEVER_SAVE, (_e, origin: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validOrigin = assertString(origin, 'origin', 2048);
    mainLogger.info(CH_NEVER_SAVE, { origin: validOrigin });
    _store.addNeverSave(validOrigin);
  });

  ipcMain.handle(CH_REMOVE_NEVER, (_e, origin: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validOrigin = assertString(origin, 'origin', 2048);
    mainLogger.info(CH_REMOVE_NEVER, { origin: validOrigin });
    _store.removeNeverSave(validOrigin);
  });

  ipcMain.handle(CH_LIST_NEVER, () => {
    if (!_store) throw new Error('PasswordStore not initialised');
    mainLogger.info(CH_LIST_NEVER);
    return _store.listNeverSave();
  });

  ipcMain.handle(CH_IS_NEVER, (_e, origin: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validOrigin = assertString(origin, 'origin', 2048);
    return _store.isNeverSave(validOrigin);
  });

  ipcMain.handle(CH_DELETE_ALL, () => {
    if (!_store) throw new Error('PasswordStore not initialised');
    mainLogger.info(CH_DELETE_ALL);
    _store.deleteAllPasswords();
  });


  ipcMain.handle(CH_AUTOFILL, async (_e, id: string) => {
    if (!_store) throw new Error('PasswordStore not initialised');
    const validId = assertString(id, 'id', 100);
    mainLogger.info(CH_AUTOFILL, { id: validId });
    await requireBiometric('fill a password into a form');
    return _store.revealPassword(validId);
  });

  ipcMain.handle(CH_CHECKUP, async (): Promise<Array<{ id: string; flags: CheckupFlag[]; breachCount: number }>> => {
    if (!_store) throw new Error('PasswordStore not initialised');
    mainLogger.info(CH_CHECKUP, { msg: 'Starting password checkup' });
    await requireBiometric('check passwords for breaches');
    const allPasswords = _store.revealAllPasswords();
    mainLogger.info(CH_CHECKUP, { credentialCount: allPasswords.length });
    const inputs = allPasswords.map((p) => ({
      id: p.id,
      plaintext: p.plaintext,
      origin: p.origin,
      username: p.username,
    }));
    const results = await runPasswordCheckup(inputs);
    mainLogger.info(CH_CHECKUP, {
      msg: 'Password checkup complete',
      resultCount: results.length,
    });
    return results;
  });

  mainLogger.info('passwords.ipc.register.ok', { channelCount: 13 });
}

export function unregisterPasswordHandlers(): void {
  mainLogger.info('passwords.ipc.unregister');
  ipcMain.removeHandler(CH_SAVE);
  ipcMain.removeHandler(CH_LIST);
  ipcMain.removeHandler(CH_REVEAL);
  ipcMain.removeHandler(CH_UPDATE);
  ipcMain.removeHandler(CH_DELETE);
  ipcMain.removeHandler(CH_FIND);
  ipcMain.removeHandler(CH_NEVER_SAVE);
  ipcMain.removeHandler(CH_REMOVE_NEVER);
  ipcMain.removeHandler(CH_LIST_NEVER);
  ipcMain.removeHandler(CH_IS_NEVER);
  ipcMain.removeHandler(CH_DELETE_ALL);
  ipcMain.removeHandler(CH_AUTOFILL);
  ipcMain.removeHandler(CH_CHECKUP);
  _store = null;
  mainLogger.info('passwords.ipc.unregister.ok');
}
