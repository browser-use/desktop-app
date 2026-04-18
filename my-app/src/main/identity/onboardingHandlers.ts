/**
 * onboardingHandlers.ts — IPC handler registration for the onboarding flow.
 *
 * Registers ipcMain.handle() calls for all channels exposed by src/preload/onboarding.ts:
 *   onboarding:set-agent-name   → AccountStore.save({ agent_name })
 *   onboarding:get-agent-name   → AccountStore.load()?.agent_name
 *   onboarding:start-oauth      → OAuthClient.startAuthFlow(scopes)
 *   onboarding:complete         → AccountStore.save({ onboarding_completed_at }),
 *                                  emit onboarding-complete, close onboarding window,
 *                                  open shell window
 *
 * Call registerOnboardingHandlers() once from main/index.ts inside app.whenReady().
 *
 * D2 logging: every handler entry and exit is logged. Agent name is logged;
 *   email is logged; tokens and passwords are NEVER logged.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { mainLogger } from '../logger';
import { AccountStore } from './AccountStore';
import { OAuthClient } from './OAuthClient';
import type { GoogleOAuthScope, AccountInfo } from '../../shared/types';

// Structural type matching what the onboarding preload sends.
// Also re-exported as `OnboardingCompletePayload` so earlier consumers
// that imported from this module keep compiling.
export interface OnboardingCompletePayload {
  agent_name: string;
  account: AccountInfo;
  oauth_scopes: GoogleOAuthScope[];
}
type CompletePayload = OnboardingCompletePayload;

export interface OnboardingHandlerDeps {
  accountStore: AccountStore;
  oauthClient: OAuthClient;
  onboardingWindow: BrowserWindow;
  /** Factory that creates (or returns existing) shell window after onboarding */
  openShellWindow: () => BrowserWindow;
}

export function registerOnboardingHandlers(deps: OnboardingHandlerDeps): void {
  const { accountStore, oauthClient, onboardingWindow, openShellWindow } = deps;

  mainLogger.info('onboardingHandlers.register', {
    windowId: onboardingWindow.id,
  });

  // -------------------------------------------------------------------------
  // onboarding:set-agent-name
  // -------------------------------------------------------------------------

  ipcMain.handle('onboarding:set-agent-name', (_event, name: string) => {
    mainLogger.debug('onboardingHandlers.setAgentName', {
      nameLength: name?.length ?? 0,
    });

    const existing = accountStore.load();
    accountStore.save({
      agent_name: name,
      email: existing?.email ?? '',
      created_at: existing?.created_at,
      onboarding_completed_at: existing?.onboarding_completed_at,
      oauth_scopes: existing?.oauth_scopes,
    });

    mainLogger.debug('onboardingHandlers.setAgentName.ok', {
      agentName: name,
    });
  });

  // -------------------------------------------------------------------------
  // onboarding:get-agent-name
  // -------------------------------------------------------------------------

  ipcMain.handle('onboarding:get-agent-name', () => {
    mainLogger.debug('onboardingHandlers.getAgentName');
    const data = accountStore.load();
    mainLogger.debug('onboardingHandlers.getAgentName.result', {
      hasName: !!data?.agent_name,
    });
    return data?.agent_name ?? null;
  });

  // -------------------------------------------------------------------------
  // onboarding:start-oauth
  // -------------------------------------------------------------------------

  ipcMain.handle('onboarding:start-oauth', async (_event, scopes: GoogleOAuthScope[]) => {
    mainLogger.info('onboardingHandlers.startOAuth', {
      scopeCount: scopes.length,
    });

    try {
      await oauthClient.startAuthFlow(scopes);
      mainLogger.info('onboardingHandlers.startOAuth.browserOpened');
    } catch (err) {
      mainLogger.error('onboardingHandlers.startOAuth.failed', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // onboarding:complete
  // -------------------------------------------------------------------------

  ipcMain.handle('onboarding:complete', async (_event, payload: CompletePayload) => {
    mainLogger.info('onboardingHandlers.complete', {
      agentName: payload.agent_name,
      email: payload.account.email,
      scopeCount: payload.oauth_scopes.length,
    });

    // Persist completed state with timestamp. Store the full OAuth scope URIs
    // (issue #221) so Settings → Google Scopes can reflect grants accurately
    // across restarts.
    const existing = accountStore.load();
    accountStore.save({
      agent_name: payload.agent_name,
      email: payload.account.email,
      created_at: existing?.created_at,
      onboarding_completed_at: new Date().toISOString(),
      oauth_scopes: payload.oauth_scopes,
    });

    mainLogger.info('onboardingHandlers.complete.accountSaved', {
      agentName: payload.agent_name,
      email: payload.account.email,
      scopeCount: payload.oauth_scopes.length,
    });

    // Small delay to let the completion animation play
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Open shell window
    const shell = openShellWindow();
    mainLogger.info('onboardingHandlers.complete.shellOpened', {
      shellWindowId: shell.id,
    });

    // Close onboarding window
    if (!onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
      mainLogger.info('onboardingHandlers.complete.onboardingWindowClosed');
    }
  });

  mainLogger.info('onboardingHandlers.register.done');
}

/**
 * Remove all onboarding IPC handlers (call when onboarding window is closed).
 */
export function unregisterOnboardingHandlers(): void {
  ipcMain.removeHandler('onboarding:set-agent-name');
  ipcMain.removeHandler('onboarding:get-agent-name');
  ipcMain.removeHandler('onboarding:start-oauth');
  ipcMain.removeHandler('onboarding:complete');
  mainLogger.info('onboardingHandlers.unregistered');
}
