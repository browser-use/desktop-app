export type ActionId =
  | 'nav.down' | 'nav.up' | 'nav.top' | 'nav.bottom' | 'nav.open'
  | 'goto.dashboard' | 'goto.agents' | 'goto.list' | 'goto.settings'
  | 'search.open'
  | 'action.create' | 'action.createPane' | 'action.dismiss' | 'action.cancel' | 'action.followUp'
  | 'view.cycle'
  | 'scroll.halfDown' | 'scroll.halfUp'
  | 'meta.help' | 'meta.commandPalette' | 'meta.escape';

export interface KeyBinding {
  id: ActionId;
  label: string;
  keys: string[];
  category: string;
}

export const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  { id: 'nav.down', label: 'Next session', keys: ['j'], category: 'Navigation' },
  { id: 'nav.up', label: 'Previous session', keys: ['k'], category: 'Navigation' },
  { id: 'nav.top', label: 'First session', keys: ['g g'], category: 'Navigation' },
  { id: 'nav.bottom', label: 'Last session', keys: ['G'], category: 'Navigation' },
  { id: 'nav.open', label: 'Open session', keys: ['Enter'], category: 'Navigation' },
  { id: 'goto.dashboard', label: 'Dashboard', keys: ['g d'], category: 'Views' },
  { id: 'goto.agents', label: 'Grid view', keys: ['g a'], category: 'Views' },
  { id: 'goto.list', label: 'List view', keys: ['g l'], category: 'Views' },
  { id: 'goto.settings', label: 'Settings', keys: ['Cmd+,'], category: 'Views' },
  { id: 'search.open', label: 'Search', keys: ['/'], category: 'Actions' },
  { id: 'action.create', label: 'New agent', keys: [], category: 'Actions' },
  { id: 'action.createPane', label: 'New pane', keys: [], category: 'Actions' },
  { id: 'action.dismiss', label: 'Dismiss session', keys: ['x'], category: 'Actions' },
  { id: 'action.cancel', label: 'Cancel session', keys: ['Ctrl+c'], category: 'Actions' },
  { id: 'action.followUp', label: 'Follow up', keys: ['f'], category: 'Actions' },
  { id: 'view.cycle', label: 'Cycle pane view', keys: ['v'], category: 'Actions' },
  { id: 'scroll.halfDown', label: 'Scroll down', keys: ['Ctrl+d'], category: 'Scroll' },
  { id: 'scroll.halfUp', label: 'Scroll up', keys: ['Ctrl+u'], category: 'Scroll' },
  { id: 'meta.help', label: 'Keybindings help', keys: [], category: 'Meta' },
  { id: 'meta.commandPalette', label: 'Command bar', keys: [], category: 'Meta' },
  { id: 'meta.escape', label: 'Close overlay', keys: ['Escape'], category: 'Meta' },
];

export type ScreenId = 'dashboard' | 'grid' | 'list';

export const SCREEN_COMMANDS: Record<ScreenId, ActionId[]> = {
  dashboard: [
    'action.createPane',
    'goto.agents',
    'goto.list',
    'goto.settings',
  ],
  grid: [
    'nav.down',
    'nav.up',
    'action.createPane',
    'action.followUp',
    'view.cycle',
    'action.dismiss',
    'goto.dashboard',
  ],
  list: [
    'nav.down',
    'nav.up',
    'nav.open',
    'action.create',
    'goto.dashboard',
    'goto.agents',
    'goto.settings',
  ],
};
