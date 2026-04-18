// @vitest-environment jsdom
/**
 * AccountCreation unit tests — regressions for issue #218.
 *
 * Issue #218 summary: the onboarding AccountCreation screen used to render a
 * full email/password form, then silently throw the password away and show a
 * "Stored securely in your system keychain" trust signal even though no
 * credential was ever persisted. The pragmatic fix was to remove the
 * email/password form and the keychain copy entirely; the OAuth path is now
 * the only supported sign-in method.
 *
 * These tests codify that contract so no one accidentally reintroduces a
 * password field or a false keychain claim.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import React from 'react';

afterEach(() => {
  cleanup();
});

vi.mock('../../../src/renderer/design/theme.global.css', () => ({}));
vi.mock('../../../src/renderer/design/theme.onboarding.css', () => ({}));
vi.mock('../../../src/renderer/components/base/components.css', () => ({}));
vi.mock('../../../src/renderer/onboarding/onboarding.css', () => ({}));

import { AccountCreation } from '../../../src/renderer/onboarding/AccountCreation';

describe('AccountCreation (issue #218 regressions)', () => {
  it('does not render any password input', () => {
    render(<AccountCreation onBack={vi.fn()} />);
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBe(0);
  });

  it('does not render an email text field', () => {
    render(<AccountCreation onBack={vi.fn()} />);
    const emailInputs = document.querySelectorAll('input[type="email"]');
    expect(emailInputs.length).toBe(0);
  });

  it('does not render a "Create account" submit button', () => {
    render(<AccountCreation onBack={vi.fn()} />);
    const createBtn = screen.queryByRole('button', { name: /create account/i });
    expect(createBtn).toBeNull();
  });

  it('does not claim credentials are stored in the system keychain', () => {
    render(<AccountCreation onBack={vi.fn()} />);
    // The removed copy was "Stored securely in your system keychain".
    // The UI must not claim ANY form of credential storage while no
    // credential is actually being stored.
    const text = document.body.textContent ?? '';
    expect(text.toLowerCase()).not.toContain('keychain');
    expect(text.toLowerCase()).not.toContain('stored securely');
  });

  it('renders the Continue with Google OAuth button', () => {
    render(<AccountCreation onBack={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /continue with google/i });
    expect(btn).toBeTruthy();
  });

  it('renders the Back button', () => {
    const onBack = vi.fn();
    render(<AccountCreation onBack={onBack} />);
    const btn = screen.getByRole('button', { name: /^back$/i });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows an OAuth error passed in via props', () => {
    render(<AccountCreation onBack={vi.fn()} oauthError="OAuth went wrong" />);
    expect(screen.getByText(/oauth went wrong/i)).toBeTruthy();
  });

  it('does not render a "Log in" link that falsely promises sign-in', () => {
    // The old component had a "Log in" button that just set an error string
    // "Sign in coming soon." That dead-end UI has been removed with the form.
    render(<AccountCreation onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^log in$/i })).toBeNull();
  });
});
