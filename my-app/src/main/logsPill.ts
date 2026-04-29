/**
 * Logs window — a small always-on-top BrowserWindow that overlays the
 * embedded browser view, anchored to the pane rect supplied by the renderer.
 * Hosts a single xterm for whichever session the user has targeted.
 * Distinct from the command pill.
 */

import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { mainLogger, rendererLogger } from './logger';
import { registerViteDepStaleHeal } from './viteDepStaleHeal';

const log = {
  info: (c: string, x: object) => mainLogger.info(c, x as Record<string, unknown>),
  warn: (c: string, x: object) => mainLogger.warn(c, x as Record<string, unknown>),
  error: (c: string, x: object) => mainLogger.error(c, x as Record<string, unknown>),
  debug: (c: string, x: object) => mainLogger.debug(c, x as Record<string, unknown>),
};

const LOGS_WIDTH = 380;
const LOGS_HEIGHT = 220;
const LOGS_MIN_WIDTH = 260;
const LOGS_MIN_HEIGHT = 140;
const LOGS_MARGIN = 10;
const DOT_SIZE = 36;

export type LogsMode = 'dot' | 'normal' | 'full';

export interface PaneAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

let logsWindow: BrowserWindow | null = null;
let logsReady = false;
const pendingMessages: Array<{ channel: string; args: unknown[] }> = [];
let activeSessionId: string | null = null;
let anchorWindow: BrowserWindow | null = null;
let lastAnchor: PaneAnchor | null = null;
let wasVisibleBeforeBlur = false;
// Display mode. 'normal' is the preset 380×220 panel, 'dot' is the small
// clickable pill, 'full' fills the anchored pane rect. User can also drag-
// resize the window; that flips `userCustomized` so we stop auto-repositioning
// until the user clicks a preset again.
let mode: LogsMode = 'normal';
let userCustomized = false;
// Timestamp until which programmatic bound changes should be ignored by the
// resize/move listeners. A single-shot flag wasn't enough because Electron
// fires both 'move' and 'resize' (plus intermediate frames) from one
// setBounds call, and the first event consumed the flag, letting later
// ones mark the window as user-customized.
let programmaticBoundsChangeUntil = 0;
function beginProgrammaticBoundsChange(durationMs = 200): void {
  programmaticBoundsChangeUntil = Date.now() + durationMs;
}
function isProgrammaticBoundsChange(): boolean {
  return Date.now() < programmaticBoundsChangeUntil;
}

type MacWindowFullscreenApi = BrowserWindow & {
  isSimpleFullScreen?: () => boolean;
  setFullScreenable?: (fullscreenable: boolean) => void;
  setSimpleFullScreen?: (flag: boolean) => void;
};

function applyLogsWindowStatePolicy(win: BrowserWindow): void {
  const macWin = win as MacWindowFullscreenApi;
  try { macWin.setFullScreenable?.(false); } catch (err) {
    log.warn('logs.setFullScreenable.error', { error: (err as Error).message });
  }
  try { win.setMaximizable(false); } catch (err) {
    log.warn('logs.setMaximizable.error', { error: (err as Error).message });
  }
  try { win.setMinimizable(false); } catch (err) {
    log.warn('logs.setMinimizable.error', { error: (err as Error).message });
  }
}

function restoreLogsWindowFromDisallowedState(reason: string): void {
  if (!logsWindow || logsWindow.isDestroyed()) return;
  const win = logsWindow as MacWindowFullscreenApi;
  log.warn('logs.disallowedWindowState', { reason, mode });
  applyLogsWindowStatePolicy(logsWindow);

  try {
    if (logsWindow.isFullScreen()) logsWindow.setFullScreen(false);
  } catch (err) {
    log.warn('logs.leaveFullScreen.error', { error: (err as Error).message });
  }

  try {
    if (win.isSimpleFullScreen?.()) win.setSimpleFullScreen?.(false);
  } catch (err) {
    log.warn('logs.leaveSimpleFullScreen.error', { error: (err as Error).message });
  }

  try {
    if (logsWindow.isMaximized()) logsWindow.unmaximize();
  } catch (err) {
    log.warn('logs.unmaximize.error', { error: (err as Error).message });
  }

  if (anchorWindow && !anchorWindow.isDestroyed()) {
    beginProgrammaticBoundsChange();
    logsWindow.setBounds(computeLogsBounds(anchorWindow, lastAnchor));
  }
}

