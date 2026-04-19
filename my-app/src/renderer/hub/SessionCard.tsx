/**
 * SessionCard — compact sidebar card showing session summary.
 * Status dot: green=running, blue=done, red=error.
 */

import React from 'react';
import type { AgentSession } from './HubApp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

const STATUS_DOT_CLASS: Record<AgentSession['status'], string> = {
  running: 'session-card__status-dot--running',
  done:    'session-card__status-dot--done',
  error:   'session-card__status-dot--error',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SessionCardProps {
  session: AgentSession;
  isSelected: boolean;
  onClick: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionCard({ session, isSelected, onClick }: SessionCardProps): React.ReactElement {
  const dotClass = STATUS_DOT_CLASS[session.status];
  const elapsed = formatElapsed(session.createdAt);

  return (
    <button
      className={`session-card${isSelected ? ' session-card--selected' : ''}`}
      onClick={onClick}
      title={session.prompt}
      aria-selected={isSelected}
      aria-label={`Session: ${session.prompt}, status: ${session.status}`}
    >
      <span className={`session-card__status-dot ${dotClass}`} aria-hidden="true" />
      <span className="session-card__body">
        <span className="session-card__prompt">{session.prompt}</span>
        <span className="session-card__meta">
          <span className="session-card__status-label">{session.status}</span>
          <span className="session-card__elapsed">{elapsed}</span>
        </span>
      </span>
    </button>
  );
}

export default SessionCard;
