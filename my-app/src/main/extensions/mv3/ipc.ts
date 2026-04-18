/**
 * mv3/ipc.ts — IPC handlers for Manifest V3 runtime queries.
 *
 * Exposes MV3 subsystem state (service workers, DNR rules, action API,
 * validation, activeTab) via ipcMain.handle channels namespaced under 'mv3:'.
 */

import { ipcMain } from 'electron';
import { mainLogger } from '../../logger';
import { assertString } from '../../ipc-validators';
import type { ExtensionManager } from '../ExtensionManager';
import type { DnrRule } from './DeclarativeNetRequestEngine';

// ---------------------------------------------------------------------------
// Channel constants
// ---------------------------------------------------------------------------

const CH_GET_INFO           = 'mv3:get-info';
const CH_LIST_MV3           = 'mv3:list';
const CH_VALIDATE           = 'mv3:validate';
const CH_WORKER_STATE       = 'mv3:worker-state';
const CH_WORKER_WAKE        = 'mv3:worker-wake';
const CH_WORKER_STOP        = 'mv3:worker-stop';
const CH_ACTION_STATE       = 'mv3:action-state';
const CH_ACTION_SET_BADGE   = 'mv3:action-set-badge';
const CH_ACTION_SET_TITLE   = 'mv3:action-set-title';
const CH_ACTION_SET_POPUP   = 'mv3:action-set-popup';
const CH_DNR_GET_RULES      = 'mv3:dnr-get-rules';
const CH_DNR_UPDATE_DYNAMIC = 'mv3:dnr-update-dynamic';
const CH_DNR_UPDATE_SESSION = 'mv3:dnr-update-session';
const CH_ACTIVE_TAB_GRANT   = 'mv3:active-tab-grant';
const CH_ACTIVE_TAB_CHECK   = 'mv3:active-tab-check';
const CH_ACTIVE_TAB_REVOKE  = 'mv3:active-tab-revoke';

const LOG_PREFIX = 'mv3.ipc';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _manager: ExtensionManager | null = null;

function runtime() {
  if (!_manager) throw new Error('ExtensionManager not initialised for MV3 IPC');
  return _manager.mv3Runtime;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetInfo(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.getInfo`, { extensionId: id });
  return runtime().getExtensionInfo(id);
}

function handleListMV3() {
  mainLogger.info(`${LOG_PREFIX}.list`);
  return runtime().getAllMV3Extensions();
}

function handleValidate(
  _event: Electron.IpcMainInvokeEvent,
  extensionPath: string,
) {
  const validPath = assertString(extensionPath, 'extensionPath', 1024);
  mainLogger.info(`${LOG_PREFIX}.validate`, { extensionPath: validPath });
  return runtime().validator.validateManifest(validPath);
}

function handleWorkerState(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.workerState`, { extensionId: id });
  return {
    state: runtime().serviceWorkers.getWorkerState(id),
    info: runtime().serviceWorkers.getWorkerInfo(id),
  };
}

async function handleWorkerWake(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.workerWake`, { extensionId: id });
  await runtime().serviceWorkers.startWorker(id);
  return runtime().serviceWorkers.getWorkerState(id);
}

function handleWorkerStop(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.workerStop`, { extensionId: id });
  runtime().serviceWorkers.stopWorker(id);
  return runtime().serviceWorkers.getWorkerState(id);
}

function handleActionState(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  tabId?: number,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.actionState`, { extensionId: id, tabId });
  return runtime().actionApi.getState(id, tabId);
}

function handleActionSetBadge(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  text: string,
  tabId?: number,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.actionSetBadge`, { extensionId: id, text, tabId });
  runtime().actionApi.setBadgeText(id, text, tabId);
}

function handleActionSetTitle(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  title: string,
  tabId?: number,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.actionSetTitle`, { extensionId: id, title, tabId });
  runtime().actionApi.setTitle(id, title, tabId);
}

function handleActionSetPopup(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  popup: string,
  tabId?: number,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.actionSetPopup`, { extensionId: id, popup, tabId });
  runtime().actionApi.setPopup(id, popup, tabId);
}

function handleDnrGetRules(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  source: 'dynamic' | 'session',
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.dnrGetRules`, { extensionId: id, source });

  if (source === 'session') {
    return runtime().dnr.getSessionRules(id);
  }
  return runtime().dnr.getDynamicRules(id);
}

function handleDnrUpdateDynamic(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  addRules: DnrRule[],
  removeRuleIds: number[],
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.dnrUpdateDynamic`, {
    extensionId: id,
    addCount: addRules?.length ?? 0,
    removeCount: removeRuleIds?.length ?? 0,
  });
  runtime().dnr.updateDynamicRules(id, addRules ?? [], removeRuleIds ?? []);
}

