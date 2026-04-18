/**
 * Print preview preload — contextBridge API for the print preview renderer.
 *
 * Exposes a typed API on window.printPreviewAPI for:
 *   - Fetching available printers
 *   - Generating PDF preview from the source tab
 *   - Executing print with configured settings
 *   - Closing the preview window
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { PrintSettings, PrintPreviewData, PrinterInfo } from '../shared/printTypes';

export interface PrintPreviewAPI {
  getPrinters: () => Promise<PrinterInfo[]>;
  generatePreview: (settings: Partial<PrintSettings>) => Promise<PrintPreviewData | null>;
  executePrint: (settings: PrintSettings) => Promise<{ success: boolean; error?: string }>;
  getPageInfo: () => Promise<{ title: string; url: string }>;
  closeWindow: () => void;
}

const api: PrintPreviewAPI = {
  getPrinters: async (): Promise<PrinterInfo[]> => {
    console.debug('[print-preview-preload] getPrinters');
    return ipcRenderer.invoke('print-preview:get-printers') as Promise<PrinterInfo[]>;
  },

  generatePreview: async (settings: Partial<PrintSettings>): Promise<PrintPreviewData | null> => {
    console.debug('[print-preview-preload] generatePreview', { settings });
    return ipcRenderer.invoke('print-preview:generate-preview', settings) as Promise<PrintPreviewData | null>;
  },

  executePrint: async (settings: PrintSettings): Promise<{ success: boolean; error?: string }> => {
    console.debug('[print-preview-preload] executePrint', { destination: settings.destination });
    return ipcRenderer.invoke('print-preview:execute-print', settings) as Promise<{ success: boolean; error?: string }>;
  },

  getPageInfo: async (): Promise<{ title: string; url: string }> => {
    console.debug('[print-preview-preload] getPageInfo');
    return ipcRenderer.invoke('print-preview:get-page-info') as Promise<{ title: string; url: string }>;
  },

  closeWindow: (): void => {
    console.debug('[print-preview-preload] closeWindow');
    ipcRenderer.send('print-preview:close');
  },
};

contextBridge.exposeInMainWorld('printPreviewAPI', api);
