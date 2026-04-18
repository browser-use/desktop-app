// @vitest-environment jsdom
/**
 * Settings → Google Scopes tab UI — regression for issue #201.
 *
 * The re-consent control must not produce a false "Re-consent initiated"
 * toast while the main-process handler is a stub. It is rendered disabled
 * with an explanatory tooltip until a real OAuth re-consent flow ships.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import React from 'react';

afterEach(() => {
  cleanup();
});

vi.mock('../../../src/renderer/design/theme.global.css', () => ({}));
vi.mock('../../../src/renderer/design/theme.onboarding.css', () => ({}));
vi.mock('../../../src/renderer/components/base/components.css', () => ({}));
vi.mock('../../../src/renderer/settings/settings.css', () => ({}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsAPI: any = {
  getOAuthScopes: vi.fn(async () => [
    { scope: 'https://www.googleapis.com/auth/gmail.readonly', label: 'Gmail', granted: true },
    { scope: 'https://www.googleapis.com/auth/calendar',        label: 'Google Calendar', granted: false },
  ]),
  reConsentScope: vi.fn(async () => {
    throw new Error('reConsentScope must NOT be called while the feature is disabled (issue #201).');
  }),
};

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).settingsAPI = settingsAPI;
  settingsAPI.getOAuthScopes.mockClear();
  settingsAPI.reConsentScope.mockClear();
});

import { ToastProvider } from '../../../src/renderer/components/base';
import { GoogleScopesTab } from '../../../src/renderer/settings/SettingsApp';

function renderTab(): void {
  render(
    <ToastProvider>
      <GoogleScopesTab />
    </ToastProvider>,
  );
}

describe('GoogleScopesTab (issue #201)', () => {
  it('renders "Re-consent" buttons but they are disabled', async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /re-consent/i }).length).toBeGreaterThan(0);
    });
    const buttons = screen.getAllByRole('button', { name: /re-consent/i });
    for (const btn of buttons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('clicking a disabled Re-consent button never calls settingsAPI.reConsentScope', async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /re-consent/i }).length).toBeGreaterThan(0);
    });
    const buttons = screen.getAllByRole('button', { name: /re-consent/i });
    for (const btn of buttons) {
      fireEvent.click(btn);
    }
    expect(settingsAPI.reConsentScope).not.toHaveBeenCalled();
  });

  it('does not show a "Re-consent initiated" success toast', async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /re-consent/i }).length).toBeGreaterThan(0);
    });
    const buttons = screen.getAllByRole('button', { name: /re-consent/i });
    for (const btn of buttons) {
      fireEvent.click(btn);
    }
    expect(document.body.textContent ?? '').not.toMatch(/re-consent initiated/i);
  });

  it('reflects the granted status returned by getOAuthScopes', async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /re-consent/i }).length).toBeGreaterThan(0);
    });
    // Gmail is granted, Calendar is not.
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/granted/i);
    expect(text).toMatch(/not granted/i);
  });
});
