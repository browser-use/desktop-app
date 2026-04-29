/**
 * onboardingWindow.ts — creates and manages the onboarding BrowserWindow.
 *
 * Spec (from plan §5 Track C decisions):
 *   width: 920, height: 640, resizable: false, titleBarStyle: 'hiddenInset'
 *   Preload: src/preload/onboarding.ts
 *   Renderer: onboarding/onboarding.html (served by the onboarding Vite entry)
 *
 * D2 logging: window creation, ready-to-show, close events.
 */

import path from 'node:path';
import { BrowserWindow } from 'electron';
import { mainLogger, rendererLogger } from '../logger';

// Forge VitePlugin injects these globals at build time.
// In dev: ONBOARDING_VITE_DEV_SERVER_URL = http://localhost:<port>
// In prod: ONBOARDING_VITE_NAME = 'onboarding'
declare const ONBOARDING_VITE_DEV_SERVER_URL: string | undefined;
declare const ONBOARDING_VITE_NAME: string | undefined;

export function createOnboardingWindow(): BrowserWindow {
  mainLogger.info('onboardingWindow.create');

  const preloadPath = path.join(__dirname, 'onboarding.js');

  const win = new BrowserWindow({
    width: 920,
    height: 640,
    resizable: true,
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    show: false,           // Show only after content loads (avoids white flash)
    backgroundColor: '#1a1a1f',  // Match --color-bg-base before CSS loads
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show window once renderer is painted
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    win.moveTop();
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    mainLogger.info('onboardingWindow.readyToShow', {
      windowId: win.id,
      position: { x, y },
      size: { w, h },
      isVisible: win.isVisible(),
      isMinimized: win.isMinimized(),
    });
  });

  win.on('closed', () => {
    mainLogger.info('onboardingWindow.closed', {
      windowId: win.id,
    });
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    mainLogger.error('onboardingWindow.did-fail-load', { code, desc, url });
  });
  win.webContents.on('did-finish-load', () => {
    mainLogger.info('onboardingWindow.did-finish-load', {
      url: win.webContents.getURL(),
    });
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    rendererLogger.info('renderer.console', { window: 'onboarding', level, source, line, message });
  });
  // Load the onboarding renderer
  if (typeof ONBOARDING_VITE_DEV_SERVER_URL !== 'undefined' && ONBOARDING_VITE_DEV_SERVER_URL) {
    const url = `${ONBOARDING_VITE_DEV_SERVER_URL}/src/renderer/onboarding/onboarding.html`;
    mainLogger.debug('onboardingWindow.loadURL', { url });
    void win.loadURL(url);
  } else {
    // Production: load from built file
    const name = typeof ONBOARDING_VITE_NAME !== 'undefined' ? ONBOARDING_VITE_NAME : 'onboarding';
    const filePath = path.join(
      __dirname,
      `../renderer/${name}/src/renderer/onboarding/onboarding.html`,
    );
    mainLogger.debug('onboardingWindow.loadFile', { filePath });
    void win.loadFile(filePath);
  }

  mainLogger.info('onboardingWindow.create.ok', {
    windowId: win.id,
    width: 920,
    height: 640,
  });

  return win;
}
