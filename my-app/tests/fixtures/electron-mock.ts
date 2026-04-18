/**
 * Minimal Electron module mock for unit tests running outside Electron.
 *
 * Required because telemetry.ts and logger.ts try to import `electron`
 * to call app.getPath('userData'). Both modules have fallbacks to os.tmpdir()
 * when electron is unavailable — this mock ensures the require() doesn't throw.
 *
 * Track H owns this file.
 */

import * as os from 'node:os';
import * as path from 'node:path';

const userDataPath = path.join(os.tmpdir(), 'AgenticBrowser-test');

export const app = {
  getPath: (name: string): string => {
    if (name === 'userData') return userDataPath;
    if (name === 'logs') return path.join(userDataPath, 'logs');
    if (name === 'temp') return os.tmpdir();
    return userDataPath;
  },
  getVersion: (): string => '0.1.0-test',
  getName: (): string => 'AgenticBrowser',
  isReady: (): boolean => true,
  whenReady: (): Promise<void> => Promise.resolve(),
};

export const ipcMain = {
  handle: (): void => undefined,
  removeHandler: (): void => undefined,
  on: (): void => undefined,
  off: (): void => undefined,
  emit: (): boolean => false,
};

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  getFocusedWindow: (): null => null,
};

export const globalShortcut = {
  register: (): boolean => false,
  unregister: (): void => undefined,
  unregisterAll: (): void => undefined,
};

export const screen = {
  getAllDisplays: () => [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ],
  getPrimaryDisplay: () => ({
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1080 },
  }),
};

export const nativeImage = {
  createEmpty: (): Record<string, never> => ({}),
  createFromPath: (): Record<string, never> => ({}),
};

export const shell = {
  openExternal: (_url: string): Promise<void> => Promise.resolve(),
};

// safeStorage stub — used by PasswordStore (passwords) and KeychainStore
// fallback path. The mock implements a deterministic XOR-style "encryption"
// purely for round-trip testing; the encrypted payload is NOT the same bytes
// as the plaintext so tests can assert non-equality.
const SAFE_STORAGE_PREFIX = 'sstmock:';

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (plain: string): Buffer => Buffer.from(`${SAFE_STORAGE_PREFIX}${plain}`, 'utf-8'),
  decryptString: (buf: Buffer): string => {
    const s = buf.toString('utf-8');
    if (s.startsWith(SAFE_STORAGE_PREFIX)) {
      return s.slice(SAFE_STORAGE_PREFIX.length);
    }
    return s;
  },
};

// systemPreferences stub — used by BiometricAuth and PermissionManager.
// macOS-specific APIs return values consistent with "permission already granted"
// so unit tests don't trigger denial code paths unless they override these.
export const systemPreferences = {
  canPromptTouchID: (): boolean => true,
  promptTouchID: (_reason: string): Promise<void> => Promise.resolve(),
  getMediaAccessStatus: (_mediaType: string): string => 'granted',
};

