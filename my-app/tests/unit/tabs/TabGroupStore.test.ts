/**
 * TabGroupStore unit tests.
 *
 * Tests cover:
 *   - createGroup: unique id, copies tabIds, collapsed=false
 *   - getGroup: returns undefined for unknown id
 *   - listGroups: returns all groups
 *   - updateGroup: patches name/color/collapsed; noop for unknown id
 *   - addTabToGroup: appends tab, idempotent, moves from existing group
 *   - removeTabFromGroup: removes tab, auto-deletes empty group
 *   - deleteGroup: removes group by id
 *   - getGroupForTab: finds the group containing a tab
 *   - serialize / deserialize: round-trip JSON
 *   - Persistence: flushSync + reload via new instance
 *   - Invalid JSON / missing file starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// TabGroupStore uses app.getPath as fallback only — we always pass dataDir
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
}));

import { TabGroupStore, TAB_GROUPS_FILE_NAME } from '../../../src/main/tabs/TabGroupStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgroupstore-'));
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): TabGroupStore {
  return new TabGroupStore(dir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TabGroupStore', () => {
  describe('createGroup()', () => {
    it('creates a group with the given name, color, and tabIds', () => {
      const store = newStore();
      const group = store.createGroup('Work', 'blue', ['tab-1', 'tab-2']);
      expect(group.name).toBe('Work');
      expect(group.color).toBe('blue');
      expect(group.tabIds).toEqual(['tab-1', 'tab-2']);
    });

    it('starts with collapsed=false', () => {
      const store = newStore();
      const group = store.createGroup('G', 'red', []);
      expect(group.collapsed).toBe(false);
    });

    it('generates a unique id each call', () => {
      const store = newStore();
      const a = store.createGroup('A', 'grey', []);
      const b = store.createGroup('B', 'grey', []);
      expect(a.id).not.toBe(b.id);
    });

    it('copies the tabIds array (no aliasing)', () => {
      const store = newStore();
      const tabs = ['tab-1'];
      const group = store.createGroup('G', 'grey', tabs);
      tabs.push('tab-2');
      expect(group.tabIds).toHaveLength(1);
    });
  });

  describe('getGroup()', () => {
    it('returns undefined for unknown id', () => {
      expect(newStore().getGroup('nonexistent')).toBeUndefined();
    });

    it('returns the group after creation', () => {
      const store = newStore();
      const group = store.createGroup('G', 'blue', []);
      expect(store.getGroup(group.id)).toBe(group);
    });
  });

  describe('listGroups()', () => {
    it('returns empty array on fresh store', () => {
      expect(newStore().listGroups()).toEqual([]);
    });

    it('returns all created groups', () => {
      const store = newStore();
      store.createGroup('A', 'grey', []);
      store.createGroup('B', 'red', []);
      expect(store.listGroups()).toHaveLength(2);
    });
  });

  describe('updateGroup()', () => {
    it('patches name', () => {
      const store = newStore();
      const g = store.createGroup('Old', 'grey', []);
      store.updateGroup(g.id, { name: 'New' });
      expect(store.getGroup(g.id)?.name).toBe('New');
    });

    it('patches color', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', []);
      store.updateGroup(g.id, { color: 'purple' });
      expect(store.getGroup(g.id)?.color).toBe('purple');
    });

    it('patches collapsed', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', []);
      store.updateGroup(g.id, { collapsed: true });
      expect(store.getGroup(g.id)?.collapsed).toBe(true);
    });

    it('partial patch leaves other fields unchanged', () => {
      const store = newStore();
      const g = store.createGroup('MyGroup', 'blue', []);
      store.updateGroup(g.id, { collapsed: true });
      expect(store.getGroup(g.id)?.name).toBe('MyGroup');
      expect(store.getGroup(g.id)?.color).toBe('blue');
    });

    it('is a noop for unknown id', () => {
      const store = newStore();
      expect(() => store.updateGroup('bad-id', { name: 'X' })).not.toThrow();
    });
  });

  describe('addTabToGroup()', () => {
    it('adds a tab to a group', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', []);
      store.addTabToGroup(g.id, 'tab-1');
      expect(store.getGroup(g.id)?.tabIds).toContain('tab-1');
    });

    it('is idempotent — does not duplicate tab', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', ['tab-1', 'tab-2']);
      store.addTabToGroup(g.id, 'tab-1');
      expect(store.getGroup(g.id)?.tabIds).toHaveLength(2);
    });

    it('moves a tab from its current group', () => {
      const store = newStore();
      const g1 = store.createGroup('G1', 'grey', ['tab-1', 'tab-2']); // 2 tabs so g1 survives
      const g2 = store.createGroup('G2', 'blue', []);
      store.addTabToGroup(g2.id, 'tab-1');
      expect(store.getGroup(g1.id)?.tabIds).not.toContain('tab-1');
      expect(store.getGroup(g2.id)?.tabIds).toContain('tab-1');
    });

    it('auto-deletes the source group when it becomes empty', () => {
      const store = newStore();
      const g1 = store.createGroup('G1', 'grey', ['tab-1']);
      const g2 = store.createGroup('G2', 'blue', []);
      store.addTabToGroup(g2.id, 'tab-1');
      expect(store.getGroup(g1.id)).toBeUndefined();
    });

    it('is a noop for unknown groupId', () => {
      const store = newStore();
      expect(() => store.addTabToGroup('bad-id', 'tab-1')).not.toThrow();
    });
  });

  describe('removeTabFromGroup()', () => {
    it('removes a tab from its group', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', ['tab-1', 'tab-2']);
      store.removeTabFromGroup('tab-1');
      expect(store.getGroup(g.id)?.tabIds).not.toContain('tab-1');
      expect(store.getGroup(g.id)?.tabIds).toContain('tab-2');
    });

    it('auto-deletes group when last tab is removed', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', ['tab-1']);
      store.removeTabFromGroup('tab-1');
      expect(store.getGroup(g.id)).toBeUndefined();
    });

    it('is safe when tab is not in any group', () => {
      expect(() => newStore().removeTabFromGroup('unknown-tab')).not.toThrow();
    });
  });

  describe('deleteGroup()', () => {
    it('removes the group', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', []);
      store.deleteGroup(g.id);
      expect(store.getGroup(g.id)).toBeUndefined();
    });

    it('is safe for unknown id', () => {
      expect(() => newStore().deleteGroup('bad-id')).not.toThrow();
    });
  });

  describe('getGroupForTab()', () => {
    it('returns undefined when tab is not in any group', () => {
      expect(newStore().getGroupForTab('tab-1')).toBeUndefined();
    });

    it('returns the group containing the tab', () => {
      const store = newStore();
      const g = store.createGroup('G', 'grey', ['tab-1']);
      expect(store.getGroupForTab('tab-1')?.id).toBe(g.id);
    });
  });

  describe('serialize / deserialize', () => {
    it('round-trips groups correctly', () => {
      const store = newStore();
      store.createGroup('Work', 'blue', ['t1', 't2']);
      const json = store.serialize();
      const store2 = newStore();
      store2.deserialize(json);
      const groups = store2.listGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Work');
      expect(groups[0].tabIds).toEqual(['t1', 't2']);
    });

    it('deserialize ignores entries with invalid color', () => {
      const store = newStore();
      store.deserialize(JSON.stringify([
        { id: 'g1', name: 'Valid', color: 'blue', tabIds: ['t1'], collapsed: false },
        { id: 'g2', name: 'Bad', color: 'invisible', tabIds: [], collapsed: false },
      ]));
      expect(store.listGroups()).toHaveLength(1);
      expect(store.listGroups()[0].name).toBe('Valid');
    });

    it('deserialize ignores non-array input', () => {
      const store = newStore();
      store.createGroup('G', 'grey', []);
      store.deserialize('{}');
      expect(store.listGroups()).toHaveLength(1);
    });

    it('deserialize is silent on invalid JSON', () => {
      const store = newStore();
      expect(() => store.deserialize('{ bad json }')).not.toThrow();
    });
  });

  describe('persistence', () => {
    it('persists and reloads groups via flushSync', () => {
      const store = newStore();
      store.createGroup('Pinned', 'cyan', ['tab-1']);
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.listGroups()).toHaveLength(1);
      expect(reloaded.listGroups()[0].name).toBe('Pinned');
    });

    it('starts fresh when file does not exist', () => {
      expect(newStore().listGroups()).toHaveLength(0);
    });

    it('starts fresh with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, TAB_GROUPS_FILE_NAME), '{ bad json }', 'utf-8');
      expect(newStore().listGroups()).toHaveLength(0);
    });
  });
});
