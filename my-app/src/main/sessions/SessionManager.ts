import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mainLogger } from '../logger';
import type { HlEvent } from '../hl/agent';
import type { AgentSession, SessionStatus, SessionEvents } from './types';
import { SessionDb } from './SessionDb';

export type { AgentSession, SessionStatus, SessionEvents };

const STUCK_TIMEOUT_MS = 30_000;

export class SessionManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private stuckTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private db: SessionDb;

  constructor(dbPath: string) {
    super();
    this.db = new SessionDb(dbPath);
    this.loadPersistedSessions();
  }

  private loadPersistedSessions(): void {
    const recoveredCount = this.db.recoverStaleSessions();
    if (recoveredCount > 0) {
      mainLogger.warn('SessionManager.loadPersistedSessions.recovered', { count: recoveredCount });
    }

    const rows = this.db.listSessions({ limit: 50 });
    for (const row of rows) {
      const events = this.db.getEvents(row.id);
      const session: AgentSession = {
        id: row.id,
        prompt: row.prompt,
        status: row.status as SessionStatus,
        createdAt: row.created_at,
        output: events,
        error: row.error ?? undefined,
        group: row.group_name ?? undefined,
      };
      this.sessions.set(row.id, session);
    }

    mainLogger.info('SessionManager.loadPersistedSessions', {
      totalLoaded: this.sessions.size,
      recovered: recoveredCount,
    });
  }

  // -- typed emit/on helpers ------------------------------------------------

  emitEvent<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): boolean {
    return this.emit(event, ...args);
  }

  onEvent<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }

  // -- public API -----------------------------------------------------------

  createSession(prompt: string): string {
    const id = randomUUID();
    const now = Date.now();
    const session: AgentSession = {
      id,
      prompt,
      status: 'draft',
      createdAt: now,
      output: [],
    };
    this.sessions.set(id, session);
    this.db.insertSession({ id, prompt, status: 'draft', createdAt: now });
    mainLogger.info('SessionManager.createSession', { id, promptLength: prompt.length });
    this.emitEvent('session-created', { ...session });
    return id;
  }

  startSession(id: string): AbortController {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    if (session.status !== 'draft' && session.status !== 'idle') {
      throw new Error(`Session ${id} is ${session.status}, expected draft or idle`);
    }

    session.status = 'running';
    this.db.updateSessionStatus(id, 'running');
    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);

    this.resetStuckTimer(id);

    mainLogger.info('SessionManager.startSession', { id, resumed: session.output.length > 0 });
    this.emitEvent('session-updated', { ...session });
    return abortController;
  }

  cancelSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      mainLogger.warn('SessionManager.cancelSession', { id, reason: 'not_found' });
      return;
    }
    if (session.status !== 'running' && session.status !== 'stuck') {
      mainLogger.warn('SessionManager.cancelSession', { id, status: session.status, reason: 'not_cancellable' });
      return;
    }

    const ctrl = this.abortControllers.get(id);
    if (ctrl) {
      ctrl.abort();
      this.abortControllers.delete(id);
    }

    this.clearStuckTimer(id);
    session.status = 'stopped';
    session.error = 'Cancelled by user';
    this.db.updateSessionStatus(id, 'stopped', 'Cancelled by user');
    mainLogger.info('SessionManager.cancelSession', { id });
    this.emitEvent('session-updated', { ...session });
  }

  appendOutput(id: string, event: HlEvent): void {
    const session = this.sessions.get(id);
    if (!session) {
      mainLogger.warn('SessionManager.appendOutput', { id, reason: 'not_found' });
      return;
    }
    session.output.push(event);
    const seq = session.output.length - 1;
    this.db.appendEvent(id, seq, event);

    if (session.status === 'stuck') {
      session.status = 'running';
      this.db.updateSessionStatus(id, 'running');
      mainLogger.info('SessionManager.appendOutput', { id, recovered: true });
      this.emitEvent('session-updated', { ...session });
    }

    if (session.status === 'running') {
      this.resetStuckTimer(id);
    }

    this.emitEvent('session-output', id, event);
  }

  completeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      mainLogger.warn('SessionManager.completeSession', { id, reason: 'not_found' });
      return;
    }
    this.clearStuckTimer(id);
    this.abortControllers.delete(id);
    session.status = 'idle';
    this.db.updateSessionStatus(id, 'idle');
    mainLogger.info('SessionManager.completeSession', { id, outputLines: session.output.length });
    this.emitEvent('session-completed', { ...session });
  }

  resumeSession(id: string, prompt: string): AbortController {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    if (session.status !== 'idle') {
      throw new Error(`Session ${id} is ${session.status}, expected idle`);
    }

    const userEvent: HlEvent = { type: 'user_input', text: prompt };
    session.output.push(userEvent);
    const seq = session.output.length - 1;
    this.db.appendEvent(id, seq, userEvent);
    this.emitEvent('session-output', id, userEvent);

    session.prompt = prompt;
    session.status = 'running';
    this.db.updateSessionPrompt(id, prompt);
    this.db.updateSessionStatus(id, 'running');
    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);

    this.resetStuckTimer(id);

    mainLogger.info('SessionManager.resumeSession', { id, promptLength: prompt.length });
    this.emitEvent('session-updated', { ...session });
    return abortController;
  }

  dismissSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      mainLogger.warn('SessionManager.dismissSession', { id, reason: 'not_found' });
      return;
    }
    session.status = 'stopped';
    this.db.updateSessionStatus(id, 'stopped');
    mainLogger.info('SessionManager.dismissSession', { id });
    this.emitEvent('session-updated', { ...session });
  }

  failSession(id: string, error: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      mainLogger.warn('SessionManager.failSession', { id, reason: 'not_found' });
      return;
    }
    this.clearStuckTimer(id);
    this.abortControllers.delete(id);
    session.status = 'stopped';
    session.error = error;
    this.db.updateSessionStatus(id, 'stopped', error);
    mainLogger.info('SessionManager.failSession', { id, error });
    this.emitEvent('session-error', { ...session });
  }

  getSession(id: string): AgentSession | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session } : undefined;
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ ...s }));
  }

  getAbortController(id: string): AbortController | undefined {
    return this.abortControllers.get(id);
  }

  // -- stuck detection ------------------------------------------------------

  private resetStuckTimer(id: string): void {
    this.clearStuckTimer(id);
    const timer = setTimeout(() => {
      const session = this.sessions.get(id);
      if (session && session.status === 'running') {
        session.status = 'stuck';
        this.db.updateSessionStatus(id, 'stuck');
        mainLogger.warn('SessionManager.stuckDetected', { id, timeoutMs: STUCK_TIMEOUT_MS });
        this.emitEvent('session-updated', { ...session });
      }
    }, STUCK_TIMEOUT_MS);
    timer.unref();
    this.stuckTimers.set(id, timer);
  }

  private clearStuckTimer(id: string): void {
    const timer = this.stuckTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.stuckTimers.delete(id);
    }
  }

  // -- cleanup --------------------------------------------------------------

  destroy(): void {
    for (const [id, ctrl] of this.abortControllers) {
      ctrl.abort();
      mainLogger.info('SessionManager.destroy.abort', { id });
    }
    this.abortControllers.clear();

    for (const timer of this.stuckTimers.values()) {
      clearTimeout(timer);
    }
    this.stuckTimers.clear();

    this.removeAllListeners();
    this.db.close();
    mainLogger.info('SessionManager.destroy', { sessionCount: this.sessions.size });
  }
}
