import React, { useRef, useEffect, useState } from 'react';
import { STATUS_LABEL, OUTPUT_TYPE_LABEL } from './constants';
import { ContentRenderer, getPreview } from './ContentRenderer';
import type { AgentSession, OutputEntry } from './types';

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ThinkingIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 6.5C5.5 5.5 6 5 7 5s1.5.5 1.5 1.5c0 .7-.5 1-1 1.3-.2.1-.5.3-.5.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="10" r="0.6" fill="currentColor" />
    </svg>
  );
}

function ToolIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M8.5 2.5L12 6M2 12l4.5-4.5M12 6l-2 2-4.5-4.5 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M3 7l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ErrorIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4.5v3M7 9.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TextIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M3 4h8M3 7h6M3 10h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function entryIcon(type: OutputEntry['type']): React.ReactElement {
  switch (type) {
    case 'thinking': return <ThinkingIcon />;
    case 'tool_call': return <ToolIcon />;
    case 'tool_result': return <CheckIcon />;
    case 'error': return <ErrorIcon />;
    default: return <TextIcon />;
  }
}

function OutputRow({ entry }: { entry: OutputEntry }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(entry.type === 'thinking');
  const canCollapse = entry.type === 'thinking' || entry.type === 'tool_result';

  const typeLabel = OUTPUT_TYPE_LABEL[entry.type] ?? entry.type;
  const label = entry.tool ? `${typeLabel} — ${entry.tool}` : typeLabel;
  const preview = collapsed ? getPreview(entry.content) : null;

  return (
    <div className={`entry entry--${entry.type}`}>
      <div
        className={`entry__head${canCollapse ? ' entry__head--toggle' : ''}`}
        onClick={canCollapse ? () => setCollapsed((c) => !c) : undefined}
        role={canCollapse ? 'button' : undefined}
        tabIndex={canCollapse ? 0 : undefined}
        aria-expanded={canCollapse ? !collapsed : undefined}
        onKeyDown={canCollapse ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((c) => !c); } } : undefined}
      >
        <span className="entry__icon">{entryIcon(entry.type)}</span>
        <span className="entry__label">
          {label}
          {preview && <span className="entry__preview"> — {preview}</span>}
        </span>
        {entry.duration != null && (
          <span className="entry__dur">{formatDuration(entry.duration)}</span>
        )}
        <span className="entry__ts">{formatTimestamp(entry.timestamp)}</span>
        {canCollapse && (
          <span className={`entry__chev${collapsed ? '' : ' entry__chev--open'}`}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="entry__body">
          <ContentRenderer content={entry.content} type={entry.type} />
        </div>
      )}
    </div>
  );
}

interface AgentPaneProps {
  session: AgentSession;
}

export function AgentPane({ session }: AgentPaneProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session.output.length]);

  const elapsed = formatElapsed(session.createdAt);
  const statusText = STATUS_LABEL[session.status] ?? session.status;

  return (
    <div className={`pane pane--${session.status}`}>
      <div className="pane__header">
        <span className={`pane__dot pane__dot--${session.status}`} />
        <span className="pane__prompt">{session.prompt}</span>
      </div>
      <div className="pane__meta">
        <span className="pane__status">{statusText}</span>
        <span className="pane__sep" />
        <span className="pane__elapsed">{elapsed}</span>
      </div>

      {session.status === 'running' && (
        <div className="pane__progress">
          <div className="pane__progress-bar" />
        </div>
      )}

      <div className="pane__output" ref={scrollRef}>
        {session.output.length === 0 && session.status === 'draft' && (
          <div className="pane__output-empty">
            <p className="pane__output-empty-text">Not started yet</p>
          </div>
        )}
        {session.output.length === 0 && session.status === 'running' && (
          <div className="pane__output-empty">
            <span className="pane__spinner" />
            <p className="pane__output-empty-text">Starting...</p>
          </div>
        )}
        {session.output.map((entry) => (
          <OutputRow key={entry.id} entry={entry} />
        ))}
        {session.status === 'running' && session.output.length > 0 && (
          <div className="pane__cursor-row">
            <span className="pane__cursor" />
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentPane;
