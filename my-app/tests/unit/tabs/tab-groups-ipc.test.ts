/**
 * tabs/tab-groups-ipc.ts unit tests.
 *
 * Tests cover:
 *   - registerTabGroupHandlers: registers all expected IPC channels
 *   - unregisterTabGroupHandlers: removes all channels
 *   - tab-groups:list: delegates to store.listGroups()
 *   - tab-groups:create: validates color, calls store.createGroup, broadcasts
 *   - tab-groups:create: returns null for invalid color
 *   - tab-groups:update: applies valid patch fields, rejects non-object patch
 *   - tab-groups:update: broadcasts after update
 *   - tab-groups:add-tab: calls store.addTabToGroup and broadcasts
 *   - tab-groups:remove-tab: calls store.removeTabFromGroup and broadcasts
 *   - tab-groups:delete: calls store.deleteGroup and broadcasts
 *   - broadcast: sends 'tab-groups:updated' to all non-destroyed windows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(() => []),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); }),
    removeHandler: vi.fn((ch: string) => { handlers.delete(ch); }),
  },
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
}));

import {
  registerTabGroupHandlers,
  unregisterTabGroupHandlers,
} from '../../../src/main/tabs/tab-groups-ipc';
import type { TabGroupStore } from '../../../src/main/tabs/TabGroupStore';
import type { TabGroup } from '../../../src/main/tabs/TabGroupStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return {
    listGroups: vi.fn(() => [] as TabGroup[]),
    createGroup: vi.fn((name: string, color: TabGroup['color'], tabIds: string[]) => ({
      id: 'g1', name, color, tabIds, collapsed: false,
    })),
    updateGroup: vi.fn(),
    addTabToGroup: vi.fn(),
    removeTabFromGroup: vi.fn(),
    deleteGroup: vi.fn(),
  } as unknown as TabGroupStore;
}

function makeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  };
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler: ${channel}`);
  return handler({} as never, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tabs/tab-groups-ipc.ts', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    store = makeStore();
    mockGetAllWindows.mockReturnValue([]);
    registerTabGroupHandlers(store as unknown as TabGroupStore, () => null);
  });

  // ---------------------------------------------------------------------------
  // Registration / unregistration
  // ---------------------------------------------------------------------------

  describe('registerTabGroupHandlers()', () => {
    it('registers tab-groups:list', () => { expect(handlers.has('tab-groups:list')).toBe(true); });
    it('registers tab-groups:create', () => { expect(handlers.has('tab-groups:create')).toBe(true); });
    it('registers tab-groups:update', () => { expect(handlers.has('tab-groups:update')).toBe(true); });
    it('registers tab-groups:add-tab', () => { expect(handlers.has('tab-groups:add-tab')).toBe(true); });
    it('registers tab-groups:remove-tab', () => { expect(handlers.has('tab-groups:remove-tab')).toBe(true); });
    it('registers tab-groups:delete', () => { expect(handlers.has('tab-groups:delete')).toBe(true); });
  });

  describe('unregisterTabGroupHandlers()', () => {
    it('removes all channels', () => {
      unregisterTabGroupHandlers();
      expect(handlers.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // tab-groups:list
  // ---------------------------------------------------------------------------

  describe('tab-groups:list', () => {
    it('returns result from store.listGroups()', async () => {
      const groups: TabGroup[] = [{ id: 'g1', name: 'Work', color: 'blue', tabIds: [], collapsed: false }];
      (store.listGroups as ReturnType<typeof vi.fn>).mockReturnValue(groups);
      const result = await invokeHandler('tab-groups:list');
      expect(result).toBe(groups);
    });
  });

  // ---------------------------------------------------------------------------
  // tab-groups:create
  // ---------------------------------------------------------------------------

  describe('tab-groups:create', () => {
    it('calls store.createGroup with name, color, tabIds', async () => {
      await invokeHandler('tab-groups:create', { name: 'My Group', color: 'blue', tabIds: ['t1', 't2'] });
      expect(store.createGroup).toHaveBeenCalledWith('My Group', 'blue', ['t1', 't2']);
    });

    it('returns the created group', async () => {
      const result = await invokeHandler('tab-groups:create', { name: 'G', color: 'red', tabIds: [] }) as TabGroup;
      expect(result.name).toBe('G');
      expect(result.color).toBe('red');
    });

    it('returns null for invalid color', async () => {
      const result = await invokeHandler('tab-groups:create', { name: 'G', color: 'invalid', tabIds: [] });
      expect(result).toBeNull();
      expect(store.createGroup).not.toHaveBeenCalled();
    });

    it('accepts all valid colors', async () => {
      const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
      for (const color of validColors) {
        vi.clearAllMocks();
        store = makeStore();
        registerTabGroupHandlers(store as unknown as TabGroupStore, () => null);
        const result = await invokeHandler('tab-groups:create', { name: 'G', color, tabIds: [] });
        expect(result).not.toBeNull();
      }
    });

    it('broadcasts to alive windows after create', async () => {
      const win = makeWindow(false);
      mockGetAllWindows.mockReturnValue([win]);
      await invokeHandler('tab-groups:create', { name: 'G', color: 'blue', tabIds: [] });
      expect(win.webContents.send).toHaveBeenCalledWith('tab-groups:updated', expect.any(Array));
    });

    it('does not send to destroyed windows', async () => {
      const win = makeWindow(true);
      mockGetAllWindows.mockReturnValue([win]);
      await invokeHandler('tab-groups:create', { name: 'G', color: 'blue', tabIds: [] });
      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // tab-groups:update
  // ---------------------------------------------------------------------------

  describe('tab-groups:update', () => {
    it('calls store.updateGroup with id and safe patch', async () => {
      await invokeHandler('tab-groups:update', { id: 'g1', patch: { name: 'New Name', color: 'green', collapsed: true } });
      expect(store.updateGroup).toHaveBeenCalledWith('g1', { name: 'New Name', color: 'green', collapsed: true });
    });

    it('ignores non-object patch', async () => {
      await invokeHandler('tab-groups:update', { id: 'g1', patch: 'not-an-object' });
      expect(store.updateGroup).not.toHaveBeenCalled();
    });

    it('strips invalid color from patch', async () => {
      await invokeHandler('tab-groups:update', { id: 'g1', patch: { color: 'rainbow' } });
      expect(store.updateGroup).toHaveBeenCalledWith('g1', {});
    });

    it('broadcasts after update', async () => {
      const win = makeWindow(false);
      mockGetAllWindows.mockReturnValue([win]);
      await invokeHandler('tab-groups:update', { id: 'g1', patch: { name: 'X' } });
      expect(win.webContents.send).toHaveBeenCalledWith('tab-groups:updated', expect.any(Array));
    });
  });

  // ---------------------------------------------------------------------------
  // tab-groups:add-tab
  // ---------------------------------------------------------------------------

  describe('tab-groups:add-tab', () => {
    it('calls store.addTabToGroup with groupId and tabId', async () => {
      await invokeHandler('tab-groups:add-tab', { groupId: 'g1', tabId: 't5' });
      expect(store.addTabToGroup).toHaveBeenCalledWith('g1', 't5');
    });

    it('broadcasts after add-tab', async () => {
      const win = makeWindow(false);
      mockGetAllWindows.mockReturnValue([win]);
      await invokeHandler('tab-groups:add-tab', { groupId: 'g1', tabId: 't1' });
      expect(win.webContents.send).toHaveBeenCalledWith('tab-groups:updated', expect.any(Array));
    });
  });

  // ---------------------------------------------------------------------------
  // tab-groups:remove-tab
  // ---------------------------------------------------------------------------

  describe('tab-groups:remove-tab', () => {
    it('calls store.removeTabFromGroup with tabId', async () => {
      await invokeHandler('tab-groups:remove-tab', { tabId: 't5' });
      expect(store.removeTabFromGroup).toHaveBeenCalledWith('t5');
    });
  });

  // ---------------------------------------------------------------------------
  // tab-groups:delete
  // ---------------------------------------------------------------------------

  describe('tab-groups:delete', () => {
    it('calls store.deleteGroup with id', async () => {
      await invokeHandler('tab-groups:delete', { id: 'g1' });
      expect(store.deleteGroup).toHaveBeenCalledWith('g1');
    });

    it('broadcasts after delete', async () => {
      const win = makeWindow(false);
      mockGetAllWindows.mockReturnValue([win]);
      await invokeHandler('tab-groups:delete', { id: 'g1' });
      expect(win.webContents.send).toHaveBeenCalledWith('tab-groups:updated', expect.any(Array));
    });
  });
});
