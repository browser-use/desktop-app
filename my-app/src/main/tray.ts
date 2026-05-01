import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { mainLogger } from './logger';
import { hidePill, togglePill } from './pill';
import { createShellWindow } from './window';
import { getGlobalCmdbarAccelerator } from './hotkeys';
import type { AgentSession, SessionManager } from './sessions/SessionManager';

const MENU_REBUILD_DEBOUNCE_MS = 100;
const SESSION_LABEL_MAX_LENGTH = 40;

let currentTray: Tray | null = null;
let disposeCurrentTray: (() => void) | null = null;
let trackedShellWindow: BrowserWindow | null = null;
let scheduleCurrentRebuild: (() => void) | null = null;

export function refreshTrayMenu(): void {
  scheduleCurrentRebuild?.();
}

function trayAssetDir(): string {
  return path.resolve(app.getAppPath(), 'assets', 'tray');
}

function getTrayIcon(): Electron.NativeImage {
  const dir = trayAssetDir();
  const icon = nativeImage.createFromBuffer(fs.readFileSync(path.join(dir, 'bu-logo-16.png')));

  // Add the @2x representation before marking as a template so macOS can adapt it in light/dark menu bars.
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(dir, 'bu-logo-32.png')) });
  icon.setTemplateImage(true);

  return icon;
}

const STATUS_DOT_NAME: Record<'active' | 'stuck' | 'idle', string> = {
  active: 'dot-active',
  stuck: 'dot-stuck',
  idle: 'dot-idle',
};

const dotCache = new Map<string, Electron.NativeImage>();

function getStatusDot(kind: 'active' | 'stuck' | 'idle'): Electron.NativeImage {
  const cached = dotCache.get(kind);
  if (cached) return cached;
  const dir = trayAssetDir();
  const name = STATUS_DOT_NAME[kind];
  const icon = nativeImage.createFromBuffer(fs.readFileSync(path.join(dir, `${name}.png`)));
  // Non-template — we want the color preserved in the menu.
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(dir, `${name}@2x.png`)) });
  dotCache.set(kind, icon);
  return icon;
}

function sessionLabel(session: AgentSession): string {
  const singleLinePrompt = session.prompt.trim().replace(/\s+/g, ' ');
  const base = singleLinePrompt.length > 0 ? singleLinePrompt : session.id.slice(0, 8);
  if (base.length <= SESSION_LABEL_MAX_LENGTH) return base;
  return `${base.slice(0, SESSION_LABEL_MAX_LENGTH - 1)}…`;
}

function shellWindowFromUrl(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  return windows.find((win) => {
    const url = win.webContents.getURL();
    return url.includes('/src/renderer/hub/hub.html') || url.includes('/renderer/shell/src/renderer/hub/hub.html');
  }) ?? null;
}

function largestCurrentWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  return windows.sort((a, b) => {
    const aBounds = a.getBounds();
    const bBounds = b.getBounds();
    return (bBounds.width * bBounds.height) - (aBounds.width * aBounds.height);
  })[0] ?? null;
}

function getShellWindow(): BrowserWindow | null {
  if (trackedShellWindow && !trackedShellWindow.isDestroyed()) return trackedShellWindow;
  const win = shellWindowFromUrl();
  if (win) trackedShellWindow = win;
  return win;
}

function ensureShellWindow(): BrowserWindow {
  const existing = getShellWindow();
  if (existing) return existing;

  mainLogger.info('main.tray.openHub.recreateShell');
  trackedShellWindow = createShellWindow();
  return trackedShellWindow;
}

function showAndFocusShellWindow(): BrowserWindow {
  const win = ensureShellWindow();
  win.show();
  win.focus();
  return win;
}

function sendWhenReady(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    });
    return;
  }

  win.webContents.send(channel, ...args);
}

function openSession(id: string): void {
  mainLogger.info('main.tray.clickSession', { id });
  hidePill();
  const win = getShellWindow();
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    win.webContents.send('select-session', id);
  }
}

function openNewAgent(): void {
  mainLogger.info('main.tray.clickNewAgent');
  togglePill();
  const win = getShellWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('pill-toggled');
  }
}

function openSettings(): void {
  mainLogger.info('main.tray.clickSettings');
  const win = showAndFocusShellWindow();
  sendWhenReady(win, 'open-settings');
}

function openHub(): void {
  mainLogger.info('main.tray.clickOpenHub');
  showAndFocusShellWindow();
}

function dotKindForStatus(status: AgentSession['status']): 'active' | 'stuck' | 'idle' {
  if (status === 'running') return 'active';
  if (status === 'stuck') return 'stuck';
  return 'idle';
}

