/**
 * Shared types for the print preview system.
 * Used by main process, preload, and renderer.
 */

export interface PrinterInfo {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  status: number;
}

export type PageRangeMode = 'all' | 'custom';

export interface PageRange {
  from: number;
  to: number;
}

export type LayoutOrientation = 'portrait' | 'landscape';
export type ColorMode = 'color' | 'monochrome';
export type MarginsType = 'default' | 'minimum' | 'none' | 'custom';
export type PagesPerSheet = 1 | 2 | 4 | 6 | 9 | 16;

export interface CustomMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PrintSettings {
  destination: string;
  pageRangeMode: PageRangeMode;
  customPageRanges: PageRange[];
  layout: LayoutOrientation;
  colorMode: ColorMode;
  pagesPerSheet: PagesPerSheet;
  marginsType: MarginsType;
  customMargins: CustomMargins;
  scaleFactor: number;
  shouldPrintBackgrounds: boolean;
  shouldPrintHeadersFooters: boolean;
  duplexMode: 'simplex' | 'shortEdge' | 'longEdge';
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  destination: '',
  pageRangeMode: 'all',
  customPageRanges: [],
  layout: 'portrait',
  colorMode: 'color',
  pagesPerSheet: 1,
  marginsType: 'default',
  customMargins: { top: 10, bottom: 10, left: 10, right: 10 },
  scaleFactor: 100,
  shouldPrintBackgrounds: false,
  shouldPrintHeadersFooters: false,
  duplexMode: 'simplex',
};

export interface PrintPreviewData {
  pdfBase64: string;
  pageCount: number;
  title: string;
  url: string;
}
