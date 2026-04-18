/**
 * PrintPreviewWindow.ts — creates and manages the Print Preview BrowserWindow.
 *
 * Opens a modal-style window showing a live PDF preview of the active tab
 * with print settings controls. Follows the SettingsWindow singleton pattern.
 *
 * Path invariants (from memory):
 *   - preload: path.join(__dirname, 'printPreview.js')
 *   - loadURL: full path from project root
 *   - HTML script src: relative ./index.tsx
 */

import path from 'node:path';
import { BrowserWindow, ipcMain, dialog, PrinterInfo } from 'electron';
import { mainLogger } from '../logger';
import type { PrintSettings, PrintPreviewData } from '../../shared/printTypes';

// ---------------------------------------------------------------------------
// Forge VitePlugin globals (injected at build time)
// ---------------------------------------------------------------------------

declare const PRINT_PREVIEW_VITE_DEV_SERVER_URL: string | undefined;
declare const PRINT_PREVIEW_VITE_NAME: string | undefined;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let printPreviewWindow: BrowserWindow | null = null;
let sourceTabWebContentsId: number | null = null;
let sourceTabTitle: string = '';
let sourceTabUrl: string = '';

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle('print-preview:get-printers', async (): Promise<PrinterInfo[]> => {
    mainLogger.info('PrintPreview.getPrinters');
    // Use the print preview window's webContents to enumerate printers
    // (any webContents works — printers are system-global)
    if (!printPreviewWindow || printPreviewWindow.isDestroyed()) return [];
    const printers = printPreviewWindow.webContents.getPrintersAsync
      ? await printPreviewWindow.webContents.getPrintersAsync()
      : (printPreviewWindow.webContents as any).getPrinters?.() ?? [];
    mainLogger.info('PrintPreview.getPrinters.result', { count: printers.length });
    return printers;
  });

  ipcMain.handle(
    'print-preview:generate-preview',
    async (_e, settings: Partial<PrintSettings>): Promise<PrintPreviewData | null> => {
      mainLogger.info('PrintPreview.generatePreview', { settings });
      if (sourceTabWebContentsId === null) {
        mainLogger.warn('PrintPreview.generatePreview.noSourceTab');
        return null;
      }

      const { webContents } = require('electron');
      const sourceWc = webContents.fromId(sourceTabWebContentsId);
      if (!sourceWc || sourceWc.isDestroyed()) {
        mainLogger.warn('PrintPreview.generatePreview.sourceDestroyed');
        return null;
      }

      try {
        const landscape = settings.layout === 'landscape';
        const marginsType = settings.marginsType === 'none' ? 0
          : settings.marginsType === 'minimum' ? 1
          : settings.marginsType === 'custom' ? 2
          : 0;

        const pdfOptions: Electron.PrintToPDFOptions = {
          landscape,
          printBackground: settings.shouldPrintBackgrounds ?? false,
          scale: (settings.scaleFactor ?? 100) / 100,
          marginsType: marginsType as 0 | 1 | 2,
          pageSize: 'Letter',
          printSelectionOnly: false,
          generateTaggedPDF: false,
        };

        if (settings.marginsType === 'custom' && settings.customMargins) {
          pdfOptions.margins = {
            top: settings.customMargins.top / 25.4,
            bottom: settings.customMargins.bottom / 25.4,
            left: settings.customMargins.left / 25.4,
            right: settings.customMargins.right / 25.4,
          };
          pdfOptions.marginsType = undefined as any;
        }

        if (settings.customPageRanges && settings.customPageRanges.length > 0 && settings.pageRangeMode === 'custom') {
          pdfOptions.pageRanges = settings.customPageRanges.reduce<Record<string, number>>((acc, range, i) => {
            acc[`from_${i}`] = range.from;
            acc[`to_${i}`] = range.to;
            return acc;
          }, {});
        }

        mainLogger.info('PrintPreview.generatePreview.printToPDF', { pdfOptions });
        const pdfBuffer = await sourceWc.printToPDF(pdfOptions);
        const pdfBase64 = pdfBuffer.toString('base64');

        // Estimate page count from PDF (rough — count /Type /Page entries)
        const pdfStr = pdfBuffer.toString('latin1');
        const pageMatches = pdfStr.match(/\/Type\s*\/Page(?!\s*s)/g);
        const pageCount = pageMatches ? pageMatches.length : 1;

        mainLogger.info('PrintPreview.generatePreview.ok', {
          pdfSizeKb: Math.round(pdfBuffer.length / 1024),
          pageCount,
        });

        return {
          pdfBase64,
          pageCount,
          title: sourceTabTitle,
          url: sourceTabUrl,
        };
      } catch (err) {
        mainLogger.error('PrintPreview.generatePreview.failed', {
          error: (err as Error).message,
          stack: (err as Error).stack,
        });
        return null;
      }
    },
  );

  ipcMain.handle(
    'print-preview:execute-print',
    async (_e, settings: PrintSettings): Promise<{ success: boolean; error?: string }> => {
      mainLogger.info('PrintPreview.executePrint', { destination: settings.destination });

      if (sourceTabWebContentsId === null) {
        return { success: false, error: 'No source tab' };
      }

      const { webContents } = require('electron');
      const sourceWc = webContents.fromId(sourceTabWebContentsId);
      if (!sourceWc || sourceWc.isDestroyed()) {
        return { success: false, error: 'Source tab destroyed' };
      }

      // "Save as PDF" destination
      if (settings.destination === '__save_as_pdf__') {
        try {
          const result = await dialog.showSaveDialog(printPreviewWindow!, {
            title: 'Save as PDF',
            defaultPath: `${sourceTabTitle || 'page'}.pdf`,
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          });

          if (result.canceled || !result.filePath) {
            mainLogger.info('PrintPreview.executePrint.savePdfCanceled');
            return { success: false, error: 'Cancelled' };
          }

          const pdfOptions: Electron.PrintToPDFOptions = {
            landscape: settings.layout === 'landscape',
            printBackground: settings.shouldPrintBackgrounds,
            scale: settings.scaleFactor / 100,
            pageSize: 'Letter',
          };

          const pdfBuffer = await sourceWc.printToPDF(pdfOptions);
          const fs = require('node:fs');
          fs.writeFileSync(result.filePath, pdfBuffer);

          mainLogger.info('PrintPreview.executePrint.savedPdf', {
            path: result.filePath,
            sizeKb: Math.round(pdfBuffer.length / 1024),
          });

          closePrintPreviewWindow();
          return { success: true };
        } catch (err) {
          mainLogger.error('PrintPreview.executePrint.savePdfFailed', {
            error: (err as Error).message,
          });
          return { success: false, error: (err as Error).message };
        }
      }

      // Physical printer
      return new Promise((resolve) => {
        const printOptions: Electron.WebContentsPrintOptions = {
          silent: true,
          printBackground: settings.shouldPrintBackgrounds,
          deviceName: settings.destination,
          landscape: settings.layout === 'landscape',
          scaleFactor: settings.scaleFactor,
          pagesPerSheet: settings.pagesPerSheet,
          color: settings.colorMode === 'color',
          collate: true,
          copies: 1,
          header: settings.shouldPrintHeadersFooters ? sourceTabTitle : undefined,
          footer: settings.shouldPrintHeadersFooters ? sourceTabUrl : undefined,
          duplexMode: settings.duplexMode,
        };

        if (settings.pageRangeMode === 'custom' && settings.customPageRanges.length > 0) {
          printOptions.pageRanges = settings.customPageRanges.map((r) => ({
            from: r.from - 1,
            to: r.to - 1,
          }));
        }

        if (settings.marginsType === 'custom' && settings.customMargins) {
          printOptions.margins = {
            marginType: 'custom',
            top: settings.customMargins.top / 25.4,
            bottom: settings.customMargins.bottom / 25.4,
            left: settings.customMargins.left / 25.4,
            right: settings.customMargins.right / 25.4,
          };
        } else if (settings.marginsType === 'none') {
          printOptions.margins = { marginType: 'none' };
        } else if (settings.marginsType === 'minimum') {
          printOptions.margins = { marginType: 'printableArea' };
        } else {
          printOptions.margins = { marginType: 'default' };
        }

        mainLogger.info('PrintPreview.executePrint.printing', { printOptions });

        sourceWc.print(printOptions, (success, failureReason) => {
          mainLogger.info('PrintPreview.executePrint.result', { success, failureReason });
          if (success) {
            closePrintPreviewWindow();
          }
          resolve({ success, error: failureReason || undefined });
        });
      });
    },
  );

  ipcMain.handle('print-preview:get-page-info', () => {
    return { title: sourceTabTitle, url: sourceTabUrl };
  });

  ipcMain.on('print-preview:close', () => {
    mainLogger.info('PrintPreview.closeRequested');
    closePrintPreviewWindow();
  });
}

