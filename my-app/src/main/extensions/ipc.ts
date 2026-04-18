/**
 * extensions/ipc.ts — IPC handlers for the Extensions window.
 *
 * Registers all extensions:* channels via ipcMain.handle / ipcMain.on.
 * Call registerExtensionsHandlers() once after app.whenReady().
 */

import { dialog, ipcMain } from 'electron';
import { mainLogger } from '../logger';
import { assertString, assertOneOf } from '../ipc-validators';
import { ExtensionManager } from './ExtensionManager';
import type { ExtensionRecord, ExtensionCommandEntry } from './ExtensionManager';
import { getExtensionsWindow, openExtensionsWindow } from './ExtensionsWindow';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CH_LIST                = 'extensions:list';
const CH_ENABLE              = 'extensions:enable';
const CH_DISABLE             = 'extensions:disable';
const CH_REMOVE              = 'extensions:remove';
const CH_GET_DETAILS         = 'extensions:get-details';
const CH_LOAD_UNPACKED       = 'extensions:load-unpacked';
const CH_UPDATE              = 'extensions:update';
const CH_SET_HOST_ACCESS     = 'extensions:set-host-access';
const CH_GET_DEV_MODE        = 'extensions:get-dev-mode';
const CH_SET_DEV_MODE        = 'extensions:set-dev-mode';
const CH_PICK_DIRECTORY      = 'extensions:pick-directory';
const CH_CLOSE_WINDOW        = 'extensions:close-window';
const CH_LIST_COMMANDS       = 'extensions:list-commands';
const CH_SET_SHORTCUT        = 'extensions:set-shortcut';

const ALLOWED_HOST_ACCESS = ['all-sites', 'specific-sites', 'on-click'] as const;

// Max shortcut string length — e.g. "Ctrl+Shift+F12"
const MAX_SHORTCUT_LEN = 64;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _manager: ExtensionManager | null = null;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleList(): ExtensionRecord[] {
  mainLogger.info(CH_LIST);
  if (!_manager) throw new Error('ExtensionManager not initialised');
  return _manager.listExtensions();
}

async function handleEnable(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
): Promise<void> {
  const validId = assertString(id, 'id', 200);
  mainLogger.info(CH_ENABLE, { id: validId });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  await _manager.enableExtension(validId);
}

function handleDisable(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
): void {
  const validId = assertString(id, 'id', 200);
  mainLogger.info(CH_DISABLE, { id: validId });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  _manager.disableExtension(validId);
}

function handleRemove(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
): void {
  const validId = assertString(id, 'id', 200);
  mainLogger.info(CH_REMOVE, { id: validId });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  _manager.removeExtension(validId);
}

function handleGetDetails(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
): ExtensionRecord | null {
  const validId = assertString(id, 'id', 200);
  mainLogger.info(CH_GET_DETAILS, { id: validId });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  return _manager.getExtensionDetails(validId);
}

async function handleLoadUnpacked(): Promise<ExtensionRecord | null> {
  mainLogger.info(CH_LOAD_UNPACKED);
  if (!_manager) throw new Error('ExtensionManager not initialised');

  const win = getExtensionsWindow();
  const result = await dialog.showOpenDialog(win ?? ({} as Electron.BrowserWindow), {
    properties: ['openDirectory'],
    title: 'Select extension directory',
  });

  if (result.canceled || result.filePaths.length === 0) {
    mainLogger.info(`${CH_LOAD_UNPACKED}.canceled`);
    return null;
  }

  const extPath = result.filePaths[0];
  mainLogger.info(`${CH_LOAD_UNPACKED}.selected`, { path: extPath });
  return _manager.loadUnpacked(extPath);
}

async function handleUpdate(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
): Promise<void> {
  const validId = assertString(id, 'id', 200);
  mainLogger.info(CH_UPDATE, { id: validId });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  await _manager.updateExtension(validId);
}

function handleSetHostAccess(
  _event: Electron.IpcMainInvokeEvent,
  id: string,
  hostAccess: string,
): void {
  const validId = assertString(id, 'id', 200);
  const validAccess = assertOneOf(hostAccess, 'hostAccess', ALLOWED_HOST_ACCESS);
  mainLogger.info(CH_SET_HOST_ACCESS, { id: validId, hostAccess: validAccess });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  _manager.setHostAccess(validId, validAccess);
}

