/**
 * HubApp — root component for the agent orchestration hub renderer.
 * Layout: sidebar (session list + new-session input) + main (session panel).
 * MVP: mock sessions pre-loaded to validate layout renders correctly.
 */

import React, { useCallback, useState } from 'react';
import { Sidebar } from './Sidebar';
import { SessionPanel } from './SessionPanel';

// ---------------------------------------------------------------------------
// Types (exported so child components share the same definition)
// ---------------------------------------------------------------------------

export interface AgentSession {
  id: string;
  prompt: string;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  output: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Mock data — removed once real IPC wiring lands
// ---------------------------------------------------------------------------

const MOCK_SESSIONS: AgentSession[] = [
  {
    id: 'mock-1',
    prompt: 'Summarise last week\'s Slack threads into a brief',
    status: 'done',
    createdAt: Date.now() - 7 * 60 * 1000,
    output: [
      'Fetching Slack workspace messages…',
      'Retrieved 142 messages across 8 channels.',
      'Summarising threads with > 3 replies…',
      'Brief ready: 6 key topics identified.',
    ],
  },
  {
    id: 'mock-2',
    prompt: 'Find and fix the memory leak in the renderer process',
    status: 'running',
    createdAt: Date.now() - 90 * 1000,
    output: [
      'Scanning renderer heap snapshots…',
      'Identified 3 detached DOM nodes accumulating across tab switches.',
    ],
  },
  {
    id: 'mock-3',
    prompt: 'Draft Q2 OKR document from Notion pages',
    status: 'error',
    createdAt: Date.now() - 25 * 60 * 1000,
    output: [
      'Connecting to Notion API…',
      'Fetching workspace pages…',
    ],
    error: 'Notion API rate limit exceeded (429). Retry after 60s.',
  },
];

// ---------------------------------------------------------------------------
// ID generator for new sessions
// ---------------------------------------------------------------------------

let sessionCounter = MOCK_SESSIONS.length + 1;

function generateId(): string {
  return `session-${sessionCounter++}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HubApp(): React.ReactElement {
  const [sessions, setSessions] = useState<AgentSession[]>(MOCK_SESSIONS);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(MOCK_SESSIONS[0]?.id ?? null);

  const handleCreateSession = useCallback((prompt: string) => {
    const id = generateId();
    const newSession: AgentSession = {
      id,
      prompt,
      status: 'running',
      createdAt: Date.now(),
      output: [],
    };
    console.log('[HubApp] createSession', { id, prompt });
    setSessions((prev) => [newSession, ...prev]);
    setSelectedSessionId(id);
  }, []);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  return (
    <div className="hub-root">
      <Sidebar
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={setSelectedSessionId}
        onCreateSession={handleCreateSession}
      />
      <SessionPanel session={selectedSession} />
    </div>
  );
}

export default HubApp;