function unregisterIpcHandlers(): void {
  ipcMain.removeHandler('print-preview:get-printers');
  ipcMain.removeHandler('print-preview:generate-preview');
  ipcMain.removeHandler('print-preview:execute-print');
  ipcMain.removeHandler('print-preview:get-page-info');
  ipcMain.removeAllListeners('print-preview:close');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let handlersRegistered = false;

export function openPrintPreviewWindow(
  sourceWebContentsId: number,
  title: string,
  url: string,
  parentWindow?: BrowserWindow,
): BrowserWindow {
  if (printPreviewWindow && !printPreviewWindow.isDestroyed()) {
    mainLogger.info('PrintPreview.focus', { windowId: printPreviewWindow.id });
    sourceTabWebContentsId = sourceWebContentsId;
    sourceTabTitle = title;
    sourceTabUrl = url;
    printPreviewWindow.focus();
    return printPreviewWindow;
  }

  mainLogger.info('PrintPreview.create', { sourceWebContentsId, title, url });

  sourceTabWebContentsId = sourceWebContentsId;
  sourceTabTitle = title;
  sourceTabUrl = url;

  if (!handlersRegistered) {
    registerIpcHandlers();
    handlersRegistered = true;
  }

  const preloadPath = path.join(__dirname, 'printPreview.js');

  printPreviewWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    show: false,
    backgroundColor: '#1a1a1f',
    parent: parentWindow,
    modal: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  printPreviewWindow.once('ready-to-show', () => {
    if (!printPreviewWindow || printPreviewWindow.isDestroyed()) return;
    printPreviewWindow.show();
    printPreviewWindow.focus();
    mainLogger.info('PrintPreview.readyToShow', { windowId: printPreviewWindow.id });
  });

  printPreviewWindow.on('closed', () => {
    mainLogger.info('PrintPreview.closed');
    printPreviewWindow = null;
    sourceTabWebContentsId = null;
  });

  printPreviewWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    mainLogger.error('PrintPreview.did-fail-load', { code, desc, url });
  });

  printPreviewWindow.webContents.on('did-finish-load', () => {
    mainLogger.info('PrintPreview.did-finish-load', {
      url: printPreviewWindow?.webContents.getURL(),
    });
  });

  printPreviewWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    mainLogger.info('printPreviewRenderer.console', { level, source, line, message });
  });

  if (process.env.NODE_ENV !== 'production') {
    printPreviewWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (typeof PRINT_PREVIEW_VITE_DEV_SERVER_URL !== 'undefined' && PRINT_PREVIEW_VITE_DEV_SERVER_URL) {
    const devUrl = `${PRINT_PREVIEW_VITE_DEV_SERVER_URL}/src/renderer/print-preview/print-preview.html`;
    mainLogger.debug('PrintPreview.loadURL', { url: devUrl });
    void printPreviewWindow.loadURL(devUrl);
  } else {
    const name = typeof PRINT_PREVIEW_VITE_NAME !== 'undefined' ? PRINT_PREVIEW_VITE_NAME : 'print_preview';
    const filePath = path.join(__dirname, `../../renderer/${name}/print-preview.html`);
    mainLogger.debug('PrintPreview.loadFile', { filePath });
    void printPreviewWindow.loadFile(filePath);
  }

  mainLogger.info('PrintPreview.create.ok', { windowId: printPreviewWindow.id });
  return printPreviewWindow;
}

export function closePrintPreviewWindow(): void {
  if (printPreviewWindow && !printPreviewWindow.isDestroyed()) {
    mainLogger.info('PrintPreview.closeRequested');
    printPreviewWindow.close();
  }
}

export function getPrintPreviewWindow(): BrowserWindow | null {
  if (printPreviewWindow && !printPreviewWindow.isDestroyed()) {
    return printPreviewWindow;
  }
  return null;
}