// Session stub covering every API reached from src/main.
//
// Callers include:
// - DownloadManager: ses.on('will-download', ...)
// - ExtensionManager: loadExtension / removeExtension / getAllExtensions
// - DeclarativeNetRequestEngine: webRequest.onBeforeRequest /
//   onHeadersReceived
// - ClearDataController: clearHistory / clearCache / clearAuthCache /
//   clearStorageData
// - PermissionManager: setPermissionRequestHandler /
//   setPermissionCheckHandler
// - ProfileContext: session.fromPartition(...)
//
// The stub returns itself for chainable .on/.off so EventEmitter patterns
// don't blow up, and resolves every async API to a typical empty value.
const sessionStub = {
  on: (_event: string, _handler: (...args: unknown[]) => void) => sessionStub,
  off: (_event: string, _handler: (...args: unknown[]) => void) => sessionStub,
  once: (_event: string, _handler: (...args: unknown[]) => void) => sessionStub,
  removeListener: (_event: string, _handler: (...args: unknown[]) => void) => sessionStub,
  removeAllListeners: (_event?: string) => sessionStub,

  // permissions
  setPermissionRequestHandler: (_handler: unknown): void => undefined,
  setPermissionCheckHandler: (_handler: unknown): void => undefined,
  setDevicePermissionHandler: (_handler: unknown): void => undefined,

  // web request interception (DeclarativeNetRequestEngine)
  webRequest: {
    onBeforeRequest: (_listener: unknown): void => undefined,
    onBeforeSendHeaders: (_listener: unknown): void => undefined,
    onSendHeaders: (_listener: unknown): void => undefined,
    onHeadersReceived: (_listener: unknown): void => undefined,
    onResponseStarted: (_listener: unknown): void => undefined,
    onBeforeRedirect: (_listener: unknown): void => undefined,
    onCompleted: (_listener: unknown): void => undefined,
    onErrorOccurred: (_listener: unknown): void => undefined,
  },

  // data clearing (ClearDataController)
  clearCache: (): Promise<void> => Promise.resolve(),
  clearAuthCache: (): Promise<void> => Promise.resolve(),
  clearHistory: (): Promise<void> => Promise.resolve(),
  clearHostResolverCache: (): Promise<void> => Promise.resolve(),
  clearStorageData: (_options?: unknown): Promise<void> => Promise.resolve(),
  flushStorageData: (): void => undefined,

  cookies: {
    get: (): Promise<unknown[]> => Promise.resolve([]),
    set: (_details: unknown): Promise<void> => Promise.resolve(),
    remove: (): Promise<void> => Promise.resolve(),
    flushStore: (): Promise<void> => Promise.resolve(),
  },

  // extensions (ExtensionManager)
  loadExtension: (_path: string, _opts?: unknown): Promise<{ id: string; manifest: Record<string, never>; name: string; path: string; version: string }> =>
    Promise.resolve({
      id: 'mock-ext-id',
      manifest: {},
      name: 'mock-ext',
      path: _path,
      version: '0.0.0',
    }),
  removeExtension: (_id: string): void => undefined,
  getExtension: (_id: string): null => null,
  getAllExtensions: (): unknown[] => [],

  // spell check / proxies / misc
  setSpellCheckerEnabled: (_enabled: boolean): void => undefined,
  isSpellCheckerEnabled: (): boolean => false,
  setProxy: (_config: unknown): Promise<void> => Promise.resolve(),
  resolveProxy: (_url: string): Promise<string> => Promise.resolve(''),

  // service workers (ServiceWorkerManager)
  serviceWorkers: {
    getAllRunning: (): Record<string, never> => ({}),
    getFromVersionID: (_id: number): null => null,
    startWorkerForScope: (_scope: string): Promise<void> => Promise.resolve(),
  },

  // user agent
  getUserAgent: (): string => 'mock-ua',
  setUserAgent: (_ua: string): void => undefined,

  // certificate handlers
  setCertificateVerifyProc: (_proc: unknown): void => undefined,
};

export const session = {
  defaultSession: sessionStub,
  fromPartition: (_partition: string): typeof sessionStub => sessionStub,
};

// Many main-process modules reach for app.whenReady via the namespace import.
// The `protocol` module is also referenced by custom scheme registration code.
export const protocol = {
  registerSchemesAsPrivileged: (_schemes: unknown[]): void => undefined,
  registerFileProtocol: (_scheme: string, _handler: unknown): void => undefined,
  registerStringProtocol: (_scheme: string, _handler: unknown): void => undefined,
  registerBufferProtocol: (_scheme: string, _handler: unknown): void => undefined,
  handle: (_scheme: string, _handler: unknown): void => undefined,
  unhandle: (_scheme: string): void => undefined,
};

export const Menu = {
  setApplicationMenu: (_menu: unknown): void => undefined,
  buildFromTemplate: (_template: unknown[]) => ({
    popup: (): void => undefined,
    closePopup: (): void => undefined,
  }),
  getApplicationMenu: (): null => null,
};

export const MenuItem = class {
  constructor(_opts: unknown) {
    // noop
  }
};

export default {
  app,
  ipcMain,
  BrowserWindow,
  globalShortcut,
  screen,
  nativeImage,
  shell,
  safeStorage,
  systemPreferences,
  session,
  protocol,
  Menu,
  MenuItem,
};
