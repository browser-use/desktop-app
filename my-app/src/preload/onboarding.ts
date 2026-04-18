/**
 * Onboarding preload — contextBridge API for the onboarding renderer.
 *
 * Exposes a minimal, typed API surface:
 *   window.onboardingAPI.setAgentName(name)
 *   window.onboardingAPI.startOAuth(scopes)
 *   window.onboardingAPI.onOAuthCallback(cb)
 *   window.onboardingAPI.completeOnboarding(payload)
 *   window.onboardingAPI.getAgentName()
 *
 * All IPC channels are namespaced under 'onboarding:' to avoid collisions.
 *
 * D2 logging: preload logs every IPC call at debug level (scrubbed of tokens).
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { GoogleOAuthScope, AccountInfo } from '../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthCallbackPayload {
  success: boolean;
  account?: AccountInfo;
  /**
   * Full Google OAuth scope URIs that Google confirmed during token exchange.
   * Present when success is true; absent on error. Forwarded so the renderer
   * can persist the exact scopes granted (issue #221).
   */
  scopes?: GoogleOAuthScope[];
  error?: string;
}

export interface OnboardingCompletePayload {
  agent_name: string;
  account: AccountInfo;
  oauth_scopes: GoogleOAuthScope[];
}

export interface OnboardingAPI {
  /** Persist the chosen agent name to AccountStore */
  setAgentName: (name: string) => Promise<void>;

  /** Retrieve the agent name from AccountStore (null if not yet set) */
  getAgentName: () => Promise<string | null>;

  /**
   * Initiate Google OAuth flow.
   * Opens system browser; result arrives via onOAuthCallback.
   */
  startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void>;

  /** Subscribe to the OAuth callback result (one-time) */
  onOAuthCallback: (cb: (payload: OAuthCallbackPayload) => void) => () => void;

  /** Fire onboarding-complete event; main closes onboarding window, opens shell */
  completeOnboarding: (payload: OnboardingCompletePayload) => Promise<void>;
}

// ---------------------------------------------------------------------------
// contextBridge exposure
// ---------------------------------------------------------------------------

const api: OnboardingAPI = {
  setAgentName: async (name: string): Promise<void> => {
    console.debug('[onboarding-preload] setAgentName', { nameLength: name.length });
    await ipcRenderer.invoke('onboarding:set-agent-name', name);
  },

  getAgentName: async (): Promise<string | null> => {
    console.debug('[onboarding-preload] getAgentName');
    return ipcRenderer.invoke('onboarding:get-agent-name') as Promise<string | null>;
  },

  startOAuth: async (scopes: GoogleOAuthScope[]): Promise<void> => {
    console.debug('[onboarding-preload] startOAuth', { scopeCount: scopes.length });
    await ipcRenderer.invoke('onboarding:start-oauth', scopes);
  },

  onOAuthCallback: (cb: (payload: OAuthCallbackPayload) => void): (() => void) => {
    console.debug('[onboarding-preload] onOAuthCallback registered');
    const handler = (_event: Electron.IpcRendererEvent, payload: OAuthCallbackPayload) => {
      console.debug('[onboarding-preload] oauth-callback received', {
        success: payload.success,
        hasAccount: !!payload.account,
        error: payload.error,
      });
      cb(payload);
    };
    ipcRenderer.on('oauth-callback', handler);
    // Return unsubscribe
    return () => {
      ipcRenderer.removeListener('oauth-callback', handler);
    };
  },

  completeOnboarding: async (payload: OnboardingCompletePayload): Promise<void> => {
    console.debug('[onboarding-preload] completeOnboarding', {
      agentName: payload.agent_name,
      email: payload.account.email,
      scopeCount: payload.oauth_scopes.length,
    });
    await ipcRenderer.invoke('onboarding:complete', payload);
  },
};

contextBridge.exposeInMainWorld('onboardingAPI', api);

// Also expose a minimal type hint for TypeScript in renderer files
// (augment Window via the global declaration below, imported in onboarding index)
