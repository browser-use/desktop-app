/**
 * PrintPreviewApp — Chrome-style print preview with settings sidebar + live PDF preview.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PrintSettings,
  PrintPreviewData,
  PrinterInfo,
  LayoutOrientation,
  ColorMode,
  MarginsType,
  PagesPerSheet,
  PageRangeMode,
} from '../../shared/printTypes';
import { DEFAULT_PRINT_SETTINGS } from '../../shared/printTypes';

// ---------------------------------------------------------------------------
// Window API type
// ---------------------------------------------------------------------------

interface PrintPreviewAPIShape {
  getPrinters: () => Promise<PrinterInfo[]>;
  generatePreview: (settings: Partial<PrintSettings>) => Promise<PrintPreviewData | null>;
  executePrint: (settings: PrintSettings) => Promise<{ success: boolean; error?: string }>;
  getPageInfo: () => Promise<{ title: string; url: string }>;
  closeWindow: () => void;
}

declare global {
  interface Window {
    printPreviewAPI: PrintPreviewAPIShape;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGES_PER_SHEET_OPTIONS: PagesPerSheet[] = [1, 2, 4, 6, 9, 16];

const SAVE_AS_PDF_DESTINATION = '__save_as_pdf__';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PrintPreviewApp(): React.ReactElement {
  const [settings, setSettings] = useState<PrintSettings>({ ...DEFAULT_PRINT_SETTINGS });
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [preview, setPreview] = useState<PrintPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [pageInfo, setPageInfo] = useState({ title: '', url: '' });
  const [customRangeText, setCustomRangeText] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Load printers and page info on mount
  useEffect(() => {
    console.debug('[PrintPreview] mounting, loading printers and page info');
    const api = window.printPreviewAPI;

    Promise.all([api.getPrinters(), api.getPageInfo()])
      .then(([printerList, info]) => {
        console.debug('[PrintPreview] printers loaded', { count: printerList.length });
        setPrinters(printerList);
        setPageInfo(info);

        const defaultPrinter = printerList.find((p) => p.isDefault);
        if (defaultPrinter) {
          setSettings((prev) => ({ ...prev, destination: defaultPrinter.name }));
        } else if (printerList.length > 0) {
          setSettings((prev) => ({ ...prev, destination: printerList[0].name }));
        } else {
          setSettings((prev) => ({ ...prev, destination: SAVE_AS_PDF_DESTINATION }));
        }
      })
      .catch((err) => {
        console.error('[PrintPreview] failed to load printers', err);
        setSettings((prev) => ({ ...prev, destination: SAVE_AS_PDF_DESTINATION }));
      });
  }, []);

  // -- Generate preview when settings change
  const generatePreview = useCallback(async (currentSettings: PrintSettings) => {
    console.debug('[PrintPreview] generating preview');
    setLoading(true);
    setError(null);

    try {
      const data = await window.printPreviewAPI.generatePreview(currentSettings);
      if (data) {
        setPreview(data);
        setCurrentPage(0);
        console.debug('[PrintPreview] preview generated', { pageCount: data.pageCount });
      } else {
        setError('Failed to generate preview');
      }
    } catch (err) {
      console.error('[PrintPreview] preview error', err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced preview refresh
  const refreshPreview = useCallback(
    (newSettings: PrintSettings) => {
      if (previewDebounceRef.current) {
        clearTimeout(previewDebounceRef.current);
      }
      previewDebounceRef.current = setTimeout(() => {
        generatePreview(newSettings);
      }, 400);
    },
    [generatePreview],
  );

  // Initial preview load
  useEffect(() => {
    const timer = setTimeout(() => {
      generatePreview(settings);
    }, 200);
    return () => clearTimeout(timer);
    // Only run once on mount (settings will trigger via refreshPreview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Render PDF page to canvas
  useEffect(() => {
    if (!preview?.pdfBase64 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const binaryStr = atob(preview.pdfBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // PDF.js is heavy; for the preview we render a simple placeholder image
    // showing the PDF was generated successfully. A full PDF.js integration
    // would be needed for actual page-by-page rendering.
    // For now, create an object URL and use an iframe-like approach
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    // Store the URL for the embed/iframe approach
    canvas.dataset.pdfUrl = url;

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [preview?.pdfBase64, currentPage]);

  // -- Computed: PDF object URL for embed
  const pdfObjectUrl = useMemo(() => {
    if (!preview?.pdfBase64) return null;
    const binaryStr = atob(preview.pdfBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/pdf' });
    return URL.createObjectURL(blob);
  }, [preview?.pdfBase64]);

  // Cleanup object URL
  useEffect(() => {
    return () => {
      if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
    };
  }, [pdfObjectUrl]);

  // -- Setting updaters
  const updateSetting = useCallback(
    <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        refreshPreview(next);
        return next;
      });
    },
    [refreshPreview],
  );

  // -- Parse custom page range text (e.g. "1-3, 5, 7-9")
  const parsePageRanges = useCallback((text: string) => {
    const ranges: { from: number; to: number }[] = [];
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const match = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (match) {
        ranges.push({ from: parseInt(match[1], 10), to: parseInt(match[2], 10) });
      } else {
        const num = parseInt(part, 10);
        if (!isNaN(num)) {
          ranges.push({ from: num, to: num });
        }
      }
    }
    return ranges;
  }, []);

  // -- Handlers
  const handlePrint = useCallback(async () => {
    console.debug('[PrintPreview] printing', { destination: settings.destination });
    setPrinting(true);
    setError(null);

    try {
      const result = await window.printPreviewAPI.executePrint(settings);
      if (!result.success && result.error !== 'Cancelled') {
        setError(result.error || 'Print failed');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrinting(false);
    }
  }, [settings]);

  const handleCancel = useCallback(() => {
    window.printPreviewAPI.closeWindow();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handlePrint();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleCancel, handlePrint]);

  // -- Destination options
  const destinationOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const p of printers) {
      opts.push({
        value: p.name,
        label: p.displayName || p.name,
      });
    }
    opts.push({ value: SAVE_AS_PDF_DESTINATION, label: 'Save as PDF' });
    return opts;
  }, [printers]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="pp-root">
      {/* ── Sidebar ── */}
      <div className="pp-sidebar">
        <div className="pp-sidebar__header">
          <h1 className="pp-sidebar__title">Print</h1>
          {pageInfo.title && (
            <div className="pp-sidebar__page-info" title={pageInfo.url}>
              {pageInfo.title}
            </div>
          )}
        </div>

        <div className="pp-sidebar__body">
          {/* Destination */}
          <div className="pp-group">
            <label className="pp-group__label">Destination</label>
            <select
              className="pp-select"
              value={settings.destination}
              onChange={(e) => updateSetting('destination', e.target.value)}
            >
              {destinationOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Pages */}
          <div className="pp-group">
            <label className="pp-group__label">Pages</label>
            <select
              className="pp-select"
              value={settings.pageRangeMode}
              onChange={(e) => updateSetting('pageRangeMode', e.target.value as PageRangeMode)}
            >
              <option value="all">All</option>
              <option value="custom">Custom</option>
            </select>
            {settings.pageRangeMode === 'custom' && (
              <input
                className="pp-input"
                style={{ marginTop: 8 }}
                placeholder="e.g. 1-3, 5, 7-9"
                value={customRangeText}
                onChange={(e) => {
                  setCustomRangeText(e.target.value);
                  const ranges = parsePageRanges(e.target.value);
                  updateSetting('customPageRanges', ranges);
                }}
              />
            )}
          </div>

          {/* Layout */}
          <div className="pp-group">
            <label className="pp-group__label">Layout</label>
            <select
              className="pp-select"
              value={settings.layout}
              onChange={(e) => updateSetting('layout', e.target.value as LayoutOrientation)}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>

          {/* Color */}
          <div className="pp-group">
            <label className="pp-group__label">Color</label>
            <select
              className="pp-select"
              value={settings.colorMode}
              onChange={(e) => updateSetting('colorMode', e.target.value as ColorMode)}
            >
              <option value="color">Color</option>
              <option value="monochrome">Black and white</option>
            </select>
          </div>

          <div className="pp-divider" />

          {/* More settings toggle */}
          <button
            className="pp-more-toggle"
            onClick={() => setShowMore(!showMore)}
            type="button"
          >
            <svg
              className={`pp-more-toggle__icon ${showMore ? 'pp-more-toggle__icon--open' : ''}`}
              width="8"
              height="10"
              viewBox="0 0 8 10"
              fill="none"
            >
              <path d="M1 1L6 5L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {showMore ? 'Fewer settings' : 'More settings'}
          </button>

          {showMore && (
            <>
              {/* Pages per sheet */}
              <div className="pp-group">
                <label className="pp-group__label">Pages per sheet</label>
                <select
                  className="pp-select"
                  value={settings.pagesPerSheet}
                  onChange={(e) => updateSetting('pagesPerSheet', parseInt(e.target.value, 10) as PagesPerSheet)}
                >
                  {PAGES_PER_SHEET_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              {/* Margins */}
              <div className="pp-group">
                <label className="pp-group__label">Margins</label>
                <select
                  className="pp-select"
                  value={settings.marginsType}
                  onChange={(e) => updateSetting('marginsType', e.target.value as MarginsType)}
                >
                  <option value="default">Default</option>
                  <option value="minimum">Minimum</option>
                  <option value="none">None</option>
                  <option value="custom">Custom</option>
                </select>
                {settings.marginsType === 'custom' && (
                  <div className="pp-margins-grid">
                    {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                      <div key={side} className="pp-margins-grid__field">
                        <span className="pp-margins-grid__field-label">{side.charAt(0).toUpperCase() + side.slice(1)} (mm)</span>
                        <input
                          className="pp-input pp-input--narrow"
                          type="number"
                          min={0}
                          max={100}
                          value={settings.customMargins[side]}
                          onChange={(e) => {
                            const val = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
                            setSettings((prev) => {
                              const next = {
                                ...prev,
                                customMargins: { ...prev.customMargins, [side]: val },
                              };
                              refreshPreview(next);
                              return next;
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Scale */}
              <div className="pp-group">
                <label className="pp-group__label">Scale</label>
                <div className="pp-scale-row">
                  <input
                    className="pp-input"
                    type="number"
                    min={10}
                    max={200}
                    value={settings.scaleFactor}
                    onChange={(e) => {
                      const val = Math.max(10, Math.min(200, parseInt(e.target.value, 10) || 100));
                      updateSetting('scaleFactor', val);
                    }}
                  />
                  <span className="pp-scale-row__unit">%</span>
                </div>
              </div>

              {/* Two-sided */}
              <div className="pp-group">
                <label className="pp-group__label">Two-sided</label>
                <select
                  className="pp-select"
                  value={settings.duplexMode}
                  onChange={(e) => updateSetting('duplexMode', e.target.value as PrintSettings['duplexMode'])}
                >
                  <option value="simplex">Off</option>
                  <option value="longEdge">Long edge</option>
                  <option value="shortEdge">Short edge</option>
                </select>
              </div>

              <div className="pp-divider" />

              {/* Options */}
              <div className="pp-group">
                <label className="pp-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.shouldPrintHeadersFooters}
                    onChange={(e) => updateSetting('shouldPrintHeadersFooters', e.target.checked)}
                  />
                  Headers and footers
                </label>
              </div>

              <div className="pp-group">
                <label className="pp-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.shouldPrintBackgrounds}
                    onChange={(e) => updateSetting('shouldPrintBackgrounds', e.target.checked)}
                  />
                  Background graphics
                </label>
              </div>
            </>
          )}
        </div>

        <div className="pp-sidebar__footer">
          <button
            className="agb-btn agb-btn--md agb-btn--ghost"
            onClick={handleCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="agb-btn agb-btn--md agb-btn--primary"
            onClick={handlePrint}
            disabled={printing}
            type="button"
          >
            {printing
              ? 'Printing…'
              : settings.destination === SAVE_AS_PDF_DESTINATION
                ? 'Save'
                : 'Print'}
          </button>
        </div>
      </div>

      {/* ── Preview pane ── */}
      <div className="pp-preview">
        {loading && (
          <div className="pp-preview__loading">
            <div className="pp-preview__spinner" />
            <span>Generating preview…</span>
          </div>
        )}

        {error && !loading && (
          <div className="pp-preview__error">{error}</div>
        )}

        {!loading && !error && pdfObjectUrl && (
          <>
            <embed
              className="pp-preview__canvas"
              src={`${pdfObjectUrl}#page=${currentPage + 1}`}
              type="application/pdf"
              style={{
                width: settings.layout === 'landscape' ? '90%' : '70%',
                height: '85%',
              }}
            />
            {preview && preview.pageCount > 1 && (
              <div className="pp-preview__pagination">
                <button
                  className="pp-preview__page-btn"
                  disabled={currentPage === 0}
                  onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                  type="button"
                  aria-label="Previous page"
                >
                  <svg width="8" height="10" viewBox="0 0 8 10" fill="none">
                    <path d="M6 1L2 5L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <span>
                  {currentPage + 1} / {preview.pageCount}
                </span>
                <button
                  className="pp-preview__page-btn"
                  disabled={currentPage >= preview.pageCount - 1}
                  onClick={() => setCurrentPage((p) => Math.min(preview.pageCount - 1, p + 1))}
                  type="button"
                  aria-label="Next page"
                >
                  <svg width="8" height="10" viewBox="0 0 8 10" fill="none">
                    <path d="M2 1L6 5L2 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )}
          </>
        )}

        {!loading && !error && !pdfObjectUrl && (
          <div className="pp-preview__loading">
            <span>No preview available</span>
          </div>
        )}
      </div>
    </div>
  );
}
