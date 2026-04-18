/**
 * AccountCreation — Screen 3 of onboarding.
 *
 * Google OAuth + email/password form. Linear-inspired styling.
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
  oauthError?: string | null;
}

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

    onComplete({ email: email.trim() }, []);
  }

  function handleGoogleClick(): void {
    setShowScopesModal(true);
  }

  async function handleScopesConfirm(scopes: GoogleOAuthScope[]): Promise<void> {
    setShowScopesModal(false);
    setIsLoading(true);

    try {
      if (typeof window !== 'undefined' && (window as Window & { onboardingAPI?: { startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void> } }).onboardingAPI) {
        await (window as Window & { onboardingAPI: { startOAuth: (scopes: GoogleOAuthScope[]) => Promise<void> } }).onboardingAPI.startOAuth(scopes);
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
            <p className="account-trust-signal" aria-label="Credentials stored securely">
              <svg width="10" height="11" viewBox="0 0 10 11" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                <rect x="1" y="4.5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              Stored securely in your system keychain
            </p>
          </div>

          <div className="auth-divider">or</div>

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
                placeholder="At least 8 characters"
                autoComplete="new-password"
                aria-required="true"
              />
            </div>

            <div className="auth-input-group">
              <label className="auth-label" htmlFor="confirm-password-input">Confirm password</label>
              <input
                id="confirm-password-input"
                className="auth-input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your password"
                autoComplete="new-password"
                aria-required="true"
              />
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
                Create account
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
