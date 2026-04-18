export interface TabGroup {
  id: string;
  name: string;
  color: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan';
  tabIds: string[];
  collapsed: boolean;
}

export class TabGroupStore {
  private groups = new Map<string, TabGroup>();

  createGroup(name: string, color: TabGroup['color'], tabIds: string[]): TabGroup {
    const id = 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const group: TabGroup = { id, name, color, tabIds: [...tabIds], collapsed: false };
    this.groups.set(id, group);
    return group;
  }

  getGroup(id: string): TabGroup | undefined {
    return this.groups.get(id);
  }

  listGroups(): TabGroup[] {
    return [...this.groups.values()];
  }

  updateGroup(id: string, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>): void {
    const group = this.groups.get(id);
    if (!group) return;
    Object.assign(group, patch);
  }

  addTabToGroup(groupId: string, tabId: string): void {
    this.removeTabFromGroup(tabId);
    const group = this.groups.get(groupId);
    if (!group) return;
    if (!group.tabIds.includes(tabId)) {
      group.tabIds.push(tabId);
    }
  }

  removeTabFromGroup(tabId: string): void {
    for (const group of this.groups.values()) {
      const idx = group.tabIds.indexOf(tabId);
      if (idx !== -1) {
        group.tabIds.splice(idx, 1);
        if (group.tabIds.length === 0) {
          this.groups.delete(group.id);
        }
        return;
      }
    }
  }

  deleteGroup(id: string): void {
    this.groups.delete(id);
  }

  getGroupForTab(tabId: string): TabGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.tabIds.includes(tabId)) return group;
    }
    return undefined;
  }

  serialize(): string {
    return JSON.stringify([...this.groups.values()]);
  }

  private static readonly VALID_COLORS = new Set<string>([
    'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan',
  ]);

  deserialize(json: string): void {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) return;
      const arr = parsed.filter(
        (g): g is TabGroup =>
          g !== null &&
          typeof g === 'object' &&
          typeof (g as TabGroup).id === 'string' &&
          typeof (g as TabGroup).name === 'string' &&
          TabGroupStore.VALID_COLORS.has((g as TabGroup).color) &&
          Array.isArray((g as TabGroup).tabIds),
      );
      this.groups.clear();
      for (const g of arr) {
        this.groups.set(g.id, g);
      }
    } catch { /* ignore */ }
  }
}
