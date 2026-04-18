/**
 * PictureInPictureManager.ts — triggers browser-native Picture-in-Picture
 * on the active tab via Chromium's requestPictureInPicture() Web API.
 *
 * Strategy: executeJavaScript on the active tab's webContents finds the
 * most-appropriate video element and calls requestPictureInPicture(). This
 * delegates the floating window, always-on-top behaviour, play/pause controls,
 * and resize/reposition to Chromium's built-in PiP implementation — exactly
 * matching Chrome parity (issue #100).
 *
 * Return-to-tab: the PiP overlay always shows a "back to tab" button courtesy
 * of Chromium's native PiP UI.
 */

import { ipcMain, WebContents } from 'electron';
import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// JS injected into the page to activate / deactivate PiP
// ---------------------------------------------------------------------------

const PIP_ENTER_SCRIPT = `
(async () => {
  // 1. Already in PiP — exit and return early.
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return { ok: true, action: 'exit' };
  }

  // 2. Find the best video candidate:
  //    • Playing video first (largest playing wins)
  //    • Fall back to any visible video (largest wins)
  //    • Fall back to first video on page
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) {
    return { ok: false, error: 'no_video' };
  }

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  const playing = videos.filter(v => !v.paused && !v.ended && isVisible(v));
  const visible = videos.filter(v => isVisible(v));

  const target =
    playing.sort((a, b) => area(b) - area(a))[0] ||
    visible.sort((a, b) => area(b) - area(a))[0] ||
    videos[0];

  if (!target) {
    return { ok: false, error: 'no_video' };
  }

  try {
    await target.requestPictureInPicture();
    return { ok: true, action: 'enter' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})();
`;

const PIP_EXIT_SCRIPT = `
(async () => {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return { ok: true };
  }
  return { ok: true, note: 'not_in_pip' };
})();
`;

const PIP_STATUS_SCRIPT = `
(() => ({
  supported: document.pictureInPictureEnabled,
  active: !!document.pictureInPictureElement,
  hasVideo: document.querySelectorAll('video').length > 0,
}))();
`;

// ---------------------------------------------------------------------------
// IPC result types
// ---------------------------------------------------------------------------

export interface PipResult {
  ok: boolean;
  action?: 'enter' | 'exit';
  error?: string;
  note?: string;
}

export interface PipStatus {
  supported: boolean;
  active: boolean;
  hasVideo: boolean;
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

type GetActiveWebContents = () => WebContents | null;

export function registerPipHandlers(
  getActiveWebContents: GetActiveWebContents,
): void {
  ipcMain.handle('pip:enter', async (): Promise<PipResult> => {
    mainLogger.info('pip.enter');
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed()) {
      mainLogger.warn('pip.enter.noWebContents');
      return { ok: false, error: 'no_active_tab' };
    }

    try {
      const result = await wc.executeJavaScript(PIP_ENTER_SCRIPT, true) as PipResult;
      mainLogger.info('pip.enter.result', result as unknown as Record<string, unknown>);
      return result;
    } catch (err) {
      mainLogger.error('pip.enter.failed', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pip:exit', async (): Promise<PipResult> => {
    mainLogger.info('pip.exit');
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed()) {
      mainLogger.warn('pip.exit.noWebContents');
      return { ok: false, error: 'no_active_tab' };
    }

    try {
      const result = await wc.executeJavaScript(PIP_EXIT_SCRIPT, true) as PipResult;
      mainLogger.info('pip.exit.result', result as unknown as Record<string, unknown>);
      return result;
    } catch (err) {
      mainLogger.error('pip.exit.failed', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pip:get-status', async (): Promise<PipStatus | null> => {
    mainLogger.debug('pip.getStatus');
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed()) {
      mainLogger.warn('pip.getStatus.noWebContents');
      return null;
    }

    try {
      const status = await wc.executeJavaScript(PIP_STATUS_SCRIPT, true) as PipStatus;
      mainLogger.debug('pip.getStatus.result', status as unknown as Record<string, unknown>);
      return status;
    } catch (err) {
      mainLogger.error('pip.getStatus.failed', { error: (err as Error).message });
      return null;
    }
  });

  mainLogger.info('pip.handlersRegistered');
}

export function unregisterPipHandlers(): void {
  ipcMain.removeHandler('pip:enter');
  ipcMain.removeHandler('pip:exit');
  ipcMain.removeHandler('pip:get-status');
  mainLogger.info('pip.handlersUnregistered');
}
