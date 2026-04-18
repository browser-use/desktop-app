/**
 * PermissionManager unit tests.
 *
 * Tests cover:
 *   - Constructor wires setPermissionRequestHandler + setPermissionCheckHandler
 *     onto the default session
 *   - request handler: auto-grant types are granted without prompting
 *   - request handler: stored 'allow' / 'deny' decisions short-circuit prompts
 *   - request handler: 'ask' triggers a renderer prompt via webContents.send
 *   - check handler: returns true for stored allow / auto-grant, false otherwise
 *   - handleDecision('allow') persists the grant and resolves the callback true
 *   - handleDecision('deny') persists deny and resolves false
 *   - handleDecision('allow-once') stores a session grant scoped to the tab
 *   - expireSessionGrants clears grants for a specific tab and dismisses
 *     pending prompts
 *   - macOS getMediaAccessStatus 'denied' overrides any stored grant
 *   - Notification quiet-UI heuristic: iframe always quiet; main-frame quiet
 *     after 3 denials in 5 minutes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted shared mocks ----------------------------------------------------
const {
  setPermissionRequestHandlerSpy,
  setPermissionCheckHandlerSpy,
  defaultSessionStub,
  systemPreferencesStub,
} = vi.hoisted(() => {
  const setPermissionRequestHandlerSpy = vi.fn();
  const setPermissionCheckHandlerSpy = vi.fn();
  const defaultSessionStub = {
    setPermissionRequestHandler: setPermissionRequestHandlerSpy,
    setPermissionCheckHandler: setPermissionCheckHandlerSpy,
  };
  const systemPreferencesStub = {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    canPromptTouchID: vi.fn(() => true),
    promptTouchID: vi.fn(() => Promise.resolve()),
  };
  return {
    setPermissionRequestHandlerSpy,
    setPermissionCheckHandlerSpy,
    defaultSessionStub,
    systemPreferencesStub,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Session: vi.fn(),
  session: { defaultSession: defaultSessionStub },
  systemPreferences: systemPreferencesStub,
  app: { getPath: () => '/tmp/permmgr-test' },
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { PermissionManager } from '../../../src/main/permissions/PermissionManager';
import { PermissionStore } from '../../../src/main/permissions/PermissionStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWindowStub(): {
  webContents: {
    send: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  };
  isDestroyed: () => boolean;
} {
  return {
    webContents: {
      send: vi.fn(),
      isDestroyed: () => false,
    },
    isDestroyed: () => false,
  };
}

function makeWebContents(id: number, url: string): {
  id: number;
  getURL: () => string;
} {
  return { id, getURL: () => url };
}

interface ManagerHandle {
  manager: PermissionManager;
  store: PermissionStore;
  win: ReturnType<typeof makeWindowStub>;
  requestHandler: (
    wc: ReturnType<typeof makeWebContents>,
    permission: string,
    callback: (granted: boolean) => void,
    details?: { isMainFrame?: boolean; requestingUrl?: string },
  ) => void;
  checkHandler: (
    wc: ReturnType<typeof makeWebContents> | null,
    permission: string,
    requestingOrigin: string,
  ) => boolean;
}

function makeManager(opts?: {
  tabIdForWc?: (wcId: number) => string | null;
  tmpDir?: string;
}): ManagerHandle {
  setPermissionRequestHandlerSpy.mockReset();
  setPermissionCheckHandlerSpy.mockReset();
  systemPreferencesStub.getMediaAccessStatus.mockReturnValue('granted');

  const win = makeWindowStub();
  const store = new PermissionStore(opts?.tmpDir ?? '/tmp/permmgr-test');
  const manager = new PermissionManager({
    store,
    getShellWindow: () => win as unknown as Electron.BrowserWindow,
    getTabIdForWebContents: opts?.tabIdForWc ?? ((wcId) => `tab-${wcId}`),
  });

  const requestHandler = setPermissionRequestHandlerSpy.mock.calls[0][0];
  const checkHandler = setPermissionCheckHandlerSpy.mock.calls[0][0];

  return { manager, store, win, requestHandler, checkHandler };
}

beforeEach(() => {
  // Force darwin path for systemPreferences calls in some tests; default macOS
  // returns 'granted' which is treated as 'not denied'.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

describe('PermissionManager — constructor wiring', () => {
  it('attaches a request handler and a check handler to the default session', () => {
    makeManager();
    expect(setPermissionRequestHandlerSpy).toHaveBeenCalledTimes(1);
    expect(setPermissionCheckHandlerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PermissionManager — request handler', () => {
  it('auto-grants whitelisted permissions without prompting', () => {
    const h = makeManager();
    const cb = vi.fn();
    h.requestHandler(makeWebContents(1, 'https://x.com'), 'fullscreen', cb, { isMainFrame: true });
    expect(cb).toHaveBeenCalledWith(true);
    expect(h.win.webContents.send).not.toHaveBeenCalled();
  });

  it('returns false when macOS Privacy denies the camera', () => {
    const h = makeManager();
    h.store.setSitePermission('https://x.com', 'camera', 'allow');
    systemPreferencesStub.getMediaAccessStatus.mockReturnValue('denied');

    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'camera',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    expect(cb).toHaveBeenCalledWith(false);
  });

  it('honours a stored "allow" decision without prompting', () => {
    const h = makeManager();
    h.store.setSitePermission('https://x.com', 'geolocation', 'allow');
    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    expect(cb).toHaveBeenCalledWith(true);
    expect(h.win.webContents.send).not.toHaveBeenCalled();
  });

  it('honours a stored "deny" decision without prompting', () => {
    const h = makeManager();
    h.store.setSitePermission('https://x.com', 'geolocation', 'deny');
    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    expect(cb).toHaveBeenCalledWith(false);
    expect(h.win.webContents.send).not.toHaveBeenCalled();
  });

  it('triggers a renderer prompt for "ask" permissions', () => {
    const h = makeManager();
    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );

    expect(h.win.webContents.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = h.win.webContents.send.mock.calls[0];
    expect(channel).toBe('permission-prompt');
    expect(payload.origin).toBe('https://x.com');
    expect(payload.permissionType).toBe('geolocation');
    expect(cb).not.toHaveBeenCalled(); // pending
  });

  it('falls back to false when the shell window is unavailable', () => {
    const store = new PermissionStore('/tmp/permmgr-test');
    setPermissionRequestHandlerSpy.mockReset();
    setPermissionCheckHandlerSpy.mockReset();

    new PermissionManager({
      store,
      getShellWindow: () => null,
      getTabIdForWebContents: () => 'tab-1',
    });
    const requestHandler = setPermissionRequestHandlerSpy.mock.calls[0][0];

    const cb = vi.fn();
    requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    expect(cb).toHaveBeenCalledWith(false);
  });
});

describe('PermissionManager — handleDecision', () => {
  function pending(h: ManagerHandle) {
    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    const promptId = (h.win.webContents.send.mock.calls.at(-1) as [string, { id: string }])[1].id;
    return { promptId, cb };
  }

  it('"allow" persists the grant and resolves true', () => {
    const h = makeManager();
    const { promptId, cb } = pending(h);
    h.manager.handleDecision(promptId, 'allow');
    expect(cb).toHaveBeenCalledWith(true);
    expect(h.store.getSitePermission('https://x.com', 'geolocation')).toBe('allow');
  });

  it('"deny" persists the deny and resolves false', () => {
    const h = makeManager();
    const { promptId, cb } = pending(h);
    h.manager.handleDecision(promptId, 'deny');
    expect(cb).toHaveBeenCalledWith(false);
    expect(h.store.getSitePermission('https://x.com', 'geolocation')).toBe('deny');
  });

  it('"allow-once" does NOT persist; instead grants for the current tab only', () => {
    const h = makeManager();
    const { promptId, cb } = pending(h);
    h.manager.handleDecision(promptId, 'allow-once');
    expect(cb).toHaveBeenCalledWith(true);
    // Persistent store is unchanged (still default)
    expect(h.store.getSitePermission('https://x.com', 'geolocation')).toBe('ask');

    // A second request from the same tab is satisfied silently
    const cb2 = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb2,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    expect(cb2).toHaveBeenCalledWith(true);
    expect(h.win.webContents.send).toHaveBeenCalledTimes(1); // no second prompt
  });

  it('handleDecision is a no-op for an unknown promptId', () => {
    const h = makeManager();
    expect(() => h.manager.handleDecision('does-not-exist', 'allow')).not.toThrow();
  });
});

describe('PermissionManager — expireSessionGrants', () => {
  it('clears one-time grants for the closed tab and dismisses pending prompts', () => {
    const h = makeManager();

    // First pending prompt → "allow-once" → adds a session grant
    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    const firstPromptId = (h.win.webContents.send.mock.calls[0] as [string, { id: string }])[1].id;
    h.manager.handleDecision(firstPromptId, 'allow-once');

    // Second pending prompt for the same tab → not yet decided
    const cb2 = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://y.com'),
      'notifications',
      cb2,
      { isMainFrame: true, requestingUrl: 'https://y.com' },
    );
    expect(cb2).not.toHaveBeenCalled();

    // Tab closes → expireSessionGrants(tabId)
    h.manager.expireSessionGrants('tab-1');

    // Pending prompt for the tab is auto-denied
    expect(cb2).toHaveBeenCalledWith(false);

    // Subsequent request from the same tab should re-prompt (no session grant)
    h.win.webContents.send.mockClear();
    const cb3 = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb3,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    expect(h.win.webContents.send).toHaveBeenCalledTimes(1);
    expect(cb3).not.toHaveBeenCalled(); // pending
  });
});

describe('PermissionManager — check handler', () => {
  it('returns true for auto-grant types regardless of store', () => {
    const h = makeManager();
    expect(h.checkHandler(null, 'fullscreen', 'https://x.com')).toBe(true);
    expect(h.checkHandler(null, 'sensors', 'https://x.com')).toBe(true);
  });

  it('returns true when the store has an "allow" record', () => {
    const h = makeManager();
    h.store.setSitePermission('https://x.com', 'geolocation', 'allow');
    expect(h.checkHandler(null, 'geolocation', 'https://x.com')).toBe(true);
  });

  it('returns false when no record exists (default ask)', () => {
    const h = makeManager();
    expect(h.checkHandler(null, 'geolocation', 'https://x.com')).toBe(false);
  });

  it('returns false when macOS Privacy denies', () => {
    const h = makeManager();
    h.store.setSitePermission('https://x.com', 'camera', 'allow');
    systemPreferencesStub.getMediaAccessStatus.mockReturnValue('denied');
    expect(h.checkHandler(null, 'camera', 'https://x.com')).toBe(false);
  });
});

describe('PermissionManager — notification quiet-UI heuristic', () => {
  it('uses quietUI for iframe notification requests', () => {
    const h = makeManager();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'notifications',
      vi.fn(),
      { isMainFrame: false, requestingUrl: 'https://x.com' },
    );
    const payload = (h.win.webContents.send.mock.calls[0] as [string, { quietUI?: boolean }])[1];
    expect(payload.quietUI).toBe(true);
  });

  it('escalates to quietUI after 3 main-frame denials in 5 minutes', () => {
    const h = makeManager();

    function denyOnce(idx: number) {
      const cb = vi.fn();
      h.requestHandler(
        makeWebContents(idx, `https://site${idx}.com`),
        'notifications',
        cb,
        { isMainFrame: true, requestingUrl: `https://site${idx}.com` },
      );
      const promptId = (h.win.webContents.send.mock.calls.at(-1) as [string, { id: string }])[1].id;
      h.manager.handleDecision(promptId, 'deny');
    }

    denyOnce(1);
    denyOnce(2);
    denyOnce(3);

    // 4th request is now quiet-UI
    h.win.webContents.send.mockClear();
    h.requestHandler(
      makeWebContents(4, 'https://site4.com'),
      'notifications',
      vi.fn(),
      { isMainFrame: true, requestingUrl: 'https://site4.com' },
    );
    const payload = (h.win.webContents.send.mock.calls[0] as [string, { quietUI?: boolean }])[1];
    expect(payload.quietUI).toBe(true);
  });
});

describe('PermissionManager — dismissPrompt', () => {
  it('resolves a pending callback with false and forgets the prompt', () => {
    const h = makeManager();
    const cb = vi.fn();
    h.requestHandler(
      makeWebContents(1, 'https://x.com'),
      'geolocation',
      cb,
      { isMainFrame: true, requestingUrl: 'https://x.com' },
    );
    const promptId = (h.win.webContents.send.mock.calls[0] as [string, { id: string }])[1].id;

    h.manager.dismissPrompt(promptId);
    expect(cb).toHaveBeenCalledWith(false);

    // Subsequent decision is a no-op
    h.manager.handleDecision(promptId, 'allow');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
