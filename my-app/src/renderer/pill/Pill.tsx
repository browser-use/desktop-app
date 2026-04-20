import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

declare global {
  interface Window {
    pillAPI: {
      submit: (prompt: string) => Promise<{ task_id: string }>;
      hide: () => void;
      setExpanded: (expanded: boolean | number) => void;
      listSessions: () => Promise<Array<{ id: string; prompt: string; status: string; createdAt: number }>>;
      selectSession: (id: string) => void;
      followUpSubmit: (sessionId: string, prompt: string) => Promise<{ resumed?: boolean; error?: string }>;
      onFollowUpMode: (cb: (data: { sessionId: string; sessionPrompt: string }) => void) => () => void;
    };
  }
}

interface SessionLite {
  id: string;
  prompt: string;
  status: string;
  createdAt: number;
}

function ArrowUpIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12V3M3 6.5L7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fuzzyMatch(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => lower.includes(t));
}

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function statusDot(status: string): string {
  switch (status) {
    case 'running': return 'cmdbar__dot--running';
    case 'stuck': return 'cmdbar__dot--stuck';
    case 'idle': return 'cmdbar__dot--idle';
    case 'draft': return 'cmdbar__dot--draft';
    default: return 'cmdbar__dot--stopped';
  }
}

export function Pill(): React.ReactElement {
  const [value, setValue] = useState('');
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [followUp, setFollowUp] = useState<{ sessionId: string; sessionPrompt: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 50);
    window.pillAPI.listSessions().then(setSessions).catch(() => {});
    const unsub = window.pillAPI.onFollowUpMode((data) => {
      setFollowUp(data);
      setValue('');
      setTimeout(() => ref.current?.focus(), 50);
    });
    return unsub;
  }, []);

  useEffect(() => {
    setSelectedIdx(0);
  }, [value]);

  const results = useMemo(() => {
    if (!value.trim()) return [];
    return sessions
      .filter((s) => fuzzyMatch(value, s.prompt))
      .slice(0, 8);
  }, [value, sessions]);

  const hasResults = results.length > 0;

  useEffect(() => {
    const baseHeight = 110;
    const resultHeight = hasResults ? Math.min(results.length + 1, 9) * 36 + 2 : 0;
    window.pillAPI.setExpanded(baseHeight + resultHeight);
  }, [hasResults, results.length]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (followUp) {
      window.pillAPI.followUpSubmit(followUp.sessionId, trimmed);
      setValue('');
      setFollowUp(null);
      window.pillAPI.hide();
      return;
    }
    if (hasResults && selectedIdx === 0) {
      window.pillAPI.submit(trimmed);
      setValue('');
      return;
    }
    if (hasResults && selectedIdx > 0 && selectedIdx <= results.length) {
      window.pillAPI.selectSession(results[selectedIdx - 1].id);
      setValue('');
      return;
    }
    window.pillAPI.submit(trimmed);
    setValue('');
  }, [value, hasResults, selectedIdx, results, followUp]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (followUp) {
          setFollowUp(null);
          setValue('');
        } else {
          window.pillAPI.hide();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) { window.pillAPI.submit(trimmed); setValue(''); }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit, value, results.length],
  );

  return (
    <div className="cmdbar__scrim" onClick={() => window.pillAPI.hide()}>
      <div className="cmdbar" onClick={(e) => e.stopPropagation()}>
        <div className="cmdbar__input-row">
          <textarea
            ref={ref}
            className="cmdbar__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={followUp ? `Follow up on: ${followUp.sessionPrompt.slice(0, 40)}${followUp.sessionPrompt.length > 40 ? '...' : ''}` : 'Search sessions or create new agent...'}
            rows={1}
            aria-label="Search or create"
          />
          <button
            className="cmdbar__send"
            onClick={submit}
            disabled={!value.trim()}
            aria-label="Submit"
          >
            <ArrowUpIcon />
          </button>
        </div>

        {hasResults && !followUp && (
          <div className="cmdbar__results">
            <button
              className={`cmdbar__result cmdbar__result--create${selectedIdx === 0 ? ' cmdbar__result--active' : ''}`}
              onClick={submit}
              onMouseEnter={() => setSelectedIdx(0)}
            >
              <span className="cmdbar__result-create-icon">+</span>
              <span className="cmdbar__result-prompt">New agent: &ldquo;{value}&rdquo;</span>
              <kbd className="cmdbar__result-kbd">{'\u2318\u21B5'}</kbd>
            </button>
            {results.map((s, i) => (
              <button
                key={s.id}
                className={`cmdbar__result${i + 1 === selectedIdx ? ' cmdbar__result--active' : ''}`}
                onClick={() => { window.pillAPI.selectSession(s.id); setValue(''); }}
                onMouseEnter={() => setSelectedIdx(i + 1)}
              >
                <span className={`cmdbar__dot ${statusDot(s.status)}`} />
                <span className="cmdbar__result-prompt">{s.prompt}</span>
                <span className="cmdbar__result-time">{formatElapsed(s.createdAt)}</span>
                <span className="cmdbar__result-status">{s.status}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cmdbar__footer">
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">Enter</kbd> {followUp ? 'follow up' : hasResults ? 'select' : 'create'}
          </span>
          {hasResults && !followUp && (
            <span className="cmdbar__hint">
              <kbd className="cmdbar__kbd">{'\u2318\u21B5'}</kbd> new agent
            </span>
          )}
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">Esc</kbd> {followUp ? 'cancel' : 'close'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default Pill;
