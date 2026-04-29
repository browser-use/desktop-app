/**
 * Unit tests for src/main/logger.ts
 *
 * Tests rotation logic, JSONL output format, channel isolation,
 * and level filtering.
 *
 * Run: npx vitest run tests/unit/logger.test.ts
 *
 * Track H owns this file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  RotatingFileWriter,
  ChannelLogger,
  LoggerFactory,
  sanitizeLogChannel,
} from '../../src/main/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  return readLines(filePath).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// RotatingFileWriter
// ---------------------------------------------------------------------------

describe('RotatingFileWriter — basic write', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    logPath = path.join(tmpDir, 'test.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the log file on first write', () => {
    const writer = new RotatingFileWriter(logPath);
    writer.write('hello world');
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('writes exactly the line content followed by newline', () => {
    const writer = new RotatingFileWriter(logPath);
    writer.write('{"test":true}');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toBe('{"test":true}\n');
  });

  it('appends multiple lines sequentially', () => {
    const writer = new RotatingFileWriter(logPath);
    writer.write('line1');
    writer.write('line2');
    writer.write('line3');
    const lines = readLines(logPath);
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('exposes the correct file path via getFilePath()', () => {
    const writer = new RotatingFileWriter(logPath);
    expect(writer.getFilePath()).toBe(logPath);
  });
});

describe('RotatingFileWriter — rotation', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    logPath = path.join(tmpDir, 'rotate.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rotates when file size exceeds maxBytes', () => {
    const maxBytes = 100;
    const writer = new RotatingFileWriter(logPath, maxBytes, 3);

    // Write enough to fill the file past 100 bytes
    const longLine = 'x'.repeat(60);
    writer.write(longLine); // 61 bytes (line + newline) — under limit
    writer.write(longLine); // would push to ~122 bytes — triggers rotation

    // After rotation the primary file should exist (reset) and .1 should exist
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('keeps at most maxFiles rotated copies', () => {
    const maxBytes = 50;
    const maxFiles = 2;
    const writer = new RotatingFileWriter(logPath, maxBytes, maxFiles);

    // Force multiple rotations
    for (let i = 0; i < 10; i++) {
      writer.write('x'.repeat(60));
    }

    // Should not have .3 or higher
    expect(fs.existsSync(`${logPath}.${maxFiles + 1}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChannelLogger
// ---------------------------------------------------------------------------

describe('ChannelLogger — JSONL output format', () => {
  let tmpDir: string;
  let logPath: string;
  let logger: ChannelLogger;

  beforeEach(() => {
    tmpDir = makeTempDir();
    logPath = path.join(tmpDir, 'main.log');
    const writer = new RotatingFileWriter(logPath);
    logger = new ChannelLogger('main', writer, 'debug');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid JSON object per log call', () => {
    logger.info('test message');
    const entries = readJsonLines(logPath);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry['level']).toBe('info');
    expect(entry['channel']).toBe('main');
    expect(entry['msg']).toBe('test message');
    expect(typeof entry['ts']).toBe('string');
  });

  it('includes extra fields in the JSON output', () => {
    logger.info('request received', { requestId: 'abc123', duration_ms: 42 });
    const entries = readJsonLines(logPath);
    expect(entries[0]!['requestId']).toBe('abc123');
    expect(entries[0]!['duration_ms']).toBe(42);
  });

  it('sets level=debug for debug() calls', () => {
    logger.debug('debug msg');
    const entries = readJsonLines(logPath);
    expect(entries[0]!['level']).toBe('debug');
  });

  it('sets level=warn for warn() calls', () => {
    logger.warn('warn msg');
    const entries = readJsonLines(logPath);
    expect(entries[0]!['level']).toBe('warn');
  });

  it('sets level=error for error() calls', () => {
    logger.error('error msg');
    const entries = readJsonLines(logPath);
    expect(entries[0]!['level']).toBe('error');
  });

  it('ISO timestamp ts field is parseable as a Date', () => {
    logger.info('ts test');
    const entries = readJsonLines(logPath);
    const ts = entries[0]!['ts'] as string;
    expect(isNaN(new Date(ts).getTime())).toBe(false);
  });
});

describe('ChannelLogger — level filtering', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    logPath = path.join(tmpDir, 'filtered.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('suppresses debug messages when minLevel=info', () => {
    const writer = new RotatingFileWriter(logPath);
    const logger = new ChannelLogger('main', writer, 'info');

    logger.debug('this should be suppressed');
    logger.info('this should appear');

    const entries = readJsonLines(logPath);
    expect(entries.length).toBe(1);
    expect(entries[0]!['level']).toBe('info');
  });

  it('suppresses info and debug when minLevel=warn', () => {
    const writer = new RotatingFileWriter(logPath);
    const logger = new ChannelLogger('main', writer, 'warn');

    logger.debug('suppressed');
    logger.info('suppressed');
    logger.warn('allowed');
    logger.error('allowed');

    const entries = readJsonLines(logPath);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e['level'])).toEqual(['warn', 'error']);
  });
});

// ---------------------------------------------------------------------------
// LoggerFactory
// ---------------------------------------------------------------------------

describe('LoggerFactory — channel management', () => {
  let tmpDir: string;
  let factory: LoggerFactory;

  beforeEach(() => {
    tmpDir = makeTempDir();
    factory = new LoggerFactory(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates logs directory under userDataPath/logs/', () => {
    const logsDir = factory.getLogsDir();
    expect(logsDir).toBe(path.join(tmpDir, 'logs'));
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('main channel writes to main.log', () => {
    const logger = factory.getLogger('main');
    logger.info('hello main');
    const logFile = path.join(tmpDir, 'logs', 'main.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const entries = readJsonLines(logFile);
    expect(entries[0]!['channel']).toBe('main');
  });

  it('daemon channel writes to daemon.log', () => {
    const logger = factory.getLogger('daemon');
    logger.warn('daemon warning');
    const logFile = path.join(tmpDir, 'logs', 'daemon.log');
    expect(fs.existsSync(logFile)).toBe(true);
  });

  it('task channel writes to agent-task-{id}.log', () => {
    const taskId = 'abc-123';
    const logger = factory.getLogger(`agent-task-${taskId}`);
    logger.info('task started');
    const logFile = path.join(tmpDir, 'logs', `agent-task-${taskId}.log`);
    expect(fs.existsSync(logFile)).toBe(true);
  });

  it('returns the same logger instance for the same channel (caching)', () => {
    const logger1 = factory.getLogger('main');
    const logger2 = factory.getLogger('main');
    expect(logger1).toBe(logger2);
  });

  it('returns different logger instances for different channels', () => {
    const main = factory.getLogger('main');
    const daemon = factory.getLogger('daemon');
    expect(main).not.toBe(daemon);
  });

  it('different channels write to separate log files', () => {
    const mainLogger = factory.getLogger('main');
    const daemonLogger = factory.getLogger('daemon');

    mainLogger.info('from main');
    daemonLogger.info('from daemon');

    const mainEntries = readJsonLines(path.join(tmpDir, 'logs', 'main.log'));
    const daemonEntries = readJsonLines(path.join(tmpDir, 'logs', 'daemon.log'));

    expect(mainEntries[0]!['msg']).toBe('from main');
    expect(daemonEntries[0]!['msg']).toBe('from daemon');
  });

  it('getFilePath() returns the correct absolute path for main logger', () => {
    const logger = factory.getLogger('main');
    expect(logger.getFilePath()).toBe(path.join(tmpDir, 'logs', 'main.log'));
  });

  it('sanitizes unsafe channel names before writing files', () => {
    const logger = factory.getLogger('../bad/channel\0name');
    logger.info('safe write');

    const expected = path.join(tmpDir, 'logs', '_bad_channel_name.log');
    expect(logger.getFilePath()).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'bad', 'channel.log'))).toBe(false);
  });
});

describe('sanitizeLogChannel', () => {
  it('keeps normal channel names stable', () => {
    expect(sanitizeLogChannel('browser')).toBe('browser');
    expect(sanitizeLogChannel('agent-task-abc_123')).toBe('agent-task-abc_123');
  });

  it('removes path traversal and filesystem separators', () => {
    expect(sanitizeLogChannel('../renderer/logs')).toBe('_renderer_logs');
  });

  it('falls back for empty or dot-only channel names', () => {
    expect(sanitizeLogChannel('')).toBe('log');
    expect(sanitizeLogChannel('...')).toBe('log');
  });
});

// ---------------------------------------------------------------------------
// Log entry structural invariants
// ---------------------------------------------------------------------------

describe('LogEntry — structural invariants', () => {
  let tmpDir: string;
  let factory: LoggerFactory;

  beforeEach(() => {
    tmpDir = makeTempDir();
    factory = new LoggerFactory(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('every log entry has ts, level, channel, and msg fields', () => {
    const logger = factory.getLogger('main');
    logger.info('invariant check');

    const entries = readJsonLines(path.join(tmpDir, 'logs', 'main.log'));
    const entry = entries[0]!;

    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('level');
    expect(entry).toHaveProperty('channel');
    expect(entry).toHaveProperty('msg');
  });

  it('log entry is valid JSON on a single line', () => {
    const logger = factory.getLogger('main');
    logger.info('single line test', { nested: { deep: true } });

    const raw = fs.readFileSync(path.join(tmpDir, 'logs', 'main.log'), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    // Each line must be independently parseable JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
