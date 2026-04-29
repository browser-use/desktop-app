/**
 * Track B — Pill BrowserWindow lifecycle.
 *
 * Creates and manages the transparent frameless overlay window used for the
 * Cmd+K pill UX. The window is created hidden at app-ready and shown/hidden
 * on hotkey toggle.
 *
 * Design decisions (from plan §5 Track B):
 * - width: 560, height: 72 initial; grows downward with toast/result
 * - transparent: true, frame: false, alwaysOnTop: true, hasShadow: true
 * - Positioned at center-top of the active display on show
 * - Show latency measured from toggle entry to window.show() call (p95 ≤ 150ms)
 *
 * D2: Verbose dev-only logging on all lifecycle events.
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { AgentEvent } from '../shared/types';
import { mainLogger, rendererLogger } from './logger';

// ---------------------------------------------------------------------------
// Scoped logger shim — delegates to mainLogger with component prefix
// ---------------------------------------------------------------------------

const log = {
  debug: (comp: string, ctx: object) => mainLogger.debug(comp, ctx as Record<string, unknown>),
  info:  (comp: string, ctx: object) => mainLogger.info(comp, ctx as Record<string, unknown>),
  warn:  (comp: string, ctx: object) => mainLogger.warn(comp, ctx as Record<string, unknown>),
  error: (comp: string, ctx: object) => mainLogger.error(comp, ctx as Record<string, unknown>),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PILL_WIDTH = 600;
const PILL_HEIGHT_COLLAPSED = 110;
const PILL_HEIGHT_EXPANDED = 520;
const PILL_TOP_OFFSET = 160;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let pillWindow: BrowserWindow | null = null;
let requestedPillHeight = PILL_HEIGHT_COLLAPSED;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the x position so the pill is horizontally centered on the display
 * nearest the cursor.
 */
function clampPillHeight(height: number): number {
  return Math.max(PILL_HEIGHT_COLLAPSED, Math.min(height, PILL_HEIGHT_EXPANDED));
}

function computePillBounds(height = requestedPillHeight): { x: number; y: number; width: number; height: number } {
  let displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };

  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    displayBounds = display.bounds;
  } catch (err) {
    log.warn('pill.computePillBounds', {
      message: 'Failed to get display bounds, using defaults',
      error: (err as Error).message,
    });
  }

  const x = Math.round(displayBounds.x + (displayBounds.width - PILL_WIDTH) / 2);
  const y = displayBounds.y + PILL_TOP_OFFSET;

  log.debug('pill.computePillBounds', {
    message: 'Computed pill position',
    x,
    y,
    displayBounds,
  });

  return { x, y, width: PILL_WIDTH, height };
}

// ---------------------------------------------------------------------------
// Visibility callbacks
// ---------------------------------------------------------------------------

const visibilityCallbacks: Array<(visible: boolean) => void> = [];

export function onPillVisibilityChange(cb: (visible: boolean) => void): () => void {
  visibilityCallbacks.push(cb);
  return () => {
    const i = visibilityCallbacks.indexOf(cb);
    if (i >= 0) visibilityCallbacks.splice(i, 1);
  };
}

