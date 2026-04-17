/**
 * GoogleScopesModal — step 3 modal shown when user clicks "Continue with Google".
 *
 * Lists 5 Google services with descriptions. All checked by default.
 * User can uncheck any scope; unchecked scopes are excluded from OAuth request.
 *
 * Matches screenshot: icon + name + description + circular checkbox on each row.
 * Uses CSS classes from theme.onboarding.css — no hardcoded colors.
 */

import React, { useState } from 'react';
import type { GoogleOAuthScope } from '../../shared/types';

// ---------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------

interface GoogleService {
  id: string;
  name: string;
  description: string;
  scope: GoogleOAuthScope;
  iconColor: string;
  iconLabel: string;
}

const GOOGLE_SERVICES: GoogleService[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read and send emails on your behalf',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    iconColor: 'var(--color-google-gmail)',
    iconLabel: 'M',
  },
  {
    id: 'calendar',
    name: 'Google Calendar',
    description: 'View your calendar events',
    scope: 'https://www.googleapis.com/auth/calendar',
    iconColor: 'var(--color-google-calendar)',
    iconLabel: '▦',
  },
  {
    id: 'sheets',
    name: 'Sheets',
    description: 'Read your spreadsheets',
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    iconColor: 'var(--color-google-sheets)',
    iconLabel: '≡',
  },
  {
    id: 'drive',
    name: 'Google Drive',
    description: 'Read your files and documents',
    scope: 'https://www.googleapis.com/auth/drive',
    iconColor: 'var(--color-google-drive)',
    iconLabel: '△',
  },
  {
    id: 'docs',
    name: 'Docs',
    description: 'Read your documents',
    scope: 'https://www.googleapis.com/auth/documents',
    iconColor: 'var(--color-google-docs)',
    iconLabel: '≡',
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GoogleScopesModalProps {
  onConfirm: (scopes: GoogleOAuthScope[]) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GoogleScopesModal({ onConfirm, onCancel }: GoogleScopesModalProps): React.ReactElement {
  // All services checked by default
  const [checked, setChecked] = useState<Set<string>>(
    new Set(GOOGLE_SERVICES.map((s) => s.id))
  );

  function toggle(id: string): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleConfirm(): void {
    const scopes = GOOGLE_SERVICES
      .filter((s) => checked.has(s.id))
      .map((s) => s.scope);
    onConfirm(scopes);
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-panel">
        {/* Header */}
        <h2 id="modal-title" className="modal-title">Connect Google services</h2>
        <p className="modal-subtitle">
          This will help me create value for you instantly. I won't do anything without your permission.
        </p>

        {/* Service rows */}
        <div role="list" aria-label="Google services">
          {GOOGLE_SERVICES.map((service, index) => (
            <React.Fragment key={service.id}>
              {index > 0 && <div className="modal-service-divider" />}
              <div
                className="google-service-row"
                data-service={service.id}
                role="listitem"
                onClick={() => toggle(service.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(service.id);
                  }
                }}
                tabIndex={0}
                aria-label={`${service.name} — ${service.description}`}
              >
                {/* Icon */}
                <div
                  className="google-service-icon"
                  style={{ backgroundColor: service.iconColor }}
                  aria-hidden="true"
                >
                  <span
                    style={{
                      color: '#ffffff',
                      fontSize: 14,
                      fontWeight: 700,
                      lineHeight: 1,
                    }}
                  >
                    {service.iconLabel}
                  </span>
                </div>

                {/* Info */}
                <div className="google-service-info">
                  <div className="google-service-name">{service.name}</div>
                  <div className="google-service-desc">{service.description}</div>
                </div>

                {/* Checkbox */}
                <div
                  className="google-service-check"
                  data-checked={checked.has(service.id) ? 'true' : 'false'}
                  role="checkbox"
                  aria-checked={checked.has(service.id)}
                  aria-label={`${service.name} permission`}
                >
                  {checked.has(service.id) && (
                    <svg
                      width="12"
                      height="10"
                      viewBox="0 0 12 10"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M1 5l3.5 3.5L11 1"
                        stroke="#ffffff"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Scope count summary */}
        <p className="modal-scope-count" aria-live="polite">
          {checked.size} of {GOOGLE_SERVICES.length} scopes granted
        </p>

        {/* Actions */}
        <div className="modal-actions">
          <button
            type="button"
            className="google-btn"
            onClick={onCancel}
            style={{ minWidth: 80 }}
            aria-label="Cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="auth-submit"
            onClick={handleConfirm}
            style={{ minWidth: 160 }}
            aria-label="Sign in with Google"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    </div>
  );
}
