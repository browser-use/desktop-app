/**
 * Visual diff engine for visual QA pipeline.
 *
 * For states WITH reference images: uses pixelmatch for pixel-level
 * structural similarity scoring (0–1 scale, 1 = identical).
 *
 * For states WITHOUT reference images: heuristic DOM/CSS checks against
 * CLAUDE.md constraints using a headless Playwright session.
 *
 * Heuristic checks performed on all states:
 *   1. No Inter font in rendered DOM (getComputedStyle on body/root)
 *   2. No `!important` in any stylesheet
 *   3. No sparkle glyph (✨) in DOM text
 *   4. Dark theme applied (background luminance < 50% for shell states)
 *
 * Outputs: tests/visual/visual-qa-report.json
 *
 * Usage:
 *   npx ts-node --project tsconfig.json tests/visual/diff.ts
 *
 * Track H Visual QA owns this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { _electron as electron } from '@playwright/test';
import type { Page, ElectronApplication } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MY_APP_ROOT = path.resolve(__dirname, '../..');
const CAPTURES_DIR = path.join(__dirname, 'captures');
const REFERENCES_DIR = path.join(__dirname, 'references');
const REPORT_PATH = path.join(__dirname, 'visual-qa-report.json');
const LOG_PREFIX = '[diff]';

/** pixelmatch threshold — 0 = exact pixel match, 0.1 = ~10% colour tolerance */
const PIXEL_THRESHOLD = 0.1;

/** Minimum acceptable similarity for reference-based states (0–1) */
const MIN_ACCEPTABLE_SIMILARITY = 0.60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeuristicResult {
  check: string;
  passed: boolean;
  detail: string;
}

export interface StateReport {
  state: string;
  capture_path: string;
  reference_path: string | null;
  has_reference: boolean;
  structural_similarity_score: number | null;
  pixel_diff_count: number | null;
  total_pixels: number | null;
  notable_differences: string[];
  heuristic_checks: HeuristicResult[];
  captured_at: string | null;
  error?: string;
}

export interface VisualQAReport {
  generated_at: string;
  total_states: number;
  states_with_captures: number;
  states_without_captures: number;
  states_with_references: number;
  reference_comparisons_passed: number;
  reference_comparisons_failed: number;
  heuristic_violations_found: number;
  results: StateReport[];
}

// ---------------------------------------------------------------------------
// Logging (structured, no raw console.*)
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    channel: 'visual-qa-diff',
    msg: `${LOG_PREFIX} ${msg}`,
    ...extra,
  });
  if (level === 'error') {
    process.stderr.write(entry + '\n');
  } else if (level === 'warn') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

// ---------------------------------------------------------------------------
// State definitions
// ---------------------------------------------------------------------------

interface StateDefinition {
  state: string;
  capture_file: string;
  reference_file: string | null;
  /** Shell-themed dark background expected */
  expectDark: boolean;
  /** Onboarding-themed warm dark background expected */
  expectOnboarding: boolean;
}

const STATE_DEFINITIONS: StateDefinition[] = [
  {
    state: 'onboarding-welcome',
    capture_file: 'onboarding-welcome.png',
    reference_file: 'onboarding-welcome.png',
    expectDark: false,
    expectOnboarding: true,
  },
  {
    state: 'onboarding-naming',
    capture_file: 'onboarding-naming.png',
    reference_file: null,
    expectDark: false,
    expectOnboarding: true,
  },
  {
    state: 'onboarding-account',
    capture_file: 'onboarding-account.png',
    reference_file: null,
    expectDark: false,
    expectOnboarding: true,
  },
  {
    state: 'onboarding-account-scopes',
    capture_file: 'onboarding-account-scopes.png',
    reference_file: 'onboarding-account-scopes.png',
    expectDark: false,
    expectOnboarding: true,
  },
  {
    state: 'shell-empty',
    capture_file: 'shell-empty.png',
    reference_file: null,
    expectDark: true,
    expectOnboarding: false,
  },
  {
    state: 'shell-3-tabs',
    capture_file: 'shell-3-tabs.png',
    reference_file: null,
    expectDark: true,
    expectOnboarding: false,
  },
  {
    state: 'pill-idle',
    capture_file: 'pill-idle.png',
    reference_file: null,
    expectDark: true,
    expectOnboarding: false,
  },
  {
    state: 'pill-streaming',
    capture_file: 'pill-streaming.png',
    reference_file: null,
    expectDark: true,
    expectOnboarding: false,
  },
  {
    state: 'pill-result',
    capture_file: 'pill-result.png',
    reference_file: null,
    expectDark: true,
    expectOnboarding: false,
  },
];

