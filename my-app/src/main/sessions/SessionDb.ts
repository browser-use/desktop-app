import Database from 'better-sqlite3';
import { mainLogger } from '../logger';
import { DB_SCHEMA_VERSION, RECOVERY_ERROR, VALID_STATUSES } from './db-constants';
import type { HlEvent, SessionStatus } from '../../shared/session-schemas';

interface SessionRow {
  id: string;
  prompt: string;
  status: string;
  created_at: number;
  error: string | null;
  group_name: string | null;
  updated_at: number;
  hidden: number;
  origin_channel: string | null;
  origin_conversation_id: string | null;
}

export class SessionDb {
  private db: Database.Database;
  private closed = false;
  private stmts!: {
    insertSession: Database.Statement;
    updateStatus: Database.Statement;
    updatePrompt: Database.Statement;
    updateCreatedAt: Database.Statement;
    getSession: Database.Statement;
    getSessionOrigin: Database.Statement;
    listAll: Database.Statement;
    listByStatus: Database.Statement;
    listAllWithHidden: Database.Statement;
    listByStatusWithHidden: Database.Statement;
    hide: Database.Statement;
    unhide: Database.Statement;
    saveMessages: Database.Statement;
    getMessages: Database.Statement;
    deleteSession: Database.Statement;
    appendEvent: Database.Statement;
    clearEvents: Database.Statement;
    getEvents: Database.Statement;
    getEventsAfter: Database.Statement;
    getEventCount: Database.Statement;
    recoverCrashed: Database.Statement;
    recoverIdle: Database.Statement;
  };

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.applyPragmas();
      this.runMigrations();
      this.prepareStatements();
      mainLogger.info('SessionDb.open', { dbPath, version: this.getVersion() });
    } catch (err) {
      mainLogger.error('SessionDb.open.failed', { dbPath, error: (err as Error).message });
      this.db = new Database(':memory:');
      this.applyPragmas();
      this.runMigrations();
      this.prepareStatements();
      mainLogger.warn('SessionDb.open.fallbackToMemory');
    }
  }

  private applyPragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  private getVersion(): number {
    return (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
  }

  private setVersion(v: number): void {
    this.db.pragma(`user_version = ${v}`);
  }

  private prepareStatements(): void {
    this.stmts = {
      insertSession: this.db.prepare(
        'INSERT INTO sessions (id, prompt, status, created_at, error, group_name, updated_at, origin_channel, origin_conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      updateStatus: this.db.prepare(
        'UPDATE sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?'
      ),
      updatePrompt: this.db.prepare(
        'UPDATE sessions SET prompt = ?, updated_at = ? WHERE id = ?'
      ),
      updateCreatedAt: this.db.prepare(
        'UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?'
      ),
      getSession: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
      getSessionOrigin: this.db.prepare('SELECT origin_channel, origin_conversation_id FROM sessions WHERE id = ?'),
      listAll: this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      listByStatus: this.db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      listAllWithHidden: this.db.prepare('SELECT * FROM sessions WHERE hidden = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      listByStatusWithHidden: this.db.prepare('SELECT * FROM sessions WHERE status = ? AND hidden = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      hide: this.db.prepare('UPDATE sessions SET hidden = 1, updated_at = ? WHERE id = ?'),
      unhide: this.db.prepare('UPDATE sessions SET hidden = 0, updated_at = ? WHERE id = ?'),
      saveMessages: this.db.prepare('UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?'),
      getMessages: this.db.prepare('SELECT messages FROM sessions WHERE id = ?'),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      appendEvent: this.db.prepare(
        'INSERT INTO session_events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)'
      ),
      clearEvents: this.db.prepare('DELETE FROM session_events WHERE session_id = ?'),
      getEvents: this.db.prepare(
        'SELECT payload FROM session_events WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
      ),
      getEventsAfter: this.db.prepare(
        'SELECT payload FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      ),
      getEventCount: this.db.prepare('SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?'),
      recoverCrashed: this.db.prepare(
        "UPDATE sessions SET status = 'stopped', error = ?, updated_at = ? WHERE status IN ('running', 'stuck')"
      ),
      recoverIdle: this.db.prepare(
        "UPDATE sessions SET status = 'stopped', updated_at = ? WHERE status = 'idle'"
      ),
    };
  }

  private runMigrations(): void {
    const current = this.getVersion();

    if (current > DB_SCHEMA_VERSION) {
      const msg = `SessionDb schema version ${current} is NEWER than expected ${DB_SCHEMA_VERSION}. This is a fatal mismatch — the app binary is older than the database. Refusing to proceed.`;
      mainLogger.error('SessionDb.migration.VERSION_MISMATCH', { current, expected: DB_SCHEMA_VERSION, msg });
      throw new Error(msg);
    }

    if (current < 1) {
      mainLogger.info('SessionDb.migration.running', { from: current, to: 1 });
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            id            TEXT PRIMARY KEY,
            prompt        TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'draft',
            created_at    INTEGER NOT NULL,
            error         TEXT,
            group_name    TEXT,
            updated_at    INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS session_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq           INTEGER NOT NULL,
            type          TEXT NOT NULL,
            payload       TEXT NOT NULL,
            UNIQUE(session_id, seq)
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
          CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_name) WHERE group_name IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_events_session_id ON session_events(session_id);
        `);
        this.setVersion(1);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 1 });
    }

    if (this.getVersion() < 2) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 2 });
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
          CREATE INDEX IF NOT EXISTS idx_sessions_hidden ON sessions(hidden);
        `);
        this.setVersion(2);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 2 });
    }

    if (this.getVersion() < 3) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 3 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'messages')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN messages TEXT');
        }
        this.setVersion(3);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 3 });
    }

    if (this.getVersion() < 4) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 4 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'origin_channel')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN origin_channel TEXT');
        }
        if (!cols.some((c) => c.name === 'origin_conversation_id')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN origin_conversation_id TEXT');
        }
        this.setVersion(4);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 4 });
    }

    const final = this.getVersion();
    if (final !== DB_SCHEMA_VERSION) {
      const msg = `SessionDb migration did not reach expected version. Got ${final}, expected ${DB_SCHEMA_VERSION}.`;
      mainLogger.error('SessionDb.migration.INCOMPLETE', { final, expected: DB_SCHEMA_VERSION });
      throw new Error(msg);
    }
  }

  // -- Session CRUD ---------------------------------------------------------

  insertSession(session: { id: string; prompt: string; status: SessionStatus; createdAt: number; error?: string; group?: string; originChannel?: string; originConversationId?: string }): void {
    if (!VALID_STATUSES.includes(session.status)) {
      throw new Error(`SessionDb.insertSession: invalid status "${session.status}". Valid: ${VALID_STATUSES.join(', ')}`);
    }
    const now = Date.now();
    try {
      this.stmts.insertSession.run(session.id, session.prompt, session.status, session.createdAt, session.error ?? null, session.group ?? null, now, session.originChannel ?? null, session.originConversationId ?? null);
      mainLogger.info('SessionDb.insertSession', { id: session.id, status: session.status, originChannel: session.originChannel ?? null });
    } catch (err) {
      mainLogger.error('SessionDb.insertSession.failed', { id: session.id, error: (err as Error).message });
      throw err;
    }
  }

  getSessionOrigin(id: string): { originChannel: string | null; originConversationId: string | null } {
    const row = this.stmts.getSessionOrigin.get(id) as { origin_channel: string | null; origin_conversation_id: string | null } | undefined;
    return {
      originChannel: row?.origin_channel ?? null,
      originConversationId: row?.origin_conversation_id ?? null,
    };
  }

  updateSessionStatus(id: string, status: SessionStatus, error?: string): void {
    if (this.closed) return;
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`SessionDb.updateSessionStatus: invalid status "${status}". Valid: ${VALID_STATUSES.join(', ')}`);
    }
    const now = Date.now();
    try {
      const result = this.stmts.updateStatus.run(status, error ?? null, now, id);
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updateSessionStatus.notFound', { id, status });
      }
    } catch (err) {
      mainLogger.error('SessionDb.updateSessionStatus.failed', { id, status, error: (err as Error).message });
      throw err;
    }
  }

  updateCreatedAt(id: string, createdAt: number): void {
    const now = Date.now();
    this.stmts.updateCreatedAt.run(createdAt, now, id);
  }

  updateSessionPrompt(id: string, prompt: string): void {
    const now = Date.now();
    try {
      this.stmts.updatePrompt.run(prompt, now, id);
    } catch (err) {
      mainLogger.error('SessionDb.updateSessionPrompt.failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  getSession(id: string): SessionRow | null {
    return (this.stmts.getSession.get(id) as SessionRow | undefined) ?? null;
  }

  listSessions(opts?: { status?: SessionStatus; limit?: number; offset?: number; includeHidden?: boolean }): SessionRow[] {
    const limit = opts?.limit ?? 1000;
    const offset = opts?.offset ?? 0;
    if (opts?.status) {
      return opts.includeHidden
        ? this.stmts.listByStatus.all(opts.status, limit, offset) as SessionRow[]
        : this.stmts.listByStatusWithHidden.all(opts.status, limit, offset) as SessionRow[];
    }
    return opts?.includeHidden
      ? this.stmts.listAll.all(limit, offset) as SessionRow[]
      : this.stmts.listAllWithHidden.all(limit, offset) as SessionRow[];
  }

  hideSession(id: string): void {
    if (this.closed) return;
    this.stmts.hide.run(Date.now(), id);
    mainLogger.info('SessionDb.hideSession', { id });
  }

  unhideSession(id: string): void {
    if (this.closed) return;
    this.stmts.unhide.run(Date.now(), id);
    mainLogger.info('SessionDb.unhideSession', { id });
  }

  saveMessages(id: string, messages: unknown[]): void {
    if (this.closed) return;
    try {
      this.stmts.saveMessages.run(JSON.stringify(messages), Date.now(), id);
    } catch (err) {
      mainLogger.error('SessionDb.saveMessages.failed', { id, error: (err as Error).message });
    }
  }

  getMessages(id: string): unknown[] | null {
    const row = this.stmts.getMessages.get(id) as { messages: string | null } | undefined;
    if (!row?.messages) return null;
    try {
      return JSON.parse(row.messages) as unknown[];
    } catch {
      mainLogger.error('SessionDb.getMessages.parseFailed', { id });
      return null;
    }
  }

  clearEvents(id: string): void {
    if (this.closed) return;
    this.stmts.clearEvents.run(id);
  }

  deleteSession(id: string): void {
    try {
      this.stmts.deleteSession.run(id);
      mainLogger.info('SessionDb.deleteSession', { id });
    } catch (err) {
      mainLogger.error('SessionDb.deleteSession.failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  // -- Event append/read ----------------------------------------------------

  appendEvent(sessionId: string, seq: number, event: HlEvent): void {
    if (this.closed) return;
    try {
      this.stmts.appendEvent.run(sessionId, seq, event.type, JSON.stringify(event));
    } catch (err) {
      mainLogger.error('SessionDb.appendEvent.failed', {
        sessionId, seq, type: event.type,
        error: (err as Error).message,
      });
    }
  }

  appendEventsBatch(sessionId: string, events: Array<{ seq: number; event: HlEvent }>): void {
    const txn = this.db.transaction((items: Array<{ seq: number; event: HlEvent }>) => {
      for (const { seq, event } of items) {
        this.stmts.appendEvent.run(sessionId, seq, event.type, JSON.stringify(event));
      }
    });
    try {
      txn(events);
    } catch (err) {
      mainLogger.error('SessionDb.appendEventsBatch.failed', { sessionId, count: events.length, error: (err as Error).message });
      throw err;
    }
  }

  getEvents(sessionId: string, opts?: { afterSeq?: number; limit?: number }): HlEvent[] {
    const limit = opts?.limit ?? 100000;
    const rows = opts?.afterSeq !== undefined
      ? this.stmts.getEventsAfter.all(sessionId, opts.afterSeq, limit) as Array<{ payload: string }>
      : this.stmts.getEvents.all(sessionId, limit) as Array<{ payload: string }>;

    return rows.map((r) => {
      try {
        return JSON.parse(r.payload) as HlEvent;
      } catch (err) {
        mainLogger.error('SessionDb.getEvents.parseFailed', { sessionId, payload: r.payload.slice(0, 100), error: (err as Error).message });
        return { type: 'error' as const, message: `corrupt event payload: ${r.payload.slice(0, 50)}` };
      }
    });
  }

  getEventCount(sessionId: string): number {
    const row = this.stmts.getEventCount.get(sessionId) as { cnt: number };
    return row.cnt;
  }

  // -- Startup recovery -----------------------------------------------------

  recoverStaleSessions(): number {
    const now = Date.now();
    try {
      const crashed = this.stmts.recoverCrashed.run(RECOVERY_ERROR, now);
      const idle = this.stmts.recoverIdle.run(now);
      const total = crashed.changes + idle.changes;
      if (total > 0) {
        mainLogger.warn('SessionDb.recoverStaleSessions', { crashed: crashed.changes, idle: idle.changes });
      }
      return total;
    } catch (err) {
      mainLogger.error('SessionDb.recoverStaleSessions.failed', { error: (err as Error).message });
      return 0;
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  close(): void {
    this.closed = true;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
      mainLogger.info('SessionDb.close');
    } catch (err) {
      mainLogger.error('SessionDb.close.failed', { error: (err as Error).message });
    }
  }
}
