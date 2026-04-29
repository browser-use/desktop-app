/**
 * SettingsWindow.ts — creates and manages the Settings BrowserWindow.
 *
 * Spec (Track 5):
 *   width: 720, height: 560, resizable: false, titleBarStyle: 'hiddenInset'
 *   Warm theme: data-theme="onboarding" for visual continuity
 *   Preload: src/preload/settings.ts (built as settings.js in .vite/build/)
 *   Renderer: settings/settings.html (served by the settings Vite entry)
 *
 * Follows path invariant rules from memory:
 *   - preload: path.join(__dirname, 'settings.js')
 *   - loadURL: full path from project root
 *   - HTML script src: relative ./index.tsx
 *
 * D2 logging: window lifecycle events.
 */

import path from 'node:path';
import { BrowserWindow } from 'electron';
import { mainLogger, rendererLogger } from '../logger';

// ---------------------------------------------------------------------------
// Forge VitePlugin globals (injected at build time)
// ---------------------------------------------------------------------------

declare const SETTINGS_VITE_DEV_SERVER_URL: string | undefined;
declare const SETTINGS_VITE_NAME: string | undefined;

// ---------------------------------------------------------------------------
// Singleton reference
// ---------------------------------------------------------------------------

let settingsWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or focus) the Settings window.
 * Returns the BrowserWindow instance.
 */
export function openSettingsWindow(): BrowserWindow {
  // If already open, focus and return
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    mainLogger.info('SettingsWindow.focus', { windowId: settingsWindow.id });
    settingsWindow.focus();
    return settingsWindow;
  }

  mainLogger.info('SettingsWindow.create');

  const preloadPath = path.join(__dirname, 'settings.js');

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    show: false,
    backgroundColor: '#1a1a1f', // Match --color-bg-base (onboarding theme)
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show window once renderer is painted (avoids white flash)
  settingsWindow.once('ready-to-show', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    settingsWindow.show();
    settingsWindow.focus();
    const [x, y] = settingsWindow.getPosition();
    const [w, h] = settingsWindow.getSize();
    mainLogger.info('SettingsWindow.readyToShow', {
      windowId: settingsWindow.id,
      position: { x, y },
      size: { w, h },
    });
  });

  settingsWindow.on('closed', () => {
    mainLogger.info('SettingsWindow.closed');
    settingsWindow = null;
  });

  settingsWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    mainLogger.error('SettingsWindow.did-fail-load', { code, desc, url });
  });

  settingsWindow.webContents.on('did-finish-load', () => {
    mainLogger.info('SettingsWindow.did-finish-load', {
      url: settingsWindow?.webContents.getURL(),
    });
  });

  settingsWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    rendererLogger.info('renderer.console', { window: 'settings', level, source, line, message });
  });

  // Load the settings renderer
  if (typeof SETTINGS_VITE_DEV_SERVER_URL !== 'undefined' && SETTINGS_VITE_DEV_SERVER_URL) {
    const url = `${SETTINGS_VITE_DEV_SERVER_URL}/src/renderer/settings/settings.html`;
    mainLogger.debug('SettingsWindow.loadURL', { url });
    void settingsWindow.loadURL(url);
  } else {
    // Production: load from built file
    const name = typeof SETTINGS_VITE_NAME !== 'undefined' ? SETTINGS_VITE_NAME : 'settings';
    const filePath = path.join(
      __dirname,
      `../../renderer/${name}/settings.html`,
    );
    mainLogger.debug('SettingsWindow.loadFile', { filePath });
    void settingsWindow.loadFile(filePath);
  }

  mainLogger.info('SettingsWindow.create.ok', {
    windowId: settingsWindow.id,
    width: 720,
    height: 560,
  });

  return settingsWindow;
}

/**
 * Get the current settings window reference (or null if not open).
 */
export function getSettingsWindow(): BrowserWindow | null {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }
  return null;
}

/**
 * Close the settings window if open.
 */
export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    mainLogger.info('SettingsWindow.closeRequested');
    settingsWindow.close();
  }
}
