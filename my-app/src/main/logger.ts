/**
 * Structured rotating logger for Browser Use Desktop.
 *
 * Outputs JSONL (one JSON object per line) to channel-specific files:
 *   ~/Library/Application Support/Browser Use/logs/main.log
 *   ~/Library/Application Support/Browser Use/logs/browser.log
 *   ~/Library/Application Support/Browser Use/logs/renderer.log
 *   ~/Library/Application Support/Browser Use/logs/engine.log
 *   ~/Library/Application Support/Browser Use/logs/agent-task-{taskId}.log
 *
 * Rotation: 10 MB per file, keep 5 rotated files.
 * Format: { ts, level, channel, msg, ...extra }
 *
 * Track H owns this file. Track A/B/C/D will import channel loggers.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[Logger]';
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB
const MAX_ROTATED_FILES = 5;
const LOG_DIR_NAME = 'logs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  channel: string;
  msg: string;
  [key: string]: unknown;
}

export function sanitizeLogChannel(channel: string): string {
  const safe = channel
    .trim()
    .replace(/[\0/\\]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');

  return safe || 'log';
}

// ---------------------------------------------------------------------------
// RotatingFileWriter
// ---------------------------------------------------------------------------

/**
 * Simple synchronous rotating file writer.
 * Rotates when current file exceeds maxBytes.
 * Keeps at most maxFiles rotated copies (.1 … .N).
 */
export class RotatingFileWriter {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(filePath: string, maxBytes = MAX_FILE_BYTES, maxFiles = MAX_ROTATED_FILES) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(line: string): void {
    const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');

    let currentSize = 0;
    try {
      const stat = fs.statSync(this.filePath);
      currentSize = stat.size;
    } catch {
      // File doesn't exist yet — that's fine, size = 0
    }

    if (currentSize + lineBytes > this.maxBytes) {
      this._rotate();
    }

    try {
      fs.appendFileSync(this.filePath, line + '\n', 'utf-8');
    } catch (err) {
      // Last-resort: write to stderr so we never silently lose logs
      process.stderr.write(
        `${LOG_PREFIX} Failed to write log line: ${(err as Error).message}\n`,
      );
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  private _rotate(): void {
    // Shift existing rotated files: .5 → deleted, .4 → .5, … .1 → .2
    for (let i = this.maxFiles; i >= 1; i--) {
      const src = `${this.filePath}.${i - 1 === 0 ? '' : String(i - 1)}`.replace(/\.$/, '');
      const dst = `${this.filePath}.${i}`;
      const actual = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      try {
        if (fs.existsSync(actual)) {
          fs.renameSync(actual, dst);
        }
      } catch (err) {
        process.stderr.write(`${LOG_PREFIX} Rotation error: ${(err as Error).message}\n`);
      }
    }
    // After rotation the primary file no longer exists; appendFileSync will create it
  }
}

// ---------------------------------------------------------------------------
// ChannelLogger
// ---------------------------------------------------------------------------

/**
 * A logger bound to a specific channel (e.g. "main", "daemon", "agent-task-abc").
 * All methods accept an optional extra-fields object for structured metadata.
 */
export class ChannelLogger {
  private readonly channel: string;
  private readonly writer: RotatingFileWriter;
  private readonly minLevel: LogLevel;

  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(channel: string, writer: RotatingFileWriter, minLevel: LogLevel = 'info') {
    this.channel = channel;
    this.writer = writer;
    this.minLevel = minLevel;
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this._log('debug', msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this._log('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this._log('warn', msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this._log('error', msg, extra);
  }

  getFilePath(): string {
    return this.writer.getFilePath();
  }

  private _log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (
      ChannelLogger.LEVEL_ORDER[level] <
      ChannelLogger.LEVEL_ORDER[this.minLevel]
    ) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      channel: this.channel,
      msg,
      ...extra,
    };

    const line = JSON.stringify(entry);
    this.writer.write(line);

    // Mirror to console for visibility during development
    const consoleFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.log;
    consoleFn(`[${level.toUpperCase()}][${this.channel}] ${msg}`, extra ?? '');
  }
}

// ---------------------------------------------------------------------------
// LoggerFactory
// ---------------------------------------------------------------------------

/**
 * Creates and caches channel loggers.
 * Ensures logs directory exists.
 */
export class LoggerFactory {
  private readonly logsDir: string;
  private readonly cache = new Map<string, ChannelLogger>();

  constructor(userDataPath?: string) {
    const base =
      userDataPath ??
      (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { app } = require('electron');
          return app.getPath('userData');
        } catch {
          return path.join(os.tmpdir(), 'Browser Use');
        }
      })();

    this.logsDir = path.join(base, LOG_DIR_NAME);
    fs.mkdirSync(this.logsDir, { recursive: true });
    console.log(`${LOG_PREFIX} Logs directory: ${this.logsDir}`);
  }

  /**
   * Get or create a channel logger.
   * Channel names are sanitized before mapping to filenames:
   *   'main'          → main.log
   *   'daemon'        → daemon.log
   *   'agent-task-X'  → agent-task-X.log
   */
  getLogger(channel: string, minLevel?: LogLevel): ChannelLogger {
    const safeChannel = sanitizeLogChannel(channel);
    const cached = this.cache.get(safeChannel);
    if (cached) return cached;

    const filename = `${safeChannel}.log`;
    const filePath = path.join(this.logsDir, filename);
    const writer = new RotatingFileWriter(filePath);
    const logger = new ChannelLogger(safeChannel, writer, minLevel);

    this.cache.set(safeChannel, logger);
    console.log(`${LOG_PREFIX} Created channel logger: ${safeChannel} → ${filePath}`);
    return logger;
  }

  getLogsDir(): string {
    return this.logsDir;
  }
}

// ---------------------------------------------------------------------------
// Singleton exports
// ---------------------------------------------------------------------------

export const loggerFactory = new LoggerFactory();
export const mainLogger = loggerFactory.getLogger('main');
export const browserLogger = loggerFactory.getLogger('browser');
export const rendererLogger = loggerFactory.getLogger('renderer');
export const engineLogger = loggerFactory.getLogger('engine');
