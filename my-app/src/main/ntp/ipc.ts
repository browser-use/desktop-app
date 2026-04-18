/**
 * ntp/ipc.ts — IPC handlers for NTP customization.
 * Mirrors the register/unregister pattern used by settings/ipc.ts.
 */

import { ipcMain } from 'electron';
import { mainLogger } from '../logger';
import { assertString } from '../ipc-validators';
import type { NtpCustomizationStore, NtpCustomization, NtpShortcut } from './NtpCustomizationStore';

// ---------------------------------------------------------------------------
// Channel constants
// ---------------------------------------------------------------------------

const CH_GET          = 'ntp:get-customization';
const CH_SET          = 'ntp:set-customization';
const CH_RESET        = 'ntp:reset-customization';
const CH_ADD_SHORTCUT = 'ntp:add-shortcut';
const CH_EDIT_SHORTCUT = 'ntp:edit-shortcut';
const CH_DELETE_SHORTCUT = 'ntp:delete-shortcut';
const CH_PICK_IMAGE   = 'ntp:pick-background-image';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _store: NtpCustomizationStore | null = null;
let _notifyShell: ((data: NtpCustomization) => void) | null = null;
let _notifyNewTab: ((data: NtpCustomization) => void) | null = null;

function getStore(): NtpCustomizationStore {
  if (!_store) throw new Error('NtpCustomizationStore not initialised');
  return _store;
}

function broadcastUpdate(data: NtpCustomization): void {
  if (_notifyShell) _notifyShell(data);
  if (_notifyNewTab) _notifyNewTab(data);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGet(): NtpCustomization {
  mainLogger.info(CH_GET);
  return getStore().load();
}

function handleSet(
  _event: Electron.IpcMainInvokeEvent,
  patch: Partial<NtpCustomization>,
): NtpCustomization {
  mainLogger.info(CH_SET, { keys: Object.keys(patch) });
  const result = getStore().save(patch);
  broadcastUpdate(result);
  return result;
}

function handleReset(): NtpCustomization {
  mainLogger.info(CH_RESET);
  const result = getStore().reset();
  broadcastUpdate(result);
  return result;
}

function handleAddShortcut(
  _event: Electron.IpcMainInvokeEvent,
  shortcut: { name: string; url: string },
): NtpCustomization {
  const name = assertString(shortcut?.name ?? '', 'name', 200);
  const url = assertString(shortcut?.url ?? '', 'url', 2000);
  mainLogger.info(CH_ADD_SHORTCUT, { name, url });

  const store = getStore();
  const current = store.load();
  const id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const newShortcut: NtpShortcut = { id, name, url };
  const result = store.save({
    customShortcuts: [...current.customShortcuts, newShortcut],
  });
  broadcastUpdate(result);
  return result;
}

function handleEditShortcut(
  _event: Electron.IpcMainInvokeEvent,
  payload: { id: string; name: string; url: string },
): NtpCustomization {
  const id = assertString(payload?.id ?? '', 'id', 100);
  const name = assertString(payload?.name ?? '', 'name', 200);
  const url = assertString(payload?.url ?? '', 'url', 2000);
  mainLogger.info(CH_EDIT_SHORTCUT, { id, name });

  const store = getStore();
  const current = store.load();
  const result = store.save({
    customShortcuts: current.customShortcuts.map((s) =>
      s.id === id ? { ...s, name, url } : s,
    ),
  });
  broadcastUpdate(result);
  return result;
}

function handleDeleteShortcut(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
): NtpCustomization {
  const validId = assertString(id, 'id', 100);
  mainLogger.info(CH_DELETE_SHORTCUT, { id: validId });

  const store = getStore();
  const current = store.load();
  const result = store.save({
    customShortcuts: current.customShortcuts.filter((s) => s.id !== validId),
  });
  broadcastUpdate(result);
  return result;
}

async function handlePickImage(): Promise<string | null> {
  mainLogger.info(CH_PICK_IMAGE);

  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog({
    title: 'Choose background image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    mainLogger.info(`${CH_PICK_IMAGE}.canceled`);
    return null;
  }

  const filePath = result.filePaths[0];
  mainLogger.info(`${CH_PICK_IMAGE}.selected`, { filePath });

  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const ext = pathMod.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  const mime = mimeMap[ext] ?? 'image/png';

  const buffer = fs.readFileSync(filePath);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  mainLogger.info(`${CH_PICK_IMAGE}.ok`, { sizeBytes: buffer.length });
  return dataUrl;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RegisterNtpHandlersOptions {
  store: NtpCustomizationStore;
  notifyShell?: (data: NtpCustomization) => void;
  notifyNewTab?: (data: NtpCustomization) => void;
}

export function registerNtpHandlers(opts: RegisterNtpHandlersOptions): void {
  mainLogger.info('ntp.ipc.register');
  _store = opts.store;
  _notifyShell = opts.notifyShell ?? null;
  _notifyNewTab = opts.notifyNewTab ?? null;

  ipcMain.handle(CH_GET, handleGet);
  ipcMain.handle(CH_SET, handleSet);
  ipcMain.handle(CH_RESET, handleReset);
  ipcMain.handle(CH_ADD_SHORTCUT, handleAddShortcut);
  ipcMain.handle(CH_EDIT_SHORTCUT, handleEditShortcut);
  ipcMain.handle(CH_DELETE_SHORTCUT, handleDeleteShortcut);
  ipcMain.handle(CH_PICK_IMAGE, handlePickImage);

  mainLogger.info('ntp.ipc.register.ok', { channelCount: 7 });
}

export function unregisterNtpHandlers(): void {
  mainLogger.info('ntp.ipc.unregister');

  ipcMain.removeHandler(CH_GET);
  ipcMain.removeHandler(CH_SET);
  ipcMain.removeHandler(CH_RESET);
  ipcMain.removeHandler(CH_ADD_SHORTCUT);
  ipcMain.removeHandler(CH_EDIT_SHORTCUT);
  ipcMain.removeHandler(CH_DELETE_SHORTCUT);
  ipcMain.removeHandler(CH_PICK_IMAGE);

  _store = null;
  _notifyShell = null;
  _notifyNewTab = null;

  mainLogger.info('ntp.ipc.unregister.ok');
}
