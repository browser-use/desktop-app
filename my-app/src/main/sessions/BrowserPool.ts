import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { mainLogger } from '../logger';
import type { TabInfo } from './types';

const DEFAULT_BROWSER_WIDTH = 1280;
const DEFAULT_BROWSER_HEIGHT = 800;
const DEFAULT_MAX_CONCURRENT = 10;
const THROTTLED_FRAME_RATE = 4;
const ACTIVE_FRAME_RATE = 60;
// Fixed emulated viewport so sites always see a desktop-sized window,
// regardless of how small the WebContentsView rect is in the hub. The
// rendered content is scaled (fitToView) into the actual rect, so media
// queries like @media (min-width: 768px) always evaluate against these
// dimensions — no accidental tablet/mobile layouts.
const EMULATED_VIEWPORT_WIDTH = 1440;
const EMULATED_VIEWPORT_HEIGHT = 900;

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
  private onGone?: (sessionId: string) => void;
  private onNavigate?: (sessionId: string, url: string) => void;

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
    mainLogger.info('BrowserPool.init', { maxConcurrent });
  }

  /** Register a listener that fires when a session's WebContents is gone
   *  (destroyed, crashed, or explicitly closed). Used to push a browser-gone
   *  notification to the renderer so the UI can stop showing "Browser starting…". */
  setOnGone(listener: (sessionId: string) => void): void {
    this.onGone = listener;
  }

  /** Register a listener that fires on every top-frame navigation (including
   *  in-page hash/pushState). Used by SessionManager to keep session.primarySite
   *  in sync with the actual browser — the source of truth, not tool-call args. */
  setOnNavigate(listener: (sessionId: string, url: string) => void): void {
    this.onNavigate = listener;
  }

  private notifyGone(sessionId: string): void {
    try { this.onGone?.(sessionId); } catch (err) {
      mainLogger.warn('BrowserPool.notifyGone.listenerError', { sessionId, error: (err as Error).message });
    }
  }

  private notifyNavigate(sessionId: string, url: string): void {
    try { this.onNavigate?.(sessionId, url); } catch (err) {
      mainLogger.warn('BrowserPool.notifyNavigate.listenerError', { sessionId, error: (err as Error).message });
    }
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

    // Pin the embedded page's viewport to a fixed desktop size so sites
    // always render their desktop layout — no tablet/mobile reflow.
    //
    // Strategy: emulate screen/view at EMULATED_VIEWPORT_* (for media
    // queries / window.innerWidth) but leave fitToView=false so Chromium
    // renders at natural size. We then scale the visible content down via
    // webContents.setZoomFactor so it fits the physical WebContentsView
    // rect. setZoomFactor doesn't change CSS viewport, so the page still
    // thinks it's 1440-wide even though we're drawing it smaller. Input
    // coordinates are scaled correctly by Chromium's zoom pipeline, so
    // clicks and scrolls land on the right DOM elements.
    const applyEmulation = (): void => {
      try {
        if (view.webContents.isDestroyed()) return;
        view.webContents.enableDeviceEmulation({
          screenSize: { width: EMULATED_VIEWPORT_WIDTH, height: EMULATED_VIEWPORT_HEIGHT },
          viewSize:   { width: EMULATED_VIEWPORT_WIDTH, height: EMULATED_VIEWPORT_HEIGHT },
          deviceScaleFactor: 1,
          viewPosition: { x: 0, y: 0 },
          screenPosition: 'desktop',
          fitToView: false,
          offset: { x: 0, y: 0 },
          scale: 1,
        });
        mainLogger.info('BrowserPool.deviceEmulation.applied', {
          sessionId,
          operationalViewport: {
            width: EMULATED_VIEWPORT_WIDTH,
            height: EMULATED_VIEWPORT_HEIGHT,
            note: 'what the page sees via window.innerWidth / media queries',
          },
        });
      } catch (err) {
        mainLogger.warn('BrowserPool.deviceEmulation.error', {
          sessionId,
          error: (err as Error).message,
        });
      }
    };
    view.webContents.once('did-start-loading', applyEmulation);
    view.webContents.on('did-finish-load', applyEmulation);

    const entry: PoolEntry = {
      sessionId,
      view,
      createdAt: Date.now(),
      attached: false,
    };

    this.entries.set(sessionId, entry);

    // Fire onGone if the renderer process crashes, closes, or otherwise dies
    // out-of-band so the UI can react (stop showing "Browser starting…").
    const wc = view.webContents;
    wc.on('destroyed', () => {
      mainLogger.info('BrowserPool.wc.destroyed', { sessionId });
      this.entries.delete(sessionId);
      this.notifyGone(sessionId);
    });
    wc.on('render-process-gone', (_event, details) => {
      mainLogger.warn('BrowserPool.wc.renderProcessGone', { sessionId, reason: details.reason });
      this.notifyGone(sessionId);
    });
    // Top-frame navigation — full page load. Covers agent-driven goto(),
    // user clicks on links, form submits, history back/forward, etc.
    wc.on('did-navigate', (_event, url) => {
      this.notifyNavigate(sessionId, url);
    });
    // SPA/hash navigation — pushState, replaceState, hash changes. Many
    // sites (x.com, linkedin, gmail) never fire did-navigate after the
    // initial load, so without this the primarySite gets stuck on the
    // first URL and misses SPA route changes.
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.notifyNavigate(sessionId, url);
    });

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
      // Don't touch zoom here — user's manual zoom (Cmd+=/Cmd+-) should
      // persist across attach cycles.
      return true;
    }

    entry.view.setBounds(bounds);
    window.contentView.addChildView(entry.view);
    entry.attached = true;

    entry.view.webContents.setFrameRate(ACTIVE_FRAME_RATE);

    // Scale the rendered page so the emulated 1440×900 viewport fits the
    // physical rect. Use the smaller axis so content never overflows.
    const zoom = Math.min(
      bounds.width / EMULATED_VIEWPORT_WIDTH,
      bounds.height / EMULATED_VIEWPORT_HEIGHT,
    );
    try {
      entry.view.webContents.setZoomFactor(Math.max(0.25, Math.min(1, zoom)));
    } catch (err) {
      mainLogger.warn('BrowserPool.attach.setZoomFactor.error', { sessionId, zoom, error: (err as Error).message });
    }

    mainLogger.info('BrowserPool.attach', {
      sessionId,
      visualBounds: bounds,
      operationalViewport: {
        width: EMULATED_VIEWPORT_WIDTH,
        height: EMULATED_VIEWPORT_HEIGHT,
      },
      zoomFactor: zoom,
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

  detachAll(window: BrowserWindow): void {
    const ids = Array.from(this.entries.keys());
    for (const id of ids) {
      this.detachFromWindow(id, window);
    }
    mainLogger.info('BrowserPool.detachAll', { count: ids.length });
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
