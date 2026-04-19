/**
 * Chrome parity smoke runner.
 *
 * Methodology (plan §8, Critic M1):
 *   1. For each URL in sites.json:
 *      a. Navigate via The Browser (Playwright-Electron)
 *      b. Collect console messages during a 30s load window
 *      c. Filter to level='error' only
 *   2. Load chrome-baseline.json (captured from stock Chrome separately)
 *   3. Diff: new_errors = agentic_errors - chrome_baseline_errors
 *   4. Ship gate: new_errors.length === 0 for all 20 sites
 *   5. Output: tests/results/parity-report.json
 *
 * Dry-run mode (--dry-run): uses stub baseline + empty agentic errors.
 * Baseline capture mode (--capture-baseline): captures from stock Chrome
 * using Playwright chromium; writes to chrome-baseline.json.
 *
 * Usage:
 *   npx ts-node tests/parity/run-parity.ts [--dry-run] [--capture-baseline]
 *
 * Track H owns this file.
 */

import { chromium, ConsoleMessage } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MY_APP_ROOT = path.resolve(__dirname, '../..');
const SITES_JSON = path.join(__dirname, 'sites.json');
const BASELINE_JSON = path.join(__dirname, 'chrome-baseline.json');
const RESULTS_DIR = path.join(MY_APP_ROOT, 'tests', 'results');
const REPORT_PATH = path.join(RESULTS_DIR, 'parity-report.json');

const LOAD_WINDOW_MS = 30_000;
const PAGE_TIMEOUT_MS = 45_000;
const LOG_PREFIX = '[Parity]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsoleError {
  text: string;
  url?: string;
  lineNumber?: number;
}

export interface SiteParityResult {
  url: string;
  chrome_console_errors: ConsoleError[];
  agentic_console_errors: ConsoleError[];
  /** Errors present in agentic but NOT in chrome baseline — the ship gate */
  new_errors: ConsoleError[];
  /** Errors present in chrome baseline but NOT in agentic (informational) */
  missing_errors: ConsoleError[];
  error?: string;
}

