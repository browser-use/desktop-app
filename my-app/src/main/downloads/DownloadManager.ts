/**
 * DownloadManager: intercepts Electron session downloads, tracks progress,
 * and emits IPC events to the shell renderer for the download bubble UI.
 */

import { BrowserWindow, dialog, ipcMain, session, shell, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from '../logger';
import { readPrefs } from '../settings/ipc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DownloadStatus =
  | 'in-progress'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  status: DownloadStatus;
  startTime: number;
  endTime: number | null;
  openWhenDone: boolean;
  speed: number;
  eta: number;
  warningLevel?: 'dangerous' | 'suspicious' | 'insecure' | null;
  warningDismissed?: boolean;
}

// Serializable version sent to renderer
export type DownloadItemDTO = Omit<DownloadItem, never>;

// ---------------------------------------------------------------------------
// Safe-browsing heuristics
// ---------------------------------------------------------------------------

const DANGEROUS_EXTS = new Set(['.exe', '.msi', '.bat', '.cmd', '.scr', '.pif', '.com', '.jar', '.vbs', '.ps1', '.psm1']);
const SUSPICIOUS_EXTS = new Set(['.dmg', '.pkg', '.deb', '.rpm', '.sh', '.bash', '.zsh', '.app', '.crx', '.xpi']);