// ---------------------------------------------------------------------------
// PNG loader
// ---------------------------------------------------------------------------

function loadPng(filePath: string): PNG {
  const buffer = fs.readFileSync(filePath);
  return PNG.sync.read(buffer);
}

// ---------------------------------------------------------------------------
// Structural similarity via pixelmatch
// ---------------------------------------------------------------------------

interface DiffResult {
  similarity: number;
  diffPixels: number;
  totalPixels: number;
  notableDifferences: string[];
}

function compareImages(capturePath: string, referencePath: string): DiffResult {
  log('info', 'Comparing images', { capture: capturePath, reference: referencePath });

  const capture = loadPng(capturePath);
  const reference = loadPng(referencePath);

  const notableDifferences: string[] = [];

  // Resize capture to match reference dimensions if needed
  let captureResized = capture;
  if (capture.width !== reference.width || capture.height !== reference.height) {
    notableDifferences.push(
      `Dimension mismatch: capture ${capture.width}×${capture.height} vs reference ${reference.width}×${reference.height}`,
    );
    log('warn', 'Image dimension mismatch — comparing at reference size', {
      captureSize: `${capture.width}×${capture.height}`,
      referenceSize: `${reference.width}×${reference.height}`,
    });

    // Create a canvas of reference size and blit capture into it (top-left aligned)
    const minW = Math.min(capture.width, reference.width);
    const minH = Math.min(capture.height, reference.height);
    const resized = new PNG({ width: reference.width, height: reference.height });

    // Fill with black
    resized.data.fill(0);
    // Set alpha to 255
    for (let i = 3; i < resized.data.length; i += 4) {
      resized.data[i] = 255;
    }

    // Copy overlapping region
    PNG.bitblt(capture, resized, 0, 0, minW, minH, 0, 0);
    captureResized = resized;
  }

  const totalPixels = reference.width * reference.height;
  const diffData = new Uint8Array(totalPixels * 4);

  const diffPixels = pixelmatch(
    captureResized.data,
    reference.data,
    diffData,
    reference.width,
    reference.height,
    { threshold: PIXEL_THRESHOLD, includeAA: false },
  );

  const similarity = 1 - diffPixels / totalPixels;

  if (similarity < MIN_ACCEPTABLE_SIMILARITY) {
    notableDifferences.push(
      `Low similarity score ${(similarity * 100).toFixed(1)}% (threshold ${(MIN_ACCEPTABLE_SIMILARITY * 100).toFixed(0)}%)`,
    );
  }

  if (diffPixels > totalPixels * 0.30) {
    notableDifferences.push(
      `High pixel diff: ${diffPixels.toLocaleString()} of ${totalPixels.toLocaleString()} pixels differ (${((diffPixels / totalPixels) * 100).toFixed(1)}%)`,
    );
  }

  log('info', 'Pixel comparison complete', {
    diffPixels,
    totalPixels,
    similarity: similarity.toFixed(4),
  });

  return { similarity, diffPixels, totalPixels, notableDifferences };
}

// ---------------------------------------------------------------------------
// Onboarding structural checks (from capture PNG — no live DOM)
// ---------------------------------------------------------------------------

/**
 * Extracts average RGB from a rectangular region of a PNG.
 */
function sampleRegionRgb(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
): { r: number; g: number; b: number } {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  const maxX = Math.min(x + w, png.width);
  const maxY = Math.min(y + h, png.height);

  for (let py = y; py < maxY; py++) {
    for (let px = x; px < maxX; px++) {
      const idx = (py * png.width + px) * 4;
      rSum += png.data[idx];
      gSum += png.data[idx + 1];
      bSum += png.data[idx + 2];
      count++;
    }
  }

  if (count === 0) return { r: 0, g: 0, b: 0 };
  return { r: rSum / count, g: gSum / count, b: bSum / count };
}

