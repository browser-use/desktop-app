/**
 * DevTools IPC handlers — bridges CDP commands from the DevTools renderer
 * to the active tab via the DevToolsBridge.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { mainLogger } from '../logger';
import { DevToolsBridge } from './DevToolsBridge';
import { TabManager } from '../tabs/TabManager';
import { getDevToolsWindow } from './DevToolsWindow';

let bridge: DevToolsBridge | null = null;

export function registerDevToolsHandlers(tabManager: TabManager): void {
  bridge = new DevToolsBridge();

  mainLogger.info('devtools.ipc.register');

  ipcMain.handle('devtools:attach', async (_e) => {
    mainLogger.info('devtools:attach');
    const wc = tabManager.getActiveWebContents();
    if (!wc) {
      mainLogger.warn('devtools:attach — no active tab');
      return { success: false, error: 'No active tab' };
    }

    const senderWindow = BrowserWindow.fromWebContents(_e.sender);
    if (!senderWindow) {
      mainLogger.warn('devtools:attach — no sender window');
      return { success: false, error: 'No DevTools window' };
    }

    try {
      bridge!.attach(wc, senderWindow);
      if (!bridge!.isAttached()) {
        return { success: false, error: 'Debugger attach failed' };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('devtools:detach', async () => {
    mainLogger.info('devtools:detach');
    bridge!.detach();
    return { success: true };
  });

  ipcMain.handle('devtools:send', async (_e, method: string, params?: Record<string, unknown>) => {
    mainLogger.debug('devtools:send', { method });
    try {
      const result = await bridge!.send(method, params);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('devtools:is-attached', async () => {
    return bridge?.isAttached() ?? false;
  });

  ipcMain.handle('devtools:get-active-tab-info', async () => {
    const state = tabManager.getState();
    if (!state.activeTabId) return null;
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    return tab ?? null;
  });

  tabManager.setOnActiveTabChanged((tabId: string) => {
    const win = getDevToolsWindow();
    if (!win) return;
    const state = tabManager.getState();
    const tab = state.tabs.find((t) => t.id === tabId);
    mainLogger.info('devtools:tab-changed', { tabId, url: tab?.url });
    win.webContents.send('devtools:tab-changed', tabId);
  });
}

export function unregisterDevToolsHandlers(tabManager?: TabManager): void {
  mainLogger.info('devtools.ipc.unregister');
  if (bridge) {
    bridge.detach();
    bridge = null;
  }
  if (tabManager) {
    tabManager.setOnActiveTabChanged(null);
  }
  ipcMain.removeHandler('devtools:attach');
  ipcMain.removeHandler('devtools:detach');
  ipcMain.removeHandler('devtools:send');
  ipcMain.removeHandler('devtools:is-attached');
  ipcMain.removeHandler('devtools:get-active-tab-info');
}

export function getDevToolsBridge(): DevToolsBridge | null {
  return bridge;
}
