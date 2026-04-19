/**
 * SessionManager — in-memory agent session store.
 * MVP: sessions live only in process memory; no HL engine wiring yet.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
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
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions: Map<string, AgentSession> = new Map();

  createSession(prompt: string): string {
    const id = randomUUID();
    const session: AgentSession = {
      id,
      prompt,
      status: 'running',
      createdAt: Date.now(),
      output: [],
    };
    this.sessions.set(id, session);
    console.log('[SessionManager] createSession', { id, prompt });
    return id;
  }

  cancelSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      console.warn('[SessionManager] cancelSession: session not found', { id });
      return;
    }
    if (session.status !== 'running') {
      console.warn('[SessionManager] cancelSession: session not running', { id, status: session.status });
      return;
    }
    session.status = 'error';
    session.error = 'Cancelled by user';
    console.log('[SessionManager] cancelSession', { id });
  }

  appendOutput(id: string, line: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      console.warn('[SessionManager] appendOutput: session not found', { id });
      return;
    }
    session.output.push(line);
    console.log('[SessionManager] appendOutput', { id, lineCount: session.output.length });
  }

  completeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      console.warn('[SessionManager] completeSession: session not found', { id });
      return;
    }
    session.status = 'done';
    console.log('[SessionManager] completeSession', { id });
  }

  failSession(id: string, error: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      console.warn('[SessionManager] failSession: session not found', { id });
      return;
    }
    session.status = 'error';
    session.error = error;
    console.log('[SessionManager] failSession', { id, error });
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
  }
}