function sessionMenuItems(sessions: AgentSession[]): MenuItemConstructorOptions[] {
  return sessions.map((session) => ({
    label: sessionLabel(session),
    icon: getStatusDot(dotKindForStatus(session.status)),
    click: () => openSession(session.id),
  }));
}

function buildTrayMenu(sessionManager: SessionManager): Menu {
  const sessions = sessionManager.listSessions();
  const activeSessions = sessions.filter((session) => session.status === 'running' || session.status === 'stuck');
  const idleSessions = sessions.filter((session) => session.status === 'idle');
  const template: MenuItemConstructorOptions[] = [
    { label: 'Browser Use', enabled: false },
    { type: 'separator' },
  ];

  if (activeSessions.length > 0) {
    template.push(
      { label: 'Active', enabled: false },
      ...sessionMenuItems(activeSessions),
    );
  }

  if (idleSessions.length > 0) {
    template.push(
      { label: 'Idle', enabled: false },
      ...sessionMenuItems(idleSessions),
    );
  }

  template.push(
    { type: 'separator' },
    { label: 'New Agent', accelerator: getGlobalCmdbarAccelerator(), click: openNewAgent },
    { label: 'Settings', accelerator: 'Command+,', click: openSettings },
    { type: 'separator' },
    { label: 'Open App', click: openHub },
    { label: 'Quit Browser Use', accelerator: 'Command+Q', click: () => app.quit() },
  );

  return Menu.buildFromTemplate(template);
}

export function createTray(sessionManager: SessionManager): Tray | null {
  // stderr write bypasses mainLogger so we still get a signal even if logger is wedged.
  process.stderr.write(`[tray.entry] called appPath=${app.getAppPath()}\n`);
  try {
    mainLogger.info('main.tray.start', { appPath: app.getAppPath(), assetDir: trayAssetDir() });
  } catch (err) {
    process.stderr.write(`[tray.startLogFailed] ${(err as Error).message}\n`);
  }

  if (currentTray && !currentTray.isDestroyed()) {
    mainLogger.info('main.tray.reuse');
    return currentTray;
  }

  disposeCurrentTray?.();

  trackedShellWindow = shellWindowFromUrl() ?? largestCurrentWindow();

  let trayIcon: Electron.NativeImage;
  try {
    trayIcon = getTrayIcon();
    mainLogger.info('main.tray.iconLoaded', { empty: trayIcon.isEmpty(), size: trayIcon.getSize() });
  } catch (err) {
    mainLogger.warn('main.tray.iconFailed', { error: (err as Error).message, stack: (err as Error).stack });
    return null;
  }

  let tray: Tray;
  try {
    tray = new Tray(trayIcon);
  } catch (err) {
    mainLogger.warn('main.tray.constructFailed', { error: (err as Error).message, stack: (err as Error).stack });
    return null;
  }
  currentTray = tray;
  tray.setToolTip('Browser Use');

  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const rebuildMenu = (): void => {
    if (tray.isDestroyed()) return;
    tray.setContextMenu(buildTrayMenu(sessionManager));
    mainLogger.info('main.tray.menuRebuilt');
  };
  const scheduleRebuild = (session: AgentSession): void => {
    mainLogger.debug('main.tray.scheduleMenuRebuild', { id: session.id, status: session.status });
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuildMenu();
    }, MENU_REBUILD_DEBOUNCE_MS);
    rebuildTimer.unref?.();
  };

  sessionManager.onEvent('session-created', scheduleRebuild);
  sessionManager.onEvent('session-updated', scheduleRebuild);
  sessionManager.onEvent('session-completed', scheduleRebuild);
  sessionManager.onEvent('session-error', scheduleRebuild);
  scheduleCurrentRebuild = rebuildMenu;

  const dispose = (): void => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
    sessionManager.off('session-created', scheduleRebuild);
    sessionManager.off('session-updated', scheduleRebuild);
    sessionManager.off('session-completed', scheduleRebuild);
    sessionManager.off('session-error', scheduleRebuild);
    app.off('before-quit', dispose);
    if (!tray.isDestroyed()) tray.destroy();
    if (currentTray === tray) currentTray = null;
    if (trackedShellWindow?.isDestroyed()) trackedShellWindow = null;
    if (disposeCurrentTray === dispose) disposeCurrentTray = null;
    if (scheduleCurrentRebuild === rebuildMenu) scheduleCurrentRebuild = null;
    mainLogger.info('main.tray.destroy');
  };

  disposeCurrentTray = dispose;
  app.on('before-quit', dispose);
  rebuildMenu();
  mainLogger.info('main.tray.create');

  return tray;
}
