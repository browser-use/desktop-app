/**
 * Daemon lifecycle management: spawn, restart, connect, stop.
 *
 * Spawns the Python agent daemon as a child process (PyInstaller binary or
 * `python -m agent_daemon` in dev) and manages its lifecycle with exponential
 * backoff restart on crash (max 5 attempts).
 *
 * Also exports pure handler functions for pill:submit and pill:cancel IPC,
 * decoupled from Electron IPC for testability.
 *
 * Key decisions:
 *   - Uses child_process.spawn (NOT utilityProcess.fork) because the daemon
 *     is a native PyInstaller binary, not a Node.js module. utilityProcess.fork
 *     only accepts JS module paths. child_process.spawn of external binaries
 *     is unaffected by the RunAsNode fuse.
 *   - Socket path: ${userData}/daemon-${pid}.sock (PID-scoped, multi-instance safe)
 *   - API key is passed via env var to the child process, NEVER logged.
 *   - All lifecycle events logged via mainLogger (D2 rule).
 *
 * Track 1 owns this file.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { DaemonClient } from './daemon/client';
import { forwardAgentEvent } from './pill';
import { mainLogger } from './logger';
import type { AgentEvent } from '../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESTART_ATTEMPTS = 5;
const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 16000;
const BACKOFF_FACTOR = 2;
const DAEMON_READY_TIMEOUT_MS = 10000;
const CONNECT_RETRY_DELAY_MS = 500;
const CONNECT_MAX_RETRIES = 10;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let daemonProcess: ChildProcess | null = null;
let restartCount = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let currentSocketPath: string | null = null;
let stopped = false;
let eventUnsubscribe: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartDaemonOptions {
  apiKey: string;
  daemonClient: DaemonClient;
  /** Skip connecting the client (for tests) */
  skipConnect?: boolean;
}

export interface PillSubmitOptions {
  prompt: string;
  getActiveTabCdpUrl: () => Promise<string | null>;
  daemonClient: DaemonClient;
  getApiKey: () => Promise<string | null>;
}

export interface PillCancelOptions {
  task_id: string;
  daemonClient: DaemonClient;
}

// ---------------------------------------------------------------------------
// Daemon binary resolution
// ---------------------------------------------------------------------------

function resolveDaemonBinary(): { bin: string; args: string[]; cwd?: string } {
  if (app.isPackaged) {
    const binPath = path.join(process.resourcesPath, 'agent_daemon');
    mainLogger.info('daemonLifecycle.resolveBinary', {
      mode: 'packaged',
      binPath,
    });
    return { bin: binPath, args: [] };
  }

  // Dev mode: try PyInstaller binary first, fall back to python -m
  const appPath = app.getAppPath();
  const pyDistBin = path.join(appPath, '..', '..', 'python', 'dist', 'agent_daemon');

  if (fs.existsSync(pyDistBin)) {
    mainLogger.info('daemonLifecycle.resolveBinary', {
      mode: 'dev-binary',
      binPath: pyDistBin,
    });
    return { bin: pyDistBin, args: [] };
  }

  // Fallback: python -m agent_daemon
  const pythonDir = path.join(appPath, '..', '..', 'python');
  mainLogger.info('daemonLifecycle.resolveBinary', {
    mode: 'dev-python',
    pythonDir,
  });
  return { bin: 'python3', args: ['-m', 'agent_daemon'], cwd: pythonDir };
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

function getSocketPath(): string {
  return path.join(app.getPath('userData'), `daemon-${process.pid}.sock`);
}

// ---------------------------------------------------------------------------
// Spawn daemon
// ---------------------------------------------------------------------------

function spawnDaemon(apiKey: string): ChildProcess {
  const socketPath = getSocketPath();
  currentSocketPath = socketPath;

  // Clean up stale socket file
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
      mainLogger.debug('daemonLifecycle.spawnDaemon', {
        msg: 'Removed stale socket file',
        socketPath,
      });
    }
  } catch {
    // Ignore cleanup errors
  }

  const { bin, args, cwd } = resolveDaemonBinary();

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    DAEMON_SOCKET_PATH: socketPath,
    ANTHROPIC_API_KEY: apiKey,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };

  if (process.env.AGENTIC_DEV) env.AGENTIC_DEV = process.env.AGENTIC_DEV;

  mainLogger.info('daemonLifecycle.spawnDaemon', {
    bin,
    args,
    socketPath,
    cwd: cwd ?? 'inherit',
    // NEVER log the API key
    hasApiKey: true,
  });

  const child = spawn(bin, args, {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe stdout for daemon readiness detection
  child.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    mainLogger.debug('daemonLifecycle.daemon.stdout', { line });
  });

  // Pipe stderr for error logging
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      mainLogger.warn('daemonLifecycle.daemon.stderr', { line });
    }
  });

  // Handle daemon exit
  child.on('exit', (code, signal) => {
    mainLogger.warn('daemonLifecycle.daemon.exit', {
      code,
      signal,
      pid: child.pid,
      restartCount,
      maxRestarts: MAX_RESTART_ATTEMPTS,
    });

    daemonProcess = null;

    if (!stopped && restartCount < MAX_RESTART_ATTEMPTS) {
      scheduleRestart(apiKey);
    } else if (restartCount >= MAX_RESTART_ATTEMPTS) {
      mainLogger.error('daemonLifecycle.daemon.maxRestartsReached', {
        restartCount,
        maxRestarts: MAX_RESTART_ATTEMPTS,
        msg: 'Daemon has crashed too many times. Agent unavailable.',
      });
    }
  });

  child.on('error', (err) => {
    mainLogger.error('daemonLifecycle.daemon.error', {
      error: err.message,
      stack: err.stack,
      pid: child.pid,
    });
  });

  return child;
}

