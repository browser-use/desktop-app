/**
 * Settings IPC tests for Google scopes — regressions for issues #221 and #201.
 *
 * Covers:
 *   - settings:get-oauth-scopes reports GRANTED for scopes persisted by
 *     onboarding (full Google OAuth scope URIs), not for legacy short ids
 *     like "gmail" / "calendar" (issue #221).
 *   - settings:re-consent-scope rejects with an error rather than quietly
 *     returning OK when no real OAuth flow is wired up (issue #201 — the
 *     renderer must not be able to show a success toast).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture every handler registered via ipcMain.handle so we can invoke them
// directly in these tests.
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', () => {
  const app = {
    getPath: vi.fn().mockReturnValue('/tmp/test-userData-settings-scopes'),
  };
  const ipcMain = {
    handle: (channel: string, h: (event: unknown, ...args: unknown[]) => unknown): void => {
      handlers.set(channel, h);
    },
    on: (channel: string, h: (event: unknown, ...args: unknown[]) => unknown): void => {
      listeners.set(channel, h);
    },
    removeHandler: (channel: string): void => { handlers.delete(channel); },
    removeAllListeners: (channel: string): void => { listeners.delete(channel); },
  };
  const session = {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: (): void => undefined,
      },
    },
  };
  return {
    app,
    ipcMain,
    session,
    BrowserWindow: { getAllWindows: (): unknown[] => [] },
    dialog: {},
  };
});

// Only stub the AccountStore load() result. Other dependencies aren't
// exercised by the handlers under test.
const loadMock = vi.fn();
const accountStore = {
  load: loadMock,
  save: vi.fn(),
};

const keychainStore = {
  getToken: vi.fn(),
  setToken: vi.fn(),
};

import { registerSettingsHandlers, unregisterSettingsHandlers } from '../../../src/main/settings/ipc';

type HandlerResult = unknown;

async function invoke(channel: string, ...args: unknown[]): Promise<HandlerResult> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

describe('settings:get-oauth-scopes (issue #221)', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    loadMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSettingsHandlers({ accountStore: accountStore as any, keychainStore: keychainStore as any });
  });

  it('reports granted=true for full Google OAuth scope URIs persisted by onboarding', async () => {
    loadMock.mockReturnValue({
      agent_name: 'Atlas',
      email: 'user@example.com',
      oauth_scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar',
      ],
    });
    const result = (await invoke('settings:get-oauth-scopes')) as Array<{ scope: string; granted: boolean }>;
    const gmail    = result.find((r) => r.scope === 'https://www.googleapis.com/auth/gmail.readonly');
    const calendar = result.find((r) => r.scope === 'https://www.googleapis.com/auth/calendar');
    const drive    = result.find((r) => r.scope === 'https://www.googleapis.com/auth/drive');
    expect(gmail?.granted).toBe(true);
    expect(calendar?.granted).toBe(true);
    expect(drive?.granted).toBe(false);
  });

  it('reports granted=false for all scopes when oauth_scopes is missing from account', async () => {
    loadMock.mockReturnValue({ agent_name: 'Atlas', email: 'user@example.com' });
    const result = (await invoke('settings:get-oauth-scopes')) as Array<{ granted: boolean }>;
    expect(result.every((r) => r.granted === false)).toBe(true);
  });

  it('does NOT use legacy short ids ("gmail", "calendar", ...) as scope values', async () => {
    loadMock.mockReturnValue({ agent_name: 'Atlas', email: 'user@example.com' });
    const result = (await invoke('settings:get-oauth-scopes')) as Array<{ scope: string }>;
    // The old implementation listed short ids like "gmail" and "calendar".
    // Those ids must no longer appear: the source of truth is the full URI.
    const scopes = result.map((r) => r.scope);
    expect(scopes).not.toContain('gmail');
    expect(scopes).not.toContain('calendar');
    expect(scopes).not.toContain('drive');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar');
    expect(scopes).toContain('https://www.googleapis.com/auth/drive');
  });

  afterEach(() => {
    unregisterSettingsHandlers();
  });
});

describe('settings:re-consent-scope (issue #201)', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    loadMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSettingsHandlers({ accountStore: accountStore as any, keychainStore: keychainStore as any });
  });

  it('rejects instead of silently resolving when no OAuth flow is implemented', async () => {
    // The previous implementation returned void/undefined so the renderer
    // treated it as success. The fix is to reject so the renderer surfaces
    // an error — or, alternatively, the button is disabled on the UI side.
    await expect(invoke('settings:re-consent-scope', 'https://www.googleapis.com/auth/gmail.readonly'))
      .rejects.toThrow();
  });

  it('never falsely returns ok/void for the re-consent channel', async () => {
    let resolvedValue: unknown;
    try {
      resolvedValue = await invoke('settings:re-consent-scope', 'anything');
    } catch {
      // Expected — swallow the rejection and assert we never got a resolved value.
      return;
    }
    // If we got here, the handler resolved — that's exactly the issue #201
    // bug. Fail the test loudly.
    throw new Error(
      `settings:re-consent-scope should reject but resolved to: ${String(resolvedValue)}`,
    );
  });

  afterEach(() => {
    unregisterSettingsHandlers();
  });
});
