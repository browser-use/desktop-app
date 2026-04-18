/**
 * AccountCreation — Screen 3 of onboarding.
 *
 * Google OAuth sign-in only. Linear-inspired styling.
 */

import React, { useState } from 'react';
import { StepIndicator } from './StepIndicator';
import { CharacterMascot } from './CharacterMascot';
import { GoogleScopesModal } from './GoogleScopesModal';
import type { GoogleOAuthScope } from '../../shared/types';

const TOTAL_STEPS = 5;
const CURRENT_STEP = 3;

interface AccountCreationProps {
  onBack: () => void;
  onComplete: (account: { email: string; display_name?: string }, scopes: GoogleOAuthScope[]) => void;
  /** Called immediately when the user confirms scope selection, before OAuth redirect.
   *  Allows the parent to store the selected scopes so they are available when
   *  the OAuth callback fires asynchronously. */
  onScopesSelected?: (scopes: GoogleOAuthScope[]) => void;
  oauthError?: string | null;
}

export function AccountCreation({ onBack, onComplete: _onComplete, onScopesSelected, oauthError }: AccountCreationProps): React.ReactElement {
  const [showScopesModal, setShowScopesModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function handleGoogleClick(): void {
    setShowScopesModal(true);
  }

  async function handleScopesConfirm(scopes: GoogleOAuthScope[]): Promise<void> {
    setShowScopesModal(false);
    setIsLoading(true);

    // Propagate selected scopes to the parent immediately so they are stored in
    // state before the async OAuth callback fires.
    onScopesSelected?.(scopes);

    try {
      if (typeof window !== 'undefined' && (window as Window & { onboardingAPI?: { startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void> } }).onboardingAPI) {
        await (window as Window & { onboardingAPI: { startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void> } }).onboardingAPI.startOAuth(scopes);
      }
    } catch (err) {
      setLocalError(`OAuth failed to start: ${(err as Error).message}`);
      setIsLoading(false);
    }
  }

  function handleScopesCancel(): void {
    setShowScopesModal(false);
  }

  const displayError = oauthError ?? localError;

  return (
    <>
      <div className="onboarding-root onboarding-fade-in">
        <div
          style={{
            position: 'absolute',
            top: 20,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            zIndex: 10,
          }}
        >
          <StepIndicator step={CURRENT_STEP} total={TOTAL_STEPS} />
        </div>

        <div className="onboarding-panel-left">
          <div>
            <h1 className="onboarding-headline">Create your account</h1>
            <p className="onboarding-subhead" style={{ marginTop: 8 }}>
              Sign in to save your preferences and sync across devices.
            </p>
          </div>

          <div>
            <button
              type="button"
              className="google-btn"
              onClick={handleGoogleClick}
              disabled={isLoading}
              aria-label="Continue with Google"
              style={{ width: '100%' }}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                />
                <path
                  fill="#34A853"
                  d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
                />
                <path
                  fill="#FBBC05"
                  d="M3.964 10.706A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
                />
                <path
                  fill="#EA4335"
                  d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z"
                />
              </svg>
              {isLoading ? 'Opening browser\u2026' : 'Continue with Google'}
            </button>
          </div>

          {displayError && (
            <p
              style={{ color: 'var(--color-status-error)', fontSize: 'var(--font-size-xs)' }}
              role="alert"
              aria-live="polite"
            >
              {displayError}
            </p>
          )}

          <div style={{ marginTop: 'auto' }}>
            <button
              type="button"
              className="google-btn"
              onClick={onBack}
              style={{ width: '100%' }}
              aria-label="Back"
            >
              Back
            </button>
          </div>
        </div>

        <div className="onboarding-panel-right">
          <CharacterMascot state={isLoading ? 'loading' : 'idle'} width={180} height={200} />
        </div>
      </div>

      {showScopesModal && (
        <GoogleScopesModal
          onConfirm={(scopes) => void handleScopesConfirm(scopes)}
          onCancel={handleScopesCancel}
        />
      )}
    </>
  );
}
