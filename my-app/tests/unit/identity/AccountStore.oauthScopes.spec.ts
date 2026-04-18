/**
 * AccountStore OAuth scope persistence — regression for issue #221.
 *
 * Issue #221: onboarding collected full Google OAuth scope URIs from the
 * modal (e.g. "https://www.googleapis.com/auth/gmail.readonly"), but
 * AccountStore had no field for them. The settings page then read
 * account.oauth_scopes and always got undefined, so every Google service
 * rendered as "Not granted" regardless of what the user actually approved.
 *
 * This test pins the contract that AccountData.oauth_scopes round-trips
 * through save/load.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsStore = new Map<string, string>();

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: string) => { fsStore.set(p, data); }),
    readFileSync: vi.fn((p: string) => {
      const content = fsStore.get(p);
      if (!content) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    }),
    existsSync: vi.fn((p: string) => fsStore.has(p)),
    renameSync: vi.fn((src: string, dst: string) => {
      const content = fsStore.get(src);
      if (content !== undefined) {
        fsStore.set(dst, content);
        fsStore.delete(src);
      }
    }),
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((p: string, data: string) => { fsStore.set(p, data); }),
  readFileSync: vi.fn((p: string) => {
    const content = fsStore.get(p);
    if (!content) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  }),
  existsSync: vi.fn((p: string) => fsStore.has(p)),
  renameSync: vi.fn((src: string, dst: string) => {
    const content = fsStore.get(src);
    if (content !== undefined) {
      fsStore.set(dst, content);
      fsStore.delete(src);
    }
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/test-userData-oauth') },
}));

import { AccountStore } from '../../../src/main/identity/AccountStore';

describe('AccountStore.oauth_scopes (issue #221)', () => {
  let store: AccountStore;
  const TEST_PATH = '/tmp/test-userData-oauth';

  beforeEach(() => {
    fsStore.clear();
    store = new AccountStore(TEST_PATH);
  });

  it('round-trips oauth_scopes containing full Google OAuth scope URIs', () => {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
    ];
    store.save({
      agent_name: 'Atlas',
      email: 'user@example.com',
      oauth_scopes: scopes,
    });
    const loaded = store.load();
    expect(loaded?.oauth_scopes).toEqual(scopes);
  });

  it('treats oauth_scopes as optional (undefined on legacy records)', () => {
    store.save({ agent_name: 'Atlas', email: 'user@example.com' });
    const loaded = store.load();
    expect(loaded?.oauth_scopes).toBeUndefined();
  });

  it('persists an empty array as empty (distinct from "no scopes stored yet")', () => {
    store.save({
      agent_name: 'Atlas',
      email: 'user@example.com',
      oauth_scopes: [],
    });
    const loaded = store.load();
    expect(Array.isArray(loaded?.oauth_scopes)).toBe(true);
    expect(loaded?.oauth_scopes).toHaveLength(0);
  });
});
