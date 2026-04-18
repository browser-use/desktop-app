/**
 * Preload script for chrome:// internal pages.
 * Exposes a safe contextBridge API for system info, downloads, navigation,
 * and remote debugging target discovery (chrome://inspect).
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { InspectTarget, NetworkTarget } from '../main/chrome/ipc';

export type { InspectTarget, NetworkTarget };

contextBridge.exposeInMainWorld('chromeAPI', {
  getPage: (): string => {
    const hash = window.location.hash.replace('#', '');
    return hash || 'about';
  },

  getVersionInfo: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('chrome:version-info'),

  getGpuInfo: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('chrome:gpu-info'),

  getDownloads: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('downloads:get-all'),

  getAccessibilityInfo: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('chrome:accessibility-info'),

  getSandboxInfo: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('chrome:sandbox-info'),

  navigateTo: (url: string): Promise<void> =>
    ipcRenderer.invoke('tabs:navigate-active', url),

  openInternalPage: (page: string): Promise<void> =>
    ipcRenderer.invoke('chrome:open-page', page),

  // chrome://inspect — remote debugging target discovery
  getInspectTargets: (): Promise<{ targets: InspectTarget[]; networkTargets: NetworkTarget[] }> =>
    ipcRenderer.invoke('chrome:inspect-targets'),

  getNetworkTargets: (): Promise<NetworkTarget[]> =>
    ipcRenderer.invoke('chrome:inspect-get-network-targets'),

  addNetworkTarget: (host: string, port: number): Promise<NetworkTarget[]> =>
    ipcRenderer.invoke('chrome:inspect-add-target', host, port),

  removeNetworkTarget: (host: string, port: number): Promise<NetworkTarget[]> =>
    ipcRenderer.invoke('chrome:inspect-remove-target', host, port),
});