function handleGetDevMode(): boolean {
  mainLogger.info(CH_GET_DEV_MODE);
  if (!_manager) throw new Error('ExtensionManager not initialised');
  return _manager.getDeveloperMode();
}

function handleSetDevMode(
  _event: Electron.IpcMainInvokeEvent,
  enabled: boolean,
): void {
  mainLogger.info(CH_SET_DEV_MODE, { enabled });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  _manager.setDeveloperMode(!!enabled);
}

async function handlePickDirectory(): Promise<string | null> {
  mainLogger.info(CH_PICK_DIRECTORY);
  const win = getExtensionsWindow();
  const result = await dialog.showOpenDialog(win ?? ({} as Electron.BrowserWindow), {
    properties: ['openDirectory'],
    title: 'Select extension directory',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

function handleCloseWindow(): void {
  mainLogger.info(CH_CLOSE_WINDOW);
  const win = getExtensionsWindow();
  if (win && !win.isDestroyed()) {
    win.close();
  }
}

function handleListCommands(): ExtensionCommandEntry[] {
  mainLogger.info(CH_LIST_COMMANDS);
  if (!_manager) throw new Error('ExtensionManager not initialised');
  return _manager.listAllCommands();
}

function handleSetShortcut(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  commandName: string,
  shortcut: string,
): void {
  const validId = assertString(extensionId, 'extensionId', 200);
  const validCmd = assertString(commandName, 'commandName', 200);
  const validShortcut = assertString(shortcut, 'shortcut', MAX_SHORTCUT_LEN);
  mainLogger.info(CH_SET_SHORTCUT, { extensionId: validId, commandName: validCmd, shortcut: validShortcut });
  if (!_manager) throw new Error('ExtensionManager not initialised');
  _manager.setExtensionShortcut(validId, validCmd, validShortcut);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerExtensionsHandlers(manager: ExtensionManager): void {
  mainLogger.info('extensions.ipc.register');
  _manager = manager;

  ipcMain.handle(CH_LIST, handleList);
  ipcMain.handle(CH_ENABLE, handleEnable);
  ipcMain.handle(CH_DISABLE, handleDisable);
  ipcMain.handle(CH_REMOVE, handleRemove);
  ipcMain.handle(CH_GET_DETAILS, handleGetDetails);
  ipcMain.handle(CH_LOAD_UNPACKED, handleLoadUnpacked);
  ipcMain.handle(CH_UPDATE, handleUpdate);
  ipcMain.handle(CH_SET_HOST_ACCESS, handleSetHostAccess);
  ipcMain.handle(CH_GET_DEV_MODE, handleGetDevMode);
  ipcMain.handle(CH_SET_DEV_MODE, handleSetDevMode);
  ipcMain.handle(CH_PICK_DIRECTORY, handlePickDirectory);
  ipcMain.handle(CH_LIST_COMMANDS, handleListCommands);
  ipcMain.handle(CH_SET_SHORTCUT, handleSetShortcut);
  ipcMain.on(CH_CLOSE_WINDOW, handleCloseWindow);

  mainLogger.info('extensions.ipc.register.ok', { channelCount: 14 });
}

export function unregisterExtensionsHandlers(): void {
  mainLogger.info('extensions.ipc.unregister');

  ipcMain.removeHandler(CH_LIST);
  ipcMain.removeHandler(CH_ENABLE);
  ipcMain.removeHandler(CH_DISABLE);
  ipcMain.removeHandler(CH_REMOVE);
  ipcMain.removeHandler(CH_GET_DETAILS);
  ipcMain.removeHandler(CH_LOAD_UNPACKED);
  ipcMain.removeHandler(CH_UPDATE);
  ipcMain.removeHandler(CH_SET_HOST_ACCESS);
  ipcMain.removeHandler(CH_GET_DEV_MODE);
  ipcMain.removeHandler(CH_SET_DEV_MODE);
  ipcMain.removeHandler(CH_PICK_DIRECTORY);
  ipcMain.removeHandler(CH_LIST_COMMANDS);
  ipcMain.removeHandler(CH_SET_SHORTCUT);
  ipcMain.removeAllListeners(CH_CLOSE_WINDOW);

  _manager = null;
  mainLogger.info('extensions.ipc.unregister.ok');
}
