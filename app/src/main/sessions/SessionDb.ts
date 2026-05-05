import Database from 'better-sqlite3';
import { mainLogger } from '../logger';
import { DB_SCHEMA_VERSION, RECOVERY_ERROR, VALID_STATUSES, MAX_ATTACHMENTS_PER_SESSION } from './db-constants';
import type { HlEvent, SessionStatus } from '../../shared/session-schemas';

interface SessionRow {
  id: string;
  prompt: string;
  status: string;
  created_at: number;
  error: string | null;
  group_name: string | null;
  updated_at: number;
  origin_channel: string | null;
  origin_conversation_id: string | null;
  primary_site: string | null;
  engine: string | null;
  model: string | null;
  auth_mode: string | null;
  subscription_type: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_source: string | null;
}

export class SessionDb {
  private db: Database.Database;
  private closed = false;
  private stmts!: {
    insertSession: Database.Statement;
    updateStatus: Database.Statement;
    updatePrompt: Database.Statement;
    updateCreatedAt: Database.Statement;
    updatePrimarySite: Database.Statement;
    updateEngine: Database.Statement;
    updateModel: Database.Statement;
    updateAuth: Database.Statement;
    updateUsage: Database.Statement;
    getSession: Database.Statement;
    getSessionOrigin: Database.Statement;
    listAll: Database.Statement;
    listByStatus: Database.Statement;
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
    insertAttachment: Database.Statement;
    getAttachmentsMeta: Database.Statement;
    getAttachmentBytes: Database.Statement;
    getLatestTurnAttachments: Database.Statement;
    getAttachmentTotalSize: Database.Statement;
    getNextTurnIndex: Database.Statement;
    getAttachmentCount: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.applyPragmas();
    this.runMigrations();
    this.prepareStatements();
    mainLogger.info('SessionDb.open', { dbPath, version: this.getVersion() });
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
      updatePrimarySite: this.db.prepare(
        'UPDATE sessions SET primary_site = ?, updated_at = ? WHERE id = ?'
      ),
      updateEngine: this.db.prepare(
        'UPDATE sessions SET engine = ?, updated_at = ? WHERE id = ?'
      ),
      updateModel: this.db.prepare(
        'UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?'
      ),
      updateAuth: this.db.prepare(
        'UPDATE sessions SET auth_mode = ?, subscription_type = ?, updated_at = ? WHERE id = ?'
      ),
      updateUsage: this.db.prepare(
        'UPDATE sessions SET cost_usd = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, cost_source = ?, updated_at = ? WHERE id = ?'
      ),
      getSession: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
      getSessionOrigin: this.db.prepare('SELECT origin_channel, origin_conversation_id FROM sessions WHERE id = ?'),
      listAll: this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      listByStatus: this.db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
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
      insertAttachment: this.db.prepare(
        'INSERT INTO session_attachments (session_id, name, mime, bytes, size, created_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ),
      getAttachmentsMeta: this.db.prepare(
        'SELECT id, name, mime, size, created_at, turn_index FROM session_attachments WHERE session_id = ? ORDER BY id ASC'
      ),
      getAttachmentBytes: this.db.prepare(
        'SELECT id, name, mime, bytes, size, turn_index FROM session_attachments WHERE session_id = ? ORDER BY id ASC'
      ),
      getLatestTurnAttachments: this.db.prepare(
        `SELECT id, name, mime, bytes, size, turn_index FROM session_attachments
         WHERE session_id = ? AND turn_index = (
           SELECT COALESCE(MAX(turn_index), 0) FROM session_attachments WHERE session_id = ?
         ) ORDER BY id ASC`
      ),
      getAttachmentTotalSize: this.db.prepare(
        'SELECT COALESCE(SUM(size), 0) AS total FROM session_attachments WHERE session_id = ?'
      ),
      getNextTurnIndex: this.db.prepare(
        'SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM session_attachments WHERE session_id = ?'
      ),
      getAttachmentCount: this.db.prepare(
        'SELECT COUNT(*) AS cnt FROM session_attachments WHERE session_id = ?'
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

    if (this.getVersion() < 5) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 5 });
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS session_attachments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            mime        TEXT NOT NULL,
            bytes       BLOB NOT NULL,
            size        INTEGER NOT NULL,
            created_at  INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_attachments_session ON session_attachments(session_id);
        `);
        this.setVersion(5);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 5 });
    }

    if (this.getVersion() < 6) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 6 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(session_attachments)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'turn_index')) {
          this.db.exec('ALTER TABLE session_attachments ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0');
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_session_turn ON session_attachments(session_id, turn_index)');
        this.setVersion(6);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 6 });
    }

    if (this.getVersion() < 7) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 7 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'primary_site')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN primary_site TEXT');
        }
        this.setVersion(7);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 7 });
    }

    if (this.getVersion() < 8) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 8 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'engine')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN engine TEXT');
        }
        this.setVersion(8);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 8 });
    }

    if (this.getVersion() < 9) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 9 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'auth_mode')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN auth_mode TEXT');
        }
        if (!cols.some((c) => c.name === 'subscription_type')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN subscription_type TEXT');
        }
        this.setVersion(9);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 9 });
    }

    if (this.getVersion() < 10) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 10 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'cost_usd')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN cost_usd REAL');
        }
        if (!cols.some((c) => c.name === 'input_tokens')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN input_tokens INTEGER');
        }
        if (!cols.some((c) => c.name === 'output_tokens')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN output_tokens INTEGER');
        }
        if (!cols.some((c) => c.name === 'cached_input_tokens')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN cached_input_tokens INTEGER');
        }
        if (!cols.some((c) => c.name === 'cost_source')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN cost_source TEXT');
        }
        this.setVersion(10);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 10 });
    }

    if (this.getVersion() < 11) {
      mainLogger.info('SessionDb.migration.running', { from: this.getVersion(), to: 11 });
      this.db.transaction(() => {
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'model')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN model TEXT');
        }
        this.setVersion(11);
      })();
      mainLogger.info('SessionDb.migration.complete', { version: 11 });
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
    mainLogger.info('SessionDb.insertSession.attempt', { id: session.id, status: session.status, promptLength: session.prompt.length, closed: this.closed });
    try {
      const result = this.stmts.insertSession.run(session.id, session.prompt, session.status, session.createdAt, session.error ?? null, session.group ?? null, now, session.originChannel ?? null, session.originConversationId ?? null);
      const totalRows = (this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
      mainLogger.info('SessionDb.insertSession.success', { id: session.id, status: session.status, changes: result.changes, totalRowsAfter: totalRows });
    } catch (err) {
      mainLogger.error('SessionDb.insertSession.failed', { id: session.id, error: (err as Error).message, stack: (err as Error).stack });
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

  updatePrimarySite(id: string, site: string | null): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      const result = this.stmts.updatePrimarySite.run(site, now, id);
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updatePrimarySite.notFound', { id, site });
      }
    } catch (err) {
      mainLogger.error('SessionDb.updatePrimarySite.failed', { id, site, error: (err as Error).message });
      throw err;
    }
  }

  updateEngine(id: string, engine: string | null): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      const result = this.stmts.updateEngine.run(engine, now, id);
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updateEngine.notFound', { id, engine });
      }
    } catch (err) {
      mainLogger.error('SessionDb.updateEngine.failed', { id, engine, error: (err as Error).message });
      throw err;
    }
  }

  updateModel(id: string, model: string | null): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      const result = this.stmts.updateModel.run(model, now, id);
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updateModel.notFound', { id, model });
      }
    } catch (err) {
      mainLogger.error('SessionDb.updateModel.failed', { id, model, error: (err as Error).message });
      throw err;
    }
  }

  updateUsage(id: string, usage: { costUsd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; costSource: 'exact' | 'estimated' }): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      const result = this.stmts.updateUsage.run(
        usage.costUsd, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.costSource, now, id,
      );
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updateUsage.notFound', { id });
      }
    } catch (err) {
      mainLogger.error('SessionDb.updateUsage.failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  updateAuth(id: string, authMode: string | null, subscriptionType: string | null): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      const result = this.stmts.updateAuth.run(authMode, subscriptionType, now, id);
      if (result.changes === 0) {
        mainLogger.warn('SessionDb.updateAuth.notFound', { id, authMode, subscriptionType });
      }
    } catch (err) {
      mainLogger.error('SessionDb.updateAuth.failed', { id, authMode, subscriptionType, error: (err as Error).message });
      throw err;
    }
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

  listSessions(opts?: { status?: SessionStatus; limit?: number; offset?: number }): SessionRow[] {
    const limit = opts?.limit ?? 1000;
    const offset = opts?.offset ?? 0;
    if (opts?.status) {
      return this.stmts.listByStatus.all(opts.status, limit, offset) as SessionRow[];
    }
    return this.stmts.listAll.all(limit, offset) as SessionRow[];
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

  // -- Attachments ----------------------------------------------------------

  getNextTurnIndex(sessionId: string): number {
    const row = this.stmts.getNextTurnIndex.get(sessionId) as { next: number };
    return row.next;
  }

  saveAttachment(
    sessionId: string,
    a: { name: string; mime: string; bytes: Buffer | Uint8Array },
    turnIndex: number,
  ): number {
    if (this.closed) throw new Error('SessionDb is closed');
    const buf = a.bytes instanceof Buffer ? a.bytes : Buffer.from(a.bytes);
    const size = buf.byteLength;
    const now = Date.now();
    const existing = this.stmts.getAttachmentCount.get(sessionId) as { cnt: number };
    if (existing.cnt >= MAX_ATTACHMENTS_PER_SESSION) {
      mainLogger.warn('SessionDb.saveAttachment.capReached', { sessionId, cap: MAX_ATTACHMENTS_PER_SESSION });
      throw new Error(`Attachment limit reached for session (max ${MAX_ATTACHMENTS_PER_SESSION})`);
    }
    try {
      const result = this.stmts.insertAttachment.run(sessionId, a.name, a.mime, buf, size, now, turnIndex);
      const id = Number(result.lastInsertRowid);
      mainLogger.info('SessionDb.saveAttachment', { sessionId, attachmentId: id, name: a.name, mime: a.mime, size, turnIndex });
      return id;
    } catch (err) {
      mainLogger.error('SessionDb.saveAttachment.failed', { sessionId, name: a.name, mime: a.mime, size, turnIndex, error: (err as Error).message });
      throw err;
    }
  }

  getAttachmentsMeta(sessionId: string): Array<{ id: number; name: string; mime: string; size: number; created_at: number; turn_index: number }> {
    return this.stmts.getAttachmentsMeta.all(sessionId) as Array<{ id: number; name: string; mime: string; size: number; created_at: number; turn_index: number }>;
  }

  getAttachmentsWithBytes(sessionId: string): Array<{ id: number; name: string; mime: string; bytes: Buffer; size: number; turn_index: number }> {
    const rows = this.stmts.getAttachmentBytes.all(sessionId) as Array<{ id: number; name: string; mime: string; bytes: Buffer; size: number; turn_index: number }>;
    mainLogger.info('SessionDb.getAttachmentsWithBytes', { sessionId, count: rows.length, totalBytes: rows.reduce((a, r) => a + r.size, 0) });
    return rows;
  }

  getLatestTurnAttachments(sessionId: string): Array<{ id: number; name: string; mime: string; bytes: Buffer; size: number; turn_index: number }> {
    const rows = this.stmts.getLatestTurnAttachments.all(sessionId, sessionId) as Array<{ id: number; name: string; mime: string; bytes: Buffer; size: number; turn_index: number }>;
    mainLogger.info('SessionDb.getLatestTurnAttachments', {
      sessionId,
      count: rows.length,
      turnIndex: rows[0]?.turn_index ?? null,
      totalBytes: rows.reduce((a, r) => a + r.size, 0),
    });
    return rows;
  }

  getAttachmentTotalSize(sessionId: string): number {
    const row = this.stmts.getAttachmentTotalSize.get(sessionId) as { total: number };
    return row.total ?? 0;
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
