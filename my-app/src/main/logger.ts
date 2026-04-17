/**
 * Structured rotating logger for Agentic Browser.
 *
 * Outputs JSONL (one JSON object per line) to:
 *   ~/Library/Application Support/AgenticBrowser/logs/main.log
 *   ~/Library/Application Support/AgenticBrowser/logs/daemon.log
 *   ~/Library/Application Support/AgenticBrowser/logs/agent-task-{taskId}.log
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
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { app } = require('electron');
          return app.getPath('userData');
        } catch {
          return path.join(os.tmpdir(), 'AgenticBrowser');
        }
      })();

    this.logsDir = path.join(base, LOG_DIR_NAME);
    fs.mkdirSync(this.logsDir, { recursive: true });
    console.log(`${LOG_PREFIX} Logs directory: ${this.logsDir}`);
  }

  /**
   * Get or create a channel logger.
   * Channel names map to filenames:
   *   'main'          → main.log
   *   'daemon'        → daemon.log
   *   'agent-task-X'  → agent-task-X.log
   */
  getLogger(channel: string, minLevel?: LogLevel): ChannelLogger {
    const cached = this.cache.get(channel);
    if (cached) return cached;

    const filename = `${channel}.log`;
    const filePath = path.join(this.logsDir, filename);
    const writer = new RotatingFileWriter(filePath);
    const logger = new ChannelLogger(channel, writer, minLevel);

    this.cache.set(channel, logger);
    console.log(`${LOG_PREFIX} Created channel logger: ${channel} → ${filePath}`);
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

/** Pre-built channel loggers for the two always-present channels */
export const mainLogger = loggerFactory.getLogger('main');
export const daemonLogger = loggerFactory.getLogger('daemon');

/**
 * Get a per-task logger. Called by Track B/D when a task starts.
 * Usage: const log = getTaskLogger('uuid-task-id')
 */
export function getTaskLogger(taskId: string): ChannelLogger {
  return loggerFactory.getLogger(`agent-task-${taskId}`);
}