function handleDnrUpdateSession(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  addRules: DnrRule[],
  removeRuleIds: number[],
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.dnrUpdateSession`, {
    extensionId: id,
    addCount: addRules?.length ?? 0,
    removeCount: removeRuleIds?.length ?? 0,
  });
  runtime().dnr.updateSessionRules(id, addRules ?? [], removeRuleIds ?? []);
}

function handleActiveTabGrant(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  tabId: number,
  url: string,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.activeTabGrant`, { extensionId: id, tabId, url: url?.slice(0, 80) });
  runtime().grantActiveTab(id, tabId, url);
}

function handleActiveTabCheck(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  tabId: number,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.activeTabCheck`, { extensionId: id, tabId });
  return runtime().hasActiveTabAccess(id, tabId);
}

function handleActiveTabRevoke(
  _event: Electron.IpcMainInvokeEvent,
  extensionId: string,
  tabId?: number,
) {
  const id = assertString(extensionId, 'extensionId', 200);
  mainLogger.info(`${LOG_PREFIX}.activeTabRevoke`, { extensionId: id, tabId });
  runtime().revokeActiveTab(id, tabId);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMV3Handlers(manager: ExtensionManager): void {
  mainLogger.info(`${LOG_PREFIX}.register`);
  _manager = manager;

  ipcMain.handle(CH_GET_INFO, handleGetInfo);
  ipcMain.handle(CH_LIST_MV3, handleListMV3);
  ipcMain.handle(CH_VALIDATE, handleValidate);
  ipcMain.handle(CH_WORKER_STATE, handleWorkerState);
  ipcMain.handle(CH_WORKER_WAKE, handleWorkerWake);
  ipcMain.handle(CH_WORKER_STOP, handleWorkerStop);
  ipcMain.handle(CH_ACTION_STATE, handleActionState);
  ipcMain.handle(CH_ACTION_SET_BADGE, handleActionSetBadge);
  ipcMain.handle(CH_ACTION_SET_TITLE, handleActionSetTitle);
  ipcMain.handle(CH_ACTION_SET_POPUP, handleActionSetPopup);
  ipcMain.handle(CH_DNR_GET_RULES, handleDnrGetRules);
  ipcMain.handle(CH_DNR_UPDATE_DYNAMIC, handleDnrUpdateDynamic);
  ipcMain.handle(CH_DNR_UPDATE_SESSION, handleDnrUpdateSession);
  ipcMain.handle(CH_ACTIVE_TAB_GRANT, handleActiveTabGrant);
  ipcMain.handle(CH_ACTIVE_TAB_CHECK, handleActiveTabCheck);
  ipcMain.handle(CH_ACTIVE_TAB_REVOKE, handleActiveTabRevoke);

  mainLogger.info(`${LOG_PREFIX}.register.ok`, { channelCount: 16 });
}

export function unregisterMV3Handlers(): void {
  mainLogger.info(`${LOG_PREFIX}.unregister`);

  ipcMain.removeHandler(CH_GET_INFO);
  ipcMain.removeHandler(CH_LIST_MV3);
  ipcMain.removeHandler(CH_VALIDATE);
  ipcMain.removeHandler(CH_WORKER_STATE);
  ipcMain.removeHandler(CH_WORKER_WAKE);
  ipcMain.removeHandler(CH_WORKER_STOP);
  ipcMain.removeHandler(CH_ACTION_STATE);
  ipcMain.removeHandler(CH_ACTION_SET_BADGE);
  ipcMain.removeHandler(CH_ACTION_SET_TITLE);
  ipcMain.removeHandler(CH_ACTION_SET_POPUP);
  ipcMain.removeHandler(CH_DNR_GET_RULES);
  ipcMain.removeHandler(CH_DNR_UPDATE_DYNAMIC);
  ipcMain.removeHandler(CH_DNR_UPDATE_SESSION);
  ipcMain.removeHandler(CH_ACTIVE_TAB_GRANT);
  ipcMain.removeHandler(CH_ACTIVE_TAB_CHECK);
  ipcMain.removeHandler(CH_ACTIVE_TAB_REVOKE);

  _manager = null;
  mainLogger.info(`${LOG_PREFIX}.unregister.ok`);
}
