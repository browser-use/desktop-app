/**
 * IPC handlers for chrome:// internal pages.
 * Exposes version, GPU, accessibility, sandbox, and remote inspect info to the renderer.
 */

import { app, ipcMain } from 'electron';
import http from 'node:http';
import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InspectTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  description?: string;
  host: string;
  port: number;
}

export interface NetworkTarget {
  host: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Network targets persistence (in-memory for session lifetime)
// ---------------------------------------------------------------------------

const networkTargets: NetworkTarget[] = [
  { host: 'localhost', port: 9222 },
];

// ---------------------------------------------------------------------------
// HTTP helper: fetch JSON from a remote debugging endpoint
// ---------------------------------------------------------------------------

function fetchJsonFromTarget(host: string, port: number, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port,
      path: urlPath,
      method: 'GET',
      timeout: 3000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error from ${host}:${port}${urlPath}: ${String(err)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout connecting to ${host}:${port}`));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Discover targets from a single host:port
// ---------------------------------------------------------------------------

async function discoverTargets(host: string, port: number): Promise<InspectTarget[]> {
  try {
    const raw = await fetchJsonFromTarget(host, port, '/json');
    if (!Array.isArray(raw)) return [];
    return (raw as Record<string, unknown>[]).map((t) => ({
      id: String(t.id ?? ''),
      type: String(t.type ?? 'page'),
      title: String(t.title ?? t.url ?? ''),
      url: String(t.url ?? ''),
      webSocketDebuggerUrl: t.webSocketDebuggerUrl ? String(t.webSocketDebuggerUrl) : undefined,
      devtoolsFrontendUrl: t.devtoolsFrontendUrl ? String(t.devtoolsFrontendUrl) : undefined,
      description: t.description ? String(t.description) : undefined,
      host,
      port,
    }));
  } catch (err) {
    mainLogger.debug('chrome.ipc.discoverTargets.failed', { host, port, error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// IPC channels
// ---------------------------------------------------------------------------

const CHANNELS = [
  'chrome:version-info',
  'chrome:gpu-info',
  'chrome:accessibility-info',
  'chrome:sandbox-info',
  'chrome:open-page',
  'chrome:inspect-targets',
  'chrome:inspect-add-target',
  'chrome:inspect-remove-target',
  'chrome:inspect-get-network-targets',
] as const;

export function registerChromeHandlers(
  openInternalPage: (page: string) => void,
  openSettingsWindow: () => void,
  openExtensionsWindow: () => void,
): void {
  mainLogger.info('chrome.ipc.register');

  ipcMain.handle('chrome:version-info', () => {
    mainLogger.debug('chrome.ipc.versionInfo');
    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      v8Version: process.versions.v8 ?? 'unknown',
      osArch: process.arch,
      osPlatform: process.platform,
      osVersion: process.getSystemVersion(),
      userData: app.getPath('userData'),
      execPath: app.getPath('exe'),
      locale: app.getLocale(),
    };
  });

  ipcMain.handle('chrome:gpu-info', async () => {
    mainLogger.debug('chrome.ipc.gpuInfo');
    try {
      const info = await app.getGPUInfo('complete');
      return info;
    } catch (err) {
      mainLogger.warn('chrome.ipc.gpuInfo.failed', { error: String(err) });
      return { error: String(err) };
    }
  });

  ipcMain.handle('chrome:accessibility-info', () => {
    mainLogger.debug('chrome.ipc.accessibilityInfo');
    return {
      accessibilitySupportEnabled: app.accessibilitySupportEnabled,
    };
  });

  ipcMain.handle('chrome:sandbox-info', () => {
    mainLogger.debug('chrome.ipc.sandboxInfo');
    return {
      sandboxed: process.sandboxed ?? false,
      contextIsolated: true,
      nodeIntegration: false,
    };
  });

  ipcMain.handle('chrome:open-page', (_event, page: string) => {
    mainLogger.info('chrome.ipc.openPage', { page });
    if (page === 'settings') {
      openSettingsWindow();
    } else if (page === 'extensions') {
      openExtensionsWindow();
    } else {
      openInternalPage(page);
    }
  });

  ipcMain.handle('chrome:inspect-targets', async () => {
    mainLogger.debug('chrome.ipc.inspectTargets', { targetCount: networkTargets.length });
    const results = await Promise.all(
      networkTargets.map((t) => discoverTargets(t.host, t.port)),
    );
    const targets = results.flat();
    mainLogger.info('chrome.ipc.inspectTargets.result', { found: targets.length });
    return { targets, networkTargets: [...networkTargets] };
  });

  ipcMain.handle('chrome:inspect-get-network-targets', () => {
    mainLogger.debug('chrome.ipc.inspectGetNetworkTargets');
    return [...networkTargets];
  });

  ipcMain.handle('chrome:inspect-add-target', (_event, host: string, port: number) => {
    mainLogger.info('chrome.ipc.inspectAddTarget', { host, port });
    const already = networkTargets.some((t) => t.host === host && t.port === port);
    if (!already) {
      networkTargets.push({ host, port });
      mainLogger.info('chrome.ipc.inspectAddTarget.added', { host, port, total: networkTargets.length });
    } else {
      mainLogger.debug('chrome.ipc.inspectAddTarget.duplicate', { host, port });
    }
    return [...networkTargets];
  });

  ipcMain.handle('chrome:inspect-remove-target', (_event, host: string, port: number) => {
    mainLogger.info('chrome.ipc.inspectRemoveTarget', { host, port });
    const idx = networkTargets.findIndex((t) => t.host === host && t.port === port);
    if (idx !== -1) {
      networkTargets.splice(idx, 1);
      mainLogger.info('chrome.ipc.inspectRemoveTarget.removed', { host, port, remaining: networkTargets.length });
    }
    return [...networkTargets];
  });
}

export function unregisterChromeHandlers(): void {
  mainLogger.info('chrome.ipc.unregister');
  for (const ch of CHANNELS) {
    ipcMain.removeHandler(ch);
  }
}
