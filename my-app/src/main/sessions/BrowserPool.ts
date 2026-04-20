import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { mainLogger } from '../logger';
import type { TabInfo } from './types';

const DEFAULT_BROWSER_WIDTH = 1280;
const DEFAULT_BROWSER_HEIGHT = 800;
const DEFAULT_MAX_CONCURRENT = 10;
const THROTTLED_FRAME_RATE = 4;
const ACTIVE_FRAME_RATE = 60;

interface PoolEntry {
  sessionId: string;
  view: WebContentsView;
  createdAt: number;
  attached: boolean;
}

export class BrowserPool {
  private entries: Map<string, PoolEntry> = new Map();
  private maxConcurrent: number;
  private queue: string[] = [];

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
    mainLogger.info('BrowserPool.init', { maxConcurrent });
  }

  get activeCount(): number {
    return this.entries.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  canCreate(): boolean {
    return this.entries.size < this.maxConcurrent;
  }

  create(sessionId: string): WebContentsView | null {
    if (this.entries.has(sessionId)) {
      mainLogger.warn('BrowserPool.create.duplicate', { sessionId });
      return this.entries.get(sessionId)!.view;
    }

    if (!this.canCreate()) {
      this.queue.push(sessionId);
      mainLogger.warn('BrowserPool.create.queued', {
        sessionId,
        activeCount: this.entries.size,
        maxConcurrent: this.maxConcurrent,
        queuePosition: this.queue.length,
      });
      return null;
    }

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: true,
      },
    });

    view.setBounds({
      x: 0,
      y: 0,
      width: DEFAULT_BROWSER_WIDTH,
      height: DEFAULT_BROWSER_HEIGHT,
    });

    view.webContents.setFrameRate(THROTTLED_FRAME_RATE);

    const entry: PoolEntry = {
      sessionId,
      view,
      createdAt: Date.now(),
      attached: false,
    };

    this.entries.set(sessionId, entry);

    mainLogger.info('BrowserPool.create', {
      sessionId,
      activeCount: this.entries.size,
      maxConcurrent: this.maxConcurrent,
      pid: view.webContents.getOSProcessId(),
    });

    return view;
  }

  getWebContents(sessionId: string): WebContents | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return entry.view.webContents;
  }

  getView(sessionId: string): WebContentsView | null {
    const entry = this.entries.get(sessionId);
    return entry?.view ?? null;
  }

  attachToWindow(sessionId: string, window: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      mainLogger.warn('BrowserPool.attach.notFound', { sessionId });
      return false;
    }

    if (entry.attached) {
      mainLogger.debug('BrowserPool.attach.alreadyAttached', { sessionId });
      entry.view.setBounds(bounds);
      return true;
    }

    entry.view.setBounds(bounds);
    window.contentView.addChildView(entry.view);
    entry.attached = true;

    entry.view.webContents.setFrameRate(ACTIVE_FRAME_RATE);

    mainLogger.info('BrowserPool.attach', {
      sessionId,
      bounds,
      frameRate: ACTIVE_FRAME_RATE,
    });

    return true;
  }

  detachFromWindow(sessionId: string, window: BrowserWindow): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      mainLogger.warn('BrowserPool.detach.notFound', { sessionId });
      return false;
    }

    if (!entry.attached) {
      mainLogger.debug('BrowserPool.detach.notAttached', { sessionId });
      return false;
    }

    window.contentView.removeChildView(entry.view);
    entry.attached = false;

    entry.view.webContents.setFrameRate(THROTTLED_FRAME_RATE);

    mainLogger.info('BrowserPool.detach', {
      sessionId,
      frameRate: THROTTLED_FRAME_RATE,
    });

    return true;
  }

  temporarilyDetachAll(window: BrowserWindow): void {
    for (const entry of this.entries.values()) {
      if (entry.attached) {
        window.contentView.removeChildView(entry.view);
      }
    }
    mainLogger.info('BrowserPool.temporarilyDetachAll');
  }

  reattachAll(window: BrowserWindow): void {
    for (const entry of this.entries.values()) {
      if (entry.attached) {
        window.contentView.addChildView(entry.view);
      }
    }
    mainLogger.info('BrowserPool.reattachAll');
  }

  async getTabs(sessionId: string): Promise<TabInfo[]> {
    const wc = this.getWebContents(sessionId);
    if (!wc) return [];

    try {
      const url = wc.getURL();
      const title = wc.getTitle();

      return [{
        targetId: String(wc.id),
        url: url || 'about:blank',
        title: title || 'New Tab',
        type: 'page',
        active: true,
      }];
    } catch (err) {
      mainLogger.warn('BrowserPool.getTabs.error', {
        sessionId,
        error: (err as Error).message,
      });
      return [];
    }
  }

  destroy(sessionId: string, window?: BrowserWindow): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      mainLogger.debug('BrowserPool.destroy.notFound', { sessionId });
      return;
    }

    if (entry.attached && window) {
      try {
        window.contentView.removeChildView(entry.view);
      } catch (err) {
        mainLogger.warn('BrowserPool.destroy.detachError', {
          sessionId,
          error: (err as Error).message,
        });
      }
    }

    const lifetimeMs = Date.now() - entry.createdAt;

    try {
      (entry.view.webContents as any).close();
    } catch {
      // webContents may already be destroyed
    }

    this.entries.delete(sessionId);

    mainLogger.info('BrowserPool.destroy', {
      sessionId,
      lifetimeMs,
      remainingActive: this.entries.size,
    });

    this.drainQueue();
  }

  destroyAll(window?: BrowserWindow): void {
    const sessionIds = Array.from(this.entries.keys());
    mainLogger.info('BrowserPool.destroyAll', { count: sessionIds.length });

    for (const sessionId of sessionIds) {
      this.destroy(sessionId, window);
    }

    this.queue.length = 0;
  }

  isAttached(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return entry?.attached ?? false;
  }

  getStats(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    sessions: Array<{ sessionId: string; attached: boolean; createdAt: number; pid: number }>;
  } {
    const sessions = Array.from(this.entries.values()).map((e) => ({
      sessionId: e.sessionId,
      attached: e.attached,
      createdAt: e.createdAt,
      pid: e.view.webContents.getOSProcessId(),
    }));

    return {
      active: this.entries.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      sessions,
    };
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.canCreate()) {
      const nextSessionId = this.queue.shift()!;
      mainLogger.info('BrowserPool.drainQueue', {
        sessionId: nextSessionId,
        remainingQueued: this.queue.length,
      });
      // The session manager will need to call create() again for this session.
      // We emit the session ID so the caller knows to retry.
      // For now, just log — the session manager polls canCreate().
    }
  }
}
