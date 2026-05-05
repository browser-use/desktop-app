import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mainLogger } from '../logger';
import type { HlEvent } from '../../shared/session-schemas';
import type { AgentSession, SessionStatus, SessionEvents } from './types';
import { SessionDb } from './SessionDb';
import { extractRegistrableDomain } from './domain';
import {
  hlEventToTermBytes,
  eventsToTermBytes,
  createTermTranslatorState,
  type TermTranslatorState,
} from '../hl/streamToTerm';

export type { AgentSession, SessionStatus, SessionEvents };

const STUCK_TIMEOUT_MS = 30_000;

export class SessionManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private stuckTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /**
   * Per-session Claude Code conversation id (from `system/init` stream event).
   * Passed as `--resume <id>` on the next spawn to continue the conversation.
   * In-memory only — cleared on process restart and on rerun.
   */
  private claudeSessionIds: Map<string, string> = new Map();
  private sessionEngines: Map<string, string> = new Map();
  private sessionModels: Map<string, string> = new Map();
  private termStates: Map<string, TermTranslatorState> = new Map();
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

    const rows = this.db.listSessions({ limit: 100 });
    mainLogger.info('SessionManager.loadPersistedSessions.rows', {
      rowCount: rows.length,
      statuses: rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    });
    for (const row of rows) {
      const session: AgentSession = {
        id: row.id,
        prompt: row.prompt,
        status: row.status as SessionStatus,
        createdAt: row.created_at,
        output: [],
        error: row.error ?? undefined,
        group: row.group_name ?? undefined,
        originChannel: row.origin_channel ?? undefined,
        originConversationId: row.origin_conversation_id ?? undefined,
        primarySite: row.primary_site ?? null,
        lastActivityAt: row.updated_at,
      };
      if (row.engine) {
        (session as AgentSession & { engine?: string }).engine = row.engine;
        this.sessionEngines.set(row.id, row.engine);
      }
      if (row.model) {
        (session as AgentSession & { model?: string }).model = row.model;
        this.sessionModels.set(row.id, row.model);
      }
      if (row.auth_mode === 'apiKey' || row.auth_mode === 'subscription') {
        session.authMode = row.auth_mode;
      }
      if (row.subscription_type) {
        session.subscriptionType = row.subscription_type;
      }
      if (typeof row.cost_usd === 'number') session.costUsd = row.cost_usd;
      if (typeof row.input_tokens === 'number') session.inputTokens = row.input_tokens;
      if (typeof row.output_tokens === 'number') session.outputTokens = row.output_tokens;
      if (typeof row.cached_input_tokens === 'number') session.cachedInputTokens = row.cached_input_tokens;
      if (row.cost_source === 'exact' || row.cost_source === 'estimated') {
        session.costSource = row.cost_source;
      }
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

    // Emit the initial prompt as a user_input term event so a freshly-mounted
    // xterm sees the user's message at the top of the live stream. It isn't
    // persisted as an HlEvent (session.prompt already holds it), and replay
    // synthesizes it from session.prompt in getTermReplay().
    if (session.output.length === 0 && session.prompt) {
      this.emitTermBytes(id, { type: 'user_input', text: session.prompt });
    }

    mainLogger.info('SessionManager.startSession', { id, resumed: session.output.length > 0 });
    this.emitEvent('session-updated', { ...session });
    return abortController;
  }

  /** Called when the session's WebContents is gone (closed by user or crashed)
   *  while the agent itself isn't running. An idle session whose browser has
   *  been torn down is functionally over — flip status to 'stopped' so the UI
   *  stops showing "Idle" and renders the proper ended state. */
  markBrowserEnded(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.status !== 'idle') return;
    session.status = 'stopped';
    this.db.updateSessionStatus(id, 'stopped');
    mainLogger.info('SessionManager.markBrowserEnded', { id });
    this.emitEvent('session-updated', { ...session });
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

    // turn_usage is telemetry — roll up into cumulative totals on the session
    // row so the UI can show a single number without scanning every event.
    // 'exact' beats 'estimated' if the session has a mix (shouldn't happen
    // since source is engine-specific, but be defensive).
    if (event.type === 'turn_usage') {
      session.costUsd = (session.costUsd ?? 0) + event.costUsd;
      session.inputTokens = (session.inputTokens ?? 0) + event.inputTokens;
      session.outputTokens = (session.outputTokens ?? 0) + event.outputTokens;
      session.cachedInputTokens = (session.cachedInputTokens ?? 0) + event.cachedInputTokens;
      if (event.source === 'exact' || !session.costSource) session.costSource = event.source;
      this.db.updateUsage(id, {
        costUsd: session.costUsd,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        cachedInputTokens: session.cachedInputTokens,
        costSource: session.costSource,
      });
      mainLogger.info('SessionManager.turnUsage', {
        id,
        addedCostUsd: event.costUsd,
        totalCostUsd: session.costUsd,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        source: event.source,
        model: event.model,
      });
      this.emitEvent('session-updated', { ...session });
    }

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
    this.emitTermBytes(id, event);
  }

  private emitTermBytes(id: string, event: HlEvent): void {
    let state = this.termStates.get(id);
    if (!state) {
      state = createTermTranslatorState();
      this.termStates.set(id, state);
    }
    const bytes = hlEventToTermBytes(event, state);
    if (bytes) this.emitEvent('session-output-term', id, bytes);
  }

  /**
   * Build the full terminal replay stream for a session from its persisted
   * event history. Called when a renderer pane mounts (or remounts) and needs
   * to repaint its xterm.
   */
  getTermReplay(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return '';
    this.hydrateOutput(id);
    const events: HlEvent[] = [];
    if (session.prompt) events.push({ type: 'user_input', text: session.prompt });
    events.push(...session.output);
    return eventsToTermBytes(events);
  }

  /** Update the session's primarySite to match the domain of the given URL.
   *  Called by index.ts when BrowserPool fires a navigation event — the
   *  browser is the source of truth for what page the session is on. */
  updatePrimarySiteFromUrl(id: string, url: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const domain = extractRegistrableDomain(url);
    if (!domain) return;
    if (session.primarySite === domain) return;
    const from = session.primarySite ?? null;
    session.primarySite = domain;
    session.lastActivityAt = Date.now();
    this.db.updatePrimarySite(session.id, domain);
    mainLogger.info('SessionManager.primarySite.update', { id: session.id, from, to: domain, url });
    this.emitEvent('session-updated', { ...session });
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
    this.emitTermBytes(id, userEvent);

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

  deleteSession(id: string): void {
    const session = this.sessions.get(id);
    if (session && (session.status === 'running' || session.status === 'stuck')) {
      this.cancelSession(id);
    }
    this.clearStuckTimer(id);
    this.abortControllers.delete(id);
    this.sessions.delete(id);
    this.sessionEngines.delete(id);
    this.sessionModels.delete(id);
    this.termStates.delete(id);
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
    this.termStates.delete(id);
    this.emitEvent('session-output-term', id, '\x1bc');
    // Rerun starts a fresh conversation — clear any resume id so the next
    // spawn doesn't attempt --resume against a now-invalid thread.
    this.claudeSessionIds.delete(id);

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);
    this.resetStuckTimer(id);

    // After clearing the terminal (`\x1bc`), re-emit the user prompt so the
    // rerun starts with the user's message visible at the top.
    if (session.prompt) {
      this.emitTermBytes(id, { type: 'user_input', text: session.prompt });
    }

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

  getNextAttachmentTurnIndex(sessionId: string): number {
    return this.db.getNextTurnIndex(sessionId);
  }

  saveAttachment(sessionId: string, a: { name: string; mime: string; bytes: Buffer | Uint8Array }, turnIndex: number): number {
    return this.db.saveAttachment(sessionId, a, turnIndex);
  }

  getAttachmentsMeta(sessionId: string): Array<{ id: number; name: string; mime: string; size: number; created_at: number; turn_index: number }> {
    return this.db.getAttachmentsMeta(sessionId);
  }

  // For rerun / start: only the latest turn's attachments are replayed, because
  // `session.prompt` is updated to the latest follow-up prompt on resume. Older
  // turns' attachments are already represented textually in priorMessages.
  loadAttachmentsForRun(sessionId: string): Array<{ id: number; name: string; mime: string; bytes: Buffer; size: number; turn_index: number }> {
    return this.db.getLatestTurnAttachments(sessionId);
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

  listSessions(): AgentSession[] {
    const list = Array.from(this.sessions.values());
    mainLogger.info('SessionManager.listSessions', {
      returning: list.length,
    });
    return list
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ ...s, output: [] }));
  }

  /** Store the Claude Code `session_id` reported in the `system/init` event. */
  setClaudeSessionId(id: string, claudeSessionId: string): void {
    this.claudeSessionIds.set(id, claudeSessionId);
    mainLogger.info('SessionManager.setClaudeSessionId', { id, claudeSessionId });
  }

  /** Retrieve a previously-captured Claude Code session id, if any. */
  getClaudeSessionId(id: string): string | undefined {
    return this.claudeSessionIds.get(id);
  }

  /** Record the engine id chosen for this session. Also
   *  stamps `session.engine` so every future `{ ...session }` snapshot carries
   *  the provider id to the renderer for header icon rendering. */
  setSessionEngine(id: string, engineId: string): void {
    this.sessionEngines.set(id, engineId);
    const session = this.sessions.get(id);
    if (session) {
      (session as AgentSession & { engine?: string }).engine = engineId;
      this.db.updateEngine(id, engineId);
      this.emitEvent('session-updated', { ...session });
    }
  }

  /** Retrieve the per-session engine id, or null if never set. */
  getSessionEngine(id: string): string | null {
    return this.sessionEngines.get(id) ?? null;
  }

  /** Record the explicit model selected for this session. Null means CLI default. */
  setSessionModel(id: string, model: string | null): void {
    const session = this.sessions.get(id);
    if (model) this.sessionModels.set(id, model);
    else this.sessionModels.delete(id);
    this.db.updateModel(id, model);
    if (session) {
      if (model) (session as AgentSession & { model?: string }).model = model;
      else delete (session as AgentSession & { model?: string }).model;
      this.emitEvent('session-updated', { ...session });
    }
  }

  /** Retrieve the per-session explicit model, or null for CLI default. */
  getSessionModel(id: string): string | null {
    return this.sessionModels.get(id) ?? null;
  }

  /** Snapshot the auth mode + subscription type that actually ran this session.
   *  Called once at spawn by runEngine via the onAuthResolved callback. Frozen
   *  for the life of the session — later global auth-mode changes do not
   *  retroactively rewrite historical sessions. */
  setSessionAuth(id: string, authMode: 'apiKey' | 'subscription' | null, subscriptionType: string | null): void {
    const session = this.sessions.get(id);
    if (!session) {
      mainLogger.warn('SessionManager.setSessionAuth.notFound', { id });
      return;
    }
    session.authMode = authMode ?? undefined;
    session.subscriptionType = subscriptionType ?? undefined;
    this.db.updateAuth(id, authMode, subscriptionType);
    mainLogger.info('SessionManager.setSessionAuth', { id, authMode, subscriptionType });
    this.emitEvent('session-updated', { ...session });
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