function safeSend(channel: string, ...args: unknown[]): void {
  if (!logsWindow || logsWindow.isDestroyed()) {
    log.warn('logs.safeSend.no-window', { channel });
    return;
  }
  if (!logsReady) {
    pendingMessages.push({ channel, args });
    log.info('logs.safeSend.queued', { channel, pendingCount: pendingMessages.length });
    return;
  }
  log.debug('logs.safeSend', { channel });
  logsWindow.webContents.send(channel, ...(args as [unknown, ...unknown[]]));
}

function flushPending(): void {
  if (!logsWindow || logsWindow.isDestroyed()) return;
  if (pendingMessages.length === 0) return;
  log.info('logs.flushPending', { count: pendingMessages.length });
  for (const { channel, args } of pendingMessages) {
    logsWindow.webContents.send(channel, ...(args as [unknown, ...unknown[]]));
  }
  pendingMessages.length = 0;
}

/**
 * Compute logs-window bounds anchored to the renderer-supplied pane rect
 * (viewport coords inside the hub). Falls back to hub-wide bottom-right if
 * no anchor was supplied.
 */
function computeLogsBounds(
  hub: BrowserWindow,
  anchor: PaneAnchor | null,
): { x: number; y: number; width: number; height: number } {
  const hubContent = hub.getContentBounds();

  if (mode === 'dot') {
    const w = DOT_SIZE;
    const h = DOT_SIZE;
    if (anchor) {
      const x = Math.round(hubContent.x + anchor.x + anchor.width - w - LOGS_MARGIN);
      const y = Math.round(hubContent.y + anchor.y + anchor.height - h - LOGS_MARGIN);
      return { x, y, width: w, height: h };
    }
    const x = hubContent.x + hubContent.width - w - LOGS_MARGIN;
    const y = hubContent.y + hubContent.height - h - LOGS_MARGIN;
    return { x, y, width: w, height: h };
  }

  if (mode === 'full' && anchor) {
    // Fill the pane rect exactly, edge-to-edge.
    const width = Math.max(LOGS_MIN_WIDTH, anchor.width);
    const height = Math.max(LOGS_MIN_HEIGHT, anchor.height);
    const x = Math.round(hubContent.x + anchor.x);
    const y = Math.round(hubContent.y + anchor.y);
    return { x, y, width, height };
  }

  // 'normal' (or 'full' with no anchor fallback): preset 380×220 bottom-right.
  if (anchor) {
    const width = Math.min(LOGS_WIDTH, Math.max(LOGS_MIN_WIDTH, anchor.width - LOGS_MARGIN * 2));
    const height = Math.min(LOGS_HEIGHT, Math.max(LOGS_MIN_HEIGHT, anchor.height - LOGS_MARGIN * 2));
    const x = Math.round(hubContent.x + anchor.x + anchor.width - width - LOGS_MARGIN);
    const y = Math.round(hubContent.y + anchor.y + anchor.height - height - LOGS_MARGIN);
    log.debug('logs.computeBounds.anchored', { hubContent, anchor, mode, computed: { x, y, width, height } });
    return { x, y, width, height };
  }
  const width = Math.min(LOGS_WIDTH, Math.max(LOGS_MIN_WIDTH, hubContent.width - LOGS_MARGIN * 2));
  const height = LOGS_HEIGHT;
  const x = hubContent.x + hubContent.width - width - LOGS_MARGIN;
  const y = hubContent.y + hubContent.height - height - LOGS_MARGIN;
  log.debug('logs.computeBounds.fallback', { hubContent, mode, computed: { x, y, width, height } });
  return { x, y, width, height };
}

