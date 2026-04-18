/**
 * GoogleScopesModal component tests — written FIRST per D1 (TDD).
 *
 * Tests cover:
 *   - Renders modal title "Connect Google services"
 *   - Renders all 5 service rows (Gmail, Google Calendar, Sheets, Google Drive, Docs)
 *   - All checkboxes checked by default
 *   - Clicking a service row toggles its checked state
 *   - Unchecking a scope removes it from the passed scope list on confirm
 *   - "Cancel" button fires onCancel
 *   - "Sign in with Google" fires onConfirm with currently selected scopes
 *   - Confirming with all 5 checked passes all 5 scopes
 *   - Confirming with none checked passes empty array (edge case)
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import React from 'react';
import type { GoogleOAuthScope } from '../../../src/shared/types';

vi.mock('../../../src/renderer/design/theme.global.css', () => ({}));
vi.mock('../../../src/renderer/design/theme.onboarding.css', () => ({}));
vi.mock('../../../src/renderer/components/base/components.css', () => ({}));
vi.mock('../../../src/renderer/onboarding/onboarding.css', () => ({}));

import { GoogleScopesModal } from '../../../src/renderer/onboarding/GoogleScopesModal';

const ALL_SCOPES: GoogleOAuthScope[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

describe('GoogleScopesModal', () => {
  it('renders the modal title', () => {
    render(<GoogleScopesModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/connect google services/i)).toBeTruthy();
  });

  it('renders all 5 service rows', () => {
    render(<GoogleScopesModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    // Use exact text matches for service names to avoid matching description text
    expect(screen.getByText('Gmail')).toBeTruthy();
    expect(screen.getByText('Google Calendar')).toBeTruthy();
    expect(screen.getByText('Sheets')).toBeTruthy();
    expect(screen.getByText('Google Drive')).toBeTruthy();
    expect(screen.getByText('Docs')).toBeTruthy();
  });

  it('renders Cancel and Sign in with Google buttons', () => {
    render(<GoogleScopesModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeTruthy();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<GoogleScopesModal onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm with all 5 scopes when nothing is unchecked', () => {
    const onConfirm = vi.fn();
    render(<GoogleScopesModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const passedScopes: GoogleOAuthScope[] = onConfirm.mock.calls[0][0];
    expect(passedScopes).toHaveLength(5);
    for (const scope of ALL_SCOPES) {
      expect(passedScopes).toContain(scope);
    }
  });

  it('all service rows start with checked indicators', () => {
    render(<GoogleScopesModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    // Each row has a check indicator with data-checked="true"
    const checks = document.querySelectorAll('[data-checked="true"]');
    expect(checks.length).toBe(5);
  });

  it('toggling Gmail row unchecks it (data-checked becomes false)', () => {
    render(<GoogleScopesModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    // Click the Gmail row
    fireEvent.click(screen.getByText(/gmail/i).closest('[data-service]') ?? screen.getByText(/gmail/i));
    const checks = document.querySelectorAll('[data-checked="true"]');
    expect(checks.length).toBe(4);
  });

  it('unchecking Gmail removes its scope from onConfirm args', () => {
    const onConfirm = vi.fn();
    render(<GoogleScopesModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    // Toggle Gmail off
    const gmailRow = screen.getByText(/gmail/i).closest('[data-service]') ?? screen.getByText(/gmail/i);
    fireEvent.click(gmailRow);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    const passedScopes: GoogleOAuthScope[] = onConfirm.mock.calls[0][0];
    expect(passedScopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(passedScopes).toHaveLength(4);
  });

  it('unchecking all services calls onConfirm with empty array', () => {
    const onConfirm = vi.fn();
    render(<GoogleScopesModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    // Toggle all 5 off
    const allRows = document.querySelectorAll('[data-service]');
    allRows.forEach((row) => fireEvent.click(row));
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    const passedScopes: GoogleOAuthScope[] = onConfirm.mock.calls[0][0];
    expect(passedScopes).toHaveLength(0);
  });

  it('re-toggling a service back to checked re-adds the scope', () => {
    const onConfirm = vi.fn();
    render(<GoogleScopesModal onConfirm={onConfirm} onCancel={vi.fn()} />);
    const gmailRow = screen.getByText(/gmail/i).closest('[data-service]') ?? screen.getByText(/gmail/i);
    // Uncheck then re-check
    fireEvent.click(gmailRow);
    fireEvent.click(gmailRow);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    const passedScopes: GoogleOAuthScope[] = onConfirm.mock.calls[0][0];
    expect(passedScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });
});