// ---------------------------------------------------------------------------
// Restart with exponential backoff
// ---------------------------------------------------------------------------

function scheduleRestart(apiKey: string): void {
  if (stopped) return;

  restartCount++;
  const delay = Math.min(
    INITIAL_RESTART_DELAY_MS * Math.pow(BACKOFF_FACTOR, restartCount - 1),
    MAX_RESTART_DELAY_MS,
  );

  mainLogger.info('daemonLifecycle.scheduleRestart', {
    attempt: restartCount,
    maxAttempts: MAX_RESTART_ATTEMPTS,
    delayMs: delay,
  });

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopped) return;

    mainLogger.info('daemonLifecycle.restart', {
      attempt: restartCount,
    });

    daemonProcess = spawnDaemon(apiKey);
  }, delay);
}

// ---------------------------------------------------------------------------
// Connect client to daemon with retries
// ---------------------------------------------------------------------------

async function connectWithRetry(client: DaemonClient): Promise<void> {
  for (let attempt = 1; attempt <= CONNECT_MAX_RETRIES; attempt++) {
    try {
      await client.connect();
      mainLogger.info('daemonLifecycle.connect.success', { attempt });
      return;
    } catch (err) {
      mainLogger.debug('daemonLifecycle.connect.retry', {
        attempt,
        maxRetries: CONNECT_MAX_RETRIES,
        error: (err as Error).message,
      });
      if (attempt === CONNECT_MAX_RETRIES) {
        throw new Error(
          `Failed to connect to daemon after ${CONNECT_MAX_RETRIES} attempts: ${(err as Error).message}`,
        );
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: startDaemon / stopDaemon
// ---------------------------------------------------------------------------

/**
 * Spawn the daemon and optionally connect the DaemonClient.
 * Subscribes to daemon events and forwards them to the pill.
 */
export async function startDaemon(opts: StartDaemonOptions): Promise<void> {
  const { apiKey, daemonClient, skipConnect } = opts;

  stopped = false;
  restartCount = 0;

  mainLogger.info('daemonLifecycle.startDaemon', {
    hasApiKey: !!apiKey,
    skipConnect: !!skipConnect,
  });

  daemonProcess = spawnDaemon(apiKey);

  if (!skipConnect) {
    // Wait for socket to appear, then connect
    await connectWithRetry(daemonClient);

    // Subscribe to events and forward to pill
    eventUnsubscribe = daemonClient.onEvent((event: AgentEvent) => {
      mainLogger.debug('daemonLifecycle.event', {
        event: event.event,
        task_id: event.task_id,
      });
      forwardAgentEvent(event);
    });
  }
}

/**
 * Gracefully stop the daemon: kill process, cancel restart timer, clean up socket.
 */
export async function stopDaemon(): Promise<void> {
  mainLogger.info('daemonLifecycle.stopDaemon', {
    hasDaemon: !!daemonProcess,
    pid: daemonProcess?.pid,
  });

  stopped = true;

  // Cancel pending restart
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  // Unsubscribe from events
  if (eventUnsubscribe) {
    eventUnsubscribe();
    eventUnsubscribe = null;
  }

  // Kill daemon process
  if (daemonProcess) {
    try {
      daemonProcess.kill('SIGTERM');
    } catch (err) {
      mainLogger.warn('daemonLifecycle.stopDaemon.killError', {
        error: (err as Error).message,
      });
    }
    daemonProcess = null;
  }

  // Clean up socket file
  if (currentSocketPath) {
    try {
      if (fs.existsSync(currentSocketPath)) {
        fs.unlinkSync(currentSocketPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    currentSocketPath = null;
  }
}

// ---------------------------------------------------------------------------
// Public API: pill:submit / pill:cancel handlers (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Handle pill:submit IPC. Returns { task_id } on success, { error, task_id? } on failure.
 *
 * This is a pure function (no globals) for testability. The actual IPC handler
 * in index.ts calls this with the appropriate dependencies.
 */
export async function handlePillSubmit(opts: PillSubmitOptions): Promise<{
  task_id?: string;
  error?: string;
}> {
  const { prompt, getActiveTabCdpUrl, daemonClient, getApiKey: getKey } = opts;

  const task_id = crypto.randomUUID();

  mainLogger.info('daemonLifecycle.handlePillSubmit', {
    promptLength: prompt?.length,
    task_id,
  });

  // Check for active tab
  const cdpUrl = await getActiveTabCdpUrl();
  if (!cdpUrl) {
    mainLogger.warn('daemonLifecycle.handlePillSubmit.noActiveTab', { task_id });
    return { error: 'no_active_tab', task_id };
  }

  // Check for API key
  const key = await getKey();
  if (!key) {
    mainLogger.warn('daemonLifecycle.handlePillSubmit.missingApiKey', { task_id });
    return { error: 'missing_api_key', task_id };
  }

  // Send to daemon
  try {
    await daemonClient.send({
      meta: 'agent_task',
      prompt,
      per_target_cdp_url: cdpUrl,
      task_id,
    });

    mainLogger.info('daemonLifecycle.handlePillSubmit.sent', {
      task_id,
      cdpUrl,
    });

    return { task_id };
  } catch (err) {
    mainLogger.error('daemonLifecycle.handlePillSubmit.sendFailed', {
      task_id,
      error: (err as Error).message,
    });
    return { error: 'daemon_unavailable', task_id };
  }
}

/**
 * Handle pill:cancel IPC. Sends cancel_task to daemon.
 */
export async function handlePillCancel(opts: PillCancelOptions): Promise<{ ok: boolean; error?: string }> {
  const { task_id, daemonClient } = opts;

  mainLogger.info('daemonLifecycle.handlePillCancel', { task_id });

  try {
    await daemonClient.send({
      meta: 'cancel_task',
      task_id,
    });

    mainLogger.info('daemonLifecycle.handlePillCancel.sent', { task_id });
    return { ok: true };
  } catch (err) {
    mainLogger.error('daemonLifecycle.handlePillCancel.sendFailed', {
      task_id,
      error: (err as Error).message,
    });
    return { ok: false, error: 'daemon_unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Test helpers (exported with underscore prefix)
// ---------------------------------------------------------------------------

/** @internal For tests: get current restart count */
export function _getRestartCount(): number {
  return restartCount;
}

/** @internal For tests: get current socket path */
export function _getSocketPath(): string | null {
  return currentSocketPath;
}

/** @internal For E2E tests: get current daemon process PID (null if not running) */
export function _getDaemonPid(): number | null {
  return daemonProcess?.pid ?? null;
}

/**
 * @internal For E2E tests only — inject a mock DaemonClient so tests can
 * synthesize agent events without a live Python daemon process.
 *
 * Call BEFORE startDaemon().  Only active when DAEMON_MOCK env var is set
 * (the E2E launcher sets DAEMON_MOCK=1).
 *
 * Usage in tests:
 *   electronApp.evaluate(() => {
 *     const { setDaemonClient } = require('./daemonLifecycle');
 *     const mock = new MockDaemonClient();
 *     setDaemonClient(mock);
 *   });
 */
export function setDaemonClient(client: DaemonClient): void {
  if (process.env.DAEMON_MOCK !== '1') {
    mainLogger.warn('daemonLifecycle.setDaemonClient', {
      msg: 'setDaemonClient called without DAEMON_MOCK=1 — ignoring (safety guard)',
    });
    return;
  }
  mainLogger.info('daemonLifecycle.setDaemonClient', {
    msg: 'Injecting mock DaemonClient for E2E test',
  });
  // Wire up event forwarding from the injected client
  if (eventUnsubscribe) {
    eventUnsubscribe();
    eventUnsubscribe = null;
  }
  eventUnsubscribe = client.onEvent((event: AgentEvent) => {
    mainLogger.debug('daemonLifecycle.mockEvent', {
      event: event.event,
      task_id: event.task_id,
    });
    forwardAgentEvent(event);
  });
}
