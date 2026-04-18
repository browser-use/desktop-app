/**
 * Preload script for the chrome://history internal page.
 * Exposes a safe contextBridge API for querying and managing browsing history
 * and journey clusters.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  favicon: string | null;
}

export interface HistoryQueryResult {
  entries: HistoryEntry[];
  totalCount: number;
}

export interface JourneyCluster {
  id: string;
  label: string;
  domain: string;
  entries: HistoryEntry[];
  startTime: number;
  endTime: number;
}

export interface JourneyQueryResult {
  clusters: JourneyCluster[];
  totalCount: number;
}

contextBridge.exposeInMainWorld('historyAPI', {
  query: (opts?: { query?: string; limit?: number; offset?: number }): Promise<HistoryQueryResult> =>
    ipcRenderer.invoke('history:query', opts),

  remove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('history:remove', id),

  removeBulk: (ids: string[]): Promise<number> =>
    ipcRenderer.invoke('history:remove-bulk', ids),

  clearAll: (): Promise<boolean> =>
    ipcRenderer.invoke('history:clear-all'),

  navigateTo: (url: string): Promise<void> =>
    ipcRenderer.invoke('tabs:navigate-active', url),

  journeys: (opts?: { query?: string; limit?: number; offset?: number }): Promise<JourneyQueryResult> =>
    ipcRenderer.invoke('history:journeys', opts),

  removeCluster: (clusterId: string): Promise<number> =>
    ipcRenderer.invoke('history:remove-cluster', clusterId),
});