export function createLogsWindow(): BrowserWindow {
  if (logsWindow && !logsWindow.isDestroyed()) {
    log.info('logs.create.existing', {});
    return logsWindow;
  }

  log.info('logs.create', { width: LOGS_WIDTH, height: LOGS_HEIGHT });

  logsWindow = new BrowserWindow({
    width: LOGS_WIDTH,
    height: LOGS_HEIGHT,
    minWidth: LOGS_MIN_WIDTH,
    minHeight: LOGS_MIN_HEIGHT,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
    hasShadow: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    backgroundColor: '#0b0d10',
    roundedCorners: true,
    skipTaskbar: true,
    show: false,
    type: 'panel',
    webPreferences: {
      preload: path.join(__dirname, 'logs.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyLogsWindowStatePolicy(logsWindow);

  // User-drag resize/move detection — once the user manually changes bounds,
  // stop auto-repositioning. A mode-switch or explicit show resets the flag.
  // We ignore events that fire within ~200ms of our own setBounds call so
  // programmatic changes don't masquerade as user customizations.
  logsWindow.on('resize', () => {
    if (isProgrammaticBoundsChange()) return;
    userCustomized = true;
    log.debug('logs.userResized', { bounds: logsWindow?.getBounds() });
  });
  logsWindow.on('move', () => {
    if (isProgrammaticBoundsChange()) return;
    userCustomized = true;
    log.debug('logs.userMoved', { bounds: logsWindow?.getBounds() });
  });
  logsWindow.on('enter-full-screen', () => restoreLogsWindowFromDisallowedState('enter-full-screen'));
  logsWindow.on('enter-html-full-screen', () => restoreLogsWindowFromDisallowedState('enter-html-full-screen'));
  logsWindow.on('maximize', () => restoreLogsWindowFromDisallowedState('maximize'));

  // Pin to the Space where the hub lives so a 3/4-finger swipe hides the
  // logs overlay along with the hub. The previous 'screen-saver' level
  // overrode Space containment on macOS (that level floats above
  // everything, including Space boundaries), causing the overlay to leak
  // onto every desktop. 'floating' is above normal windows but respects
  // Spaces — sufficient for our overlay purpose.
  logsWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  logsWindow.setAlwaysOnTop(true, 'floating');

  const preloadPath = path.join(__dirname, 'logs.js');
  log.info('logs.preload.path', { preloadPath });

  const isDev = typeof LOGS_VITE_DEV_SERVER_URL !== 'undefined' && LOGS_VITE_DEV_SERVER_URL;
  const devUrl = isDev ? `${LOGS_VITE_DEV_SERVER_URL}/src/renderer/logs/logs.html` : null;
  const htmlPath = isDev ? null : path.join(__dirname, '../renderer/logs/src/renderer/logs/logs.html');

  const loadLogs = (): void => {
    if (!logsWindow || logsWindow.isDestroyed()) return;
    if (devUrl) {
      log.info('logs.load.dev', { url: devUrl });
      logsWindow.loadURL(devUrl).catch((err) => log.error('logs.loadURL.reject', { url: devUrl, error: (err as Error).message }));
    } else if (htmlPath) {
      log.info('logs.load.file', { htmlPath });
      logsWindow.loadFile(htmlPath).catch((err) => log.error('logs.loadFile.reject', { htmlPath, error: (err as Error).message }));
    }
  };
  loadLogs();

  logsWindow.webContents.setZoomFactor(1);
  logsWindow.webContents.setVisualZoomLevelLimits(1, 1);

  logsWindow.webContents.on('did-start-loading', () => log.info('logs.did-start-loading', {}));
  logsWindow.webContents.on('dom-ready', () => log.info('logs.dom-ready', {}));
  logsWindow.webContents.on('did-finish-load', () => {
    log.info('logs.did-finish-load', { activeSessionId, mode });
    logsReady = true;
    if (activeSessionId) {
      logsWindow?.webContents.send('logs:active-session-changed', activeSessionId);
    }
    logsWindow?.webContents.send('logs:mode-changed', mode);
    flushPending();
  });
  // Retry did-fail-load on the dev-mode Vite race — matches the hub window
  // pattern. Without this, if the logs window loads before Vite is listening,
  // the overlay opens as an empty gray panel because its renderer never ran.
  let logsRetriesLeft = isDev ? 10 : 0;
  logsWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    log.warn('logs.did-fail-load', { code, desc, url, retriesLeft: logsRetriesLeft });
    if (logsRetriesLeft > 0 && (code === -102 || code === -105 || code === -2)) {
      logsRetriesLeft -= 1;
      setTimeout(loadLogs, 400);
    }
  });
  // Auto-heal stale Vite dep cache 504s via the shared session listener.
  // See viteDepStaleHeal for why this must be shared across windows.
  if (isDev) registerViteDepStaleHeal(logsWindow, 'logs');
  logsWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('logs.render-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });
  logsWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
    log.error('logs.preload-error', { preloadPath, error: (err as Error).message });
  });
  logsWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    rendererLogger.info('renderer.console', { window: 'logs', level, message, line, sourceId });
  });

  logsWindow.on('closed', () => {
    log.info('logs.closed', {});
    logsWindow = null;
    logsReady = false;
    activeSessionId = null;
    pendingMessages.length = 0;
  });

  return logsWindow;
}

