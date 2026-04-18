/**
 * DevToolsWindow — creates and manages the custom DevTools BrowserWindow.
 *
 * Follows SettingsWindow singleton pattern.
 * Preload: src/preload/devtools.ts (built as devtools.js in .vite/build/)
 * Renderer: devtools/devtools.html
 */

import path from 'node:path';
import { BrowserWindow } from 'electron';
import { mainLogger } from '../logger';

declare const DEVTOOLS_PANEL_VITE_DEV_SERVER_URL: string | undefined;
declare const DEVTOOLS_PANEL_VITE_NAME: string | undefined;

let devtoolsWindow: BrowserWindow | null = null;

export function openDevToolsWindow(): BrowserWindow {
  if (devtoolsWindow && !devtoolsWindow.isDestroyed()) {
    mainLogger.info('DevToolsWindow.focus', { windowId: devtoolsWindow.id });
    devtoolsWindow.focus();
    return devtoolsWindow;
  }

  mainLogger.info('DevToolsWindow.create');

  const preloadPath = path.join(__dirname, 'devtools.js');

  devtoolsWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 680,
    minHeight: 400,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    show: false,
    backgroundColor: '#0a0a0d',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  devtoolsWindow.once('ready-to-show', () => {
    if (!devtoolsWindow || devtoolsWindow.isDestroyed()) return;
    devtoolsWindow.show();
    devtoolsWindow.focus();
    mainLogger.info('DevToolsWindow.readyToShow', { windowId: devtoolsWindow.id });
  });

  devtoolsWindow.on('closed', () => {
    mainLogger.info('DevToolsWindow.closed');
    devtoolsWindow = null;
  });

  devtoolsWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    mainLogger.error('DevToolsWindow.did-fail-load', { code, desc, url });
  });

  devtoolsWindow.webContents.on('did-finish-load', () => {
    mainLogger.info('DevToolsWindow.did-finish-load', {
      url: devtoolsWindow?.webContents.getURL(),
    });
  });

  devtoolsWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    mainLogger.info('devtoolsRenderer.console', { level, source, line, message });
  });

  if (process.env.NODE_ENV !== 'production') {
    devtoolsWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (typeof DEVTOOLS_PANEL_VITE_DEV_SERVER_URL !== 'undefined' && DEVTOOLS_PANEL_VITE_DEV_SERVER_URL) {
    const url = `${DEVTOOLS_PANEL_VITE_DEV_SERVER_URL}/src/renderer/devtools/devtools.html`;
    mainLogger.debug('DevToolsWindow.loadURL', { url });
    void devtoolsWindow.loadURL(url);
  } else {
    const name = typeof DEVTOOLS_PANEL_VITE_NAME !== 'undefined' ? DEVTOOLS_PANEL_VITE_NAME : 'devtools_panel';
    const filePath = path.join(__dirname, `../../renderer/${name}/devtools.html`);
    mainLogger.debug('DevToolsWindow.loadFile', { filePath });
    void devtoolsWindow.loadFile(filePath);
  }

  mainLogger.info('DevToolsWindow.create.ok', { windowId: devtoolsWindow.id });
  return devtoolsWindow;
}

export function getDevToolsWindow(): BrowserWindow | null {
  if (devtoolsWindow && !devtoolsWindow.isDestroyed()) return devtoolsWindow;
  return null;
}

export function closeDevToolsWindow(): void {
  if (devtoolsWindow && !devtoolsWindow.isDestroyed()) {
    mainLogger.info('DevToolsWindow.closeRequested');
    devtoolsWindow.close();
  }
}
