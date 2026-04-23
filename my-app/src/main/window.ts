/**
 * BrowserWindow lifecycle and bounds persistence.
 * Saves/restores window position and size to userData/window-bounds.json.
 */

import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from './logger';
import { registerViteDepStaleHeal } from './viteDepStaleHeal';

declare const SHELL_VITE_DEV_SERVER_URL: string | undefined;

const BOUNDS_FILE_NAME = 'window-bounds.json';
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
const DEBOUNCE_MS = 500;

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function getBoundsPath(): string {
  return path.join(app.getPath('userData'), BOUNDS_FILE_NAME);
}

function loadBounds(): WindowBounds {
  try {
    const raw = fs.readFileSync(getBoundsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as WindowBounds;
    // Validate the bounds are on a visible display
    const displays = screen.getAllDisplays();
    const isVisible = displays.some((d) => {
      if (parsed.x === undefined || parsed.y === undefined) return false;
      return (
        parsed.x >= d.bounds.x &&
        parsed.y >= d.bounds.y &&
        parsed.x < d.bounds.x + d.bounds.width &&
        parsed.y < d.bounds.y + d.bounds.height
      );
    });
    if (!isVisible) {
      mainLogger.warn('window.loadBounds.offScreen', { msg: 'Saved bounds off-screen, using defaults' });
      return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    }
    return parsed;
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
}

function saveBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    fs.writeFileSync(getBoundsPath(), JSON.stringify(bounds), 'utf-8');
    mainLogger.debug('window.saveBounds.ok', { bounds });
  } catch (err) {
    mainLogger.error('window.saveBounds.failed', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
}

export interface ShellWindowOptions {
  titleSuffix?: string;
  incognito?: boolean;
}

export function createShellWindow(opts?: ShellWindowOptions): BrowserWindow {
  const bounds = loadBounds();
  const titleSuffix = opts?.titleSuffix ?? '';
  const incognito = opts?.incognito ?? false;
  mainLogger.info('window.createShellWindow', { bounds, titleSuffix, incognito });

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: incognito ? '#1a1a2e' : '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (titleSuffix) {
    win.setTitle(win.getTitle() + titleSuffix);
  }

  // Load the hub renderer. Dev mode races the Vite dev server — on a cold
  // cache Electron can call loadURL before Vite is listening, which fails
  // silently and leaves a blank window. Log every load attempt + outcome
  // and retry did-fail-load a few times with backoff so a slow cold-start
  // self-heals instead of requiring a manual restart.
  const isDev =
    typeof SHELL_VITE_DEV_SERVER_URL !== 'undefined' && SHELL_VITE_DEV_SERVER_URL;
  const hubDevUrl = isDev
    ? `${SHELL_VITE_DEV_SERVER_URL}/src/renderer/hub/hub.html`
    : null;
  const htmlPath = isDev
    ? null
    : path.join(__dirname, '../renderer/shell/src/renderer/hub/hub.html');

  const loadHub = (): void => {
    if (hubDevUrl) {
      mainLogger.info('window.loadURL', { url: hubDevUrl });
      win.loadURL(hubDevUrl).catch((err) => {
        mainLogger.error('window.loadURL.reject', { url: hubDevUrl, error: (err as Error).message });
      });
    } else if (htmlPath) {
      mainLogger.info('window.loadFile', { filePath: htmlPath });
      win.loadFile(htmlPath).catch((err) => {
        mainLogger.error('window.loadFile.reject', { filePath: htmlPath, error: (err as Error).message });
      });
    }
  };

  let retriesLeft = isDev ? 10 : 0;
  win.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    mainLogger.warn('window.did-fail-load', { errorCode, errorDesc, validatedURL, retriesLeft });
    if (retriesLeft > 0 && (errorCode === -102 /* CONNECTION_REFUSED */ || errorCode === -105 /* NAME_NOT_RESOLVED */ || errorCode === -2 /* FAILED */)) {
      retriesLeft -= 1;
      setTimeout(loadHub, 400);
    }
  });
  win.webContents.on('did-finish-load', () => {
    mainLogger.info('window.did-finish-load', { url: win.webContents.getURL() });
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    mainLogger.error('window.render-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    mainLogger.error('window.preload-error', { preloadPath, error: (error as Error).message });
  });
  // Forward renderer console to main.log so we can diagnose silent-render
  // failures without needing the user to open DevTools. Mirrors the logs
  // window's existing `logs.console` forwarding.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    mainLogger.info('hubRenderer.console', { level, message, line, sourceId });
  });

  // Dev only: if Vite serves a 504 for an optimized dep (stale .vite/deps
  // cache racing re-optimization on a fresh `task up`), the renderer's
  // import chain throws before React mounts and the window looks blank.
  // Register this window for shared 504 auto-reload (see viteDepStaleHeal).
  if (isDev) registerViteDepStaleHeal(win, 'hub');

  loadHub();

  // Debounced bounds persistence — incognito windows do NOT persist bounds
  // to avoid leaking usage patterns.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (incognito) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveBounds(win), DEBOUNCE_MS);
  };

  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!incognito) saveBounds(win);
    mainLogger.info('window.close', { windowId: win.id, incognito });
  });
  win.on('closed', () => {
    mainLogger.info('window.closed', { msg: 'Shell window destroyed', incognito });
  });

  return win;
}
