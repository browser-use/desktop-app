/**
 * Sidebar — left panel with session list and new-session input.
 * Header shows app title. Bottom has a textarea + submit button.
 */

import React, { useCallback, useRef, useState } from 'react';
import { SessionCard } from './SessionCard';
import type { AgentSession } from './HubApp';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_TITLE = 'Agent Hub' as const;
const INPUT_PLACEHOLDER = 'New task…' as const;
const SUBMIT_LABEL = 'Start session' as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  sessions: AgentSession[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (prompt: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
}: SidebarProps): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    console.log('[Sidebar] handleSubmit', { prompt: trimmed });
    onCreateSession(trimmed);
    setPrompt('');
    textareaRef.current?.focus();
  }, [prompt, onCreateSession]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <aside className="hub-sidebar" aria-label="Sessions sidebar">
      <header className="hub-sidebar__header">
        <span className="hub-sidebar__title">{APP_TITLE}</span>
      </header>

      <div className="hub-sidebar__session-list" role="list" aria-label="Session list">
        {sessions.length === 0 ? (
          <div className="hub-sidebar__empty">
            <p className="hub-sidebar__empty-text">No sessions yet. Start one below.</p>
          </div>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              onClick={() => onSelectSession(session.id)}
            />
          ))
        )}
      </div>

      <div className="hub-sidebar__input-area">
        <p className="hub-sidebar__input-label">New session</p>
        <div className="hub-sidebar__input-wrapper">
          <textarea
            ref={textareaRef}
            className="hub-sidebar__input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={INPUT_PLACEHOLDER}
            rows={2}
            aria-label="New session prompt"
          />
          <button
            className="hub-sidebar__submit"
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            aria-label={SUBMIT_LABEL}
            title="Start session (Enter)"
          >
            ↑
          </button>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
