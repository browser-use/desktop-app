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

  private hydratedOutputs = new Set<string>();

  private loadPersistedSessions(): void {
    const recoveredCount = this.db.recoverStaleSessions();
    if (recoveredCount > 0) {
      mainLogger.warn('SessionManager.loadPersistedSessions.recovered', { count: recoveredCount });
    }

    const rows = this.db.listSessions({ limit: 100, includeHidden: true });
    for (const row of rows) {
      const session: AgentSession = {
        id: row.id,
        prompt: row.prompt,
        status: row.status as SessionStatus,
        createdAt: row.created_at,
        output: [],
        error: row.error ?? undefined,
        group: row.group_name ?? undefined,
        hidden: row.hidden === 1,
        originChannel: row.origin_channel ?? undefined,
        originConversationId: row.origin_conversation_id ?? undefined,
      };
      this.sessions.set(row.id, session);
    }

    mainLogger.info('SessionManager.loadPersistedSessions', {
      totalLoaded: this.sessions.size,
      recovered: recoveredCount,
    });
  }

  private hydrateOutput(id: string): void {
    if (this.hydratedOutputs.has(id)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.output.length > 0) {
      this.hydratedOutputs.add(id);
      return;
    }
    const events = this.db.getEvents(id);
    if (events.length > 0) {
      session.output = events;
      mainLogger.info('SessionManager.hydrateOutput', { id, eventCount: events.length });
    }
    this.hydratedOutputs.add(id);
  }

  // -- typed emit/on helpers ------------------------------------------------

  emitEvent<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): boolean {
    return this.emit(event, ...args);
  }

  onEvent<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }

  // -- public API -----------------------------------------------------------

  createSession(prompt: string, opts?: { originChannel?: string; originConversationId?: string }): string {
    const id = randomUUID();
    const now = Date.now();
    const session: AgentSession = {
      id,
      prompt,
      status: 'draft',
      createdAt: now,
      output: [],
      originChannel: opts?.originChannel,
      originConversationId: opts?.originConversationId,
    };
    this.sessions.set(id, session);
    this.db.insertSession({ id, prompt, status: 'draft', createdAt: now, originChannel: opts?.originChannel, originConversationId: opts?.originConversationId });
    mainLogger.info('SessionManager.createSession', { id, promptLength: prompt.length, originChannel: opts?.originChannel ?? null });
    this.emitEvent('session-created', { ...session });
    return id;
  }

  getSessionOrigin(id: string): { originChannel: string | null; originConversationId: string | null } {
    return this.db.getSessionOrigin(id);
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

    this.hydrateOutput(id);
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

  hideSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) (session as AgentSession & { hidden?: boolean }).hidden = true;
    this.db.hideSession(id);
    mainLogger.info('SessionManager.hideSession', { id });
  }

  unhideSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) (session as AgentSession & { hidden?: boolean }).hidden = false;
    this.db.unhideSession(id);
    mainLogger.info('SessionManager.unhideSession', { id });
    if (session) this.emitEvent('session-updated', { ...session });
  }

  deleteSession(id: string): void {
    const session = this.sessions.get(id);
    if (session && (session.status === 'running' || session.status === 'stuck')) {
      this.cancelSession(id);
    }
    this.clearStuckTimer(id);
    this.abortControllers.delete(id);
    this.sessions.delete(id);
    this.db.deleteSession(id);
    mainLogger.info('SessionManager.deleteSession', { id });
  }

  rerunSession(id: string): AbortController {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    const ctrl = this.abortControllers.get(id);
    if (ctrl) { ctrl.abort(); this.abortControllers.delete(id); }
    this.clearStuckTimer(id);

    session.output = [];
    session.error = undefined;
    session.status = 'running';
    session.createdAt = Date.now();
    this.db.updateCreatedAt(id, session.createdAt);
    this.db.updateSessionStatus(id, 'running');
    this.db.saveMessages(id, []);
    this.db.clearEvents(id);

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);
    this.resetStuckTimer(id);

    mainLogger.info('SessionManager.rerunSession', { id, promptLength: session.prompt.length });
    this.emitEvent('session-updated', { ...session });
    return abortController;
  }

  saveMessages(id: string, messages: unknown[]): void {
    this.db.saveMessages(id, messages);
  }

  getMessages(id: string): unknown[] | null {
    return this.db.getMessages(id);
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
    if (!session) return undefined;
    this.hydrateOutput(id);
    return { ...session };
  }

  listSessions(opts?: { includeHidden?: boolean }): AgentSession[] {
    let list = Array.from(this.sessions.values());
    if (!opts?.includeHidden) {
      list = list.filter((s) => !(s as any).hidden);
    }
    return list
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ ...s, output: [] }));
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
