/**
 * SignOutDialog — Chrome-parity sign-out prompt.
 *
 * Offers two choices on sign-out:
 *   1. "Clear data"      — revokes tokens AND removes local copies of synced data
 *   2. "Keep local data" — revokes tokens but retains bookmarks/history/passwords
 *
 * Also exposes a "Turn off sync" action that disables sync while keeping
 * the Google account association (distinct from full sign-out).
 */

import React, { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

declare const electronAPI: {
  identity: {
    signOut: (mode: 'clear' | 'keep') => Promise<{
      success: boolean;
      mode: string;
      tokenRevoked: boolean;
      dataCleared: boolean;
      errors: string[];
    }>;
    turnOffSync: () => Promise<{ success: boolean }>;
    getAccountInfo: () => Promise<{ email: string; agentName: string } | null>;
  };
};

interface SignOutDialogProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SignOutDialog({ open, onClose }: SignOutDialogProps): React.ReactElement | null {
  const [email, setEmail] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);

    console.log('[SignOutDialog] Loading account info');
    electronAPI.identity.getAccountInfo().then((info) => {
      console.log('[SignOutDialog] Account info loaded', { hasEmail: !!info?.email });
      setEmail(info?.email ?? '');
    }).catch((err) => {
      console.error('[SignOutDialog] Failed to load account info:', err);
      setEmail('');
    });
  }, [open]);

  const handleSignOut = useCallback(async (mode: 'clear' | 'keep') => {
    console.log('[SignOutDialog] Sign out requested', { mode });
    setBusy(true);
    setError(null);

    try {
      const result = await electronAPI.identity.signOut(mode);
      console.log('[SignOutDialog] Sign out result', {
        success: result.success,
        mode: result.mode,
        tokenRevoked: result.tokenRevoked,
        dataCleared: result.dataCleared,
        errorCount: result.errors.length,
      });

      if (!result.success) {
        setError('Sign out failed. Please try again.');
        setBusy(false);
      }
    } catch (err) {
      console.error('[SignOutDialog] Sign out error:', err);
      setError((err as Error).message ?? 'Sign out failed');
      setBusy(false);
    }
  }, []);

  const handleTurnOffSync = useCallback(async () => {
    console.log('[SignOutDialog] Turn off sync requested');
    setBusy(true);
    setError(null);

    try {
      const result = await electronAPI.identity.turnOffSync();
      console.log('[SignOutDialog] Turn off sync result', { success: result.success });
      if (result.success) {
        onClose();
      } else {
        setError('Failed to turn off sync.');
      }
    } catch (err) {
      console.error('[SignOutDialog] Turn off sync error:', err);
      setError((err as Error).message ?? 'Failed to turn off sync');
    } finally {
      setBusy(false);
    }
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      onClose();
    }
  }, [busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="sod-scrim"
      role="presentation"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="sod-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Sign out"
      >
        {/* Header */}
        <div className="sod-header">
          <h2 className="sod-title">Sign out</h2>
          <button
            type="button"
            className="sod-close-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M1 1L13 13M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Account info */}
        {email && (
          <p className="sod-account">
            Signed in as <strong>{email}</strong>
          </p>
        )}

        <p className="sod-desc">
          This will sign you out and revoke your access tokens.
          Choose what happens to your local data:
        </p>

        {/* Action buttons */}
        <div className="sod-actions">
          <button
            type="button"
            className="sod-btn sod-btn--danger"
            onClick={() => void handleSignOut('clear')}
            disabled={busy}
          >
            <svg className="sod-btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="sod-btn-text">
              <span className="sod-btn-label">Clear data</span>
              <span className="sod-btn-desc">Remove local copies of synced data (bookmarks, history, passwords)</span>
            </span>
          </button>

          <button
            type="button"
            className="sod-btn sod-btn--keep"
            onClick={() => void handleSignOut('keep')}
            disabled={busy}
          >
            <svg className="sod-btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="sod-btn-text">
              <span className="sod-btn-label">Keep local data</span>
              <span className="sod-btn-desc">Retain bookmarks, history, and passwords on this device</span>
            </span>
          </button>
        </div>

        {/* Divider + Turn off sync */}
        <div className="sod-divider" />

        <button
          type="button"
          className="sod-sync-btn"
          onClick={() => void handleTurnOffSync()}
          disabled={busy}
        >
          Turn off sync
          <span className="sod-sync-desc">Stop syncing but stay signed in to your Google Account</span>
        </button>

        {/* Error display */}
        {error && (
          <p className="sod-error" role="alert">
            {error}
          </p>
        )}

        {/* Loading indicator */}
        {busy && (
          <div className="sod-loading" aria-live="polite">
            Signing out...
          </div>
        )}
      </div>
    </div>
  );
}

export default SignOutDialog;
