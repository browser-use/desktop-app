/**
 * ContentPolicyEnforcer unit tests (Issue #222).
 *
 * Verifies the enforcement side of the Settings > Content feature actually
 * works end-to-end at the level we control from main-process code:
 *   - handleBeforeRequest cancels image resource types when the resolved
 *     policy (override > default) is 'block'.
 *   - install() wires the listener onto session.webRequest.onBeforeRequest,
 *     using the electron-mock Session stub.
 *   - shouldBlockPopup / isJavaScriptAllowed / shouldMuteForSoundPolicy
 *     consult the store with per-origin override precedence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ContentCategoryStore } from '../../../src/main/content-categories/ContentCategoryStore';
import { ContentPolicyEnforcer } from '../../../src/main/content-categories/ContentPolicyEnforcer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshTempDir(): string {
  const dir = path.join(os.tmpdir(), `cpe-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function freshStore(): { store: ContentCategoryStore; dir: string } {
  const dir = freshTempDir();
  return { store: new ContentCategoryStore(dir), dir };
}

function makeSessionStub(): {
  webRequest: {
    onBeforeRequest: ReturnType<typeof vi.fn>;
  };
  lastListener: null | ((details: unknown, cb: (r: unknown) => void) => void);
} {
  const handle = {
    lastListener: null as null | ((details: unknown, cb: (r: unknown) => void) => void),
    webRequest: {
      onBeforeRequest: vi.fn((listener: (details: unknown, cb: (r: unknown) => void) => void) => {
        handle.lastListener = listener;
      }),
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContentPolicyEnforcer — image blocking via onBeforeRequest', () => {
  let cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanup = [];
  });

  beforeEach(() => {
    cleanup = [];
  });

  it('cancels image requests when default policy is block', () => {
    const { store, dir } = freshStore();
    cleanup.push(dir);
    store.setDefault('images', 'block');
    const enforcer = new ContentPolicyEnforcer({ store });

    const cb = vi.fn();
    enforcer.handleBeforeRequest(
      { url: 'https://example.com/cat.png', resourceType: 'image' },
      cb,
    );
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  });

  it('allows image requests when default policy is allow', () => {
    const { store, dir } = freshStore();
    cleanup.push(dir);
    // Default is 'allow' from DEFAULT_CATEGORY_STATES, but be explicit.
    store.setDefault('images', 'allow');
    const enforcer = new ContentPolicyEnforcer({ store });

    const cb = vi.fn();
    enforcer.handleBeforeRequest(
      { url: 'https://example.com/cat.png', resourceType: 'image' },
      cb,
    );
    expect(cb).toHaveBeenCalledWith({});
  });

  it('never cancels non-image resource types even when images are blocked', () => {
    const { store, dir } = freshStore();
    cleanup.push(dir);
    store.setDefault('images', 'block');
    const enforcer = new ContentPolicyEnforcer({ store });

    const types = ['mainFrame', 'subFrame', 'stylesheet', 'script', 'font', 'xhr', 'other'] as const;
    for (const resourceType of types) {
      const cb = vi.fn();
      enforcer.handleBeforeRequest(
        { url: 'https://example.com/thing', resourceType },
        cb,
      );
      expect(cb).toHaveBeenCalledWith({});
    }
  });

  it('per-site allow override beats global block default for images', () => {
    const { store, dir } = freshStore();
    cleanup.push(dir);
    store.setDefault('images', 'block');
    store.setSiteOverride('https://trusted.example', 'images', 'allow');
    const enforcer = new ContentPolicyEnforcer({ store });

    const cb = vi.fn();
    enforcer.handleBeforeRequest(
      { url: 'https://trusted.example/pic.jpg', resourceType: 'image' },
      cb,
    );
    expect(cb).toHaveBeenCalledWith({});

    const cb2 = vi.fn();
    enforcer.handleBeforeRequest(
      { url: 'https://other.example/pic.jpg', resourceType: 'image' },
      cb2,
    );
    expect(cb2).toHaveBeenCalledWith({ cancel: true });
  });

  it('per-site block override beats global allow default for images', () => {
    const { store, dir } = freshStore();
    cleanup.push(dir);
    store.setDefault('images', 'allow');
    store.setSiteOverride('https://ads.example', 'images', 'block');
    const enforcer = new ContentPolicyEnforcer({ store });

    const cb = vi.fn();
    enforcer.handleBeforeRequest(
      { url: 'https://ads.example/banner.gif', resourceType: 'image' },
      cb,
    );
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  });

  it('handles un-parseable URLs gracefully (falls back to default)', () => {
    const { store, dir } = freshStore();
    cleanup.push(dir);
    store.setDefault('images', 'block');
    const enforcer = new ContentPolicyEnforcer({ store });

    const cb = vi.fn();
    enforcer.handleBeforeRequest(
      { url: 'not-a-url', resourceType: 'image' },
      cb,
    );
    // Still applies default policy because origin extraction falls back to
    // the raw url string.
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  });
});

describe('ContentPolicyEnforcer — install wires webRequest listener', () => {
  it('registers onBeforeRequest on the provided session', () => {
    const { store, dir } = freshStore();
    try {
      const enforcer = new ContentPolicyEnforcer({ store });
      const ses = makeSessionStub();
      // The electron-mock session stub shape is compatible with the
      // Session type for our purposes.
      enforcer.install(ses as unknown as import('electron').Session);
      expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
      expect(typeof ses.lastListener).toBe('function');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('the registered listener blocks images per store policy', () => {
    const { store, dir } = freshStore();
    try {
      store.setDefault('images', 'block');
      const enforcer = new ContentPolicyEnforcer({ store });
      const ses = makeSessionStub();
      enforcer.install(ses as unknown as import('electron').Session);
      expect(ses.lastListener).not.toBeNull();
      const cb = vi.fn();
      ses.lastListener!(
        { url: 'https://example.com/a.png', resourceType: 'image' },
        cb,
      );
      expect(cb).toHaveBeenCalledWith({ cancel: true });
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('uninstall clears the listener with null', () => {
    const { store, dir } = freshStore();
    try {
      const enforcer = new ContentPolicyEnforcer({ store });
      const ses = makeSessionStub();
      enforcer.install(ses as unknown as import('electron').Session);
      enforcer.uninstall();
      // install registered once, uninstall registered with null (clears).
      expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledTimes(2);
      expect(ses.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('ContentPolicyEnforcer — predicates (popups, javascript, sound)', () => {
  let dir: string;
  let store: ContentCategoryStore;
  let enforcer: ContentPolicyEnforcer;

  beforeEach(() => {
    const fresh = freshStore();
    dir = fresh.dir;
    store = fresh.store;
    enforcer = new ContentPolicyEnforcer({ store });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('popups: blocked by default (Chrome-parity)', () => {
    // DEFAULT_CATEGORY_STATES has popups: 'block'.
    expect(enforcer.shouldBlockPopup('https://example.com/page')).toBe(true);
  });

  it('popups: allow override unblocks a specific origin', () => {
    store.setSiteOverride('https://trusted.example', 'popups', 'allow');
    expect(enforcer.shouldBlockPopup('https://trusted.example/page')).toBe(false);
    expect(enforcer.shouldBlockPopup('https://other.example/page')).toBe(true);
  });

  it('popups: global allow lets all popups through', () => {
    store.setDefault('popups', 'allow');
    expect(enforcer.shouldBlockPopup('https://any.example/page')).toBe(false);
  });

  it('javascript: allowed by default', () => {
    expect(enforcer.isJavaScriptAllowed('https://example.com/')).toBe(true);
  });

  it('javascript: global block disables JS for all origins', () => {
    store.setDefault('javascript', 'block');
    expect(enforcer.isJavaScriptAllowed('https://anywhere.example/')).toBe(false);
  });

  it('javascript: per-origin allow override beats global block', () => {
    store.setDefault('javascript', 'block');
    store.setSiteOverride('https://app.example', 'javascript', 'allow');
    expect(enforcer.isJavaScriptAllowed('https://app.example/x')).toBe(true);
    expect(enforcer.isJavaScriptAllowed('https://elsewhere.example/x')).toBe(false);
  });

  it('sound: not muted by default', () => {
    expect(enforcer.shouldMuteForSoundPolicy('https://example.com/')).toBe(false);
  });

  it('sound: global block mutes every origin', () => {
    store.setDefault('sound', 'block');
    expect(enforcer.shouldMuteForSoundPolicy('https://one.example/')).toBe(true);
    expect(enforcer.shouldMuteForSoundPolicy('https://two.example/')).toBe(true);
  });

  it('sound: per-origin block mutes only that origin', () => {
    store.setSiteOverride('https://noisy.example', 'sound', 'block');
    expect(enforcer.shouldMuteForSoundPolicy('https://noisy.example/')).toBe(true);
    expect(enforcer.shouldMuteForSoundPolicy('https://quiet.example/')).toBe(false);
  });
});