function classifyDownload(url: string, referrer: string, filename: string): 'dangerous' | 'suspicious' | 'insecure' | null {
  const ext = path.extname(filename).toLowerCase();
  // Extension checks take precedence over transport — a dangerous .exe over HTTP is still dangerous.
  if (DANGEROUS_EXTS.has(ext)) return 'dangerous';
  if (SUSPICIOUS_EXTS.has(ext)) return 'suspicious';
  if (referrer.startsWith('https://') && url.startsWith('http://')) return 'insecure';
  return null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFS_FILE = 'preferences.json';
const PROGRESS_THROTTLE_MS = 250;
const AUTO_DISMISS_DELAY_MS = 5000;
const IS_MACOS = process.platform === 'darwin';

// IPC channels
const CH_GET_DOWNLOADS = 'downloads:get-all';
const CH_PAUSE = 'downloads:pause';
const CH_RESUME = 'downloads:resume';
const CH_CANCEL = 'downloads:cancel';
const CH_OPEN_FILE = 'downloads:open-file';
const CH_SHOW_IN_FOLDER = 'downloads:show-in-folder';
const CH_SET_OPEN_WHEN_DONE = 'downloads:set-open-when-done';
const CH_CLEAR_COMPLETED = 'downloads:clear-completed';
const CH_REMOVE = 'downloads:remove';
const CH_CLEAR_ALL = 'downloads:clear-all';
const CH_GET_SHOW_ON_COMPLETE = 'downloads:get-show-on-complete';
const CH_SET_SHOW_ON_COMPLETE = 'downloads:set-show-on-complete';
const CH_DISMISS_WARNING = 'downloads:dismiss-warning';

// Events (main → renderer)
const EVT_DOWNLOAD_STARTED = 'download-started';
const EVT_DOWNLOAD_PROGRESS = 'download-progress';
const EVT_DOWNLOAD_DONE = 'download-done';
const EVT_DOWNLOADS_STATE = 'downloads-state';

// ---------------------------------------------------------------------------
// DownloadManager
// ---------------------------------------------------------------------------

export class DownloadManager {
  private win: BrowserWindow;
  private downloads: Map<string, DownloadItem> = new Map();
  private electronItems: Map<string, Electron.DownloadItem> = new Map();
  private nextId = 1;
  private throttleTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(win: BrowserWindow) {
    this.win = win;
    this.registerIpcHandlers();
    this.attachSessionDownloadHandler();
    mainLogger.info('DownloadManager.init', { msg: 'Download manager initialized' });
  }

  // ---------------------------------------------------------------------------
  // Session download interception
  // ---------------------------------------------------------------------------

  private attachSessionDownloadHandler(): void {
    const ses = session.defaultSession;

    ses.on('will-download', (_event, item, webContents) => {
      const id = `dl-${this.nextId++}`;
      const filename = item.getFilename() || 'download';
      const url = item.getURL();
      const totalBytes = item.getTotalBytes();

      // Apply download folder / ask-before-save preferences
      const prefs = readPrefs();
      const customFolder = typeof prefs.defaultDownloadFolder === 'string' ? prefs.defaultDownloadFolder : '';
      if (prefs.askBeforeSave === true) {
        item.pause();
        const defaultPath = path.join(customFolder || app.getPath('downloads'), filename);
        void dialog.showSaveDialog(this.win, { defaultPath }).then((result) => {
          if (result.canceled || !result.filePath) {
            item.cancel();
          } else {
            item.setSavePath(result.filePath);
            item.resume();
          }
        }).catch(() => { item.cancel(); });
      } else if (customFolder) {
        item.setSavePath(path.join(customFolder, filename));
      }

      mainLogger.info('DownloadManager.willDownload', {
        id,
        filename,
        url: url.slice(0, 200),
        totalBytes,
      });

      const referrer = (webContents?.getURL?.() ?? '');
      const warningLevel = classifyDownload(url, referrer, filename);

      const dlItem: DownloadItem = {
        id,
        filename,
        url,
        savePath: item.getSavePath() || '',
        totalBytes,
        receivedBytes: 0,
        status: 'in-progress',
        startTime: Date.now(),
        endTime: null,
        openWhenDone: false,
        speed: 0,
        eta: 0,
        warningLevel,
        warningDismissed: false,
      };

      this.downloads.set(id, dlItem);
      this.electronItems.set(id, item);

      if (warningLevel === 'dangerous') {
        item.pause();
        dlItem.status = 'paused';
        mainLogger.info('DownloadManager.dangerousDownloadPaused', { id, filename, warningLevel });
      }

      // Update savePath after dialog (Electron sets it after user picks location)
      item.once('done', () => {
        dlItem.savePath = item.getSavePath();
      });

      // Progress tracking
      let lastReceivedBytes = 0;
      let lastProgressTime = Date.now();

      item.on('updated', (_updateEvent, state) => {
        const now = Date.now();
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();

        // Calculate speed (bytes/sec)
        const elapsed = (now - lastProgressTime) / 1000;
        if (elapsed > 0) {
          dlItem.speed = Math.round((received - lastReceivedBytes) / elapsed);
        }
        lastReceivedBytes = received;
        lastProgressTime = now;

        // ETA in seconds
        if (dlItem.speed > 0 && total > 0) {
          dlItem.eta = Math.round((total - received) / dlItem.speed);
        } else {
          dlItem.eta = 0;
        }

        dlItem.receivedBytes = received;
        dlItem.totalBytes = total;
        dlItem.savePath = item.getSavePath() || dlItem.savePath;

        if (state === 'interrupted') {
          dlItem.status = 'interrupted';
          mainLogger.info('DownloadManager.interrupted', { id, received, total });
        } else {
          dlItem.status = 'in-progress';
        }

        this.throttledBroadcastProgress(id, dlItem);
        this.updateDockProgress();
      });

      item.once('done', (_doneEvent, state) => {
        dlItem.receivedBytes = item.getReceivedBytes();
        dlItem.totalBytes = item.getTotalBytes();
        dlItem.savePath = item.getSavePath() || dlItem.savePath;
        dlItem.endTime = Date.now();
        dlItem.speed = 0;
        dlItem.eta = 0;

        if (state === 'completed') {
          dlItem.status = 'completed';
          mainLogger.info('DownloadManager.completed', {
            id,
            filename: dlItem.filename,
            bytes: dlItem.receivedBytes,
            durationMs: dlItem.endTime - dlItem.startTime,
          });

          if (dlItem.openWhenDone && dlItem.savePath) {
            shell.openPath(dlItem.savePath).catch((err) => {
              mainLogger.warn('DownloadManager.openWhenDone.failed', { id, error: err });
            });
          } else if (!dlItem.openWhenDone && dlItem.savePath) {
            // Auto-open by file type association — use final saved path, not initial filename
            const ext = path.extname(dlItem.savePath).toLowerCase().slice(1);
            const fileTypeAssociations = (readPrefs().fileTypeAssociations as Record<string, boolean>) ?? {};
            if (ext && fileTypeAssociations[ext] === true) {
              mainLogger.info('DownloadManager.autoOpen', { id, ext });
              shell.openPath(dlItem.savePath).catch((err) => {
                mainLogger.warn('DownloadManager.autoOpen.failed', { id, ext, error: err });
              });
            }
          }
        } else if (state === 'interrupted') {
          dlItem.status = 'interrupted';
          mainLogger.info('DownloadManager.interrupted', { id, state });
        } else {
          dlItem.status = 'cancelled';
          mainLogger.info('DownloadManager.cancelled', { id, state });
        }

        this.electronItems.delete(id);
        this.clearThrottle(id);
        this.safeSend(EVT_DOWNLOAD_DONE, this.toDTO(dlItem));
        this.broadcastState();
      });

      // Broadcast the new download
      this.safeSend(EVT_DOWNLOAD_STARTED, this.toDTO(dlItem));
      this.broadcastState();
    });
  }

  // ---------------------------------------------------------------------------
  // IPC handlers
  // ---------------------------------------------------------------------------

  private registerIpcHandlers(): void {
    ipcMain.handle(CH_GET_DOWNLOADS, () => {
      return this.getAllDTOs();
    });

    ipcMain.handle(CH_PAUSE, (_e, id: string) => {
      this.pause(id);
    });

    ipcMain.handle(CH_RESUME, (_e, id: string) => {
      this.resume(id);
    });

    ipcMain.handle(CH_CANCEL, (_e, id: string) => {
      this.cancel(id);
    });

    ipcMain.handle(CH_OPEN_FILE, (_e, id: string) => {
      this.openFile(id);
    });

    ipcMain.handle(CH_SHOW_IN_FOLDER, (_e, id: string) => {
      this.showInFolder(id);
    });

    ipcMain.handle(CH_SET_OPEN_WHEN_DONE, (_e, id: string, value: boolean) => {
      this.setOpenWhenDone(id, value);
    });

    ipcMain.handle(CH_CLEAR_COMPLETED, () => {
      this.clearCompleted();
    });

    ipcMain.handle(CH_REMOVE, (_e, id: string) => {
      this.removeFromList(id);
    });

    ipcMain.handle(CH_CLEAR_ALL, () => {
      this.clearAll();
    });

    ipcMain.handle(CH_GET_SHOW_ON_COMPLETE, () => {
      return this.getShowOnComplete();
    });

    ipcMain.handle(CH_SET_SHOW_ON_COMPLETE, (_e, value: boolean) => {
      this.setShowOnComplete(value);
    });

    ipcMain.handle(CH_DISMISS_WARNING, (_e, id: string) => {
      this.dismissWarning(id);
    });

    mainLogger.info('DownloadManager.ipc.registered', { channelCount: 13 });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private pause(id: string): void {
    const item = this.electronItems.get(id);
    const dl = this.downloads.get(id);
    if (!item || !dl) {
      mainLogger.warn('DownloadManager.pause.notFound', { id });
      return;
    }
    item.pause();
    dl.status = 'paused';
    dl.speed = 0;
    dl.eta = 0;
    mainLogger.info('DownloadManager.pause', { id, filename: dl.filename });
    this.broadcastState();
  }

  private resume(id: string): void {
    const item = this.electronItems.get(id);
    const dl = this.downloads.get(id);
    if (!item || !dl) {
      mainLogger.warn('DownloadManager.resume.notFound', { id });
      return;
    }
    if (item.canResume()) {
      item.resume();
      dl.status = 'in-progress';
      mainLogger.info('DownloadManager.resume', { id, filename: dl.filename });
    } else {
      mainLogger.warn('DownloadManager.resume.cannotResume', { id });
    }
    this.broadcastState();
  }

  private cancel(id: string): void {
    const item = this.electronItems.get(id);
    const dl = this.downloads.get(id);
    if (!dl) {
      mainLogger.warn('DownloadManager.cancel.notFound', { id });
      return;
    }
    if (item) {
      item.cancel();
    }
    dl.status = 'cancelled';
    dl.endTime = Date.now();
    dl.speed = 0;
    dl.eta = 0;
    this.electronItems.delete(id);
    mainLogger.info('DownloadManager.cancel', { id, filename: dl.filename });
    this.broadcastState();
  }

  private openFile(id: string): void {
    const dl = this.downloads.get(id);
    if (!dl || !dl.savePath) {
      mainLogger.warn('DownloadManager.openFile.notFound', { id });
      return;
    }
    mainLogger.info('DownloadManager.openFile', { id, path: dl.savePath });
    shell.openPath(dl.savePath).catch((err) => {
      mainLogger.warn('DownloadManager.openFile.failed', { id, error: String(err) });
    });
  }

  private showInFolder(id: string): void {
    const dl = this.downloads.get(id);
    if (!dl || !dl.savePath) {
      mainLogger.warn('DownloadManager.showInFolder.notFound', { id });
      return;
    }
    mainLogger.info('DownloadManager.showInFolder', { id, path: dl.savePath });
    shell.showItemInFolder(dl.savePath);
  }

  private dismissWarning(id: string): void {
    const dl = this.downloads.get(id);
    const eItem = this.electronItems.get(id);
    if (!dl) {
      mainLogger.warn('DownloadManager.dismissWarning.notFound', { id });
      return;
    }
    dl.warningDismissed = true;
    if (eItem && dl.status === 'paused' && eItem.canResume()) {
      eItem.resume();
      dl.status = 'in-progress';
    }
    mainLogger.info('DownloadManager.dismissWarning', { id, filename: dl.filename });
    this.broadcastState();
  }

  private setOpenWhenDone(id: string, value: boolean): void {
    const dl = this.downloads.get(id);
    if (!dl) return;
    dl.openWhenDone = value;
    mainLogger.debug('DownloadManager.setOpenWhenDone', { id, value });
    this.broadcastState();
  }

  private clearCompleted(): void {
    const toRemove: string[] = [];
    for (const [id, dl] of this.downloads) {
      if (dl.status === 'completed' || dl.status === 'cancelled') {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.downloads.delete(id);
    }
    mainLogger.info('DownloadManager.clearCompleted', { removed: toRemove.length });
    this.broadcastState();
  }

  private removeFromList(id: string): void {
    const dl = this.downloads.get(id);
    if (!dl) {
      mainLogger.warn('DownloadManager.removeFromList.notFound', { id });
      return;
    }
    const eItem = this.electronItems.get(id);
    if (eItem) {
      eItem.cancel();
      this.electronItems.delete(id);
    }
    this.downloads.delete(id);
    this.clearThrottle(id);
    mainLogger.info('DownloadManager.removeFromList', { id, filename: dl.filename });
    this.broadcastState();
  }

  /**
   * Wipe the app-local download history (in-memory list only — does NOT
   * touch files already saved to disk). Exposed publicly so callers like
   * `ClearDataController` ("Clear browsing data" → downloads) and
   * `SignOutController` ("Clear data" mode) can invoke it directly.
   */
  clearAll(): void {
    for (const [id, eItem] of this.electronItems) {
      eItem.cancel();
      this.clearThrottle(id);
    }
    this.electronItems.clear();
    const count = this.downloads.size;
    this.downloads.clear();
    mainLogger.info('DownloadManager.clearAll', { removed: count });
    this.broadcastState();
  }

  /**
   * Public entry point used by ClearDataController ("Clear browsing data →
   * Download history"). Clears the in-memory download list and cancels any
   * active downloads, then broadcasts the empty state to the renderer.
   */
  clearAllForPrivacy(): void {
    mainLogger.info('DownloadManager.clearAllForPrivacy');
    this.clearAll();
  }

  // ---------------------------------------------------------------------------
  // Settings: show downloads when done
  // ---------------------------------------------------------------------------

  private getPrefsPath(): string {
    return path.join(app.getPath('userData'), PREFS_FILE);
  }

  private getShowOnComplete(): boolean {
    try {
      const raw = fs.readFileSync(this.getPrefsPath(), 'utf-8');
      const prefs = JSON.parse(raw) as { showDownloadsOnComplete?: boolean };
      return prefs.showDownloadsOnComplete ?? true;
    } catch {
      return true;
    }
  }

  private setShowOnComplete(value: boolean): void {
    const prefsPath = this.getPrefsPath();
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    } catch {
      // file doesn't exist yet
    }
    prefs.showDownloadsOnComplete = value;
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
    mainLogger.info('DownloadManager.setShowOnComplete', { value });
  }

  // ---------------------------------------------------------------------------
  // Dock / taskbar badge & progress
  // ---------------------------------------------------------------------------

  private getActiveDownloads(): DownloadItem[] {
    const active: DownloadItem[] = [];
    for (const dl of this.downloads.values()) {
      if (dl.status === 'in-progress' || dl.status === 'paused') {
        active.push(dl);
      }
    }
    return active;
  }

  private updateDockBadge(): void {
    const activeCount = this.getActiveDownloads().length;

    if (IS_MACOS) {
      app.dock.setBadge(activeCount > 0 ? String(activeCount) : '');
      mainLogger.debug('DownloadManager.updateDockBadge', {
        platform: 'macOS',
        activeCount,
        badge: activeCount > 0 ? String(activeCount) : '(cleared)',
      });
    } else {
      app.setBadgeCount(activeCount);
      mainLogger.debug('DownloadManager.updateDockBadge', {
        platform: process.platform,
        activeCount,
      });
    }
  }

  private updateDockProgress(): void {
    if (this.win.isDestroyed()) return;

    const active = this.getActiveDownloads();
    if (active.length === 0) {
      this.win.setProgressBar(-1);
      mainLogger.debug('DownloadManager.updateDockProgress', { progress: 'cleared' });
      return;
    }

    let totalBytes = 0;
    let receivedBytes = 0;
    for (const dl of active) {
      totalBytes += dl.totalBytes;
      receivedBytes += dl.receivedBytes;
    }

    const progress = totalBytes > 0 ? receivedBytes / totalBytes : 0;
    this.win.setProgressBar(progress);
    mainLogger.debug('DownloadManager.updateDockProgress', {
      activeCount: active.length,
      totalBytes,
      receivedBytes,
      progress: Math.round(progress * 100),
    });
  }

  private clearDockIndicators(): void {
    if (IS_MACOS) {
      app.dock.setBadge('');
    } else {
      app.setBadgeCount(0);
    }
    if (!this.win.isDestroyed()) {
      this.win.setProgressBar(-1);
    }
    mainLogger.debug('DownloadManager.clearDockIndicators', { msg: 'Badge and progress cleared' });
  }

  // ---------------------------------------------------------------------------
  // Broadcast helpers
  // ---------------------------------------------------------------------------

  private throttledBroadcastProgress(id: string, dl: DownloadItem): void {
    if (this.throttleTimers.has(id)) return;
    this.safeSend(EVT_DOWNLOAD_PROGRESS, this.toDTO(dl));
    const timer = setTimeout(() => {
      this.throttleTimers.delete(id);
    }, PROGRESS_THROTTLE_MS);
    this.throttleTimers.set(id, timer);
  }

  private clearThrottle(id: string): void {
    const timer = this.throttleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.throttleTimers.delete(id);
    }
  }

  private broadcastState(): void {
    this.safeSend(EVT_DOWNLOADS_STATE, this.getAllDTOs());
    this.updateDockBadge();
    this.updateDockProgress();
  }

  private getAllDTOs(): DownloadItemDTO[] {
    return Array.from(this.downloads.values()).map((dl) => this.toDTO(dl));
  }

  private toDTO(dl: DownloadItem): DownloadItemDTO {
    return { ...dl };
  }

  private safeSend(channel: string, payload: unknown): void {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    ipcMain.removeHandler(CH_GET_DOWNLOADS);
    ipcMain.removeHandler(CH_PAUSE);
    ipcMain.removeHandler(CH_RESUME);
    ipcMain.removeHandler(CH_CANCEL);
    ipcMain.removeHandler(CH_OPEN_FILE);
    ipcMain.removeHandler(CH_SHOW_IN_FOLDER);
    ipcMain.removeHandler(CH_SET_OPEN_WHEN_DONE);
    ipcMain.removeHandler(CH_CLEAR_COMPLETED);
    ipcMain.removeHandler(CH_REMOVE);
    ipcMain.removeHandler(CH_CLEAR_ALL);
    ipcMain.removeHandler(CH_GET_SHOW_ON_COMPLETE);
    ipcMain.removeHandler(CH_SET_SHOW_ON_COMPLETE);
    ipcMain.removeHandler(CH_DISMISS_WARNING);
    for (const timer of this.throttleTimers.values()) {
      clearTimeout(timer);
    }
    this.throttleTimers.clear();
    this.clearDockIndicators();
    mainLogger.info('DownloadManager.destroy');
  }
}
