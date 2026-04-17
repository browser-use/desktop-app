/**
 * AccountCreation — Screen 3 of onboarding.
 *
 * Email/password form + "Continue with Google" button.
 * When Continue with Google is clicked, shows the GoogleScopesModal.
 * On scope confirmation, fires startOAuth via the preload API.
 *
 * Layout matches screenshot: form on left, mascot on right, modal overlays both.
 */

import React, { useState } from 'react';
import { StepIndicator } from './StepIndicator';
import { CharacterMascot } from './CharacterMascot';
import { GoogleScopesModal } from './GoogleScopesModal';
import type { GoogleOAuthScope } from '../../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 5;
const CURRENT_STEP = 3;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AccountCreationProps {
  onBack: () => void;
  /** Called after email/password account created or OAuth callback received */
  onComplete: (account: { email: string; display_name?: string }, scopes: GoogleOAuthScope[]) => void;
  oauthError?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccountCreation({ onBack, onComplete, oauthError }: AccountCreationProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [showScopesModal, setShowScopesModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  function handleEmailSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setFormError(null);

    if (!email.trim() || !email.includes('@')) {
      setFormError('Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setFormError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    // Email/password account creation — for now, complete with local account
    // (no backend yet; tokens will be added when auth service is available)
    onComplete({ email: email.trim() }, []);
  }

  function handleGoogleClick(): void {
    setShowScopesModal(true);
  }

  async function handleScopesConfirm(scopes: GoogleOAuthScope[]): Promise<void> {
    setShowScopesModal(false);
    setIsLoading(true);

    try {
      // Start OAuth flow via preload API
      if (typeof window !== 'undefined' && (window as Window & { onboardingAPI?: { startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void> } }).onboardingAPI) {
        await (window as Window & { onboardingAPI: { startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void> } }).onboardingAPI.startOAuth(scopes);
        // The result arrives via the oauth-callback IPC event handled in index.tsx
      }
    } catch (err) {
      setFormError(`OAuth failed to start: ${(err as Error).message}`);
      setIsLoading(false);
    }
  }

  function handleScopesCancel(): void {
    setShowScopesModal(false);
  }

  const displayError = oauthError ?? formError;

  return (
    <>
      <div className="onboarding-root">
        {/* Step indicator */}
        <div
          style={{
            position: 'absolute',
            top: 24,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            zIndex: 10,
          }}
        >
          <StepIndicator step={CURRENT_STEP} total={TOTAL_STEPS} />
        </div>

        {/* Left panel */}
        <div className="onboarding-panel-left">
          <div>
            <h1 className="onboarding-headline">Let's create an account</h1>
            <p className="onboarding-subhead" style={{ marginTop: 8 }}>
              Create an account to save your preferences and continue where you left off.
            </p>
          </div>

          {/* Google button */}
          <div>
            <button
              type="button"
              className="google-btn"
              onClick={handleGoogleClick}
              disabled={isLoading}
              aria-label="Continue with Google"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
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
              {isLoading ? 'Opening browser…' : 'Continue with Google'}
            </button>
            {/* Trust signal — visible below OAuth button */}
            <p className="account-trust-signal" aria-label="Credentials are stored securely in your system keychain">
              <svg width="10" height="11" viewBox="0 0 10 11" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                <rect x="1" y="4.5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              We use Keychain to store your credentials securely
            </p>
          </div>

          {/* Divider */}
          <div className="auth-divider">or</div>

          {/* Email/password form */}
          <form className="auth-form" onSubmit={handleEmailSubmit} noValidate>
            <div className="auth-input-group">
              <label className="auth-label" htmlFor="email-input">Email</label>
              <input
                id="email-input"
                className="auth-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@email.com"
                autoComplete="email"
                aria-required="true"
              />
            </div>

            <div className="auth-input-group">
              <label className="auth-label" htmlFor="password-input">Password</label>
              <input
                id="password-input"
                className="auth-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="new-password"
                aria-required="true"
              />
            </div>

            <div className="auth-input-group">
              <label className="auth-label" htmlFor="confirm-password-input">Confirm Password</label>
              <input
                id="confirm-password-input"
                className="auth-input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                autoComplete="new-password"
                aria-required="true"
              />
            </div>

            {displayError && (
              <p
                className="onboarding-subhead"
                style={{ color: 'var(--color-status-error)' }}
                role="alert"
                aria-live="polite"
              >
                {displayError}
              </p>
            )}

            <p className="legal-text">
              By signing up you agree to our{' '}
              <a href="#terms" onClick={(e) => e.preventDefault()}>Terms of Service</a>
              {' '}and{' '}
              <a href="#privacy" onClick={(e) => e.preventDefault()}>Privacy Policy</a>.
            </p>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="google-btn"
                onClick={onBack}
                style={{ flex: 1 }}
                aria-label="Back"
              >
                Back
              </button>
              <button
                type="submit"
                className="auth-submit"
                style={{ flex: 2 }}
                aria-label="Create Account"
              >
                Create Account
              </button>
            </div>
          </form>

          <p className="auth-switch">
            Already have an account?{' '}
            <button type="button" onClick={() => setFormError('Sign in coming soon.')}>
              Log in
            </button>
          </p>
        </div>

        {/* Right panel */}
        <div className="onboarding-panel-right">
          <CharacterMascot state={isLoading ? 'loading' : 'idle'} />
        </div>
      </div>

      {/* Google Scopes Modal — rendered outside the split layout so it overlays everything */}
      {showScopesModal && (
        <GoogleScopesModal
          onConfirm={(scopes) => void handleScopesConfirm(scopes)}
          onCancel={handleScopesCancel}
        />
      )}
    </>
  );
}
