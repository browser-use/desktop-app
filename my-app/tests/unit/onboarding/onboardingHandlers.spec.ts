/**
 * onboardingHandlers unit tests — regression for issue #221.
 *
 * The onboarding:complete IPC handler used to call AccountStore.save without
 * the oauth_scopes field, so any scopes the user approved in the Google
 * scopes modal were silently dropped. This test pins the contract that
 * onboarding:complete persists oauth_scopes alongside the rest of the
 * account record.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, h: (event: unknown, ...args: unknown[]) => unknown): void => {
      handlers.set(channel, h);
    },
    removeHandler: (channel: string): void => { handlers.delete(channel); },
  },
  BrowserWindow: class {
    id = 1;
    isDestroyed(): boolean { return false; }
    close(): void { /* noop */ }
    webContents = { send: vi.fn() };
  },
}));

import { registerOnboardingHandlers, unregisterOnboardingHandlers } from '../../../src/main/identity/onboardingHandlers';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

function handlerFor(channel: string): HandlerFn {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}`);
  return h;
}

describe('onboardingHandlers.complete (issue #221)', () => {
  const accountSave = vi.fn();
  const accountLoad = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountStore: any = { save: accountSave, load: accountLoad };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oauthClient: any = { startAuthFlow: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onboardingWindow: any = {
    id: 1,
    isDestroyed: () => false,
    close: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const openShellWindow = vi.fn(() => ({ id: 2 }));

  beforeEach(() => {
    handlers.clear();
    accountSave.mockReset();
    accountLoad.mockReset();
    openShellWindow.mockClear();
    registerOnboardingHandlers({
      accountStore,
      oauthClient,
      onboardingWindow,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openShellWindow: openShellWindow as any,
    });
  });

  it('persists oauth_scopes in the account record on completion', async () => {
    accountLoad.mockReturnValue(null);
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
    ];
    await handlerFor('onboarding:complete')({}, {
      agent_name: 'Atlas',
      account: { email: 'user@example.com' },
      oauth_scopes: scopes,
    });
    expect(accountSave).toHaveBeenCalledTimes(1);
    const saved = accountSave.mock.calls[0][0];
    expect(saved.oauth_scopes).toEqual(scopes);
    expect(saved.agent_name).toBe('Atlas');
    expect(saved.email).toBe('user@example.com');
    expect(saved.onboarding_completed_at).toBeDefined();
  });

  it('persists an empty oauth_scopes array when the user declined every Google service', async () => {
    accountLoad.mockReturnValue(null);
    await handlerFor('onboarding:complete')({}, {
      agent_name: 'Atlas',
      account: { email: 'user@example.com' },
      oauth_scopes: [],
    });
    const saved = accountSave.mock.calls[0][0];
    expect(Array.isArray(saved.oauth_scopes)).toBe(true);
    expect(saved.oauth_scopes).toHaveLength(0);
  });

  it('preserves existing oauth_scopes when re-saving via set-agent-name', () => {
    accountLoad.mockReturnValue({
      agent_name: 'Atlas',
      email: 'user@example.com',
      oauth_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    handlerFor('onboarding:set-agent-name')({}, 'Atlas-2');
    const saved = accountSave.mock.calls[0][0];
    expect(saved.oauth_scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
  });

  afterEach(() => {
    unregisterOnboardingHandlers();
  });
});
