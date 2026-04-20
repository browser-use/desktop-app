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
}

interface EventRow {
  session_id: string;
  seq: number;
  type: string;
  payload: string;
}

export class SessionDb {
  private db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.applyPragmas();
      this.runMigrations();
      mainLogger.info('SessionDb.open', { dbPath, version: this.getVersion() });
    } catch (err) {
      mainLogger.error('SessionDb.open.failed', { dbPath, error: (err as Error).message });
      this.db = new Database(':memory:');
      this.applyPragmas();
      this.runMigrations();
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

  private runMigrations(): void {
    const current = this.getVersion();

    if (current > DB_SCHEMA_VERSION) {
      const msg = `SessionDb schema version ${current} is NEWER than expected ${DB_SCHEMA_VERSION}. This is a fatal mismatch — the app binary is older than the database. Refusing to proceed.`;
      mainLogger.error('SessionDb.migration.VERSION_MISMATCH', { current, expected: DB_SCHEMA_VERSION, msg });
      throw new Error(msg);
    }

    if (current < 1) {
      mainLogger.info('SessionDb.migration.running', { from: current, to: 1 });
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
      mainLogger.info('SessionDb.migration.complete', { version: 1 });
    }

    if (this.getVersion() < 2) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 2 });
      this.db.exec(`
        ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_sessions_hidden ON sessions(hidden);
      `);
      this.setVersion(2);
      mainLogger.info('SessionDb.migration.complete', { version: 2 });
    }

    const final = this.getVersion();
    if (final !== DB_SCHEMA_VERSION) {
      const msg = `SessionDb migration did not reach expected version. Got ${final}, expected ${DB_SCHEMA_VERSION}.`;
      mainLogger.error('SessionDb.migration.INCOMPLETE', { final, expected: DB_SCHEMA_VERSION });
      throw new Error(msg);
    }
  }

  // -- Session CRUD ---------------------------------------------------------

  insertSession(session: { id: string; prompt: string; status: SessionStatus; createdAt: number; error?: string; group?: string }): void {
    if (!VALID_STATUSES.includes(session.status)) {
      throw new Error(`SessionDb.insertSession: invalid status "${session.status}". Valid: ${VALID_STATUSES.join(', ')}`);
    }
    const now = Date.now();
    try {
      this.db.prepare(
        'INSERT INTO sessions (id, prompt, status, created_at, error, group_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(session.id, session.prompt, session.status, session.createdAt, session.error ?? null, session.group ?? null, now);
      mainLogger.info('SessionDb.insertSession', { id: session.id, status: session.status });
    } catch (err) {
      mainLogger.error('SessionDb.insertSession.failed', { id: session.id, error: (err as Error).message });
      throw err;
    }
  }

  updateSessionStatus(id: string, status: SessionStatus, error?: string): void {
    if (this.closed) return;
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`SessionDb.updateSessionStatus: invalid status "${status}". Valid: ${VALID_STATUSES.join(', ')}`);
    }
    const now = Date.now();
    try {
      const result = this.db.prepare(
        'UPDATE sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?'
      ).run(status, error ?? null, now, id);
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updateSessionStatus.notFound', { id, status });
      }
      mainLogger.info('SessionDb.updateSessionStatus', { id, status });
    } catch (err) {
      mainLogger.error('SessionDb.updateSessionStatus.failed', { id, status, error: (err as Error).message });
      throw err;
    }
  }

  updateSessionPrompt(id: string, prompt: string): void {
    const now = Date.now();
    try {
      this.db.prepare('UPDATE sessions SET prompt = ?, updated_at = ? WHERE id = ?').run(prompt, now, id);
      mainLogger.info('SessionDb.updateSessionPrompt', { id, promptLength: prompt.length });
    } catch (err) {
      mainLogger.error('SessionDb.updateSessionPrompt.failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  getSession(id: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  listSessions(opts?: { status?: SessionStatus; limit?: number; offset?: number; includeHidden?: boolean }): SessionRow[] {
    const hiddenFilter = opts?.includeHidden ? '' : ' AND hidden = 0';
    if (opts?.status) {
      return this.db.prepare(
        `SELECT * FROM sessions WHERE status = ?${hiddenFilter} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).all(opts.status, opts.limit ?? 1000, opts.offset ?? 0) as SessionRow[];
    }
    return this.db.prepare(
      `SELECT * FROM sessions WHERE 1=1${hiddenFilter} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(opts?.limit ?? 1000, opts?.offset ?? 0) as SessionRow[];
  }

  hideSession(id: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE sessions SET hidden = 1, updated_at = ? WHERE id = ?').run(now, id);
    mainLogger.info('SessionDb.hideSession', { id });
  }

  unhideSession(id: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE sessions SET hidden = 0, updated_at = ? WHERE id = ?').run(now, id);
    mainLogger.info('SessionDb.unhideSession', { id });
  }

  deleteSession(id: string): void {
    try {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
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
      this.db.prepare(
        'INSERT INTO session_events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)'
      ).run(sessionId, seq, event.type, JSON.stringify(event));
    } catch (err) {
      mainLogger.error('SessionDb.appendEvent.failed', {
        sessionId, seq, type: event.type,
        error: (err as Error).message,
      });
    }
  }

  appendEventsBatch(sessionId: string, events: Array<{ seq: number; event: HlEvent }>): void {
    const stmt = this.db.prepare(
      'INSERT INTO session_events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)'
    );
    const txn = this.db.transaction((items: Array<{ seq: number; event: HlEvent }>) => {
      for (const { seq, event } of items) {
        stmt.run(sessionId, seq, event.type, JSON.stringify(event));
      }
    });
    try {
      txn(events);
      mainLogger.info('SessionDb.appendEventsBatch', { sessionId, count: events.length });
    } catch (err) {
      mainLogger.error('SessionDb.appendEventsBatch.failed', { sessionId, count: events.length, error: (err as Error).message });
      throw err;
    }
  }

  getEvents(sessionId: string, opts?: { afterSeq?: number; limit?: number }): HlEvent[] {
    const rows = opts?.afterSeq !== undefined
      ? this.db.prepare(
          'SELECT payload FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
        ).all(sessionId, opts.afterSeq, opts.limit ?? 100000) as Array<{ payload: string }>
      : this.db.prepare(
          'SELECT payload FROM session_events WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
        ).all(sessionId, opts?.limit ?? 100000) as Array<{ payload: string }>;

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
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?').get(sessionId) as { cnt: number };
    return row.cnt;
  }

  // -- Startup recovery -----------------------------------------------------

  recoverStaleSessions(): number {
    const now = Date.now();
    try {
      const result = this.db.prepare(
        "UPDATE sessions SET status = 'stopped', error = ?, updated_at = ? WHERE status IN ('running', 'stuck', 'idle')"
      ).run(RECOVERY_ERROR, now);
      if (result.changes > 0) {
        mainLogger.warn('SessionDb.recoverStaleSessions', { recovered: result.changes });
      }
      return result.changes;
    } catch (err) {
      mainLogger.error('SessionDb.recoverStaleSessions.failed', { error: (err as Error).message });
      return 0;
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  close(): void {
    this.closed = true;
    try {
      this.db.close();
      mainLogger.info('SessionDb.close');
    } catch (err) {
      mainLogger.error('SessionDb.close.failed', { error: (err as Error).message });
    }
  }
}
