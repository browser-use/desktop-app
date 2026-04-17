/**
 * NavButtons: back, forward, reload/stop navigation controls.
 */

import React from 'react';

interface NavButtonsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  onBack: () => void;
  onForward: () => void;
  // Issue #25 — hard=true when the user shift-clicks the reload button.
  onReload: (hard: boolean) => void;
}

export function NavButtons({
  canGoBack,
  canGoForward,
  isLoading,
  onBack,
  onForward,
  onReload,
}: NavButtonsProps): React.ReactElement {
  return (
    <div className="nav-buttons">
      <button
        className="nav-buttons__btn"
        aria-label="Go back"
        disabled={!canGoBack}
        onClick={onBack}
        title="Back"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M10 12L6 8l4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button
        className="nav-buttons__btn"
        aria-label="Go forward"
        disabled={!canGoForward}
        onClick={onForward}
        title="Forward"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6 12l4-4-4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button
        className="nav-buttons__btn"
        aria-label={isLoading ? 'Stop loading' : 'Reload page'}
        onClick={(e) => onReload(e.shiftKey)}
        title={isLoading ? 'Stop (Esc)' : 'Reload (Cmd+R, Shift-click to bypass cache)'}
      >
        {isLoading ? (
          /* Stop icon */
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" opacity="0.7" />
          </svg>
        ) : (
          /* Reload icon */
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.46-3.54"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M11.5 4.5V2.5H13.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