/**
 * Checks if a colour is "dark" (luminance < 128).
 */
function isDark(r: number, g: number, b: number): boolean {
  // Relative luminance (sRGB)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 128;
}

function analyzeCapturePng(capturePath: string, stateDef: StateDefinition): string[] {
  const issues: string[] = [];

  if (!fs.existsSync(capturePath)) return issues;

  try {
    const png = loadPng(capturePath);

    // Sample top-left corner (likely background)
    const bgSample = sampleRegionRgb(png, 0, 0, 100, 100);
    const bgLuminance = 0.2126 * bgSample.r + 0.7152 * bgSample.g + 0.0722 * bgSample.b;

    log('info', 'Background sample', {
      state: stateDef.state,
      r: bgSample.r.toFixed(0),
      g: bgSample.g.toFixed(0),
      b: bgSample.b.toFixed(0),
      luminance: bgLuminance.toFixed(1),
    });

    if (stateDef.expectDark && !isDark(bgSample.r, bgSample.g, bgSample.b)) {
      issues.push(
        `Background appears light (luminance ${bgLuminance.toFixed(1)}) — dark theme may not be applied for shell state`,
      );
    }

    // Check for near-white background that would indicate no theme applied
    if (bgSample.r > 240 && bgSample.g > 240 && bgSample.b > 240) {
      issues.push(
        `Background is near-white (rgb ${bgSample.r.toFixed(0)},${bgSample.g.toFixed(0)},${bgSample.b.toFixed(0)}) — theme CSS may not have loaded`,
      );
    }

    // Check if image is completely blank (all one color — likely crash or blank window)
    const centerSample = sampleRegionRgb(
      png,
      Math.floor(png.width / 4),
      Math.floor(png.height / 4),
      Math.floor(png.width / 2),
      Math.floor(png.height / 2),
    );
    const variance = Math.abs(bgSample.r - centerSample.r) +
                     Math.abs(bgSample.g - centerSample.g) +
                     Math.abs(bgSample.b - centerSample.b);
    if (variance < 5) {
      issues.push(
        `Image appears blank or single-color (corner vs center variance: ${variance.toFixed(1)}) — window may not have rendered`,
      );
    }
  } catch (err) {
    issues.push(`PNG analysis failed: ${(err as Error).message}`);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Live DOM heuristic checks
// ---------------------------------------------------------------------------

async function launchHeadlessForChecks(stateDef: StateDefinition): Promise<{
  electronApp: ElectronApplication;
  page: Page;
  userDataDir: string;
} | null> {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const appPath = path.join(
    MY_APP_ROOT,
    'out',
    `my-app-darwin-${arch}`,
    'my-app.app',
    'Contents',
    'MacOS',
    'my-app',
  );

  if (!fs.existsSync(appPath)) {
    log('warn', 'App executable not found — skipping DOM heuristics', { appPath });
    return null;
  }

  const isOnboarding = stateDef.expectOnboarding;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-qa-diff-'));

  if (!isOnboarding) {
    fs.writeFileSync(
      path.join(userDataDir, 'account.json'),
      JSON.stringify({ agent_name: 'Aria', email: 'aria@test.com', onboarding_complete: true }),
      'utf-8',
    );
  }

  try {
    const electronApp = await electron.launch({
      executablePath: appPath,
      args: [
        path.join(MY_APP_ROOT, '.vite', 'build', 'main.js'),
        `--user-data-dir=${userDataDir}`,
        '--no-sandbox',
        '--disable-gpu',
        '--remote-debugging-port=0',
      ],
      env: {
        ...process.env as Record<string, string>,
        DEV_MODE: '1',
        KEYCHAIN_MOCK: '1',
        POSTHOG_API_KEY: '',
        ...(isOnboarding ? {} : { SKIP_ONBOARDING: '1' }),
      },
      timeout: 20_000,
      cwd: MY_APP_ROOT,
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1_000);

    return { electronApp, page, userDataDir };
  } catch (err) {
    log('warn', 'Failed to launch for DOM heuristics', { error: (err as Error).message });
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

async function teardownHeadless(electronApp: ElectronApplication, userDataDir: string): Promise<void> {
  try { await electronApp.close(); } catch { /* ignore */ }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function runDomHeuristics(page: Page, stateDef: StateDefinition): Promise<HeuristicResult[]> {
  const results: HeuristicResult[] = [];

  // -------------------------------------------------------------------------
  // Check 1: No Inter font in computed styles
  // -------------------------------------------------------------------------
  try {
    const fontFamily: string = await page.evaluate(() => {
      const body = document.body;
      return window.getComputedStyle(body).fontFamily;
    });
    const hasInter = /\binter\b/i.test(fontFamily);
    results.push({
      check: 'no-inter-font',
      passed: !hasInter,
      detail: hasInter
        ? `Inter font detected in body computed style: "${fontFamily}"`
        : `Font family clean — no Inter detected: "${fontFamily}"`,
    });
    log('info', 'Font check', { state: stateDef.state, fontFamily, hasInter });
  } catch (err) {
    results.push({
      check: 'no-inter-font',
      passed: false,
      detail: `Font check failed: ${(err as Error).message}`,
    });
  }

  // -------------------------------------------------------------------------
  // Check 2: No !important in any stylesheet
  // -------------------------------------------------------------------------
  try {
    const importantViolations: string[] = await page.evaluate(() => {
      const violations: string[] = [];
      const sheets = Array.from(document.styleSheets);

      for (const sheet of sheets) {
        try {
          const rules = Array.from(sheet.cssRules ?? []);
          for (const rule of rules) {
            const cssText = rule.cssText ?? '';
            if (/!important/i.test(cssText)) {
              // Extract a short excerpt of the violating rule
              const excerpt = cssText.slice(0, 120).replace(/\s+/g, ' ');
              violations.push(excerpt);
            }
          }
        } catch {
          // Cross-origin sheets will throw — ignore
        }
      }
      return violations;
    });

    const hasImportant = importantViolations.length > 0;
    results.push({
      check: 'no-important-css',
      passed: !hasImportant,
      detail: hasImportant
        ? `${importantViolations.length} !important rule(s) found:\n  ${importantViolations.slice(0, 3).join('\n  ')}`
        : 'No !important rules found in stylesheets',
    });
    log('info', 'Important check', { state: stateDef.state, violations: importantViolations.length });
  } catch (err) {
    results.push({
      check: 'no-important-css',
      passed: false,
      detail: `!important check failed: ${(err as Error).message}`,
    });
  }

  // -------------------------------------------------------------------------
  // Check 3: No sparkle glyph (✨) in DOM
  // -------------------------------------------------------------------------
  try {
    const sparkleFound: boolean = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      return bodyText.includes('\u2728');
    });
    results.push({
      check: 'no-sparkle-glyph',
      passed: !sparkleFound,
      detail: sparkleFound
        ? 'Sparkle glyph ✨ found in DOM text — violates CLAUDE.md constraint'
        : 'No sparkle glyph detected in DOM',
    });
    log('info', 'Sparkle check', { state: stateDef.state, sparkleFound });
  } catch (err) {
    results.push({
      check: 'no-sparkle-glyph',
      passed: false,
      detail: `Sparkle check failed: ${(err as Error).message}`,
    });
  }

  // -------------------------------------------------------------------------
  // Check 4: Dark theme applied (html background color check)
  // -------------------------------------------------------------------------
  if (stateDef.expectDark) {
    try {
      const bgColor: string = await page.evaluate(() => {
        const html = document.documentElement;
        return window.getComputedStyle(html).backgroundColor;
      });

      // Parse rgb(r, g, b) or rgba(r, g, b, a)
      const match = bgColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      let darkApplied = false;
      let luminance = 0;
      if (match) {
        const r = parseInt(match[1], 10);
        const g = parseInt(match[2], 10);
        const b = parseInt(match[3], 10);
        luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        darkApplied = luminance < 128;
      }

      results.push({
        check: 'dark-theme-applied',
        passed: darkApplied,
        detail: darkApplied
          ? `Dark theme confirmed (bg: ${bgColor}, luminance: ${luminance.toFixed(1)})`
          : `Dark theme NOT applied — bg color: ${bgColor} (luminance: ${luminance.toFixed(1)})`,
      });
      log('info', 'Dark theme check', { state: stateDef.state, bgColor, luminance: luminance.toFixed(1) });
    } catch (err) {
      results.push({
        check: 'dark-theme-applied',
        passed: false,
        detail: `Dark theme check failed: ${(err as Error).message}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 5: No left-outline emphasis (outline on non-focus elements)
  // -------------------------------------------------------------------------
  try {
    const leftOutlineViolations: string[] = await page.evaluate(() => {
      const violations: string[] = [];
      const allElements = Array.from(document.querySelectorAll('*'));
      for (const el of allElements.slice(0, 500)) {
        // Only check elements that aren't focused
        if (el === document.activeElement) continue;
        const style = window.getComputedStyle(el);
        const outline = style.outlineStyle;
        const outlineWidth = parseFloat(style.outlineWidth ?? '0');
        // Flag solid/auto outlines wider than 0 on non-focused elements
        if (outlineWidth > 0 && outline !== 'none' && outline !== '') {
          const tag = el.tagName.toLowerCase();
          const cls = el.className?.toString().slice(0, 40) ?? '';
          violations.push(`${tag}.${cls}`);
          if (violations.length >= 5) break;
        }
      }
      return violations;
    });

    const hasLeftOutline = leftOutlineViolations.length > 0;
    results.push({
      check: 'no-left-outline',
      passed: !hasLeftOutline,
      detail: hasLeftOutline
        ? `${leftOutlineViolations.length} element(s) with unexpected outline (left-outline signal): ${leftOutlineViolations.join(', ')}`
        : 'No unexpected outline styles detected',
    });
    log('info', 'Left-outline check', { state: stateDef.state, violations: leftOutlineViolations.length });
  } catch (err) {
    results.push({
      check: 'no-left-outline',
      passed: false,
      detail: `Left-outline check failed: ${(err as Error).message}`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Reference image structural checks (for onboarding states)
// ---------------------------------------------------------------------------

function checkOnboardingStructure(capturePath: string, stateName: string): string[] {
  const issues: string[] = [];

  if (!fs.existsSync(capturePath)) return issues;

  try {
    const png = loadPng(capturePath);

    // Sample background region for luminance comparisons
    const bgSampleOb = sampleRegionRgb(png, 0, 0, 100, 100);
    const bgLuminance = 0.2126 * bgSampleOb.r + 0.7152 * bgSampleOb.g + 0.0722 * bgSampleOb.b;

    // 1. Image should have reasonable dimensions (not tiny = crash)
    if (png.width < 400 || png.height < 300) {
      issues.push(`Window too small (${png.width}×${png.height}) — may be a crash or minimal window`);
    }

    // Sample top-left corner for background luminance (used in checks below)
    const bgSample = sampleRegionRgb(png, 0, 0, 100, 100);
    const bgLuminance = 0.2126 * bgSample.r + 0.7152 * bgSample.g + 0.0722 * bgSample.b;

    // 2. Sample the step indicator region (top-center, ~50px from top)
    //    Expect a lighter colored region (step dots are colored)
    const stepIndicatorRegion = sampleRegionRgb(
      png,
      Math.floor(png.width * 0.3),
      20,
      Math.floor(png.width * 0.4),
      30,
    );
    const stepLuminance = 0.2126 * stepIndicatorRegion.r + 0.7152 * stepIndicatorRegion.g + 0.0722 * stepIndicatorRegion.b;

    log('info', 'Step indicator region sample', {
      state: stateName,
      r: stepIndicatorRegion.r.toFixed(0),
      g: stepIndicatorRegion.g.toFixed(0),
      b: stepIndicatorRegion.b.toFixed(0),
      luminance: stepLuminance.toFixed(1),
    });

    // Step indicator dots should be visible (not pure black background = they rendered)
    if (stepLuminance < 15) {
      issues.push('Step indicator region is very dark — dots may not be rendering');
    }

    // 3. Right panel should be rendered — sample for non-pure-black pixel values
    const rightPanel = sampleRegionRgb(
      png,
      Math.floor(png.width * 0.6),
      Math.floor(png.height * 0.25),
      Math.floor(png.width * 0.35),
      Math.floor(png.height * 0.5),
    );
    const rightPanelLuminance = 0.2126 * rightPanel.r + 0.7152 * rightPanel.g + 0.0722 * rightPanel.b;
    log('info', 'Right panel region sample', {
      state: stateName,
      luminance: rightPanelLuminance.toFixed(1),
    });

    if (rightPanelLuminance < 5) {
      issues.push('Right panel region is pure black — panel may not be rendering');
    }

    // 4. Left panel should have text content — check for varied pixel values
    const leftPanel = sampleRegionRgb(
      png,
      30,
      Math.floor(png.height * 0.15),
      Math.floor(png.width * 0.45),
      Math.floor(png.height * 0.6),
    );
    const leftLuminance = 0.2126 * leftPanel.r + 0.7152 * leftPanel.g + 0.0722 * leftPanel.b;
    if (leftLuminance < 12 && bgLuminance < 30) {
      issues.push(
        `Left panel content area very dark (luminance ${leftLuminance.toFixed(1)}) — text/pills may not be rendering`,
      );
    }

    if (stateName.includes('scopes')) {
      // 5. For scopes modal: center of image should be significantly brighter (modal overlay)
      const modalCenter = sampleRegionRgb(
        png,
        Math.floor(png.width * 0.25),
        Math.floor(png.height * 0.2),
        Math.floor(png.width * 0.5),
        Math.floor(png.height * 0.6),
      );
      const modalLuminance = 0.2126 * modalCenter.r + 0.7152 * modalCenter.g + 0.0722 * modalCenter.b;
      const modalContrast = Math.abs(modalLuminance - bgLuminance);
      log('info', 'Scopes modal region', { modalLuminance: modalLuminance.toFixed(1), contrast: modalContrast.toFixed(1) });
      if (modalContrast < 10) {
        issues.push(
          `Google scopes modal center has low contrast vs background (${modalContrast.toFixed(1)}) — modal overlay may not be visible`,
        );
      }
    }
  } catch (err) {
    issues.push(`Structural PNG analysis failed: ${(err as Error).message}`);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main diff runner
// ---------------------------------------------------------------------------

async function runDiff(): Promise<void> {
  log('info', 'Starting visual QA diff', { states: STATE_DEFINITIONS.length });

  // Read capture manifest if available
  const manifestPath = path.join(CAPTURES_DIR, 'manifest.json');
  let manifest: Array<{ state: string; captured_at: string; success: boolean }> = [];
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      log('info', 'Loaded capture manifest', { entries: manifest.length });
    } catch (err) {
      log('warn', 'Failed to parse capture manifest', { error: (err as Error).message });
    }
  } else {
    log('warn', 'No capture manifest found — proceeding without capture metadata');
  }

  const results: StateReport[] = [];
  let heuristicViolationsFound = 0;
  let referencePassCount = 0;
  let referenceFailCount = 0;

  for (const stateDef of STATE_DEFINITIONS) {
    log('info', `Processing state: ${stateDef.state}`);

    const capturePath = path.join(CAPTURES_DIR, stateDef.capture_file);
    const referencePath = stateDef.reference_file
      ? path.join(REFERENCES_DIR, stateDef.reference_file)
      : null;

    const manifestEntry = manifest.find((m) => m.state === stateDef.state);
    const capturedAt = manifestEntry?.captured_at ?? null;

    const notableDifferences: string[] = [];
    const heuristicChecks: HeuristicResult[] = [];
    let similarity: number | null = null;
    let diffPixels: number | null = null;
    let totalPixels: number | null = null;

    const hasCaptureFile = fs.existsSync(capturePath);
    const hasReferenceFile = referencePath !== null && fs.existsSync(referencePath);

    // -----------------------------------------------------------------------
    // PNG-based analysis (always run if capture exists)
    // -----------------------------------------------------------------------
    if (hasCaptureFile) {
      const pngIssues = analyzeCapturePng(capturePath, stateDef);
      notableDifferences.push(...pngIssues);

      if (stateDef.expectOnboarding) {
        const structuralIssues = checkOnboardingStructure(capturePath, stateDef.state);
        notableDifferences.push(...structuralIssues);
      }
    } else {
      notableDifferences.push(`Capture file not found: ${capturePath} — run capture.spec.ts first`);
    }

    // -----------------------------------------------------------------------
    // Reference image comparison (pixelmatch)
    // -----------------------------------------------------------------------
    if (hasCaptureFile && hasReferenceFile) {
      try {
        const diffResult = compareImages(capturePath, referencePath!);
        similarity = diffResult.similarity;
        diffPixels = diffResult.diffPixels;
        totalPixels = diffResult.totalPixels;
        notableDifferences.push(...diffResult.notableDifferences);

        if (similarity >= MIN_ACCEPTABLE_SIMILARITY) {
          referencePassCount++;
        } else {
          referenceFailCount++;
        }
      } catch (err) {
        notableDifferences.push(`Image comparison failed: ${(err as Error).message}`);
        referenceFailCount++;
      }
    } else if (referencePath !== null && !hasReferenceFile) {
      notableDifferences.push(`Reference image not found: ${referencePath}`);
    }

    // -----------------------------------------------------------------------
    // DOM heuristic checks (launch app for this state)
    // -----------------------------------------------------------------------
    const heuristicHandle = await launchHeadlessForChecks(stateDef);
    if (heuristicHandle) {
      const { electronApp, page, userDataDir } = heuristicHandle;
      try {
        const checks = await runDomHeuristics(page, stateDef);
        heuristicChecks.push(...checks);

        const failedChecks = checks.filter((c) => !c.passed);
        if (failedChecks.length > 0) {
          heuristicViolationsFound += failedChecks.length;
          for (const failed of failedChecks) {
            notableDifferences.push(`HEURISTIC FAIL [${failed.check}]: ${failed.detail}`);
          }
        }
      } finally {
        await teardownHeadless(electronApp, userDataDir);
      }
    } else {
      heuristicChecks.push({
        check: 'dom-heuristics',
        passed: false,
        detail: 'App could not be launched for DOM heuristic checks — built artifact may be missing',
      });
    }

    results.push({
      state: stateDef.state,
      capture_path: capturePath,
      reference_path: referencePath,
      has_reference: hasReferenceFile,
      structural_similarity_score: similarity,
      pixel_diff_count: diffPixels,
      total_pixels: totalPixels,
      notable_differences: notableDifferences,
      heuristic_checks: heuristicChecks,
      captured_at: capturedAt,
      ...(manifestEntry?.success === false ? { error: 'Capture reported failure in manifest' } : {}),
    });

    log('info', `State processed: ${stateDef.state}`, {
      hasCaptureFile,
      hasReferenceFile,
      similarity: similarity?.toFixed(4) ?? 'n/a',
      heuristicChecks: heuristicChecks.length,
      notableDifferences: notableDifferences.length,
    });
  }

  // -------------------------------------------------------------------------
  // Write report
  // -------------------------------------------------------------------------

  const statesWithCaptures = results.filter((r) =>
    fs.existsSync(r.capture_path),
  ).length;

  const report: VisualQAReport = {
    generated_at: new Date().toISOString(),
    total_states: STATE_DEFINITIONS.length,
    states_with_captures: statesWithCaptures,
    states_without_captures: STATE_DEFINITIONS.length - statesWithCaptures,
    states_with_references: results.filter((r) => r.has_reference).length,
    reference_comparisons_passed: referencePassCount,
    reference_comparisons_failed: referenceFailCount,
    heuristic_violations_found: heuristicViolationsFound,
    results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  log('info', 'Visual QA report written', { path: REPORT_PATH });

  process.stdout.write(`\n[diff] Report: ${REPORT_PATH}\n`);
  process.stdout.write(`[diff] States: ${statesWithCaptures}/${STATE_DEFINITIONS.length} captured\n`);
  process.stdout.write(`[diff] Reference comparisons: ${referencePassCount} passed, ${referenceFailCount} failed\n`);
  process.stdout.write(`[diff] Heuristic violations: ${heuristicViolationsFound}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runDiff().catch((err: Error) => {
  log('error', 'diff runner crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