function notifyVisibility(visible: boolean): void {
  for (const cb of visibilityCallbacks) {
    try { cb(visible); } catch (err) {
      log.warn('pill.notifyVisibility.error', { error: (err as Error).message });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the pill BrowserWindow. Call once at app.whenReady().
 * The window starts hidden and is shown on first toggle.
 */
export function createPillWindow(): BrowserWindow {
  if (pillWindow && !pillWindow.isDestroyed()) {
    log.warn('pill.createPillWindow', {
      message: 'Pill window already exists — returning existing instance',
    });
    return pillWindow;
  }

  log.info('pill.createPillWindow', {
    message: 'Creating pill window',
    width: PILL_WIDTH,
    height: PILL_HEIGHT_COLLAPSED,
  });

  requestedPillHeight = PILL_HEIGHT_COLLAPSED;

  pillWindow = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT_COLLAPSED,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: true,
    resizable: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    skipTaskbar: true,
    show: false,
    vibrancy: 'hud',
    visualEffectState: 'active',
    // Ensure it appears above full-screen apps on macOS
    type: 'panel',
    webPreferences: {
      preload: path.join(__dirname, 'pill.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pillWindow.setAlwaysOnTop(true, 'screen-saver');

  // Load the pill renderer
  if (
    typeof PILL_VITE_DEV_SERVER_URL !== 'undefined' &&
    PILL_VITE_DEV_SERVER_URL
  ) {
    const pillDevUrl = `${PILL_VITE_DEV_SERVER_URL}/src/renderer/pill/pill.html`;
    log.debug('pill.createPillWindow', {
      message: 'Loading pill from dev server',
      url: pillDevUrl,
    });
    pillWindow.loadURL(pillDevUrl);
  } else {
    // Forge VitePlugin preserves the input path relative to project root.
    // __dirname = .vite/build; renderer lands at
    // .vite/renderer/pill/src/renderer/pill/pill.html
    const htmlPath = path.join(__dirname, '../renderer/pill/src/renderer/pill/pill.html');
    log.debug('pill.createPillWindow', {
      message: 'Loading pill from file',
      htmlPath,
    });
    pillWindow.loadFile(htmlPath);
  }

  pillWindow.webContents.setZoomFactor(1);
  pillWindow.webContents.setVisualZoomLevelLimits(1, 1);
  pillWindow.webContents.once('did-finish-load', () => {
    log.info('pill.webContents.ready', {
      message: 'Pill renderer loaded and ready',
    });
  });

  pillWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    rendererLogger.info('renderer.console', { window: 'pill', level, source: sourceId, line, message });
  });

  pillWindow.on('closed', () => {
    log.info('pill.closed', { message: 'Pill window closed — nulling reference' });
    pillWindow = null;
  });

  log.info('pill.createPillWindow.complete', {
    message: 'Pill window created (hidden)',
    width: PILL_WIDTH,
    height: PILL_HEIGHT_COLLAPSED,
  });

  return pillWindow;
}

/**
 * Show the pill window, repositioning it to center-top of the active display.
 * Measures show latency (§6 Acceptance #6 target: p95 ≤ 150ms).
 */
export function showPill(): void {
  const t0 = performance.now();

  if (!pillWindow || pillWindow.isDestroyed()) {
    log.error('pill.showPill', {
      message: 'Cannot show pill — window not created or destroyed',
    });
    return;
  }

  // Reposition to center-top of active display every time we show
  const bounds = computePillBounds();
  pillWindow.setBounds(bounds);

  pillWindow.showInactive();
  pillWindow.setAlwaysOnTop(true, 'screen-saver');
  pillWindow.focus();
  notifyVisibility(true);

  const latency_ms = performance.now() - t0;
  log.info('pill.show', {
    message: 'Pill shown',
    latency_ms,
    bounds,
  });

  // Warn if we're approaching the 150ms p95 target
  if (latency_ms > 100) {
    log.warn('pill.show.latency', {
      message: 'Pill show latency above 100ms warning threshold',
      latency_ms,
      target_p95_ms: 150,
    });
  }
}

/**
 * Hide the pill window.
 */
export function hidePill(): void {
  if (!pillWindow || pillWindow.isDestroyed()) {
    log.debug('pill.hidePill', {
      message: 'No pill window to hide',
    });
    return;
  }

  log.info('pill.hidePill', { message: 'Hiding pill window' });
  pillWindow.hide();
  notifyVisibility(false);
}

/**
 * Toggle pill visibility.
 * - If hidden → show (reposition to center-top of active display)
 * - If visible → hide
 *
 * This is the function called by the Cmd+K hotkey handler.
 */
export function togglePill(): void {
  if (!pillWindow || pillWindow.isDestroyed()) {
    log.error('pill.togglePill', {
      message: 'Cannot toggle pill — window not created or destroyed',
    });
    return;
  }

  const visible = pillWindow.isVisible();
  log.info('pill.togglePill', {
    message: 'Toggling pill',
    currentlyVisible: visible,
  });

  if (visible) {
    hidePill();
  } else {
    showPill();
  }
}

/**
/**
 * Send a channel+payload to the pill renderer via webContents.send.
 * Used by the main-process IPC hub to forward agent events.
 */
export function sendToPill(channel: string, payload: unknown): void {
  if (!pillWindow || pillWindow.isDestroyed()) {
    log.warn('pill.sendToPill', {
      message: 'Cannot send to pill — window not created or destroyed',
      channel,
    });
    return;
  }

  if (!pillWindow.isVisible()) {
    log.debug('pill.sendToPill', {
      message: 'Pill is hidden — sending anyway (renderer may queue)',
      channel,
    });
  }

  log.debug('pill.sendToPill', {
    message: 'Sending message to pill renderer',
    channel,
    payloadType: typeof payload === 'object' && payload !== null
      ? (payload as { event?: string }).event ?? 'unknown'
      : typeof payload,
  });

  pillWindow.webContents.send(channel, payload);
}

/**
 * Forward an AgentEvent to the pill renderer on the `pill:event` channel.
 */
export function forwardAgentEvent(event: AgentEvent): void {
  log.debug('pill.forwardAgentEvent', {
    message: 'Forwarding agent event to pill',
    event: event.event,
    task_id: event.task_id,
  });
  sendToPill('pill:event', event);
}

/**
 * Exported dimension constants — use these in IPC handlers to grow/shrink the pill.
 * COLLAPSED = idle/focused (56px input row only)
 * EXPANDED  = streaming or result state (input row + expanded section)
 */
export { PILL_HEIGHT_COLLAPSED, PILL_HEIGHT_EXPANDED };

/**
 * Resize pill window height (grows downward as toast/result appear).
 */
export function setPillHeight(height: number): void {
  const nextHeight = clampPillHeight(height);
  requestedPillHeight = nextHeight;

  if (!pillWindow || pillWindow.isDestroyed()) return;

  const current = pillWindow.getBounds();
  pillWindow.setBounds({ ...current, height: nextHeight }, true);

  log.debug('pill.setPillHeight', {
    message: 'Pill height updated',
    previous: current.height,
    next: nextHeight,
  });
}
