import { ipcMain } from 'electron';
import { captureEvent } from './telemetry';
import { mainLogger } from './logger';

/**
 * IPC bridge for renderer-side product events. Renderers call
 * `window.*API.capture(name, props)` which lands here and forwards to the
 * main-process PostHog emitter (which handles consent gating, install id, etc).
 *
 * Property values are coerced to primitives server-side to prevent accidental
 * leakage of object graphs containing PII.
 */

const HANDLERS = ['telemetry:capture'] as const;

const MAX_EVENT_NAME = 64;
const MAX_PROP_KEYS = 32;
const MAX_STRING_VALUE = 500;

function sanitizeProps(input: unknown): Record<string, string | number | boolean> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_PROP_KEYS) break;
    if (typeof k !== 'string' || k.length === 0 || k.length > 64) continue;
    if (typeof v === 'string') {
      out[k] = v.length > MAX_STRING_VALUE ? v.slice(0, MAX_STRING_VALUE) : v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    }
    // objects/arrays/null are dropped intentionally
    count++;
  }
  return out;
}

export function registerTelemetryHandlers(): void {
  ipcMain.handle('telemetry:capture', (_evt, name: unknown, props: unknown) => {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_EVENT_NAME) {
      mainLogger.warn('telemetry.capture.invalid-name', { name: String(name).slice(0, 80) });
      return;
    }
    captureEvent(name, sanitizeProps(props));
  });
}

export function unregisterTelemetryHandlers(): void {
  for (const ch of HANDLERS) ipcMain.removeHandler(ch);
}
