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
  handle: () => undefined,
  removeHandler: () => undefined,
  on: () => undefined,
  off: () => undefined,
  emit: () => false,
};

export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
};

export const globalShortcut = {
  register: () => false,
  unregister: () => undefined,
  unregisterAll: () => undefined,
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
  createEmpty: () => ({}),
  createFromPath: () => ({}),
};

export const shell = {
  openExternal: (_url: string) => Promise.resolve(),
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
  setPermissionRequestHandler: (_handler: unknown) => undefined,
  setPermissionCheckHandler: (_handler: unknown) => undefined,
  setDevicePermissionHandler: (_handler: unknown) => undefined,

  // web request interception (DeclarativeNetRequestEngine)
  webRequest: {
    onBeforeRequest: (_listener: unknown) => undefined,
    onBeforeSendHeaders: (_listener: unknown) => undefined,
    onSendHeaders: (_listener: unknown) => undefined,
    onHeadersReceived: (_listener: unknown) => undefined,
    onResponseStarted: (_listener: unknown) => undefined,
    onBeforeRedirect: (_listener: unknown) => undefined,
    onCompleted: (_listener: unknown) => undefined,
    onErrorOccurred: (_listener: unknown) => undefined,
  },

  // data clearing (ClearDataController)
  clearCache: () => Promise.resolve(),
  clearAuthCache: () => Promise.resolve(),
  clearHistory: () => Promise.resolve(),
  clearHostResolverCache: () => Promise.resolve(),
  clearStorageData: (_options?: unknown) => Promise.resolve(),
  flushStorageData: () => undefined,

  cookies: {
    get: () => Promise.resolve([]),
    set: (_details: unknown) => Promise.resolve(),
    remove: () => Promise.resolve(),
    flushStore: () => Promise.resolve(),
  },

  // extensions (ExtensionManager)
  loadExtension: (_path: string, _opts?: unknown) =>
    Promise.resolve({
      id: 'mock-ext-id',
      manifest: {},
      name: 'mock-ext',
      path: _path,
      version: '0.0.0',
    }),
  removeExtension: (_id: string) => undefined,
  getExtension: (_id: string) => null,
  getAllExtensions: () => [],

  // spell check / proxies / misc
  setSpellCheckerEnabled: (_enabled: boolean) => undefined,
  isSpellCheckerEnabled: () => false,
  setProxy: (_config: unknown) => Promise.resolve(),
  resolveProxy: (_url: string) => Promise.resolve(''),

  // service workers (ServiceWorkerManager)
  serviceWorkers: {
    getAllRunning: () => ({}),
    getFromVersionID: (_id: number) => null,
    startWorkerForScope: (_scope: string) => Promise.resolve(),
  },

  // user agent
  getUserAgent: () => 'mock-ua',
  setUserAgent: (_ua: string) => undefined,

  // certificate handlers
  setCertificateVerifyProc: (_proc: unknown) => undefined,
};

export const session = {
  defaultSession: sessionStub,
  fromPartition: (_partition: string) => sessionStub,
};

// Many main-process modules reach for app.whenReady via the namespace import.
// The `protocol` module is also referenced by custom scheme registration code.
export const protocol = {
  registerSchemesAsPrivileged: (_schemes: unknown[]) => undefined,
  registerFileProtocol: (_scheme: string, _handler: unknown) => undefined,
  registerStringProtocol: (_scheme: string, _handler: unknown) => undefined,
  registerBufferProtocol: (_scheme: string, _handler: unknown) => undefined,
  handle: (_scheme: string, _handler: unknown) => undefined,
  unhandle: (_scheme: string) => undefined,
};

export const Menu = {
  setApplicationMenu: (_menu: unknown) => undefined,
  buildFromTemplate: (_template: unknown[]) => ({
    popup: () => undefined,
    closePopup: () => undefined,
  }),
  getApplicationMenu: () => null,
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
  session,
  protocol,
  Menu,
  MenuItem,
};
