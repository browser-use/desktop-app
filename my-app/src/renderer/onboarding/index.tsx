/**
 * Onboarding renderer entry point.
 *
 * Flow state machine:
 *   welcome → naming → account → complete
 *
 * Sets data-theme="onboarding" on <html> before React mounts.
 * Handles oauth-callback IPC event from preload and advances to complete.
 *
 * Window: 920×640, resizable: false, titleBarStyle: 'hiddenInset'
 */

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { loadFonts } from '../design/fonts';
import '../design/theme.global.css';
import '../design/theme.onboarding.css';
import '../components/base/components.css';
import './onboarding.css';

import { Welcome } from './Welcome';
import { NamingFlow } from './NamingFlow';
import { AccountCreation } from './AccountCreation';

import type { GoogleOAuthScope, AccountInfo } from '../../shared/types';

// ---------------------------------------------------------------------------
// Theme activation — must happen before React mounts
// ---------------------------------------------------------------------------

document.documentElement.dataset.theme = 'onboarding';
loadFonts();

window.addEventListener('error', (e) => {
  console.error('renderer.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('renderer.unhandledrejection', { reason: String(e.reason) });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OnboardingStep = 'welcome' | 'naming' | 'account' | 'complete';

interface OnboardingState {
  step: OnboardingStep;
  agentName: string | undefined;
  account: AccountInfo | null;
  oauthScopes: GoogleOAuthScope[];
  oauthError: string | null;
}

// Extend Window for TypeScript
declare global {
  interface Window {
    onboardingAPI: {
      setAgentName: (name: string) => Promise<void>;
      getAgentName: () => Promise<string | null>;
      startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void>;
      onOAuthCallback: (cb: (payload: { success: boolean; account?: AccountInfo; error?: string }) => void) => () => void;
      completeOnboarding: (payload: {
        agent_name: string;
        account: AccountInfo;
        oauth_scopes: GoogleOAuthScope[];
      }) => Promise<void>;
    };
  }
}

// ---------------------------------------------------------------------------
// Completion screen
// ---------------------------------------------------------------------------

function CompletionScreen({ agentName }: { agentName: string }): React.ReactElement {
  return (
    <div className="completion-screen" role="main" aria-label="Onboarding complete">
      <div className="completion-checkmark" aria-hidden="true">
        <svg width="24" height="20" viewBox="0 0 24 20" fill="none">
          <path
            d="M2 10l7 7L22 2"
            stroke="var(--color-fg-inverse)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1 className="onboarding-headline" style={{ textAlign: 'center' }}>
        Welcome, {agentName}
      </h1>
      <p className="onboarding-subhead" style={{ textAlign: 'center', maxWidth: 320 }}>
        Opening your browser now&hellip;
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App component
// ---------------------------------------------------------------------------

function OnboardingApp(): React.ReactElement {
  const [state, setState] = useState<OnboardingState>({
    step: 'welcome',
    agentName: undefined,
    account: null,
    oauthScopes: [],
    oauthError: null,
  });

  // Subscribe to OAuth callback from main process
  useEffect(() => {
    if (typeof window === 'undefined' || !window.onboardingAPI) return;

    const unsub = window.onboardingAPI.onOAuthCallback((payload) => {
      console.debug('[onboarding] oauth-callback received', {
        success: payload.success,
        hasAccount: !!payload.account,
        error: payload.error,
      });

      if (payload.success && payload.account) {
        setState((prev) => ({
          ...prev,
          account: payload.account!,
          oauthError: null,
          step: 'complete',
        }));
        void completeOnboarding(
          state.agentName ?? 'Companion',
          payload.account,
          state.oauthScopes,
        );
      } else {
        setState((prev) => ({
          ...prev,
          oauthError: payload.error ?? 'Google sign-in failed. Please try again.',
        }));
      }
    });

    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.agentName, state.oauthScopes]);

  async function completeOnboarding(
    agentName: string,
    account: AccountInfo,
    scopes: GoogleOAuthScope[],
  ): Promise<void> {
    try {
      if (window.onboardingAPI) {
        await window.onboardingAPI.completeOnboarding({
          agent_name: agentName,
          account,
          oauth_scopes: scopes,
        });
      }
    } catch (err) {
      console.error('[onboarding] completeOnboarding failed', err);
    }
  }

  // -------------------------------------------------------------------------
  // Step handlers
  // -------------------------------------------------------------------------

  function handleWelcomeNext(): void {
    setState((prev) => ({ ...prev, step: 'naming' }));
  }

  async function handleNamingNext(name: string): Promise<void> {
    setState((prev) => ({ ...prev, agentName: name }));
    try {
      if (window.onboardingAPI) {
        await window.onboardingAPI.setAgentName(name);
      }
    } catch (err) {
      console.warn('[onboarding] setAgentName failed', err);
    }
    setState((prev) => ({ ...prev, step: 'account' }));
  }

  async function handleAccountComplete(
    account: AccountInfo,
    scopes: GoogleOAuthScope[],
  ): Promise<void> {
    setState((prev) => ({
      ...prev,
      account,
      oauthScopes: scopes,
      step: 'complete',
    }));
    await completeOnboarding(state.agentName ?? 'Companion', account, scopes);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const { step, agentName, oauthError } = state;

  if (step === 'complete') {
    return <CompletionScreen agentName={agentName ?? 'Companion'} />;
  }

  if (step === 'account') {
    return (
      <AccountCreation
        onBack={() => setState((prev) => ({ ...prev, step: 'naming', oauthError: null }))}
        onComplete={(account, scopes) => void handleAccountComplete(account, scopes)}
        onScopesSelected={(scopes) => setState((prev) => ({ ...prev, oauthScopes: scopes }))}
        oauthError={oauthError}
      />
    );
  }

  if (step === 'naming') {
    return (
      <NamingFlow
        onNext={(name) => void handleNamingNext(name)}
        onBack={() => setState((prev) => ({ ...prev, step: 'welcome' }))}
      />
    );
  }

  return <Welcome onNext={handleWelcomeNext} agentName={agentName} />;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const container = document.getElementById('onboarding-root');
if (!container) {
  throw new Error('[onboarding] #onboarding-root element not found in onboarding.html');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <OnboardingApp />
  </React.StrictMode>,
);
