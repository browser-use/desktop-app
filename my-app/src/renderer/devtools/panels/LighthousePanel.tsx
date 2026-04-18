import React, { useState, useCallback } from 'react';

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

interface AuditResult {
  id: string;
  title: string;
  description: string;
  passed: boolean;
  score: number | null;
  displayValue?: string;
}

interface CategoryResult {
  id: string;
  title: string;
  score: number;
  audits: AuditResult[];
}

interface MetricResult {
  name: string;
  value: string;
  unit: string;
  score: number;
}

interface LighthouseResults {
  categories: CategoryResult[];
  metrics: MetricResult[];
  runAt: string;
}

const SCORE_COLOR = (score: number): string => {
  if (score >= 90) return 'var(--color-status-success)';
  if (score >= 50) return 'var(--color-status-warning)';
  return 'var(--color-status-error)';
};

const SCORE_BG = (score: number): string => {
  if (score >= 90) return 'rgba(74, 222, 128, 0.08)';
  if (score >= 50) return 'rgba(245, 158, 11, 0.08)';
  return 'rgba(248, 113, 113, 0.08)';
};

export function LighthousePanel({ cdpSend, onCdpEvent: _onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [results, setResults] = useState<LighthouseResults | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState('');

  const evalExpr = useCallback(
    async (expression: string): Promise<unknown> => {
      const resp = await cdpSend('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (!resp.success) throw new Error(resp.error ?? 'Runtime.evaluate failed');
      const evalResult = resp.result as { result?: { value?: unknown }; exceptionDetails?: { text?: string } } | undefined;
      if (evalResult?.exceptionDetails) {
        throw new Error(evalResult.exceptionDetails.text ?? 'JS exception during eval');
      }
      return evalResult?.result?.value;
    },
    [cdpSend],
  );

  // ── Performance audit ─────────────────────────────────────────────────────

  const runPerformanceAudit = useCallback(async (): Promise<{ audits: AuditResult[]; metrics: MetricResult[] }> => {
    console.log('[LighthousePanel] running performance audit');
    setProgress('Collecting performance metrics...');

    const timingJson = (await evalExpr(
      'JSON.stringify(performance.timing)',
    )) as string;
    const navJson = (await evalExpr(
      'JSON.stringify(performance.getEntriesByType("navigation")[0] || null)',
    )) as string;
    const paintJson = (await evalExpr(
      'JSON.stringify(performance.getEntriesByType("paint"))',
    )) as string;
    await evalExpr(
      `(function() {
        if (!window.__lcp_observer_injected__) {
          window.__lcp_observer_injected__ = true;
          try {
            new PerformanceObserver(function(list) {
              var entries = list.getEntries();
              if (entries.length > 0) window.__lcp_entry__ = entries[entries.length - 1];
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch(e) {}
          try {
            window.__cls_value__ = 0;
            new PerformanceObserver(function(list) {
              list.getEntries().forEach(function(e) { if (!e.hadRecentInput) window.__cls_value__ += e.value; });
            }).observe({ type: 'layout-shift', buffered: true });
          } catch(e) {}
        }
      })()`,
    );
    await new Promise((r) => setTimeout(r, 150));
    const lcpJson = (await evalExpr(
      `JSON.stringify(
        (() => {
          try {
            return window.__lcp_entry__ ? { startTime: window.__lcp_entry__.startTime } : null;
          } catch(e) { return null; }
        })()
      )`,
    )) as string;
    const clsJson = (await evalExpr(
      `JSON.stringify(
        (() => {
          try {
            return typeof window.__cls_value__ === 'number' ? { value: window.__cls_value__ } : null;
          } catch(e) { return null; }
        })()
      )`,
    )) as string;
    const resourceCountJson = (await evalExpr(
      'performance.getEntriesByType("resource").length',
    )) as number;

    const timing = JSON.parse(timingJson) as Record<string, number>;
    const nav = navJson !== 'null' ? JSON.parse(navJson) as Record<string, number> : null;
    const paint = JSON.parse(paintJson) as Array<{ name: string; startTime: number }>;
    const lcp = lcpJson !== 'null' ? JSON.parse(lcpJson) as { startTime: number } : null;
    const cls = clsJson !== 'null' ? JSON.parse(clsJson) as { value: number } : null;

    console.log('[LighthousePanel] performance timing:', { timing, nav, paint, lcp, cls, resourceCountJson });

    const fcp = paint.find((p) => p.name === 'first-contentful-paint');
    const fp = paint.find((p) => p.name === 'first-paint');

    const fcpMs = fcp?.startTime ?? (nav ? nav.responseEnd : 0);
    const domLoadMs = nav ? nav.domContentLoadedEventEnd : timing.domContentLoadedEventEnd - timing.navigationStart;
    const loadMs = nav ? nav.loadEventEnd : timing.loadEventEnd - timing.navigationStart;

    const metrics: MetricResult[] = [
      {
        name: 'First Contentful Paint',
        value: fcpMs > 0 ? `${Math.round(fcpMs)}` : 'N/A',
        unit: 'ms',
        score: fcpMs <= 0 ? 50 : fcpMs <= 1800 ? 100 : fcpMs <= 3000 ? 60 : 30,
      },
      {
        name: 'First Paint',
        value: fp ? `${Math.round(fp.startTime)}` : 'N/A',
        unit: 'ms',
        score: fp ? (fp.startTime <= 2000 ? 100 : fp.startTime <= 4000 ? 60 : 30) : 50,
      },
      {
        name: 'DOM Content Loaded',
        value: domLoadMs > 0 ? `${Math.round(domLoadMs)}` : 'N/A',
        unit: 'ms',
        score: domLoadMs <= 0 ? 50 : domLoadMs <= 2000 ? 100 : domLoadMs <= 4000 ? 60 : 30,
      },
      {
        name: 'Page Load',
        value: loadMs > 0 ? `${Math.round(loadMs)}` : 'N/A',
        unit: 'ms',
        score: loadMs <= 0 ? 50 : loadMs <= 3000 ? 100 : loadMs <= 6000 ? 60 : 30,
      },
      {
        name: 'LCP (approx.)',
        value: lcp ? `${Math.round(lcp.startTime)}` : 'N/A',
        unit: 'ms',
        score: !lcp ? 50 : lcp.startTime <= 2500 ? 100 : lcp.startTime <= 4000 ? 60 : 30,
      },
      {
        name: 'CLS (approx.)',
        value: cls ? cls.value.toFixed(3) : 'N/A',
        unit: '',
        score: !cls ? 50 : cls.value <= 0.1 ? 100 : cls.value <= 0.25 ? 60 : 30,
      },
      {
        name: 'Resource Count',
        value: String(resourceCountJson),
        unit: 'requests',
        score: resourceCountJson <= 50 ? 100 : resourceCountJson <= 100 ? 60 : 30,
      },
    ];

    const audits: AuditResult[] = [
      {
        id: 'fcp',
        title: 'First Contentful Paint',
        description: 'Time until the browser renders the first bit of content.',
        passed: fcpMs > 0 && fcpMs <= 1800,
        score: fcpMs > 0 ? Math.max(0, Math.min(100, Math.round(100 - ((fcpMs - 1800) / 120)))) : null,
        displayValue: fcpMs > 0 ? `${Math.round(fcpMs)} ms` : undefined,
      },
      {
        id: 'dcl',
        title: 'DOM Content Loaded',
        description: 'Time until the DOM is fully parsed.',
        passed: domLoadMs > 0 && domLoadMs <= 2000,
        score: domLoadMs > 0 ? Math.max(0, Math.min(100, Math.round(100 - ((domLoadMs - 2000) / 80)))) : null,
        displayValue: domLoadMs > 0 ? `${Math.round(domLoadMs)} ms` : undefined,
      },
      {
        id: 'resource-count',
        title: 'Resource count',
        description: 'Fewer network requests means faster page loads.',
        passed: resourceCountJson <= 80,
        score: Math.max(0, Math.min(100, Math.round(100 - (resourceCountJson - 20) * 0.8))),
        displayValue: `${resourceCountJson} requests`,
      },
    ];

    return { audits, metrics };
  }, [evalExpr]);

  // ── Accessibility audit ───────────────────────────────────────────────────

  const runAccessibilityAudit = useCallback(async (): Promise<{ audits: AuditResult[] }> => {
    console.log('[LighthousePanel] running accessibility audit');
    setProgress('Checking accessibility...');

    const imagesWithoutAlt = (await evalExpr(
      'document.querySelectorAll("img:not([alt])").length',
    )) as number;
    const inputsWithoutLabel = (await evalExpr(
      `(function() {
        var inputs = document.querySelectorAll('input');
        var unlabeled = 0;
        inputs.forEach(function(input) {
          var hasAriaLabel = input.hasAttribute('aria-label');
          var hasAriaLabelledBy = input.hasAttribute('aria-labelledby');
          var hasLabelFor = input.id && document.querySelector('label[for="' + input.id + '"]');
          var hasWrappingLabel = input.closest('label') !== null;
          if (!hasAriaLabel && !hasAriaLabelledBy && !hasLabelFor && !hasWrappingLabel) unlabeled++;
        });
        return unlabeled;
      })()`,
    )) as number;
    const hasMainLandmark = (await evalExpr(
      `document.querySelector("main, [role='main']") !== null`,
    )) as boolean;
    const hasNavLandmark = (await evalExpr(
      `document.querySelector("nav, [role='navigation']") !== null`,
    )) as boolean;
    const headingOrder = (await evalExpr(
      `JSON.stringify(Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => parseInt(h.tagName[1])))`,
    )) as string;
    const hasLangAttr = (await evalExpr(
      `document.documentElement.hasAttribute('lang')`,
    )) as boolean;
    const hasTitle = (await evalExpr(
      `document.title.trim().length > 0`,
    )) as boolean;
    const buttonsWithText = (await evalExpr(
      `Array.from(document.querySelectorAll('button')).filter(b => !b.textContent?.trim() && !b.getAttribute('aria-label')).length`,
    )) as number;

    console.log('[LighthousePanel] a11y checks:', { imagesWithoutAlt, inputsWithoutLabel, hasMainLandmark, hasNavLandmark, hasLangAttr, hasTitle, buttonsWithText });

    const headings: number[] = JSON.parse(headingOrder);
    let headingOrderOk = true;
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        headingOrderOk = false;
        break;
      }
    }

    const audits: AuditResult[] = [
      {
        id: 'image-alt',
        title: 'Images have alt text',
        description: 'All images should have descriptive alt attributes for screen readers.',
        passed: imagesWithoutAlt === 0,
        score: imagesWithoutAlt === 0 ? 100 : Math.max(0, 100 - imagesWithoutAlt * 15),
        displayValue: imagesWithoutAlt > 0 ? `${imagesWithoutAlt} image(s) missing alt` : undefined,
      },
      {
        id: 'input-labels',
        title: 'Form inputs have labels',
        description: 'All form inputs must have an associated label.',
        passed: inputsWithoutLabel === 0,
        score: inputsWithoutLabel === 0 ? 100 : Math.max(0, 100 - inputsWithoutLabel * 20),
        displayValue: inputsWithoutLabel > 0 ? `${inputsWithoutLabel} input(s) without label` : undefined,
      },
      {
        id: 'landmark-main',
        title: 'Page has a <main> landmark',
        description: 'A <main> or role=main landmark helps users navigate to the primary content.',
        passed: hasMainLandmark,
        score: hasMainLandmark ? 100 : 0,
      },
      {
        id: 'landmark-nav',
        title: 'Page has a <nav> landmark',
        description: 'A <nav> or role=navigation landmark helps users navigate between pages.',
        passed: hasNavLandmark,
        score: hasNavLandmark ? 100 : 0,
      },
      {
        id: 'heading-order',
        title: 'Heading levels are sequential',
        description: 'Heading levels should increase by at most one to form a logical structure.',
        passed: headingOrderOk,
        score: headingOrderOk ? 100 : 30,
        displayValue: headings.length > 0 ? `${headings.length} heading(s) found` : 'No headings',
      },
      {
        id: 'html-lang',
        title: 'Document has a lang attribute',
        description: 'The html element should have a lang attribute to aid screen readers.',
        passed: hasLangAttr,
        score: hasLangAttr ? 100 : 0,
      },
      {
        id: 'document-title',
        title: 'Document has a title',
        description: 'A descriptive document title helps users identify the page.',
        passed: hasTitle,
        score: hasTitle ? 100 : 0,
      },
      {
        id: 'button-name',
        title: 'Buttons have accessible names',
        description: 'Buttons must have text content or an aria-label.',
        passed: buttonsWithText === 0,
        score: buttonsWithText === 0 ? 100 : Math.max(0, 100 - buttonsWithText * 20),
        displayValue: buttonsWithText > 0 ? `${buttonsWithText} button(s) without name` : undefined,
      },
    ];

    return { audits };
  }, [evalExpr]);

  // ── Best Practices audit ──────────────────────────────────────────────────

  const runBestPracticesAudit = useCallback(async (): Promise<{ audits: AuditResult[] }> => {
    console.log('[LighthousePanel] running best practices audit');
    setProgress('Checking best practices...');

    const isHttps = (await evalExpr(`location.protocol === 'https:'`)) as boolean;
    const hasConsoleErrors = (await evalExpr(
      `typeof window.__devtools_error_count__ === 'number' ? window.__devtools_error_count__ > 0 : false`,
    )) as boolean;
    const hasDoctype = (await evalExpr(
      `document.doctype !== null`,
    )) as boolean;
    const hasCharset = (await evalExpr(
      `document.querySelector('meta[charset]') !== null || document.characterSet.toLowerCase().includes('utf')`,
    )) as boolean;
    const hasXFrameOptions = (await evalExpr(
      `document.querySelector('meta[http-equiv="X-Frame-Options"]') !== null`,
    )) as boolean;
    const listenersJson = (await evalExpr(
      `JSON.stringify(typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[onclick]').length : 0)`,
    )) as string;
    const inlineHandlerCount = JSON.parse(listenersJson) as number;
    const hasViewport = (await evalExpr(
      `document.querySelector('meta[name="viewport"]') !== null`,
    )) as boolean;

    console.log('[LighthousePanel] best practices checks:', { isHttps, hasConsoleErrors, hasDoctype, hasCharset, hasViewport, inlineHandlerCount });

    const audits: AuditResult[] = [
      {
        id: 'https',
        title: 'Page uses HTTPS',
        description: 'HTTPS encrypts data in transit and improves security.',
        passed: isHttps,
        score: isHttps ? 100 : 0,
      },
      {
        id: 'doctype',
        title: 'Page has a doctype',
        description: 'A doctype prevents the browser from switching to quirks mode.',
        passed: hasDoctype,
        score: hasDoctype ? 100 : 0,
      },
      {
        id: 'charset',
        title: 'Character encoding is specified',
        description: 'Specifying a charset avoids potential XSS vectors and rendering bugs.',
        passed: hasCharset,
        score: hasCharset ? 100 : 40,
      },
      {
        id: 'viewport',
        title: 'Has a viewport meta tag',
        description: 'A viewport meta tag ensures the page renders correctly on mobile.',
        passed: hasViewport,
        score: hasViewport ? 100 : 0,
      },
      {
        id: 'inline-handlers',
        title: 'No inline event handlers',
        description: 'Inline event handlers (onclick="...") are harder to maintain and may violate CSP.',
        passed: inlineHandlerCount === 0,
        score: inlineHandlerCount === 0 ? 100 : Math.max(0, 100 - inlineHandlerCount * 10),
        displayValue: inlineHandlerCount > 0 ? `${inlineHandlerCount} inline handler(s)` : undefined,
      },
      {
        id: 'no-console-errors',
        title: 'No console errors detected',
        description: 'Console errors indicate JavaScript exceptions or failed resources.',
        passed: !hasConsoleErrors,
        score: hasConsoleErrors ? 50 : 100,
      },
    ];

    return { audits };
  }, [evalExpr]);

  // ── SEO audit ─────────────────────────────────────────────────────────────

  const runSeoAudit = useCallback(async (): Promise<{ audits: AuditResult[] }> => {
    console.log('[LighthousePanel] running SEO audit');
    setProgress('Checking SEO...');

    const hasMetaDescription = (await evalExpr(
      `document.querySelector('meta[name="description"]')?.content?.trim().length > 0`,
    )) as boolean;
    const hasTitle = (await evalExpr(`document.title.trim().length > 0`)) as boolean;
    const titleLength = (await evalExpr(`document.title.trim().length`)) as number;
    const hasViewport = (await evalExpr(
      `document.querySelector('meta[name="viewport"]') !== null`,
    )) as boolean;
    const hasCanonical = (await evalExpr(
      `document.querySelector('link[rel="canonical"]') !== null`,
    )) as boolean;
    const h1Count = (await evalExpr(`document.querySelectorAll('h1').length`)) as number;
    const hasRobotsTag = (await evalExpr(
      `document.querySelector('meta[name="robots"]') !== null`,
    )) as boolean;
    const imagesWithAlt = (await evalExpr(
      `document.querySelectorAll('img[alt]').length`,
    )) as number;
    const totalImages = (await evalExpr(`document.querySelectorAll('img').length`)) as number;

    console.log('[LighthousePanel] SEO checks:', { hasMetaDescription, hasTitle, titleLength, hasViewport, hasCanonical, h1Count, hasRobotsTag, imagesWithAlt, totalImages });

    const audits: AuditResult[] = [
      {
        id: 'meta-description',
        title: 'Document has a meta description',
        description: 'A meta description helps search engines show a relevant snippet in search results.',
        passed: hasMetaDescription,
        score: hasMetaDescription ? 100 : 0,
      },
      {
        id: 'title',
        title: 'Document has a title tag',
        description: 'The title tag is important for SEO and browser tabs.',
        passed: hasTitle && titleLength >= 10 && titleLength <= 70,
        score: !hasTitle ? 0 : titleLength < 10 ? 40 : titleLength > 70 ? 60 : 100,
        displayValue: hasTitle ? `"${titleLength}" chars` : undefined,
      },
      {
        id: 'viewport',
        title: 'Has viewport meta tag',
        description: 'Mobile-friendliness is a ranking factor.',
        passed: hasViewport,
        score: hasViewport ? 100 : 0,
      },
      {
        id: 'canonical',
        title: 'Page has a canonical link',
        description: 'A canonical URL prevents duplicate content issues.',
        passed: hasCanonical,
        score: hasCanonical ? 100 : 50,
      },
      {
        id: 'h1',
        title: 'Page has exactly one H1',
        description: 'A single H1 provides a clear primary heading for search engines.',
        passed: h1Count === 1,
        score: h1Count === 1 ? 100 : h1Count === 0 ? 0 : 60,
        displayValue: `${h1Count} H1(s)`,
      },
      {
        id: 'robots',
        title: 'Has robots meta tag',
        description: 'A robots meta tag controls indexing behavior.',
        passed: hasRobotsTag,
        score: hasRobotsTag ? 100 : 50,
      },
      {
        id: 'image-alt-seo',
        title: 'Images have descriptive alt text',
        description: 'Alt text on images helps search engines understand page content.',
        passed: totalImages === 0 || imagesWithAlt === totalImages,
        score: totalImages === 0 ? 100 : Math.round((imagesWithAlt / totalImages) * 100),
        displayValue: totalImages > 0 ? `${imagesWithAlt}/${totalImages} images` : undefined,
      },
    ];

    return { audits };
  }, [evalExpr]);

  // ── Main run handler ──────────────────────────────────────────────────────

  const runAudit = useCallback(async () => {
    if (!isAttached) return;
    console.log('[LighthousePanel] starting audit run');
    setRunning(true);
    setError(null);
    setResults(null);
    setProgress('Starting audit...');

    try {
      await cdpSend('Runtime.enable');

      const [perfResult, a11yResult, bpResult, seoResult] = await Promise.all([
        runPerformanceAudit(),
        runAccessibilityAudit(),
        runBestPracticesAudit(),
        runSeoAudit(),
      ]);

      const calcScore = (audits: AuditResult[]): number => {
        const scored = audits.filter((a) => a.score !== null);
        if (scored.length === 0) return 0;
        return Math.round(scored.reduce((sum, a) => sum + (a.score ?? 0), 0) / scored.length);
      };

      const categories: CategoryResult[] = [
        { id: 'performance', title: 'Performance', score: calcScore(perfResult.audits), audits: perfResult.audits },
        { id: 'accessibility', title: 'Accessibility', score: calcScore(a11yResult.audits), audits: a11yResult.audits },
        { id: 'best-practices', title: 'Best Practices', score: calcScore(bpResult.audits), audits: bpResult.audits },
        { id: 'seo', title: 'SEO', score: calcScore(seoResult.audits), audits: seoResult.audits },
      ];

      console.log('[LighthousePanel] audit complete, category scores:', categories.map((c) => `${c.title}: ${c.score}`));

      setResults({
        categories,
        metrics: perfResult.metrics,
        runAt: new Date().toLocaleTimeString(),
      });
      setProgress('');
    } catch (err) {
      console.error('[LighthousePanel] audit run failed:', err);
      setError(String(err));
      setProgress('');
    } finally {
      setRunning(false);
    }
  }, [isAttached, cdpSend, runPerformanceAudit, runAccessibilityAudit, runBestPracticesAudit, runSeoAudit]);

  const clearResults = useCallback(() => {
    console.log('[LighthousePanel] clearing results');
    setResults(null);
    setError(null);
    setProgress('');
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!isAttached) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Not attached</div>
        <div className="panel-placeholder-desc">Attach to a tab to run Lighthouse audits.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
          flexShrink: 0,
          backgroundColor: 'var(--color-bg-elevated)',
        }}
      >
        <button
          className="devtools-connect-btn"
          onClick={() => void runAudit()}
          disabled={running}
          style={{ padding: 'var(--space-2) var(--space-5)', fontSize: 'var(--font-size-xs)' }}
        >
          {running ? 'Running...' : 'Run Audit'}
        </button>
        {results && (
          <button className="console-clear-btn" onClick={clearResults}>
            Clear Results
          </button>
        )}
        {progress && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-fg-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {progress}
          </span>
        )}
        {results && (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-tertiary)' }}>
            Run at {results.runAt}
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
        {error && (
          <div style={{ color: 'var(--color-status-error)', fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)', marginBottom: 'var(--space-4)' }}>
            {error}
          </div>
        )}

        {!results && !running && !error && (
          <div className="panel-placeholder" style={{ height: '300px' }}>
            <div className="panel-placeholder-icon">☆</div>
            <div className="panel-placeholder-title">Lighthouse Audit</div>
            <div className="panel-placeholder-desc">
              Click "Run Audit" to analyze performance, accessibility, best practices, and SEO.
            </div>
          </div>
        )}

        {results && (
          <>
            {/* Category scores */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-6)',
              }}
            >
              {results.categories.map((cat) => (
                <div
                  key={cat.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-4)',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${SCORE_COLOR(cat.score)}`,
                    backgroundColor: SCORE_BG(cat.score),
                  }}
                >
                  <div
                    style={{
                      fontSize: '28px',
                      fontWeight: 'var(--font-weight-semibold)',
                      color: SCORE_COLOR(cat.score),
                      lineHeight: 1,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {cat.score}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-fg-secondary)', textAlign: 'center' }}>
                    {cat.title}
                  </div>
                </div>
              ))}
            </div>

            {/* Metrics */}
            <div style={{ marginBottom: 'var(--space-6)' }}>
              <div
                style={{
                  fontSize: 'var(--font-size-xs)',
                  fontWeight: 'var(--font-weight-semibold)',
                  color: 'var(--color-fg-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 'var(--space-3)',
                  paddingBottom: 'var(--space-2)',
                  borderBottom: '1px solid var(--color-border-subtle)',
                }}
              >
                Metrics
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' }}>
                {results.metrics.map((metric, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 'var(--space-3)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--color-border-subtle)',
                      backgroundColor: 'var(--color-bg-elevated)',
                    }}
                  >
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-fg-tertiary)', marginBottom: 'var(--space-1)' }}>
                      {metric.name}
                    </div>
                    <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: SCORE_COLOR(metric.score), fontFamily: 'var(--font-mono)' }}>
                      {metric.value} {metric.unit && <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'normal' }}>{metric.unit}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Per-category audit details */}
            {results.categories.map((cat) => (
              <div key={cat.id} style={{ marginBottom: 'var(--space-6)' }}>
                <div
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--color-fg-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginBottom: 'var(--space-3)',
                    paddingBottom: 'var(--space-2)',
                    borderBottom: '1px solid var(--color-border-subtle)',
                  }}
                >
                  {cat.title} Audits
                </div>
                {cat.audits.map((audit) => (
                  <div
                    key={audit.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-2) 0',
                      borderBottom: '1px solid var(--color-border-subtle)',
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 'var(--font-size-xs)',
                        color: audit.passed ? 'var(--color-status-success)' : 'var(--color-status-error)',
                        width: '16px',
                        textAlign: 'center',
                      }}
                    >
                      {audit.passed ? '✓' : '✕'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-fg-primary)', fontWeight: 'var(--font-weight-medium)' }}>
                        {audit.title}
                        {audit.displayValue && (
                          <span style={{ marginLeft: 'var(--space-2)', color: 'var(--color-fg-tertiary)', fontWeight: 'normal', fontFamily: 'var(--font-mono)' }}>
                            — {audit.displayValue}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-tertiary)', marginTop: 'var(--space-1)', lineHeight: 'var(--line-height-relaxed)' }}>
                        {audit.description}
                      </div>
                    </div>
                    {audit.score !== null && (
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: 'var(--font-size-2xs)',
                          fontFamily: 'var(--font-mono)',
                          color: SCORE_COLOR(audit.score),
                          width: '32px',
                          textAlign: 'right',
                        }}
                      >
                        {audit.score}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
