import React, { useCallback, useEffect, useState } from 'react';
import { AgentPane } from './AgentPane';
import { ListView } from './ListView';
import { Dashboard } from './Dashboard';
import { CommandBar } from './CommandBar';
import { MOCK_SESSIONS } from './mock-data';
import type { AgentSession, OutputEntry } from './types';

type ViewMode = 'dashboard' | 'grid' | 'list';

let sessionCounter = MOCK_SESSIONS.length + 1;
let entryCounter = 1000;

function uid(prefix: string): string {
  return `${prefix}-${++entryCounter}`;
}

function PlusIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ListIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function DashboardIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1.5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8.5" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.5" y="8.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function HubApp(): React.ReactElement {
  const [sessions, setSessions] = useState<AgentSession[]>(MOCK_SESSIONS);
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard');
  const [cmdBarOpen, setCmdBarOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdBarOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleCreateSession = useCallback((prompt: string) => {
    const id = `session-${++sessionCounter}`;
    const now = Date.now();

    const newSession: AgentSession = {
      id,
      prompt,
      status: 'running',
      createdAt: now,
      elapsedMs: 0,
      toolCallCount: 0,
      output: [
        {
          id: uid('e'),
          type: 'thinking',
          timestamp: now,
          content: `Analyzing the task: "${prompt}". Let me break this down and determine the best approach.`,
        },
      ],
    };

    console.log('[HubApp] createSession', { id, prompt });
    setSessions((prev) => [...prev, newSession]);

    setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const entry: OutputEntry = {
            id: uid('e'),
            type: 'tool_call',
            timestamp: Date.now(),
            tool: 'file.search',
            content: `{ "pattern": "**/*.ts", "query": "${prompt.split(' ').slice(0, 3).join(' ')}" }`,
          };
          return { ...s, output: [...s.output, entry], toolCallCount: 1, elapsedMs: 2000 };
        }),
      );
    }, 2000);

    setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const entry: OutputEntry = {
            id: uid('e'),
            type: 'tool_result',
            timestamp: Date.now(),
            tool: 'file.search',
            content: 'Found 7 relevant files across 3 directories.',
            duration: 1500,
          };
          return { ...s, output: [...s.output, entry], elapsedMs: 3500 };
        }),
      );
    }, 3500);

    setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const entry: OutputEntry = {
            id: uid('e'),
            type: 'thinking',
            timestamp: Date.now(),
            content: 'I\'ve found the relevant files. Now analyzing the code structure and planning modifications.',
          };
          return { ...s, output: [...s.output, entry], elapsedMs: 5000 };
        }),
      );
    }, 5000);

    setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const entry: OutputEntry = {
            id: uid('e'),
            type: 'tool_call',
            timestamp: Date.now(),
            tool: 'file.read',
            content: '{ "path": "src/main/index.ts", "lines": "1-50" }',
          };
          return { ...s, output: [...s.output, entry], toolCallCount: 2, elapsedMs: 7000 };
        }),
      );
    }, 7000);

    setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const entry: OutputEntry = {
            id: uid('e'),
            type: 'tool_result',
            timestamp: Date.now(),
            tool: 'file.read',
            content: 'Read 50 lines from src/main/index.ts. Found the entry point configuration and module initialization.',
            duration: 800,
          };
          return { ...s, output: [...s.output, entry], elapsedMs: 8000 };
        }),
      );
    }, 8000);

    setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const entry: OutputEntry = {
            id: uid('e'),
            type: 'text',
            timestamp: Date.now(),
            content: 'Implementation complete. I\'ve made the following changes:\n\n1. Updated the module configuration\n2. Added proper error handling\n3. Refactored the initialization sequence\n\nAll changes have been saved.',
          };
          return { ...s, output: [...s.output, entry], status: 'stopped', elapsedMs: 10000 };
        }),
      );
    }, 10000);
  }, []);

  const hasNoSessions = sessions.length === 0;

  const handleSelectSession = useCallback((id: string) => {
    console.log('[HubApp] selectSession', { id });
  }, []);

  return (
    <div className="hub-root">
      <header className="hub-toolbar">
        <div className="hub-toolbar__left">
          <span className="hub-toolbar__title">Agent Hub</span>
        </div>
        <div className="hub-toolbar__right">
          <button
            className="hub-toolbar__new-btn"
            onClick={() => setCmdBarOpen(true)}
            aria-label="New agent"
            title="New agent"
          >
            <PlusIcon />
            <span className="hub-toolbar__new-label">New agent</span>
          </button>
          {sessions.length > 0 && (
            <div className="hub-toolbar__view-toggle" role="radiogroup" aria-label="View mode">
              <button
                className={`hub-toolbar__view-btn${viewMode === 'dashboard' ? ' hub-toolbar__view-btn--active' : ''}`}
                onClick={() => setViewMode('dashboard')}
                aria-label="Dashboard"
                title="Dashboard"
              >
                <DashboardIcon />
              </button>
              <button
                className={`hub-toolbar__view-btn${viewMode === 'grid' ? ' hub-toolbar__view-btn--active' : ''}`}
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                title="Grid view"
              >
                <GridIcon />
              </button>
              <button
                className={`hub-toolbar__view-btn${viewMode === 'list' ? ' hub-toolbar__view-btn--active' : ''}`}
                onClick={() => setViewMode('list')}
                aria-label="List view"
                title="List view"
              >
                <ListIcon />
              </button>
            </div>
          )}
        </div>
      </header>

      {hasNoSessions ? (
        <div className="hub-empty-state">
          <div className="hub-empty-state__icon" aria-hidden="true">
            <PlusIcon />
          </div>
          <p className="hub-empty-state__title">Start your first agent session</p>
          <p className="hub-empty-state__body">Type a task below to begin</p>
        </div>
      ) : viewMode === 'dashboard' ? (
        <Dashboard sessions={sessions} onSwitchToGrid={() => setViewMode('grid')} />
      ) : viewMode === 'grid' ? (
        <div className="hub-grid" data-count={Math.min(sessions.length, 4)}>
          {sessions.map((session) => (
            <AgentPane key={session.id} session={session} />
          ))}
        </div>
      ) : (
        <ListView sessions={sessions} onSelectSession={handleSelectSession} />
      )}

      <CommandBar
        open={cmdBarOpen}
        onClose={() => setCmdBarOpen(false)}
        onSubmit={handleCreateSession}
      />
    </div>
  );
}

export default HubApp;
