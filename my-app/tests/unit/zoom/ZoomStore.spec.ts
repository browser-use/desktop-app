/**
 * ZoomStore unit tests — backfilled coverage for the per-origin zoom feature.
 *
 * Tests cover:
 *   - extractOrigin: standard URLs, data:/about: rejection, malformed input
 *   - zoomLevelToPercent: matches the 1.2^level formula used by the badge
 *   - get/set/remove round-trip on a fresh store
 *   - setZoomForOrigin(origin, 0) deletes the override (don't store noise)
 *   - listOverrides returns one entry per persisted origin
 *   - removeOrigin returns false for unknown origin
 *   - clearAll wipes all overrides
 *   - flushSync writes the JSON file with the right shape
 *   - load() handles missing file (returns empty), malformed JSON, wrong version
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// In-memory fs mock
// ---------------------------------------------------------------------------

const fsStore = new Map<string, string>();

vi.mock('node:fs', () => {
  const readFileSync = vi.fn((p: string) => {
    const content = fsStore.get(p);
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return content;
  });
  const writeFileSync = vi.fn((p: string, data: string) => {
    fsStore.set(p, data);
  });
  const existsSync = vi.fn((p: string) => fsStore.has(p));
  const mkdirSync = vi.fn();
  return {
    default: { readFileSync, writeFileSync, existsSync, mkdirSync },
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-zoom-userData'),
  },
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  ZoomStore,
  extractOrigin,
  zoomLevelToPercent,
} from '../../../src/main/tabs/ZoomStore';

const ZOOM_PATH = path.join('/tmp/test-zoom-userData', 'zoom.json');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('extractOrigin', () => {
  it('extracts the origin from a standard https URL', () => {
    expect(extractOrigin('https://example.com/path?q=1')).toBe('https://example.com');
  });

  it('preserves the port in the origin', () => {
    expect(extractOrigin('http://localhost:3000/foo')).toBe('http://localhost:3000');
  });

  it('returns null for data: URLs', () => {
    expect(extractOrigin('data:text/html,<h1>hi</h1>')).toBeNull();
  });

  it('returns null for about: URLs', () => {
    expect(extractOrigin('about:blank')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractOrigin('')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(extractOrigin('not a url')).toBeNull();
  });
});

describe('zoomLevelToPercent', () => {
  it('returns 100 when level is 0 (Chrome default)', () => {
    expect(zoomLevelToPercent(0)).toBe(100);
  });

  it('returns 120 when level is 1 (1.2^1 == 120)', () => {
    expect(zoomLevelToPercent(1)).toBe(120);
  });

  it('rounds to the nearest integer', () => {
    // 1.2^0.5 ≈ 1.0954 → 110
    expect(zoomLevelToPercent(0.5)).toBe(110);
  });

  it('decreases for negative levels', () => {
    expect(zoomLevelToPercent(-1)).toBe(83); // 1.2^-1 ≈ 0.833
  });
});

// ---------------------------------------------------------------------------
// ZoomStore lifecycle
// ---------------------------------------------------------------------------

describe('ZoomStore — load and construction', () => {
  beforeEach(() => {
    fsStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts empty when zoom.json does not exist', () => {
    const store = new ZoomStore();
    expect(store.listOverrides()).toEqual([]);
  });

  it('loads existing origin overrides from disk', () => {
    const persisted = {
      version: 1,
      origins: {
        'https://example.com': 0.5,
        'https://github.com': 1,
      },
    };
    fsStore.set(ZOOM_PATH, JSON.stringify(persisted));
    const store = new ZoomStore();
    expect(store.listOverrides()).toHaveLength(2);
    expect(store.getZoomForOrigin('https://example.com')).toBe(0.5);
  });

  it('resets to empty when persisted version is wrong', () => {
    fsStore.set(ZOOM_PATH, JSON.stringify({ version: 2, origins: { 'https://x.com': 1 } }));
    const store = new ZoomStore();
    expect(store.listOverrides()).toEqual([]);
  });

  it('resets to empty when persisted JSON is malformed', () => {
    fsStore.set(ZOOM_PATH, '{not-valid-json');
    const store = new ZoomStore();
    expect(store.listOverrides()).toEqual([]);
  });
});

describe('ZoomStore — get / set', () => {
  let store: ZoomStore;

  beforeEach(() => {
    fsStore.clear();
    store = new ZoomStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('getZoomForOrigin returns 0 for an unknown origin', () => {
    expect(store.getZoomForOrigin('https://nope.com')).toBe(0);
  });

  it('setZoomForOrigin persists a non-zero level', () => {
    store.setZoomForOrigin('https://example.com', 1.5);
    expect(store.getZoomForOrigin('https://example.com')).toBe(1.5);
  });

  it('setZoomForOrigin with level=0 deletes the entry (no noise stored)', () => {
    store.setZoomForOrigin('https://example.com', 1.5);
    store.setZoomForOrigin('https://example.com', 0);
    expect(store.listOverrides()).toEqual([]);
  });

  it('getZoomForUrl extracts the origin and looks it up', () => {
    store.setZoomForOrigin('https://example.com', 0.75);
    expect(store.getZoomForUrl('https://example.com/path?q=1')).toBe(0.75);
  });

  it('getZoomForUrl returns 0 for data: URLs', () => {
    store.setZoomForOrigin('https://example.com', 0.75);
    expect(store.getZoomForUrl('data:text/html,hi')).toBe(0);
  });

  it('setZoomForUrl ignores URLs with no resolvable origin', () => {
    store.setZoomForUrl('about:blank', 1);
    expect(store.listOverrides()).toEqual([]);
  });

  it('listOverrides returns one entry per persisted origin', () => {
    store.setZoomForOrigin('https://a.com', 1);
    store.setZoomForOrigin('https://b.com', 2);
    const overrides = store.listOverrides();
    expect(overrides).toHaveLength(2);
    expect(overrides.map((o) => o.origin).sort()).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
});

describe('ZoomStore — remove and clear', () => {
  let store: ZoomStore;

  beforeEach(() => {
    fsStore.clear();
    store = new ZoomStore();
    store.setZoomForOrigin('https://a.com', 1);
    store.setZoomForOrigin('https://b.com', 2);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removeOrigin returns true and removes the entry', () => {
    expect(store.removeOrigin('https://a.com')).toBe(true);
    expect(store.listOverrides()).toHaveLength(1);
  });

  it('removeOrigin returns false for unknown origin', () => {
    expect(store.removeOrigin('https://nope.com')).toBe(false);
    expect(store.listOverrides()).toHaveLength(2);
  });

  it('clearAll wipes every override', () => {
    store.clearAll();
    expect(store.listOverrides()).toEqual([]);
  });
});

describe('ZoomStore — persistence (flushSync)', () => {
  beforeEach(() => {
    fsStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes a versioned origins map on flushSync()', () => {
    const store = new ZoomStore();
    store.setZoomForOrigin('https://example.com', 1.5);
    store.flushSync();

    const raw = fsStore.get(ZOOM_PATH);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
    expect(parsed.origins['https://example.com']).toBe(1.5);
  });

  it('flushSync is a no-op when nothing is dirty', () => {
    const store = new ZoomStore();
    store.flushSync();
    expect(fsStore.has(ZOOM_PATH)).toBe(false);
  });

  it('round-trips through flushSync + a fresh ZoomStore load', () => {
    const writer = new ZoomStore();
    writer.setZoomForOrigin('https://a.com', 1);
    writer.setZoomForOrigin('https://b.com', -0.5);
    writer.flushSync();

    const reader = new ZoomStore();
    expect(reader.getZoomForOrigin('https://a.com')).toBe(1);
    expect(reader.getZoomForOrigin('https://b.com')).toBe(-0.5);
  });
});
