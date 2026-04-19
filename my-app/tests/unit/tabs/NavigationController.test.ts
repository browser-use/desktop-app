/**
 * NavigationController unit tests.
 *
 * Tests cover:
 *   - navigate: calls loadURL with the given URL
 *   - goBack: calls goBack() only when canGoBack() is true
 *   - goForward: calls goForward() only when canGoForward() is true
 *   - reload: calls reload()
 *   - reloadIgnoringCache: calls reloadIgnoringCache()
 *   - canGoBack / canGoForward: delegates to navigationHistory
 *   - getCurrentURL: returns webContents.getURL()
 *   - getActiveIndex: returns navigationHistory.getActiveIndex()
 *   - getAllEntries: maps entries, falls back to [{url, title:''}] on error
 *   - goToIndex: calls goToIndex with the given index
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { NavigationController } from '../../../src/main/tabs/NavigationController';

// ---------------------------------------------------------------------------
// Mock WebContentsView
// ---------------------------------------------------------------------------

function makeMockView(overrides: {
  canGoBack?: boolean;
  canGoForward?: boolean;
  url?: string;
  activeIndex?: number;
  entries?: Array<{ url: string; title: string }>;
  getEntriesThrows?: boolean;
} = {}) {
  const nav = {
    canGoBack: vi.fn(() => overrides.canGoBack ?? false),
    canGoForward: vi.fn(() => overrides.canGoForward ?? false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    getActiveIndex: vi.fn(() => overrides.activeIndex ?? 0),
    getAllEntries: vi.fn(() => {
      if (overrides.getEntriesThrows) throw new Error('CDP error');
      return overrides.entries ?? [];
    }),
    goToIndex: vi.fn(),
  };

  const webContents = {
    loadURL: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    getURL: vi.fn(() => overrides.url ?? 'https://example.com'),
    navigationHistory: nav,
  };

  return { webContents, nav } as unknown as { webContents: typeof webContents; nav: typeof nav };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NavigationController', () => {
  let mockView: ReturnType<typeof makeMockView>;
  let controller: NavigationController;

  beforeEach(() => {
    mockView = makeMockView({ canGoBack: true, canGoForward: true, url: 'https://example.com' });
    controller = new NavigationController(mockView as unknown as import('electron').WebContentsView);
    vi.clearAllMocks();
    // Reinitialise mocks after clearAllMocks
    mockView = makeMockView({ canGoBack: true, canGoForward: true, url: 'https://example.com' });
    controller = new NavigationController(mockView as unknown as import('electron').WebContentsView);
  });

  describe('navigate()', () => {
    it('calls loadURL with the given URL', () => {
      controller.navigate('https://google.com');
      expect(mockView.webContents.loadURL).toHaveBeenCalledWith('https://google.com');
    });
  });

  describe('goBack()', () => {
    it('calls navigationHistory.goBack() when canGoBack is true', () => {
      controller.goBack();
      expect(mockView.nav.goBack).toHaveBeenCalledOnce();
    });

    it('does not call goBack() when canGoBack is false', () => {
      const view = makeMockView({ canGoBack: false });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      ctrl.goBack();
      expect(view.nav.goBack).not.toHaveBeenCalled();
    });
  });

  describe('goForward()', () => {
    it('calls navigationHistory.goForward() when canGoForward is true', () => {
      controller.goForward();
      expect(mockView.nav.goForward).toHaveBeenCalledOnce();
    });

    it('does not call goForward() when canGoForward is false', () => {
      const view = makeMockView({ canGoForward: false });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      ctrl.goForward();
      expect(view.nav.goForward).not.toHaveBeenCalled();
    });
  });

  describe('reload()', () => {
    it('calls webContents.reload()', () => {
      controller.reload();
      expect(mockView.webContents.reload).toHaveBeenCalledOnce();
    });
  });

  describe('reloadIgnoringCache()', () => {
    it('calls webContents.reloadIgnoringCache()', () => {
      controller.reloadIgnoringCache();
      expect(mockView.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    });
  });

  describe('canGoBack()', () => {
    it('returns true when navigationHistory.canGoBack() returns true', () => {
      expect(controller.canGoBack()).toBe(true);
    });

    it('returns false when navigationHistory.canGoBack() returns false', () => {
      const view = makeMockView({ canGoBack: false });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      expect(ctrl.canGoBack()).toBe(false);
    });
  });

  describe('canGoForward()', () => {
    it('returns true when navigationHistory.canGoForward() returns true', () => {
      expect(controller.canGoForward()).toBe(true);
    });

    it('returns false when navigationHistory.canGoForward() returns false', () => {
      const view = makeMockView({ canGoForward: false });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      expect(ctrl.canGoForward()).toBe(false);
    });
  });

  describe('getCurrentURL()', () => {
    it('returns the current URL from webContents.getURL()', () => {
      expect(controller.getCurrentURL()).toBe('https://example.com');
    });
  });

  describe('getActiveIndex()', () => {
    it('returns the active index from navigationHistory', () => {
      const view = makeMockView({ activeIndex: 3 });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      expect(ctrl.getActiveIndex()).toBe(3);
    });
  });

  describe('getAllEntries()', () => {
    it('maps entries to {url, title}', () => {
      const view = makeMockView({
        entries: [
          { url: 'https://a.com', title: 'A' },
          { url: 'https://b.com', title: 'B' },
        ],
        url: 'https://a.com',
      });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      const entries = ctrl.getAllEntries();
      expect(entries).toEqual([
        { url: 'https://a.com', title: 'A' },
        { url: 'https://b.com', title: 'B' },
      ]);
    });

    it('falls back to url when title is empty', () => {
      const view = makeMockView({
        entries: [{ url: 'https://a.com', title: '' }],
        url: 'https://a.com',
      });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      const entries = ctrl.getAllEntries();
      expect(entries[0].title).toBe('https://a.com');
    });

    it('falls back to [{url, title:""}] when getAllEntries throws', () => {
      const view = makeMockView({ getEntriesThrows: true, url: 'https://fallback.com' });
      const ctrl = new NavigationController(view as unknown as import('electron').WebContentsView);
      const entries = ctrl.getAllEntries();
      expect(entries).toEqual([{ url: 'https://fallback.com', title: '' }]);
    });
  });

  describe('goToIndex()', () => {
    it('calls navigationHistory.goToIndex with the given index', () => {
      controller.goToIndex(2);
      expect(mockView.nav.goToIndex).toHaveBeenCalledWith(2);
    });
  });
});
