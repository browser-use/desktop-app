/**
 * Permission IPC handlers — register/unregister pattern matching
 * bookmarks/ipc.ts and settings/ipc.ts.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { mainLogger } from '../logger';
import { PermissionStore, PermissionType, PermissionState } from './PermissionStore';
import { PermissionManager, PermissionDecision } from './PermissionManager';
import { ProtocolHandlerStore } from './ProtocolHandlerStore';

export interface RegisterPermissionHandlersOptions {
  store: PermissionStore;
  manager: PermissionManager;
  getShellWindow: () => BrowserWindow | null;
  protocolHandlerStore?: ProtocolHandlerStore;
}

export function registerPermissionHandlers(opts: RegisterPermissionHandlersOptions): void {
  const { store, manager, protocolHandlerStore } = opts;

  ipcMain.handle('permissions:respond', (_e, promptId: string, decision: string) => {
    mainLogger.info('permissions:respond', { promptId, decision });
    manager.handleDecision(promptId, decision as PermissionDecision);
  });

  ipcMain.handle('permissions:dismiss', (_e, promptId: string) => {
    mainLogger.info('permissions:dismiss', { promptId });
    manager.dismissPrompt(promptId);
  });

  ipcMain.handle('permissions:get-site', (_e, origin: string) => {
    return store.getPermissionsForOrigin(origin);
  });

  ipcMain.handle('permissions:set-site', (_e, origin: string, permissionType: string, state: string) => {
    store.setSitePermission(origin, permissionType as PermissionType, state as PermissionState);
  });

  ipcMain.handle('permissions:remove-site', (_e, origin: string, permissionType: string) => {
    return store.removeSitePermission(origin, permissionType as PermissionType);
  });

  ipcMain.handle('permissions:clear-origin', (_e, origin: string) => {
    store.clearOrigin(origin);
  });

  ipcMain.handle('permissions:get-defaults', () => {
    return store.getDefaults();
  });

  ipcMain.handle('permissions:set-default', (_e, permissionType: string, state: string) => {
    store.setDefault(permissionType as PermissionType, state as PermissionState);
  });

  ipcMain.handle('permissions:get-all', () => {
    return store.getAllRecords();
  });

  ipcMain.handle('permissions:reset-all', () => {
    store.resetAllSitePermissions();
  });

  // Protocol handler management (chrome://settings/handlers parity)
  if (protocolHandlerStore) {
    ipcMain.handle('protocol-handlers:get-all', () => {
      mainLogger.info('protocol-handlers:get-all');
      return protocolHandlerStore.getAll();
    });

    ipcMain.handle('protocol-handlers:get-for-protocol', (_e, protocol: string) => {
      mainLogger.info('protocol-handlers:get-for-protocol', { protocol });
      return protocolHandlerStore.getForProtocol(protocol);
    });

    ipcMain.handle('protocol-handlers:get-for-origin', (_e, origin: string) => {
      mainLogger.info('protocol-handlers:get-for-origin', { origin });
      return protocolHandlerStore.getForOrigin(origin);
    });

    ipcMain.handle('protocol-handlers:register', (_e, protocol: string, origin: string, url: string) => {
      mainLogger.info('protocol-handlers:register', { protocol, origin, url });
      protocolHandlerStore.register(protocol, origin, url);
    });

    ipcMain.handle('protocol-handlers:unregister', (_e, protocol: string, origin: string) => {
      mainLogger.info('protocol-handlers:unregister', { protocol, origin });
      return protocolHandlerStore.unregister(protocol, origin);
    });

    ipcMain.handle('protocol-handlers:clear-all', () => {
      mainLogger.info('protocol-handlers:clear-all');
      protocolHandlerStore.clearAll();
    });
  }

  mainLogger.info('permissions.ipc.registered');
}

export function unregisterPermissionHandlers(): void {
  ipcMain.removeHandler('permissions:respond');
  ipcMain.removeHandler('permissions:dismiss');
  ipcMain.removeHandler('permissions:get-site');
  ipcMain.removeHandler('permissions:set-site');
  ipcMain.removeHandler('permissions:remove-site');
  ipcMain.removeHandler('permissions:clear-origin');
  ipcMain.removeHandler('permissions:get-defaults');
  ipcMain.removeHandler('permissions:set-default');
  ipcMain.removeHandler('permissions:get-all');
  ipcMain.removeHandler('permissions:reset-all');
  ipcMain.removeHandler('protocol-handlers:get-all');
  ipcMain.removeHandler('protocol-handlers:get-for-protocol');
  ipcMain.removeHandler('protocol-handlers:get-for-origin');
  ipcMain.removeHandler('protocol-handlers:register');
  ipcMain.removeHandler('protocol-handlers:unregister');
  ipcMain.removeHandler('protocol-handlers:clear-all');
  mainLogger.info('permissions.ipc.unregistered');
}