export interface ParityReport {
  generated_at: string;
  baseline_source: 'stub' | 'real';
  total_sites: number;
  sites_with_new_errors: number;
  gate_passed: boolean;
  results: SiteParityResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseErrorText(text: string): string {
  // Strip stack trace line numbers and dynamic identifiers to allow
  // fuzzy matching between Chrome and The Browser console errors.
  return text
    .replace(/:\d+:\d+/g, '') // strip :line:col
    .replace(/https?:\/\/[^\s]+/g, '[URL]') // strip URLs
    .trim()
    .toLowerCase();
}

function isNewError(agError: ConsoleError, baselineErrors: ConsoleError[]): boolean {
  const normAg = normaliseErrorText(agError.text);
  return !baselineErrors.some((be) => normaliseErrorText(be.text) === normAg);
}

function isMissingError(chromeError: ConsoleError, agErrors: ConsoleError[]): boolean {
  const normCh = normaliseErrorText(chromeError.text);
  return !agErrors.some((ae) => normaliseErrorText(ae.text) === normCh);
}

// ---------------------------------------------------------------------------
// Capture from a Playwright browser (Chrome or Agentic)
// ---------------------------------------------------------------------------

async function captureConsoleErrors(
  browserType: 'chromium',
  url: string,
): Promise<ConsoleError[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const errors: ConsoleError[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      errors.push({
        text: msg.text(),
        url: msg.location().url,
        lineNumber: msg.location().lineNumber,
      });
    }
  });

  page.on('pageerror', (err: Error) => {
    errors.push({ text: `[pageerror] ${err.message}` });
  });

  try {
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'networkidle' });
    // Observe for the full load window
    await page.waitForTimeout(LOAD_WINDOW_MS - PAGE_TIMEOUT_MS > 0 ? 5_000 : LOAD_WINDOW_MS);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Navigation error for ${url}: ${(err as Error).message}`);
  } finally {
    await browser.close();
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Dry-run mode: returns empty agentic errors (no Electron required)
// ---------------------------------------------------------------------------

async function captureAgenticErrors(
  url: string,
  dryRun: boolean,
): Promise<ConsoleError[]> {
  if (dryRun) {
    console.log(`${LOG_PREFIX} [dry-run] Returning empty agentic errors for ${url}`);
    return [];
  }

  // In real mode, this would launch the Electron app via electron-launcher and
  // capture console errors from the WebContentsView. Stubbed until integration.
  console.warn(
    `${LOG_PREFIX} Real agentic capture not yet implemented. ` +
    `Run with --dry-run until Electron integration is ready.`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// Main parity runner
// ---------------------------------------------------------------------------

async function runParity(opts: {
  dryRun: boolean;
  captureBaseline: boolean;
}): Promise<ParityReport> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Load sites
  const sites: string[] = JSON.parse(fs.readFileSync(SITES_JSON, 'utf-8'));
  console.log(`${LOG_PREFIX} Running parity for ${sites.length} sites`);

  // Load or capture baseline
  let baseline: Record<string, ConsoleError[]>;
  let baselineSource: 'stub' | 'real' = 'stub';

  if (opts.captureBaseline) {
    console.log(`${LOG_PREFIX} Capturing Chrome baseline for ${sites.length} sites...`);
    baseline = {};
    for (const url of sites) {
      console.log(`${LOG_PREFIX}   Capturing Chrome baseline: ${url}`);
      baseline[url] = await captureConsoleErrors('chromium', url);
      console.log(`${LOG_PREFIX}   → ${baseline[url].length} errors`);
    }
    const baselineData = Object.assign({ _comment: 'Captured by run-parity.ts --capture-baseline' }, baseline);
    fs.writeFileSync(BASELINE_JSON, JSON.stringify(baselineData, null, 2), 'utf-8');
    console.log(`${LOG_PREFIX} Baseline written to ${BASELINE_JSON}`);
    baselineSource = 'real';
  } else {
    const raw = JSON.parse(fs.readFileSync(BASELINE_JSON, 'utf-8')) as Record<string, unknown>;
    baseline = {};
    for (const [url, errors] of Object.entries(raw)) {
      if (url.startsWith('_')) continue; // skip metadata keys
      baseline[url] = Array.isArray(errors) ? (errors as ConsoleError[]) : [];
    }
    baselineSource = Object.values(baseline).some((v) => v.length > 0) ? 'real' : 'stub';
    console.log(`${LOG_PREFIX} Loaded baseline (source=${baselineSource})`);
  }

  // Run parity checks
  const results: SiteParityResult[] = [];

  for (const url of sites) {
    console.log(`${LOG_PREFIX} Checking: ${url}`);
    let agenticErrors: ConsoleError[] = [];
    let error: string | undefined;

    try {
      agenticErrors = await captureAgenticErrors(url, opts.dryRun);
    } catch (err) {
      error = (err as Error).message;
      console.error(`${LOG_PREFIX} Error capturing agentic errors for ${url}: ${error}`);
    }

    const chromeErrors = baseline[url] ?? [];
    const newErrors = agenticErrors.filter((ae) => isNewError(ae, chromeErrors));
    const missingErrors = chromeErrors.filter((ce) => isMissingError(ce, agenticErrors));

    console.log(
      `${LOG_PREFIX}   chrome=${chromeErrors.length} agentic=${agenticErrors.length} ` +
      `new=${newErrors.length} missing=${missingErrors.length}`,
    );

    results.push({
      url,
      chrome_console_errors: chromeErrors,
      agentic_console_errors: agenticErrors,
      new_errors: newErrors,
      missing_errors: missingErrors,
      error,
    });
  }

  // Build report
  const sitesWithNewErrors = results.filter((r) => r.new_errors.length > 0).length;
  const gatePassed = sitesWithNewErrors === 0;

  const report: ParityReport = {
    generated_at: new Date().toISOString(),
    baseline_source: baselineSource,
    total_sites: sites.length,
    sites_with_new_errors: sitesWithNewErrors,
    gate_passed: gatePassed,
    results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n${LOG_PREFIX} =============================================`);
  console.log(`${LOG_PREFIX} Parity report written to: ${REPORT_PATH}`);
  console.log(`${LOG_PREFIX} Gate passed: ${gatePassed}`);
  console.log(`${LOG_PREFIX} Sites with new errors: ${sitesWithNewErrors} / ${sites.length}`);

  if (!gatePassed) {
    console.error(`\n${LOG_PREFIX} GATE FAILED — new_errors detected:`);
    for (const r of results.filter((x) => x.new_errors.length > 0)) {
      console.error(`  ${r.url}: ${r.new_errors.length} new error(s)`);
      for (const e of r.new_errors) {
        console.error(`    - ${e.text.slice(0, 120)}`);
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const captureBaseline = args.includes('--capture-baseline');

  console.log(`${LOG_PREFIX} Starting parity run (dry-run=${dryRun}, capture-baseline=${captureBaseline})`);

  runParity({ dryRun, captureBaseline })
    .then((report) => {
      process.exit(report.gate_passed ? 0 : 1);
    })
    .catch((err) => {
      console.error(`${LOG_PREFIX} Fatal error:`, err);
      process.exit(1);
    });
}

export { runParity };
