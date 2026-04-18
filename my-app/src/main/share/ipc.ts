/**
 * Share IPC handlers — main-process side of the share surface.
 *
 * Handles: copy link, email page, save page as, QR code data generation.
 */

import { ipcMain, clipboard, shell, dialog, type BrowserWindow } from 'electron';
import { mainLogger } from '../logger';
import type { TabManager } from '../tabs/TabManager';

// ---------------------------------------------------------------------------
// State refs set by register/unregister
// ---------------------------------------------------------------------------
let tabManagerRef: TabManager | null = null;
let shellWindowRef: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getActivePageInfo(): { url: string; title: string } | null {
  if (!tabManagerRef) return null;
  const url = tabManagerRef.getActiveTabUrl();
  if (!url) return null;
  const wc = tabManagerRef.getActiveWebContents();
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

function handleEmailPage(): boolean {
  const info = getActivePageInfo();
  if (!info) {
    mainLogger.warn('share.emailPage', { msg: 'no active page info' });
    return false;
  }
  const subject = encodeURIComponent(info.title || info.url);
  const body = encodeURIComponent(info.url);
  const mailto = `mailto:?subject=${subject}&body=${body}`;
  mainLogger.info('share.emailPage', { url: info.url });
  shell.openExternal(mailto);
  return true;
}

async function handleSavePageAs(): Promise<boolean> {
  const info = getActivePageInfo();
  const wc = tabManagerRef?.getActiveWebContents();
  if (!info || !wc || !shellWindowRef) {
    mainLogger.warn('share.savePageAs', { msg: 'missing page info, webContents, or shellWindow' });
    return false;
  }

  const sanitizedTitle = (info.title || 'page').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
  mainLogger.info('share.savePageAs', { url: info.url, title: sanitizedTitle });

  const result = await dialog.showSaveDialog(shellWindowRef, {
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

export function registerShareHandlers(tabManager: TabManager, shellWindow: BrowserWindow): void {
  tabManagerRef = tabManager;
  shellWindowRef = shellWindow;
  mainLogger.info('share.register', { msg: 'Registering share IPC handlers' });

  ipcMain.handle('share:copy-link', () => handleCopyLink());
  ipcMain.handle('share:email-page', () => handleEmailPage());
  ipcMain.handle('share:save-page-as', () => handleSavePageAs());
  ipcMain.handle('share:get-page-info', () => handleGetPageInfo());
}

export function unregisterShareHandlers(): void {
  mainLogger.info('share.unregister', { msg: 'Unregistering share IPC handlers' });
  tabManagerRef = null;
  shellWindowRef = null;

  ipcMain.removeHandler('share:copy-link');
  ipcMain.removeHandler('share:email-page');
  ipcMain.removeHandler('share:save-page-as');
  ipcMain.removeHandler('share:get-page-info');
}
