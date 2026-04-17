/**
 * Engine selector for pill submissions.
 *
 * Two engines exist side-by-side during migration:
 *   - 'python-daemon'  — legacy Python agent daemon (daemon/*.ts)
 *   - 'hl-inprocess'   — new TS port in this directory
 *
 * The default is 'hl-inprocess'. Users can flip via settings; we keep the
 * daemon code around so a regression can be recovered by flag-flip.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { mainLogger } from '../logger';

export type EngineId = 'python-daemon' | 'hl-inprocess';

const PREFS_FILE = 'preferences.json';
const DEFAULT_ENGINE: EngineId = 'hl-inprocess';

function prefsPath(): string {
  try { return path.join(app.getPath('userData'), PREFS_FILE); } catch { return `/tmp/${PREFS_FILE}`; }
}

export function getEngine(): EngineId {
  if (process.env.HL_ENGINE === 'python-daemon' || process.env.HL_ENGINE === 'hl-inprocess') {
    return process.env.HL_ENGINE;
  }
  try {
    const raw = fs.readFileSync(prefsPath(), 'utf-8');
    const prefs = JSON.parse(raw) as { engine?: string };
    if (prefs.engine === 'python-daemon' || prefs.engine === 'hl-inprocess') return prefs.engine;
  } catch { /* fall through */ }
  return DEFAULT_ENGINE;
}

export function setEngine(engine: EngineId): void {
  const p = prefsPath();
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { /* new file */ }
  prefs.engine = engine;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(prefs, null, 2), 'utf-8');
  mainLogger.info('hl.engine.set', { engine });
}
