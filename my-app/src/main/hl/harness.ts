/**
 * Harness directory bootstrap: seeds `<userData>/harness/` with the stock
 * `helpers.js` + `SKILL.md`. The agent (Claude Code subprocess) reads and
 * edits these files freely. No tool schema, no dispatcher — helpers.js is
 * a plain Node library that the agent invokes from its own shell tool.
 *
 * Stock content is bundled via Vite's `?raw` import modifier.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { mainLogger } from '../logger';
import type { HlContext } from './context';

import STOCK_HELPERS_JS from './stock/helpers.js?raw';
import STOCK_TOOLS_JSON from './stock/TOOLS.json?raw';
import STOCK_SKILL_MD from './stock/AGENTS.md?raw';

export interface HarnessTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface LoadedHarness {
  tools: HarnessTool[];
  dispatch: (ctx: HlContext, name: string, args: Record<string, unknown>) => Promise<unknown>;
  helpersPath: string;
  toolsPath: string;
}

export function harnessDir(): string {
  return path.join(app.getPath('userData'), 'harness');
}

export function helpersPath(): string { return path.join(harnessDir(), 'helpers.js'); }
export function toolsPath(): string { return path.join(harnessDir(), 'TOOLS.json'); }
export function skillPath(): string { return path.join(harnessDir(), 'AGENTS.md'); }

/**
 * Ensure `<userData>/harness/` exists and contains the stock files.
 * - Writes helpers.js if missing OR if the on-disk version is the legacy
 *   dispatcher-style (didn't export `createContext`).
 * - Writes SKILL.md if missing.
 * - Writes TOOLS.json if missing (retained for the legacy Anthropic-SDK
 *   agent loop; safe to ignore under the claude-subprocess path).
 * User edits to the up-to-date helpers.js / SKILL.md are preserved.
 */
export function bootstrapHarness(): void {
  const dir = harnessDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    mainLogger.error('harness.bootstrap.mkdir.failed', { dir, error: (err as Error).message });
    throw err;
  }

  const hp = helpersPath();
  const needsHelpers = !fs.existsSync(hp) || (() => {
    try { return !fs.readFileSync(hp, 'utf-8').includes('createContext'); }
    catch { return true; }
  })();
  if (needsHelpers) {
    fs.writeFileSync(hp, STOCK_HELPERS_JS as string, 'utf-8');
    mainLogger.info('harness.bootstrap.wroteHelpers', { path: hp, bytes: (STOCK_HELPERS_JS as string).length });
  }

  const sp = skillPath();
  const needsSkill = !fs.existsSync(sp) || (() => {
    try { return !fs.readFileSync(sp, 'utf-8').includes('Uploads and outputs'); }
    catch { return true; }
  })();
  if (needsSkill) {
    fs.writeFileSync(sp, STOCK_SKILL_MD as string, 'utf-8');
    mainLogger.info('harness.bootstrap.wroteSkill', { path: sp, bytes: (STOCK_SKILL_MD as string).length });
  }

  const tp = toolsPath();
  if (!fs.existsSync(tp)) {
    fs.writeFileSync(tp, STOCK_TOOLS_JSON as string, 'utf-8');
    mainLogger.info('harness.bootstrap.wroteTools', { path: tp, bytes: (STOCK_TOOLS_JSON as string).length });
  }
}

/** Restore all stock files. Destroys user edits. */
export function resetHarness(): void {
  fs.writeFileSync(helpersPath(), STOCK_HELPERS_JS as string, 'utf-8');
  fs.writeFileSync(skillPath(), STOCK_SKILL_MD as string, 'utf-8');
  fs.writeFileSync(toolsPath(), STOCK_TOOLS_JSON as string, 'utf-8');
  mainLogger.warn('harness.reset', { helpersPath: helpersPath(), skillPath: skillPath(), toolsPath: toolsPath() });
}

/**
 * LEGACY: used by the Anthropic-SDK agent loop in `agent.ts`. Retained so
 * that file compiles; the claude-subprocess path does not call this.
 * Throws if helpers.js doesn't export a `dispatch` table — which is now
 * the common case with the claude-subprocess helpers.js.
 */
export function loadHarness(): LoadedHarness {
  const hp = helpersPath();
  const tp = toolsPath();

  const rawTools = fs.readFileSync(tp, 'utf-8');
  let tools: HarnessTool[];
  try { tools = JSON.parse(rawTools) as HarnessTool[]; }
  catch (err) { throw new Error(`harness TOOLS.json parse error: ${(err as Error).message}`); }
  if (!Array.isArray(tools)) throw new Error('harness TOOLS.json must be an array');

  const resolved = require.resolve(hp);
  delete require.cache[resolved];

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(resolved) as {
    dispatch?: Record<string, (ctx: HlContext, args: Record<string, unknown>) => Promise<unknown>>;
  };
  const table = mod.dispatch;
  if (!table || typeof table !== 'object') {
    throw new Error('harness helpers.js has no `dispatch` export (claude-subprocess path — this code path is legacy)');
  }

  const dispatch = async (ctx: HlContext, name: string, args: Record<string, unknown>): Promise<unknown> => {
    const fn = table[name];
    if (typeof fn !== 'function') {
      throw new Error(`harness has no dispatcher for tool "${name}"`);
    }
    return fn(ctx, args);
  };

  return { tools, dispatch, helpersPath: hp, toolsPath: tp };
}
