/**
 * Track B — Pill hotkey (Cmd+K) registration.
 *
 * Cmd+K is handled via webContents.before-input-event on every tab and
 * on the shell window (see TabManager.attachGlobalKeyHandlers and the
 * inline handler in index.ts openShellAndWire). The Menu accelerator
 * (Agent → Toggle Agent Pill, Cmd+K) is a fallback for the rare case
 * where no WebContentsView has focus. Global shortcuts are NOT used —
 * they steal focus system-wide. These functions are retained as no-ops
 * so existing callers in index.ts keep compiling.
 */

import { globalShortcut } from 'electron';
import { mainLogger } from './logger';

// ---------------------------------------------------------------------------
// Scoped logger shim — delegates to mainLogger with component prefix
// ---------------------------------------------------------------------------

const log = {
  debug: (comp: string, ctx: object) => mainLogger.debug(comp, ctx as Record<string, unknown>),
  info:  (comp: string, ctx: object) => mainLogger.info(comp, ctx as Record<string, unknown>),
  warn:  (comp: string, ctx: object) => mainLogger.warn(comp, ctx as Record<string, unknown>),
  error: (comp: string, ctx: object) => mainLogger.error(comp, ctx as Record<string, unknown>),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOTKEY_PILL_TOGGLE = 'CommandOrControl+K' as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the Cmd+K global hotkey.
 *
 * @param toggleCallback - called every time Cmd+K fires; toggles pill show/hide
 * @returns true if registration succeeded; false if the shortcut was already
 *          claimed by another app or if Electron rejected the registration
 */
export function registerHotkeys(_toggleCallback: () => void): boolean {
  log.info('hotkeys.registerHotkeys', {
    message: 'Cmd+K is now an app-local Menu accelerator — no globalShortcut registered',
    hotkey: HOTKEY_PILL_TOGGLE,
  });
  return true;
}

/**
 * Unregister the Cmd+K global hotkey.
 * Should be called in the app `will-quit` event handler.
 */
export function unregisterHotkeys(): void {
  log.info('hotkeys.unregisterHotkeys', {
    message: 'Cmd+K is app-local (Menu accelerator) — nothing to unregister',
    hotkey: HOTKEY_PILL_TOGGLE,
  });
}
