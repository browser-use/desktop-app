#!/usr/bin/env node
/**
 * build-renderer.ts — Programmatic Vite build helper for renderer bundles.
 *
 * Usage:
 *   npx tsx scripts/build-renderer.ts <name>
 *   node --loader ts-node/esm scripts/build-renderer.ts <name>
 *
 * Where <name> is one of: shell | pill | onboarding | settings
 *
 * Finds the corresponding vite.<name>.config.ts and invokes the Vite
 * programmatic build API to produce output that the Electron main process
 * expects at runtime:
 *
 *   .vite/renderer/<name>/<name>.html
 *
 * This is the "Option B" safe approach: it does NOT modify vite.<name>.config.ts
 * to set root: — that would violate the path invariant rules documented in
 * memory: project_electron_forge_vite_paths.md.
 *
 * Instead, we:
 *   1. Load the config file as-is via Vite's configFile option.
 *   2. Override only the build.outDir to point at .vite/renderer/<name>/.
 *   3. Pass logLevel: 'warn' so the output stays terse.
 *
 * The build is idempotent: if the output HTML already exists and --force is
 * not passed, it exits 0 immediately.
 *
 * Exit codes:
 *   0  — success (built or already present)
 *   1  — unknown renderer name or build failure
 */

import path from 'node:path';
import fs from 'node:fs';
import { build as viteBuild } from 'vite';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MY_APP_ROOT = path.resolve(__dirname, '..');

const VALID_NAMES = ['shell', 'pill', 'onboarding', 'settings'] as const;
type RendererName = (typeof VALID_NAMES)[number];

// Map each renderer to the HTML file that main expects at runtime.
// Pattern: .vite/renderer/<name>/<htmlFile>
const HTML_FILENAME: Record<RendererName, string> = {
  shell:      'shell.html',
  pill:       'pill.html',
  onboarding: 'onboarding.html',
  settings:   'settings.html',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(`[build-renderer] ${msg}\n`);
}

function logError(msg: string): void {
  process.stderr.write(`[build-renderer] ERROR: ${msg}\n`);
}

function isValidName(name: string): name is RendererName {
  return (VALID_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const forceFlag = args.includes('--force');
  const nameArg = args.find((a) => !a.startsWith('--'));

  if (!nameArg || !isValidName(nameArg)) {
    logError(`Usage: build-renderer.ts <name> [--force]`);
    logError(`  name must be one of: ${VALID_NAMES.join(' | ')}`);
    logError(`  Got: ${nameArg ?? '(none)'}`);
    process.exit(1);
  }

  const name = nameArg;
  const configFile = path.join(MY_APP_ROOT, `vite.${name}.config.ts`);
  const outDir = path.join(MY_APP_ROOT, '.vite', 'renderer', name);
  const htmlFile = HTML_FILENAME[name];
  const outputHtmlPath = path.join(outDir, htmlFile);

  log(`Renderer:   ${name}`);
  log(`Config:     ${configFile}`);
  log(`Output dir: ${outDir}`);
  log(`HTML path:  ${outputHtmlPath}`);

  // Validate config file exists
  if (!fs.existsSync(configFile)) {
    logError(`Config file not found: ${configFile}`);
    process.exit(1);
  }

  // Idempotency check — skip if already built
  if (!forceFlag && fs.existsSync(outputHtmlPath)) {
    log(`Already built — skipping (pass --force to rebuild)`);
    log(`Output: ${outputHtmlPath}`);
    process.exit(0);
  }

  log(`Building ${name} renderer…`);

  try {
    await viteBuild({
      configFile,
      logLevel: 'warn',
      build: {
        outDir,
        // Emit an empty dir if needed; don't clean other renderers
        emptyOutDir: true,
      },
    });

    if (!fs.existsSync(outputHtmlPath)) {
      logError(`Build completed but expected output not found: ${outputHtmlPath}`);
      logError(`Check that vite.${name}.config.ts rollupOptions.input points to ${htmlFile}`);
      process.exit(1);
    }

    log(`Build complete: ${outputHtmlPath}`);
    process.exit(0);
  } catch (err) {
    logError(`Vite build failed: ${(err as Error).message}`);
    logError((err as Error).stack ?? '');
    process.exit(1);
  }
}

void main();
