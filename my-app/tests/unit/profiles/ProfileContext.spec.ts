/**
 * ProfileContext unit tests.
 *
 * Tests cover:
 *   - getProfilePartitionName: 'default'/null → '' (default session)
 *   - getProfilePartitionName: real id → 'persist:profile-<id>'
 *   - getProfileSession returns defaultSession for 'default' / null
 *   - getProfileSession calls session.fromPartition('persist:profile-<id>') for real ids
 *   - Two distinct profile ids resolve to two distinct partitions
 *     (isolation guarantee — relies on Electron partition semantics)
 *   - getProfileDataDir: 'default' → userData; non-default → userData/profiles/<id>
 *   - createGuestPartitionName produces unique names per call
 *   - clearGuestSession invokes clearStorageData/clearCache/clearAuthCache
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const USER_DATA_PATH = path.join(os.tmpdir(), `profile-context-test-${process.pid}`);

// We hoist shared mock primitives so vi.mock factories can reference them.
const {
  fromPartitionSpy,
  defaultSessionSentinel,
  clearStorageDataSpy,
  clearCacheSpy,
  clearAuthCacheSpy,
  partitionSessions,
  getPathSpy,
} = vi.hoisted(() => {
  const partitionSessions = new Map<string, unknown>();
  const clearStorageDataSpy = vi.fn(() => Promise.resolve());
  const clearCacheSpy = vi.fn(() => Promise.resolve());
  const clearAuthCacheSpy = vi.fn(() => Promise.resolve());

  const makeSession = (label: string) => ({
    __label: label,
    clearStorageData: clearStorageDataSpy,
    clearCache: clearCacheSpy,
    clearAuthCache: clearAuthCacheSpy,
  });

  const defaultSessionSentinel = makeSession('default');

  const fromPartitionSpy = vi.fn((partition: string) => {
    if (!partitionSessions.has(partition)) {
      partitionSessions.set(partition, makeSession(partition));
    }
    return partitionSessions.get(partition);
  });

  const getPathSpy = vi.fn((_name: string) => '/tmp/will-be-overridden');

  return {
    fromPartitionSpy,
    defaultSessionSentinel,
    clearStorageDataSpy,
    clearCacheSpy,
    clearAuthCacheSpy,
    partitionSessions,
    getPathSpy,
  };
});

vi.mock('electron', () => ({
  app: { getPath: getPathSpy },
  session: {
    defaultSession: defaultSessionSentinel,
    fromPartition: fromPartitionSpy,
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
  getProfilePartitionName,
  getProfileSession,
  getProfileDataDir,
  createGuestPartitionName,
  clearGuestSession,
} from '../../../src/main/profiles/ProfileContext';

beforeEach(() => {
  fromPartitionSpy.mockClear();
  clearStorageDataSpy.mockClear();
  clearCacheSpy.mockClear();
  clearAuthCacheSpy.mockClear();
  partitionSessions.clear();
  getPathSpy.mockReset();
  getPathSpy.mockImplementation(() => USER_DATA_PATH);
});

describe('ProfileContext.getProfilePartitionName', () => {
  it('returns empty string for the default profile', () => {
    expect(getProfilePartitionName('default')).toBe('');
  });

  it('returns empty string for null (no profile)', () => {
    expect(getProfilePartitionName(null)).toBe('');
  });

  it('returns persist:profile-<id> for a non-default profile', () => {
    expect(getProfilePartitionName('work')).toBe('persist:profile-work');
    expect(getProfilePartitionName('profile-123')).toBe('persist:profile-profile-123');
  });
});

describe('ProfileContext.getProfileSession', () => {
  it('returns defaultSession for the default profile', () => {
    const sess = getProfileSession('default');
    expect(sess).toBe(defaultSessionSentinel);
    expect(fromPartitionSpy).not.toHaveBeenCalled();
  });

  it('returns defaultSession when profileId is null', () => {
    const sess = getProfileSession(null);
    expect(sess).toBe(defaultSessionSentinel);
    expect(fromPartitionSpy).not.toHaveBeenCalled();
  });

  it('resolves a non-default profile via session.fromPartition(persist:profile-<id>)', () => {
    getProfileSession('work');
    expect(fromPartitionSpy).toHaveBeenCalledWith('persist:profile-work');
  });

  it('isolation guarantee: two distinct profile ids resolve to distinct partition strings', () => {
    getProfileSession('alice');
    getProfileSession('bob');

    const calledWith = fromPartitionSpy.mock.calls.map((c) => c[0]);
    expect(calledWith).toContain('persist:profile-alice');
    expect(calledWith).toContain('persist:profile-bob');
    // Different partitions → different sessions (electron contract)
    const aliceSess = partitionSessions.get('persist:profile-alice');
    const bobSess = partitionSessions.get('persist:profile-bob');
    expect(aliceSess).toBeDefined();
    expect(bobSess).toBeDefined();
    expect(aliceSess).not.toBe(bobSess);
    expect(aliceSess).not.toBe(defaultSessionSentinel);
    expect(bobSess).not.toBe(defaultSessionSentinel);
  });
});

describe('ProfileContext.getProfileDataDir', () => {
  it('returns userData root for the default profile', () => {
    const dir = getProfileDataDir('default');
    expect(dir).toBe(USER_DATA_PATH);
  });

  it('returns userData/profiles/<id> for a non-default profile', () => {
    const dir = getProfileDataDir('alice');
    expect(dir).toBe(path.join(USER_DATA_PATH, 'profiles', 'alice'));
  });
});

describe('ProfileContext — guest mode', () => {
  it('createGuestPartitionName produces a unique name per call', () => {
    const a = createGuestPartitionName();
    const b = createGuestPartitionName();
    expect(a).not.toBe(b);
    expect(a.startsWith('guest-')).toBe(true);
    expect(b.startsWith('guest-')).toBe(true);
  });

  it('clearGuestSession clears storage / cache / auth cache', async () => {
    const partition = 'guest-test-1';
    await clearGuestSession(partition);
    expect(fromPartitionSpy).toHaveBeenCalledWith(partition);
    expect(clearStorageDataSpy).toHaveBeenCalledTimes(1);
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);
    expect(clearAuthCacheSpy).toHaveBeenCalledTimes(1);
  });

  it('clearGuestSession swallows errors instead of propagating', async () => {
    clearStorageDataSpy.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await expect(clearGuestSession('guest-error')).resolves.toBeUndefined();
  });
});
