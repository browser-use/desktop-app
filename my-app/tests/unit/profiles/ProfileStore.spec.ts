/**
 * ProfileStore unit tests.
 *
 * Tests cover:
 *   - Persistence round-trip (save → load → same data)
 *   - Default profile created when no file exists
 *   - addProfile / removeProfile mutations
 *   - Active-profile-ID (lastSelectedProfileId) persistence
 *   - showPickerOnLaunch toggle persistence
 *   - Last-profile rule: cannot remove the last remaining profile
 *   - lastSelectedProfileId is migrated when the selected profile is removed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ProfileStore, PROFILE_COLORS, PROFILES_FILE_NAME } from '../../../src/main/profiles/ProfileStore';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profilestore-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.clearAllMocks();
});

describe('ProfileStore — defaults', () => {
  it('creates a default profile when no profiles.json exists', () => {
    const store = new ProfileStore(tmpDir);
    const data = store.load();

    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].id).toBe('default');
    expect(data.profiles[0].name).toBe('Default');
    expect(PROFILE_COLORS).toContain(data.profiles[0].color);
    expect(data.lastSelectedProfileId).toBe('default');
    expect(data.showPickerOnLaunch).toBe(false);
  });

  it('persists default profile to disk on first load', () => {
    new ProfileStore(tmpDir).load();
    const filePath = path.join(tmpDir, PROFILES_FILE_NAME);
    expect(fs.existsSync(filePath)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(onDisk.profiles).toHaveLength(1);
    expect(onDisk.profiles[0].id).toBe('default');
  });
});

describe('ProfileStore — persistence round-trip', () => {
  it('round-trips an explicit save() then load() with a fresh store', () => {
    const first = new ProfileStore(tmpDir);
    const initial = first.load();
    initial.profiles.push({
      id: 'work',
      name: 'Work',
      color: '#22c55e',
      createdAt: new Date('2026-01-01').toISOString(),
    });
    first.save(initial);

    const second = new ProfileStore(tmpDir);
    const data = second.load();

    expect(data.profiles).toHaveLength(2);
    expect(data.profiles.map((p) => p.id)).toEqual(['default', 'work']);
    expect(data.profiles[1].name).toBe('Work');
    expect(data.profiles[1].color).toBe('#22c55e');
  });

  it('writes are atomic (uses tmp + rename)', () => {
    const store = new ProfileStore(tmpDir);
    store.addProfile('Foo', PROFILE_COLORS[2]);

    const filePath = path.join(tmpDir, PROFILES_FILE_NAME);
    expect(fs.existsSync(filePath)).toBe(true);

    // Verify no leftover .tmp file (rename should consume it)
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('profiles.tmp.'));
    expect(leftovers).toHaveLength(0);
  });

  it('falls back to defaults when the file is corrupt', () => {
    const filePath = path.join(tmpDir, PROFILES_FILE_NAME);
    fs.writeFileSync(filePath, '{not-json', 'utf-8');

    const store = new ProfileStore(tmpDir);
    const data = store.load();
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].id).toBe('default');
  });

  it('falls back to defaults when the profiles array is empty', () => {
    const filePath = path.join(tmpDir, PROFILES_FILE_NAME);
    fs.writeFileSync(filePath, JSON.stringify({
      profiles: [],
      showPickerOnLaunch: false,
      lastSelectedProfileId: null,
    }), 'utf-8');

    const store = new ProfileStore(tmpDir);
    const data = store.load();
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].id).toBe('default');
  });
});

describe('ProfileStore — addProfile / removeProfile', () => {
  it('addProfile assigns a unique id and persists it', () => {
    const store = new ProfileStore(tmpDir);
    const a = store.addProfile('Alice', PROFILE_COLORS[1]);
    const b = store.addProfile('Bob',   PROFILE_COLORS[3]);

    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe('Alice');
    expect(b.color).toBe(PROFILE_COLORS[3]);

    const reloaded = new ProfileStore(tmpDir).getProfiles();
    expect(reloaded).toHaveLength(3);                 // default + Alice + Bob
    expect(reloaded.map((p) => p.name)).toContain('Alice');
    expect(reloaded.map((p) => p.name)).toContain('Bob');
  });

  it('removeProfile removes a non-default profile', () => {
    const store = new ProfileStore(tmpDir);
    const added = store.addProfile('Doomed', PROFILE_COLORS[4]);
    expect(store.getProfiles()).toHaveLength(2);

    const ok = store.removeProfile(added.id);
    expect(ok).toBe(true);

    const after = new ProfileStore(tmpDir).getProfiles();
    expect(after).toHaveLength(1);
    expect(after.find((p) => p.id === added.id)).toBeUndefined();
  });

  it('removeProfile returns false when id does not exist', () => {
    const store = new ProfileStore(tmpDir);
    expect(store.removeProfile('does-not-exist')).toBe(false);
  });

  it('refuses to remove the last remaining profile', () => {
    const store = new ProfileStore(tmpDir);
    expect(store.getProfiles()).toHaveLength(1);
    expect(store.removeProfile('default')).toBe(false);
    expect(store.getProfiles()).toHaveLength(1);
  });

  it('migrates lastSelectedProfileId when the selected profile is removed', () => {
    const store = new ProfileStore(tmpDir);
    const added = store.addProfile('Selected', PROFILE_COLORS[5]);
    store.setLastSelectedProfileId(added.id);
    expect(store.getLastSelectedProfileId()).toBe(added.id);

    store.removeProfile(added.id);
    const newId = store.getLastSelectedProfileId();
    expect(newId).not.toBe(added.id);
    expect(newId).not.toBeNull();
  });
});

describe('ProfileStore — showPickerOnLaunch + active-profile persistence', () => {
  it('persists showPickerOnLaunch across reloads', () => {
    new ProfileStore(tmpDir).setShowPickerOnLaunch(true);
    expect(new ProfileStore(tmpDir).getShowPickerOnLaunch()).toBe(true);

    new ProfileStore(tmpDir).setShowPickerOnLaunch(false);
    expect(new ProfileStore(tmpDir).getShowPickerOnLaunch()).toBe(false);
  });

  it('persists lastSelectedProfileId (active-profile id) across reloads', () => {
    const store = new ProfileStore(tmpDir);
    const profile = store.addProfile('Persistent', PROFILE_COLORS[6]);
    store.setLastSelectedProfileId(profile.id);

    const reload = new ProfileStore(tmpDir);
    expect(reload.getLastSelectedProfileId()).toBe(profile.id);
  });
});

describe('ProfileStore — color palette', () => {
  it('exposes a non-empty PROFILE_COLORS palette of unique hex values', () => {
    expect(PROFILE_COLORS.length).toBeGreaterThan(0);
    const unique = new Set(PROFILE_COLORS);
    expect(unique.size).toBe(PROFILE_COLORS.length);
    for (const c of PROFILE_COLORS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
