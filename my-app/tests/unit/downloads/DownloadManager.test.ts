/**
 * DownloadManager unit tests.
 *
 * Tests cover:
 *   - classifyDownload: dangerous/suspicious/insecure/safe classification
 *   - dismissWarning: marks warningDismissed, resumes paused dangerous download
 *   - clearAll: empties in-memory download list
 *   - removeFromList: removes a single entry
 *   - getAll: returns current downloads list via IPC
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — electron + logger + settings/ipc (readPrefs)
// ---------------------------------------------------------------------------

const ipcHandlers: Map<string, (...args: unknown[]) => unknown> = new Map();
let sessionWillDownloadCallback: ((event: unknown, item: MockElectronDownloadItem, wc: unknown) => void) | null = null;

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));
vi.mock('../../../src/main/settings/ipc', () => ({
  readPrefs: vi.fn(() => ({ askBeforeSave: false, defaultDownloadFolder: '' })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
  session: {
    defaultSession: {
      on: vi.fn((event: string, cb: unknown) => {
        if (event === 'will-download') {
          sessionWillDownloadCallback = cb as typeof sessionWillDownloadCallback;
        }
      }),
    },
  },
  dialog: {
    showSaveDialog: vi.fn(() => Promise.resolve({ canceled: false, filePath: '/tmp/test' })),
  },
  shell: {
    openPath: vi.fn(() => Promise.resolve('')),
    showItemInFolder: vi.fn(),
  },
  app: {
    getPath: vi.fn(() => '/tmp'),
    dock: { setBadge: vi.fn() },
    setBadgeCount: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock Electron DownloadItem helper
// ---------------------------------------------------------------------------

interface MockElectronDownloadItem {
  getFilename: () => string;
  getURL: () => string;
  getTotalBytes: () => number;
  getSavePath: () => string;
  setSavePath: (p: string) => void;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  canResume: () => boolean;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeElectronItem(overrides: Partial<{
  filename: string;
  url: string;
  totalBytes: number;
  savePath: string;
  canResume: boolean;
}> = {}): MockElectronDownloadItem {
  const { filename = 'file.txt', url = 'https://example.com/file.txt', totalBytes = 1000, savePath = '/tmp/file.txt', canResume = true } = overrides;
  return {
    getFilename: () => filename,
    getURL: () => url,
    getTotalBytes: () => totalBytes,
    getSavePath: () => savePath,
    setSavePath: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    canResume: () => canResume,
    once: vi.fn(),
    on: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { DownloadManager, classifyDownload } from '../../../src/main/downloads/DownloadManager';

// ---------------------------------------------------------------------------
// classifyDownload tests (pure function)
// ---------------------------------------------------------------------------

describe('classifyDownload', () => {
  describe('dangerous extensions', () => {
    const dangerousFiles = ['setup.exe', 'install.msi', 'run.bat', 'run.cmd', 'screen.scr',
      'hack.pif', 'dos.com', 'lib.jar', 'macro.vbs', 'script.ps1', 'module.psm1'];

    for (const filename of dangerousFiles) {
      it(`classifies ${filename} as dangerous`, () => {
        expect(classifyDownload('https://example.com/' + filename, 'https://example.com', filename)).toBe('dangerous');
      });
    }

    it('is case-insensitive for extension matching', () => {
      expect(classifyDownload('https://example.com/FILE.EXE', 'https://example.com', 'FILE.EXE')).toBe('dangerous');
    });

    it('dangerous extension over HTTP is still dangerous (not overridden by insecure)', () => {
      expect(classifyDownload('http://evil.com/payload.exe', 'https://example.com', 'payload.exe')).toBe('dangerous');
    });
  });

  describe('suspicious extensions', () => {
    const suspiciousFiles = ['app.dmg', 'installer.pkg', 'package.deb', 'package.rpm',
      'script.sh', 'script.bash', 'script.zsh', 'App.app', 'extension.crx', 'addon.xpi'];

    for (const filename of suspiciousFiles) {
      it(`classifies ${filename} as suspicious`, () => {
        expect(classifyDownload('https://example.com/' + filename, 'https://example.com', filename)).toBe('suspicious');
      });
    }
  });

  describe('insecure download', () => {
    it('flags HTTP url with HTTPS referrer as insecure', () => {
      expect(classifyDownload('http://cdn.example.com/file.zip', 'https://example.com', 'file.zip')).toBe('insecure');
    });

    it('does NOT flag HTTPS url with HTTPS referrer', () => {
      expect(classifyDownload('https://cdn.example.com/file.zip', 'https://example.com', 'file.zip')).toBeNull();
    });

    it('does NOT flag HTTP url with HTTP referrer', () => {
      expect(classifyDownload('http://cdn.example.com/file.zip', 'http://example.com', 'file.zip')).toBeNull();
    });
  });

  describe('safe downloads', () => {
    it('returns null for a plain .zip', () => {
      expect(classifyDownload('https://example.com/archive.zip', 'https://example.com', 'archive.zip')).toBeNull();
    });

    it('returns null for a .pdf', () => {
      expect(classifyDownload('https://example.com/doc.pdf', 'https://example.com', 'doc.pdf')).toBeNull();
    });

    it('returns null for a no-extension file', () => {
      expect(classifyDownload('https://example.com/download', 'https://example.com', 'download')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// DownloadManager behaviour tests
// ---------------------------------------------------------------------------

describe('DownloadManager', () => {
  let manager: DownloadManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockWin = {
    isDestroyed: vi.fn(() => false),
    setProgressBar: vi.fn(),
    webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
  } as any;

  beforeEach(() => {
    ipcHandlers.clear();
    sessionWillDownloadCallback = null;
    vi.clearAllMocks();
    manager = new DownloadManager(mockWin);
  });

  function simulateDownload(item: MockElectronDownloadItem): void {
    if (!sessionWillDownloadCallback) throw new Error('will-download handler not registered');
    sessionWillDownloadCallback({}, item, { getURL: () => 'https://example.com' });
  }

  async function callHandler(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = ipcHandlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as Electron.IpcMainInvokeEvent, ...args);
  }

  it('registers will-download handler on session', async () => {
    const { session } = await import('electron');
    expect(session.defaultSession.on).toHaveBeenCalledWith('will-download', expect.any(Function));
  });

  it('returns empty list when no downloads', async () => {
    const result = await callHandler('downloads:get-all');
    expect(result).toEqual([]);
  });

  it('adds a safe download with null warningLevel', async () => {
    const item = makeElectronItem({ filename: 'report.pdf', url: 'https://example.com/report.pdf' });
    simulateDownload(item);
    const list = await callHandler('downloads:get-all') as unknown[];
    expect(list).toHaveLength(1);
    expect((list[0] as { warningLevel: null }).warningLevel).toBeNull();
    expect((list[0] as { status: string }).status).toBe('in-progress');
  });

  it('auto-pauses a dangerous download and sets warningLevel', async () => {
    const item = makeElectronItem({ filename: 'malware.exe', url: 'https://evil.com/malware.exe' });
    simulateDownload(item);
    expect(item.pause).toHaveBeenCalledOnce();
    const list = await callHandler('downloads:get-all') as unknown[];
    expect(list).toHaveLength(1);
    const dl = list[0] as { warningLevel: string; status: string };
    expect(dl.warningLevel).toBe('dangerous');
    expect(dl.status).toBe('paused');
  });

  it('sets warningLevel for suspicious download but does NOT pause it', async () => {
    const item = makeElectronItem({ filename: 'app.dmg', url: 'https://example.com/app.dmg' });
    simulateDownload(item);
    expect(item.pause).not.toHaveBeenCalled();
    const list = await callHandler('downloads:get-all') as unknown[];
    const dl = list[0] as { warningLevel: string; status: string };
    expect(dl.warningLevel).toBe('suspicious');
    expect(dl.status).toBe('in-progress');
  });

  describe('dismissWarning', () => {
    it('marks warningDismissed and resumes a paused dangerous download', async () => {
      const item = makeElectronItem({ filename: 'setup.exe', url: 'https://example.com/setup.exe', canResume: true });
      simulateDownload(item);

      const [dl0] = await callHandler('downloads:get-all') as Array<{ id: string; warningDismissed: boolean; status: string }>;
      expect(dl0.warningDismissed).toBe(false);
      expect(dl0.status).toBe('paused');

      await callHandler('downloads:dismiss-warning', dl0.id);

      const [dl1] = await callHandler('downloads:get-all') as Array<{ id: string; warningDismissed: boolean; status: string }>;
      expect(dl1.warningDismissed).toBe(true);
      expect(dl1.status).toBe('in-progress');
      expect(item.resume).toHaveBeenCalledOnce();
    });

    it('dismisses warning on suspicious download without resuming (already in-progress)', async () => {
      const item = makeElectronItem({ filename: 'app.dmg', url: 'https://example.com/app.dmg' });
      simulateDownload(item);

      const [dl0] = await callHandler('downloads:get-all') as Array<{ id: string; status: string }>;
      expect(dl0.status).toBe('in-progress');

      await callHandler('downloads:dismiss-warning', dl0.id);

      const [dl1] = await callHandler('downloads:get-all') as Array<{ warningDismissed: boolean }>;
      expect(dl1.warningDismissed).toBe(true);
      expect(item.resume).not.toHaveBeenCalled();
    });

    it('logs a warning for unknown id', async () => {
      await callHandler('downloads:dismiss-warning', 'nonexistent-id');
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        'DownloadManager.dismissWarning.notFound',
        expect.objectContaining({ id: 'nonexistent-id' }),
      );
    });
  });

  describe('remove', () => {
    it('removes a download from the list', async () => {
      const item = makeElectronItem({ filename: 'report.pdf' });
      simulateDownload(item);

      const [dl] = await callHandler('downloads:get-all') as Array<{ id: string }>;
      await callHandler('downloads:remove', dl.id);

      const list = await callHandler('downloads:get-all') as unknown[];
      expect(list).toHaveLength(0);
    });

    it('logs a warning for unknown id', async () => {
      await callHandler('downloads:remove', 'bad-id');
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        'DownloadManager.removeFromList.notFound',
        expect.objectContaining({ id: 'bad-id' }),
      );
    });
  });

  describe('clearAll', () => {
    it('clears all downloads and cancels active ones', async () => {
      const item1 = makeElectronItem({ filename: 'file1.pdf' });
      const item2 = makeElectronItem({ filename: 'file2.pdf' });
      simulateDownload(item1);
      simulateDownload(item2);

      expect(await callHandler('downloads:get-all') as unknown[]).toHaveLength(2);

      manager.clearAll();

      expect(await callHandler('downloads:get-all') as unknown[]).toHaveLength(0);
      expect(item1.cancel).toHaveBeenCalledOnce();
      expect(item2.cancel).toHaveBeenCalledOnce();
    });
  });
});