export function attachToHub(hub: BrowserWindow): void {
  anchorWindow = hub;
  log.info('logs.attachToHub', { hubId: hub.id });

  // Parent the logs window to the hub. Child windows follow the parent's
  // Space / workspace on macOS and z-order above it — this is the
  // reliable way to stop the overlay from leaking onto other desktops
  // when the user swipes Spaces (alwaysOnTop leaks regardless of level).
  if (logsWindow && !logsWindow.isDestroyed()) {
    try { logsWindow.setParentWindow(hub); } catch (err) {
      log.warn('logs.setParentWindow.error', { error: (err as Error).message });
    }
  }

  const reposition = (): void => {
    if (!logsWindow || logsWindow.isDestroyed()) return;
    if (!logsWindow.isVisible()) return;
    if (!anchorWindow || anchorWindow.isDestroyed()) return;
    // User has manually resized or moved the logs window — leave it alone
    // until they pick a preset (dot / normal / full) again.
    if (userCustomized) {
      log.debug('logs.reposition.skippedUserCustom', {});
      return;
    }
    const bounds = computeLogsBounds(anchorWindow, lastAnchor);
    log.debug('logs.reposition', { bounds });
    beginProgrammaticBoundsChange();
    logsWindow.setBounds(bounds);
  };

  hub.on('resize', reposition);
  hub.on('move', reposition);
  hub.on('enter-full-screen', reposition);
  hub.on('leave-full-screen', reposition);
  hub.on('minimize', () => {
    log.info('logs.hub.minimize', {});
    if (logsWindow && !logsWindow.isDestroyed()) logsWindow.hide();
  });
  hub.on('restore', () => {
    log.info('logs.hub.restore', { wasVisibleBeforeBlur, activeSessionId });
    if (logsWindow && !logsWindow.isDestroyed() && activeSessionId && wasVisibleBeforeBlur) {
      showLogs(activeSessionId, lastAnchor);
    }
  });

  // Display-aware app-blur auto-hide. Hide the logs window only if the
  // user switched to another app *on the same monitor* as the logs —
  // multi-monitor setups keep the logs visible on their own screen so
  // users can reference them while working in another app elsewhere.
  //
  // Listen at app-level, not hub-level: if the logs window itself had
  // focus (user typing a follow-up), switching away fires blur on LOGS,
  // not on hub. hub.on('blur') would miss that path entirely.
  app.on('browser-window-blur', () => {
    setTimeout(() => {
      if (!logsWindow || logsWindow.isDestroyed()) return;
      if (!logsWindow.isVisible()) return;
      const focused = BrowserWindow.getFocusedWindow();
      if (focused !== null) return; // still inside our own app
      try {
        const cursor = screen.getCursorScreenPoint();
        const cursorDisplay = screen.getDisplayNearestPoint(cursor);
        const logsDisplay = screen.getDisplayMatching(logsWindow.getBounds());
        log.info('logs.blur.displayCheck', {
          cursorDisplay: cursorDisplay.id,
          logsDisplay: logsDisplay.id,
          sameScreen: cursorDisplay.id === logsDisplay.id,
        });
        if (cursorDisplay.id !== logsDisplay.id) return; // different monitor, keep visible
      } catch (err) {
        log.warn('logs.blur.displayCheck.error', { error: (err as Error).message });
        // On error, fall through and hide — safer default.
      }
      wasVisibleBeforeBlur = true;
      log.info('logs.autohide.appBlurSameScreen', {});
      logsWindow.hide();
    }, 50);
  });

  hub.on('focus', () => {
    if (!logsWindow || logsWindow.isDestroyed()) return;
    if (wasVisibleBeforeBlur && activeSessionId) {
      log.info('logs.autoshow.appFocus', { activeSessionId });
      showLogs(activeSessionId, lastAnchor);
      wasVisibleBeforeBlur = false;
    }
  });
}

export function showLogs(sessionId: string, anchor: PaneAnchor | null = null): void {
  if (!logsWindow || logsWindow.isDestroyed()) {
    log.warn('logs.show.no-window', {});
    return;
  }
  activeSessionId = sessionId;
  if (anchor) lastAnchor = anchor;
  log.info('logs.show', { sessionId, anchor: anchor ?? lastAnchor, ready: logsReady, mode, userCustomized });
  // Defer the visual show when the user is currently focused on another
  // app (no Electron window of ours is the foreground window). AgentPane
  // auto-fires logs.show() when it mounts for a new session — for tasks
  // started via the global-shortcut pill, that happens while the user is
  // still in Cursor / their browser / wherever, and we don't want a
  // floating logs window to pop over their work uninvited. Record the
  // intent in wasVisibleBeforeBlur so the hub-focus handler restores it
  // the next time the user actually comes back to the app.
  const someoneIsFocused = BrowserWindow.getFocusedWindow() !== null;
  if (!someoneIsFocused) {
    log.info('logs.show.deferred', { reason: 'app-not-foreground', sessionId });
    wasVisibleBeforeBlur = true;
    safeSend('logs:active-session-changed', sessionId);
    return;
  }
  if (anchorWindow && !anchorWindow.isDestroyed() && !userCustomized) {
    applyLogsWindowStatePolicy(logsWindow);
    beginProgrammaticBoundsChange();
    logsWindow.setBounds(computeLogsBounds(anchorWindow, lastAnchor));
  }
  logsWindow.showInactive();
  // Keep the level in sync with the one set at window creation — using
  // 'screen-saver' here would float the overlay across Spaces again on
  // every session switch.
  logsWindow.setAlwaysOnTop(true, 'floating');
  safeSend('logs:active-session-changed', sessionId);
}

