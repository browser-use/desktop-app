/**
 * mv3/ServiceWorkerManager.ts — Manages extension service worker lifecycles.
 *
 * MV3 background scripts run as event-driven service workers with idle timeouts.
 * This manager tracks worker state, enforces timeouts, and handles wake/sleep cycles.
 */

import { session } from 'electron';
import { mainLogger } from '../../logger';
import {
  MV3_LOG_PREFIX,
  SERVICE_WORKER_IDLE_TIMEOUT_MS,
  SERVICE_WORKER_MAX_LIFETIME_MS,
} from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerState = 'starting' | 'running' | 'idle' | 'stopped';

export interface ServiceWorkerInfo {
  extensionId: string;
  state: WorkerState;
  startedAt: number | null;
  lastActivityAt: number;
  wakeCount: number;
}

// ---------------------------------------------------------------------------
// ServiceWorkerManager
// ---------------------------------------------------------------------------

const LOG = `${MV3_LOG_PREFIX}.ServiceWorkerManager`;

export class ServiceWorkerManager {
  private workers = new Map<string, ServiceWorkerInfo>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lifetimeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    mainLogger.info(`${LOG}.init`);
  }

  registerWorker(extensionId: string): void {
    mainLogger.info(`${LOG}.registerWorker`, { extensionId });

    const info: ServiceWorkerInfo = {
      extensionId,
      state: 'stopped',
      startedAt: null,
      lastActivityAt: Date.now(),
      wakeCount: 0,
    };

    this.workers.set(extensionId, info);
  }

  async startWorker(extensionId: string): Promise<void> {
    const info = this.workers.get(extensionId);
    if (!info) {
      mainLogger.warn(`${LOG}.startWorker.notRegistered`, { extensionId });
      return;
    }

    if (info.state === 'running') {
      mainLogger.info(`${LOG}.startWorker.alreadyRunning`, { extensionId });
      return;
    }

    info.state = 'starting';
    info.startedAt = Date.now();
    info.wakeCount += 1;

    mainLogger.info(`${LOG}.startWorker`, {
      extensionId,
      wakeCount: info.wakeCount,
    });

    try {
      const ext = session.defaultSession
        .getAllExtensions()
        .find((e) => e.id === extensionId);

      if (!ext) {
        mainLogger.warn(`${LOG}.startWorker.extensionNotLoaded`, { extensionId });
        info.state = 'stopped';
        return;
      }

      info.state = 'running';
      info.lastActivityAt = Date.now();

      this.scheduleIdleTimeout(extensionId);
      this.scheduleLifetimeTimeout(extensionId);

      mainLogger.info(`${LOG}.startWorker.ok`, { extensionId });
    } catch (err) {
      info.state = 'stopped';
      mainLogger.error(`${LOG}.startWorker.failed`, {
        extensionId,
        error: (err as Error).message,
      });
    }
  }

  recordActivity(extensionId: string): void {
    const info = this.workers.get(extensionId);
    if (!info) return;

    info.lastActivityAt = Date.now();

    if (info.state === 'idle') {
      info.state = 'running';
      mainLogger.info(`${LOG}.recordActivity.wakeFromIdle`, { extensionId });
    }

    this.scheduleIdleTimeout(extensionId);
  }

  stopWorker(extensionId: string): void {
    const info = this.workers.get(extensionId);
    if (!info) return;

    mainLogger.info(`${LOG}.stopWorker`, {
      extensionId,
      previousState: info.state,
      uptimeMs: info.startedAt ? Date.now() - info.startedAt : 0,
    });

    info.state = 'stopped';
    info.startedAt = null;

    this.clearTimers(extensionId);
  }

  unregisterWorker(extensionId: string): void {
    mainLogger.info(`${LOG}.unregisterWorker`, { extensionId });
    this.clearTimers(extensionId);
    this.workers.delete(extensionId);
  }

  getWorkerState(extensionId: string): WorkerState | null {
    return this.workers.get(extensionId)?.state ?? null;
  }

  getWorkerInfo(extensionId: string): ServiceWorkerInfo | null {
    return this.workers.get(extensionId) ?? null;
  }

  getAllWorkerStates(): Map<string, WorkerState> {
    const result = new Map<string, WorkerState>();
    for (const [id, info] of this.workers) {
      result.set(id, info.state);
    }
    return result;
  }

  dispose(): void {
    mainLogger.info(`${LOG}.dispose`, { workerCount: this.workers.size });
    for (const extensionId of this.workers.keys()) {
      this.clearTimers(extensionId);
    }
    this.workers.clear();
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private scheduleIdleTimeout(extensionId: string): void {
    const existing = this.idleTimers.get(extensionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const info = this.workers.get(extensionId);
      if (!info || info.state !== 'running') return;

      const elapsed = Date.now() - info.lastActivityAt;
      if (elapsed >= SERVICE_WORKER_IDLE_TIMEOUT_MS) {
        mainLogger.info(`${LOG}.idleTimeout`, { extensionId, idleMs: elapsed });
        info.state = 'idle';
        this.stopWorker(extensionId);
      }
    }, SERVICE_WORKER_IDLE_TIMEOUT_MS);

    this.idleTimers.set(extensionId, timer);
  }

  private scheduleLifetimeTimeout(extensionId: string): void {
    const existing = this.lifetimeTimers.get(extensionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const info = this.workers.get(extensionId);
      if (!info || info.state === 'stopped') return;

      mainLogger.info(`${LOG}.lifetimeTimeout`, {
        extensionId,
        maxLifetimeMs: SERVICE_WORKER_MAX_LIFETIME_MS,
      });

      this.stopWorker(extensionId);
    }, SERVICE_WORKER_MAX_LIFETIME_MS);

    this.lifetimeTimers.set(extensionId, timer);
  }

  private clearTimers(extensionId: string): void {
    const idle = this.idleTimers.get(extensionId);
    if (idle) {
      clearTimeout(idle);
      this.idleTimers.delete(extensionId);
    }

    const lifetime = this.lifetimeTimers.get(extensionId);
    if (lifetime) {
      clearTimeout(lifetime);
      this.lifetimeTimers.delete(extensionId);
    }
  }
}
