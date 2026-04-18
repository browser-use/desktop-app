import { ipcMain, BrowserWindow } from 'electron';
import type { TabGroup } from './TabGroupStore';
import { TabGroupStore } from './TabGroupStore';

const VALID_COLORS = new Set<TabGroup['color']>(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan']);

function isValidColor(c: unknown): c is TabGroup['color'] {
  return typeof c === 'string' && VALID_COLORS.has(c as TabGroup['color']);
}

export function registerTabGroupHandlers(
  store: TabGroupStore,
  _getShellWindow: () => BrowserWindow | null,
): void {
  const broadcast = () => {
    const groups = store.listGroups();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('tab-groups:updated', groups);
      }
    }
  };

  ipcMain.handle('tab-groups:list', () => store.listGroups());

  ipcMain.handle('tab-groups:create', (_e, { name, color, tabIds }: { name: string; color: string; tabIds: string[] }) => {
    if (!isValidColor(color)) return null;
    const group = store.createGroup(String(name).slice(0, 64), color, Array.isArray(tabIds) ? tabIds.filter((t) => typeof t === 'string') : []);
    broadcast();
    return group;
  });

  ipcMain.handle('tab-groups:update', (_e, { id, patch }: { id: string; patch: unknown }) => {
    if (typeof patch !== 'object' || patch === null) return;
    const safe: Parameters<TabGroupStore['updateGroup']>[1] = {};
    const p = patch as Record<string, unknown>;
    if (typeof p['name'] === 'string') safe.name = p['name'].slice(0, 64);
    if (isValidColor(p['color'])) safe.color = p['color'];
    if (typeof p['collapsed'] === 'boolean') safe.collapsed = p['collapsed'];
    store.updateGroup(id, safe);
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