/**
 * Activate the logs window for the given session and focus its follow-up
 * input. Replaces the old "follow-up pill popup" path: pressing 'f' on a
 * card should land the cursor in the logs overlay's textarea, not open a
 * separate window.
 *
 * Mode rules:
 *   dot    → promoted to normal (user is about to type; dot has no input)
 *   normal → stays normal
 *   full   → stays full (user deliberately expanded; don't shrink under them)
 */
export function focusLogsFollowUp(sessionId: string, anchor: PaneAnchor | null = null): void {
  if (!logsWindow || logsWindow.isDestroyed()) {
    log.warn('logs.focusFollowUp.no-window', {});
    return;
  }
  const cameFromDot = mode === 'dot';
  if (cameFromDot) setLogsMode('normal');
  showLogs(sessionId, anchor);
  // Take OS-level focus — showLogs() uses showInactive() so the hub keeps
  // focus normally, but to type into the textarea the logs window needs to
  // be the focused window. Without this macOS leaves the caret in the hub.
  logsWindow.focus();
  // When promoting from dot→normal the textarea isn't in the DOM yet;
  // defer the focus-followup signal so the renderer has re-rendered by
  // the time it arrives. Normal/full can focus synchronously.
  const dispatch = (): void => safeSend('logs:focus-followup');
  if (cameFromDot) setTimeout(dispatch, 80);
  else dispatch();
}

export function hideLogs(): void {
  if (!logsWindow || logsWindow.isDestroyed()) return;
  log.info('logs.hide', { activeSessionId });
  logsWindow.hide();
  activeSessionId = null;
  wasVisibleBeforeBlur = false;
}

export function toggleLogs(sessionId: string, anchor: PaneAnchor | null = null): boolean {
  if (!logsWindow || logsWindow.isDestroyed()) {
    log.warn('logs.toggle.no-window', {});
    return false;
  }
  const visible = logsWindow.isVisible();
  log.info('logs.toggle', { sessionId, visible, activeSessionId, anchor });
  if (visible && activeSessionId === sessionId) {
    hideLogs();
    return false;
  }
  showLogs(sessionId, anchor);
  return true;
}

/**
 * Update the cached pane anchor and reposition the logs window in-place.
 * Called rapidly during hub window resize so all modes (dot/normal/full)
 * track the pane rect. No-ops if the window is hidden or the user has
 * manually moved/resized it.
 */
export function updateLogsAnchor(anchor: PaneAnchor): void {
  lastAnchor = anchor;
  if (!logsWindow || logsWindow.isDestroyed()) return;
  if (!logsWindow.isVisible()) return;
  if (!anchorWindow || anchorWindow.isDestroyed()) return;
  if (userCustomized) return;
  const bounds = computeLogsBounds(anchorWindow, lastAnchor);
  beginProgrammaticBoundsChange();
  logsWindow.setBounds(bounds);
}

/** Set the logs window display mode: 'dot' | 'normal' | 'full'. */
export function setLogsMode(next: LogsMode): void {
  if (!logsWindow || logsWindow.isDestroyed()) return;
  if (mode === next) return;
  mode = next;
  userCustomized = false;
  log.info('logs.setMode', { mode });
  applyLogsWindowStatePolicy(logsWindow);
  // Adjust the OS-level minimum size before setBounds, otherwise the 'dot'
  // target (36×36) gets clamped up to the normal-mode minimum and renders
  // as a stretched ellipse in the corner.
  try {
    if (mode === 'dot') {
      logsWindow.setMinimumSize(DOT_SIZE, DOT_SIZE);
    } else {
      logsWindow.setMinimumSize(LOGS_MIN_WIDTH, LOGS_MIN_HEIGHT);
    }
  } catch (err) {
    log.warn('logs.setMinimumSize.error', { error: (err as Error).message });
  }
  if (anchorWindow && !anchorWindow.isDestroyed()) {
    beginProgrammaticBoundsChange();
    logsWindow.setBounds(computeLogsBounds(anchorWindow, lastAnchor));
  }
  safeSend('logs:mode-changed', mode);
}

export function getLogsWindow(): BrowserWindow | null {
  return logsWindow;
}
