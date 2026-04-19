/**
 * NtpCustomizationStore unit tests.
 *
 * Tests cover:
 *   - load(): returns defaults on fresh start, merges partial file data
 *   - load(): caches after first read (no second disk read)
 *   - save(patch): merges patch with current state, persists to disk
 *   - reset(): restores defaults, deletes file
 *   - Corrupt / missing file → returns defaults
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy, mockApp } = vi.hoisted(() => ({
  loggerSpy: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockApp: { getPath: vi.fn(() => os.tmpdir()) },
}));

vi.mock('electron', () => ({ app: mockApp }));
vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

import { NtpCustomizationStore, type NtpCustomization } from '../../../src/main/ntp/NtpCustomizationStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntpstore-'));
  mockApp.getPath.mockReturnValue(tmpDir);
  vi.clearAllMocks();
});

function newStore(): NtpCustomizationStore {
  return new NtpCustomizationStore();
}

const DEFAULTS: NtpCustomization = {
  backgroundType: 'default',
  backgroundColor: '#202124',
  backgroundImageDataUrl: '',
  accentColor: '#6D8196',
  colorScheme: 'system',
  shortcutMode: 'most-visited',
  shortcutsVisible: true,
  customShortcuts: [],
  cardsVisible: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NtpCustomizationStore', () => {
  describe('load()', () => {
    it('returns all defaults on a fresh store', () => {
      const store = newStore();
      const data = store.load();
      expect(data).toEqual(DEFAULTS);
    });

    it('merges persisted data with defaults (partial file)', () => {
      const filePath = path.join(tmpDir, 'ntp-customization.json');
      fs.writeFileSync(filePath, JSON.stringify({ colorScheme: 'dark', shortcutsVisible: false }), 'utf-8');
      const store = newStore();
      const data = store.load();
      expect(data.colorScheme).toBe('dark');
      expect(data.shortcutsVisible).toBe(false);
      // other fields remain as defaults
      expect(data.backgroundType).toBe('default');
      expect(data.cardsVisible).toBe(true);
    });

    it('returns defaults when file has invalid JSON', () => {
      const filePath = path.join(tmpDir, 'ntp-customization.json');
      fs.writeFileSync(filePath, '{ not valid json }', 'utf-8');
      const store = newStore();
      expect(store.load()).toEqual(DEFAULTS);
    });

    it('caches the result after first call (no second file read)', () => {
      const store = newStore();
      store.load(); // first read
      // Remove the file to ensure a second disk read would fail
      const filePath = path.join(tmpDir, 'ntp-customization.json');
      store.save({ colorScheme: 'dark' }); // writes file
      fs.unlinkSync(filePath);
      // Second call should return cached value, not re-read disk
      const data = store.load();
      expect(data.colorScheme).toBe('dark');
    });

    it('file with complete data returns all persisted fields', () => {
      const full = {
        ...DEFAULTS,
        backgroundType: 'solid-color',
        backgroundColor: '#ff0000',
        accentColor: '#00ff00',
        colorScheme: 'light',
        shortcutMode: 'custom',
        customShortcuts: [{ id: 'sc1', name: 'Google', url: 'https://google.com' }],
        cardsVisible: false,
      };
      const filePath = path.join(tmpDir, 'ntp-customization.json');
      fs.writeFileSync(filePath, JSON.stringify(full), 'utf-8');
      const store = newStore();
      expect(store.load()).toEqual(full);
    });
  });

  describe('save()', () => {
    it('merges a single-field patch with current state', () => {
      const store = newStore();
      const result = store.save({ colorScheme: 'dark' });
      expect(result.colorScheme).toBe('dark');
      expect(result.backgroundType).toBe('default'); // unchanged
    });

    it('returns the full merged state', () => {
      const store = newStore();
      const result = store.save({ backgroundType: 'solid-color', backgroundColor: '#ff0000' });
      expect(result).toMatchObject({ backgroundType: 'solid-color', backgroundColor: '#ff0000' });
      expect(result.colorScheme).toBe('system'); // default unchanged
    });

    it('persists to disk — reloading confirms the change', () => {
      const store = newStore();
      store.save({ accentColor: '#abcdef', cardsVisible: false });
      store.save({ colorScheme: 'light' });

      const reloaded = newStore();
      const data = reloaded.load();
      expect(data.accentColor).toBe('#abcdef');
      expect(data.cardsVisible).toBe(false);
      expect(data.colorScheme).toBe('light');
    });

    it('multiple patches accumulate correctly', () => {
      const store = newStore();
      store.save({ colorScheme: 'dark' });
      store.save({ shortcutsVisible: false });
      const result = store.save({ cardsVisible: false });
      expect(result.colorScheme).toBe('dark');
      expect(result.shortcutsVisible).toBe(false);
      expect(result.cardsVisible).toBe(false);
    });

    it('saves custom shortcuts', () => {
      const store = newStore();
      const shortcuts = [
        { id: 'sc1', name: 'GitHub', url: 'https://github.com' },
        { id: 'sc2', name: 'Docs', url: 'https://docs.example.com' },
      ];
      const result = store.save({ shortcutMode: 'custom', customShortcuts: shortcuts });
      expect(result.shortcutMode).toBe('custom');
      expect(result.customShortcuts).toHaveLength(2);
      expect(result.customShortcuts[0].name).toBe('GitHub');
    });
  });

  describe('reset()', () => {
    it('returns the defaults after reset', () => {
      const store = newStore();
      store.save({ colorScheme: 'dark', cardsVisible: false });
      const result = store.reset();
      expect(result).toEqual(DEFAULTS);
    });

    it('subsequent load() returns defaults after reset', () => {
      const store = newStore();
      store.save({ colorScheme: 'dark' });
      store.reset();
      expect(store.load()).toEqual(DEFAULTS);
    });

    it('deletes the file on disk', () => {
      const store = newStore();
      store.save({ colorScheme: 'dark' });
      store.reset();
      const filePath = path.join(tmpDir, 'ntp-customization.json');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('is safe when file does not exist (no throw)', () => {
      const store = newStore();
      expect(() => store.reset()).not.toThrow();
    });

    it('a new store after reset returns defaults', () => {
      const store = newStore();
      store.save({ colorScheme: 'dark' });
      store.reset();
      // New store reads the (now-deleted) file → defaults
      const fresh = newStore();
      expect(fresh.load().colorScheme).toBe('system');
    });
  });
});
