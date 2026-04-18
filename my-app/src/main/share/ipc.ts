/**
 * Share IPC handlers — main-process side of the share surface.
 *
 * Handles: copy link, email page, save page as, QR code data generation.
 *
 * The handlers resolve their dependencies (tab manager, shell window) lazily
 * through getter functions supplied at registration time. This lets the caller
 * wire the handlers up during `app.whenReady()` — before the shell window
 * and tab manager actually exist — without leaving the handlers bound to
 * stale `null` references. See issue #205 for background.
 */

import { ipcMain, clipboard, shell, dialog, type BrowserWindow } from 'electron';
import { mainLogger } from '../logger';
import type { TabManager } from '../tabs/TabManager';

// ---------------------------------------------------------------------------
// Dependency getters — populated at registration time
// ---------------------------------------------------------------------------
type TabManagerGetter = () => TabManager | null;
type ShellWindowGetter = () => BrowserWindow | null;

let getTabManager: TabManagerGetter = () => null;
let getShellWindow: ShellWindowGetter = () => null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getActivePageInfo(): { url: string; title: string } | null {
  const tabManager = getTabManager();
  if (!tabManager) return null;
  const url = tabManager.getActiveTabUrl();
  if (!url) return null;
  const wc = tabManager.getActiveWebContents();
  const title = wc?.getTitle() ?? '';
  return { url, title };
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function handleCopyLink(): boolean {
  const info = getActivePageInfo();
  if (!info) {
    mainLogger.warn('share.copyLink', { msg: 'no active page info' });
    return false;
  }
  mainLogger.info('share.copyLink', { url: info.url });
  clipboard.writeText(info.url);
  return true;
}

async function handleEmailPage(): Promise<boolean> {
  const info = getActivePageInfo();
  if (!info) {
    mainLogger.warn('share.emailPage', { msg: 'no active page info' });
    return false;
  }
  const subject = encodeURIComponent(info.title || info.url);
  const body = encodeURIComponent(info.url);
  const mailto = `mailto:?subject=${subject}&body=${body}`;
  mainLogger.info('share.emailPage', { url: info.url });
  await shell.openExternal(mailto);
  return true;
}

async function handleSavePageAs(): Promise<boolean> {
  const info = getActivePageInfo();
  const tabManager = getTabManager();
  const shellWindow = getShellWindow();
  const wc = tabManager?.getActiveWebContents();
  if (!info || !wc || !shellWindow) {
    mainLogger.warn('share.savePageAs', { msg: 'missing page info, webContents, or shellWindow' });
    return false;
  }

  const sanitizedTitle = (info.title || 'page').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
  mainLogger.info('share.savePageAs', { url: info.url, title: sanitizedTitle });

  const result = await dialog.showSaveDialog(shellWindow, {
    defaultPath: sanitizedTitle,
    filters: [
      { name: 'Webpage, Complete', extensions: ['html'] },
      { name: 'Webpage, HTML Only', extensions: ['html'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    mainLogger.debug('share.savePageAs', { msg: 'user cancelled save dialog' });
    return false;
  }

  mainLogger.info('share.savePageAs.saving', { filePath: result.filePath });

  try {
    await wc.savePage(result.filePath, 'HTMLComplete');
    mainLogger.info('share.savePageAs.success', { filePath: result.filePath });
    return true;
  } catch (err) {
    mainLogger.error('share.savePageAs.failed', { error: (err as Error).message });
    return false;
  }
}

function handleGetPageInfo(): { url: string; title: string } | null {
  const info = getActivePageInfo();
  mainLogger.debug('share.getPageInfo', { info });
  return info;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ShareHandlerDeps {
  getTabManager: TabManagerGetter;
  getShellWindow: ShellWindowGetter;
}

export function registerShareHandlers(deps: ShareHandlerDeps): void {
  getTabManager = deps.getTabManager;
  getShellWindow = deps.getShellWindow;
  mainLogger.info('share.register', { msg: 'Registering share IPC handlers' });

  ipcMain.handle('share:copy-link', () => handleCopyLink());
  ipcMain.handle('share:email-page', () => handleEmailPage());
  ipcMain.handle('share:save-page-as', () => handleSavePageAs());
  ipcMain.handle('share:get-page-info', () => handleGetPageInfo());
}

export function unregisterShareHandlers(): void {
  mainLogger.info('share.unregister', { msg: 'Unregistering share IPC handlers' });
  getTabManager = () => null;
  getShellWindow = () => null;

  ipcMain.removeHandler('share:copy-link');
  ipcMain.removeHandler('share:email-page');
  ipcMain.removeHandler('share:save-page-as');
  ipcMain.removeHandler('share:get-page-info');
}
