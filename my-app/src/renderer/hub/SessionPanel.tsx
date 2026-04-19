/**
 * SessionPanel — right-hand content area showing selected session details.
 * Displays prompt, status badge, output lines, and error block when relevant.
 * Shows an empty state when no session is selected.
 */

import React from 'react';
import type { AgentSession } from './HubApp';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_TITLE = 'No session selected' as const;
const EMPTY_BODY = 'Choose a session from the sidebar or create a new one to get started.' as const;

const BADGE_CLASS: Record<AgentSession['status'], string> = {
  running: 'session-panel__badge--running',
  done:    'session-panel__badge--done',
  error:   'session-panel__badge--error',
};

const STATUS_LABEL: Record<AgentSession['status'], string> = {
  running: 'Running',
  done:    'Done',
  error:   'Error',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SessionPanelProps {
  session: AgentSession | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionPanel({ session }: SessionPanelProps): React.ReactElement {
  if (!session) {
    return (
      <div className="hub-main">
        <div className="hub-empty" role="status" aria-label={EMPTY_TITLE}>
          <div className="hub-empty__icon" aria-hidden="true">
            <div className="hub-empty__icon-inner" />
          </div>
          <p className="hub-empty__title">{EMPTY_TITLE}</p>
          <p className="hub-empty__body">{EMPTY_BODY}</p>
        </div>
      </div>
    );
  }

  const badgeClass = BADGE_CLASS[session.status];
  const statusLabel = STATUS_LABEL[session.status];

  return (
    <div className="hub-main">
      <div className="session-panel">
        <header className="session-panel__header">
          <div className="session-panel__header-info">
            <p className="session-panel__prompt-label">Prompt</p>
            <p className="session-panel__prompt-text" title={session.prompt}>
              {session.prompt}
            </p>
          </div>
          <span className={`session-panel__badge ${badgeClass}`} aria-label={`Status: ${statusLabel}`}>
            <span className="session-panel__badge-dot" aria-hidden="true" />
            {statusLabel}
          </span>
        </header>

        <div className="session-panel__output-area" role="log" aria-live="polite" aria-label="Session output">
          {session.output.length > 0 ? (
            <>
              <div className="session-panel__output-placeholder">
                <span className="session-panel__output-placeholder-label">Output</span>
              </div>
              {session.output.map((line, i) => (
                <div key={i} className="session-panel__output-line">
                  {line}
                </div>
              ))}
              {session.status === 'running' && (
                <span className="session-panel__output-stream-cursor" aria-hidden="true" />
              )}
            </>
          ) : (
            <div className="session-panel__output-placeholder">
              <span className="session-panel__output-placeholder-label">Output</span>
              {session.status === 'running' && (
                <span className="session-panel__output-stream-cursor" aria-hidden="true" />
              )}
            </div>
          )}

          {session.status === 'error' && session.error && (
            <div className="session-panel__error-block" role="alert">
              <p className="session-panel__error-label">Error</p>
              <p className="session-panel__error-text">{session.error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SessionPanel;
