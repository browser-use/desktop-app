import { ipcMain, BrowserWindow } from 'electron';
import { TabGroupStore } from './TabGroupStore';

export function registerTabGroupHandlers(
  store: TabGroupStore,
  getShellWindow: () => BrowserWindow | null,
): void {
  const broadcast = () => {
    const win = getShellWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('tab-groups:updated', store.listGroups());
    }
  };

  ipcMain.handle('tab-groups:list', () => store.listGroups());

  ipcMain.handle('tab-groups:create', (_e, { name, color, tabIds }: { name: string; color: string; tabIds: string[] }) => {
    const group = store.createGroup(name, color as Parameters<TabGroupStore['createGroup']>[1], tabIds);
    broadcast();
    return group;
  });

  ipcMain.handle('tab-groups:update', (_e, { id, patch }: { id: string; patch: object }) => {
    store.updateGroup(id, patch as Parameters<TabGroupStore['updateGroup']>[1]);
    broadcast();
  });

  ipcMain.handle('tab-groups:add-tab', (_e, { groupId, tabId }: { groupId: string; tabId: string }) => {
    store.addTabToGroup(groupId, tabId);
    broadcast();
  });

  ipcMain.handle('tab-groups:remove-tab', (_e, { tabId }: { tabId: string }) => {
    store.removeTabFromGroup(tabId);
    broadcast();
  });

  ipcMain.handle('tab-groups:delete', (_e, { id }: { id: string }) => {
    store.deleteGroup(id);
    broadcast();
  });
}

export function unregisterTabGroupHandlers(): void {
  ipcMain.removeHandler('tab-groups:list');
  ipcMain.removeHandler('tab-groups:create');
  ipcMain.removeHandler('tab-groups:update');
  ipcMain.removeHandler('tab-groups:add-tab');
  ipcMain.removeHandler('tab-groups:remove-tab');
  ipcMain.removeHandler('tab-groups:delete');
}
