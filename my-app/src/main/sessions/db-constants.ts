export const DB_SCHEMA_VERSION = 2;

export const RECOVERY_ERROR = 'App exited unexpectedly';

export const TABLE_SESSIONS = 'sessions';
export const TABLE_EVENTS = 'session_events';

export const VALID_STATUSES = ['draft', 'running', 'stuck', 'idle', 'stopped'] as const;
