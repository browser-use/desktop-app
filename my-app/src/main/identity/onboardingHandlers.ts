import { ipcMain, BrowserWindow, globalShortcut } from 'electron';
import { mainLogger } from '../logger';
import { AccountStore } from './AccountStore';
import { assertString } from '../ipc-validators';
import { createPillWindow, togglePill } from '../pill';

const GLOBAL_SHORTCUT = 'CommandOrControl+Shift+Space';

const ANTHROPIC_SERVICE = 'com.agenticbrowser.anthropic';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const API_TEST_MODEL = 'claude-haiku-4-5-20251001';
const API_TEST_TIMEOUT_MS = 8000;

export interface OnboardingHandlerDeps {
  accountStore: AccountStore;
  onboardingWindow: BrowserWindow;
  openShellWindow: () => BrowserWindow;
}

export function registerOnboardingHandlers(deps: OnboardingHandlerDeps): void {
  const { accountStore, onboardingWindow, openShellWindow } = deps;

  mainLogger.info('onboardingHandlers.register', {
    windowId: onboardingWindow.id,
  });

  ipcMain.handle('onboarding:save-api-key', async (_event, key: string) => {
    const validatedKey = assertString(key, 'key', 500);
    mainLogger.info('onboardingHandlers.saveApiKey', {
      keyLength: validatedKey.length,
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const keytar = require('keytar') as {
        setPassword(s: string, a: string, p: string): Promise<void>;
      };
      await keytar.setPassword(ANTHROPIC_SERVICE, 'default', validatedKey);
      mainLogger.info('onboardingHandlers.saveApiKey.ok');
    } catch (err) {
      mainLogger.error('onboardingHandlers.saveApiKey.failed', {
        error: (err as Error).message,
      });
      throw new Error('Failed to save API key to keychain');
    }
  });

  ipcMain.handle('onboarding:test-api-key', async (_event, key: string) => {
    const validatedKey = assertString(key, 'key', 500);
    mainLogger.info('onboardingHandlers.testApiKey', {
      keyLength: validatedKey.length,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TEST_TIMEOUT_MS);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': validatedKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: API_TEST_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        mainLogger.info('onboardingHandlers.testApiKey.ok');
        return { success: true };
      }

      let errorMsg = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body?.error?.message) errorMsg = body.error.message;
      } catch {
        // ignore parse error
      }

      mainLogger.warn('onboardingHandlers.testApiKey.failed', {
        status: response.status,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = (err as Error).message ?? 'Network error';
      mainLogger.warn('onboardingHandlers.testApiKey.exception', { error: msg });
      return { success: false, error: msg };
    }
  });

  let pillCreated = false;
  let currentAccelerator = GLOBAL_SHORTCUT;

  const registerOnboardingShortcut = (accelerator: string): boolean => {
    if (!pillCreated) {
      const pill = createPillWindow();
      pill.on('show', () => {
        if (!onboardingWindow.isDestroyed()) {
          onboardingWindow.webContents.send('pill-shown');
        }
      });
      pill.on('hide', () => {
        if (!onboardingWindow.isDestroyed()) {
          onboardingWindow.webContents.send('pill-hidden');
        }
      });
      pillCreated = true;
      mainLogger.info('onboardingHandlers.pillCreated');
    }

    globalShortcut.unregister(currentAccelerator);
    const ok = globalShortcut.register(accelerator, () => {
      mainLogger.info('onboardingHandlers.shortcutFired', { accelerator });
      togglePill();
      if (!onboardingWindow.isDestroyed()) {
        onboardingWindow.webContents.send('shortcut-activated');
      }
    });
    if (ok) currentAccelerator = accelerator;
    return ok;
  };

  ipcMain.handle('onboarding:listen-shortcut', () => {
    mainLogger.info('onboardingHandlers.listenShortcut');
    const ok = registerOnboardingShortcut(GLOBAL_SHORTCUT);
    return { ok, accelerator: GLOBAL_SHORTCUT };
  });

  ipcMain.handle('onboarding:set-shortcut', (_event, accelerator: string) => {
    const validated = assertString(accelerator, 'accelerator', 100);
    mainLogger.info('onboardingHandlers.setShortcut', { accelerator: validated });
    const ok = registerOnboardingShortcut(validated);
    return { ok, accelerator: ok ? validated : currentAccelerator };
  });

  ipcMain.handle('onboarding:complete', async () => {
    mainLogger.info('onboardingHandlers.complete');

    const existing = accountStore.load();
    accountStore.save({
      agent_name: existing?.agent_name ?? '',
      email: existing?.email ?? '',
      created_at: existing?.created_at,
      onboarding_completed_at: new Date().toISOString(),
    });

    mainLogger.info('onboardingHandlers.complete.accountSaved');

    await new Promise((resolve) => setTimeout(resolve, 400));

    const shell = openShellWindow();
    mainLogger.info('onboardingHandlers.complete.shellOpened', {
      shellWindowId: shell.id,
    });

    if (!onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
      mainLogger.info('onboardingHandlers.complete.onboardingWindowClosed');
    }
  });

  mainLogger.info('onboardingHandlers.register.done');
}

export function unregisterOnboardingHandlers(): void {
  ipcMain.removeHandler('onboarding:save-api-key');
  ipcMain.removeHandler('onboarding:test-api-key');
  ipcMain.removeHandler('onboarding:listen-shortcut');
  ipcMain.removeHandler('onboarding:set-shortcut');
  ipcMain.removeHandler('onboarding:complete');
  mainLogger.info('onboardingHandlers.unregistered');
}
