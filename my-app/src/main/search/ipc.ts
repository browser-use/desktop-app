/**
 * ipc.ts — search engine IPC bindings.
 * Registers `search-engines:*` handlers.
 */

import { ipcMain } from 'electron';
import { SearchEngineStore } from './SearchEngineStore';
import { assertString } from '../ipc-validators';
import { mainLogger } from '../logger';

const CHANNELS = [
  'search-engines:list',
  'search-engines:get-default',
  'search-engines:set-default',
  'search-engines:add-custom',
  'search-engines:update-custom',
  'search-engines:remove-custom',
] as const;

export interface SearchEnginesIpcOptions {
  store: SearchEngineStore;
  /** Called after the default engine changes so TabManager can pick up the new URL template. */
  onDefaultChanged?: (searchUrl: string) => void;
}

export function registerSearchEngineHandlers(opts: SearchEnginesIpcOptions): void {
  const { store, onDefaultChanged } = opts;

  ipcMain.handle('search-engines:list', () => store.listAll());

  ipcMain.handle('search-engines:get-default', () => store.getDefault());

  ipcMain.handle('search-engines:set-default', (_e, id: unknown) => {
    const engineId = assertString(id, 'id', 256);
    store.setDefault(engineId);
    if (onDefaultChanged) {
      onDefaultChanged(store.getDefault().searchUrl);
    }
    mainLogger.info('search-engines:set-default', { id: engineId });
  });

  ipcMain.handle(
    'search-engines:add-custom',
    (
      _e,
      payload: { name: string; keyword: string; searchUrl: string },
    ) => {
      const name = assertString(payload?.name, 'name', 512);
      const keyword = assertString(payload?.keyword, 'keyword', 64);
      const searchUrl = assertString(payload?.searchUrl, 'searchUrl', 2048);
      return store.addCustom({ name, keyword, searchUrl });
    },
  );

  ipcMain.handle(
    'search-engines:update-custom',
    (
      _e,
      payload: { id: string; name?: string; keyword?: string; searchUrl?: string },
    ) => {
      const id = assertString(payload?.id, 'id', 256);
      const isDefault = store.getDefault().id === id;
      const input: Partial<{ name: string; keyword: string; searchUrl: string }> = {};
      if (payload?.name !== undefined) input.name = assertString(payload.name, 'name', 512);
      if (payload?.keyword !== undefined) input.keyword = assertString(payload.keyword, 'keyword', 64);
      if (payload?.searchUrl !== undefined) input.searchUrl = assertString(payload.searchUrl, 'searchUrl', 2048);
      const result = store.updateCustom(id, input);
      // If the updated engine is (or was) the default, propagate the new template.
      if (result && isDefault && onDefaultChanged) {
        onDefaultChanged(store.getDefault().searchUrl);
        mainLogger.info('search-engines:update-custom.defaultChanged', { id });
      }
      return result;
    },
  );

  ipcMain.handle('search-engines:remove-custom', (_e, id: unknown) => {
    const engineId = assertString(id, 'id', 256);
    const wasDefault = store.getDefault().id === engineId;
    const result = store.removeCustom(engineId);
    // If the removed engine was the default, the store falls back to Google
    // internally. Notify active TabManagers of the new default URL.
    if (result && wasDefault && onDefaultChanged) {
      onDefaultChanged(store.getDefault().searchUrl);
      mainLogger.info('search-engines:remove-custom.defaultChanged', { fallback: store.getDefault().id });
    }
    return result;
  });
}

export function unregisterSearchEngineHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
