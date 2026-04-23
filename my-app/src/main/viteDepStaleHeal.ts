/**
 * Shared auto-heal for Vite "504 Outdated Optimize Dep" races in dev mode.
 *
 * Why this exists as a single module: `session.webRequest.onCompleted` is a
 * single-listener API per session. If two windows each register their own
 * listener on the default session, the second registration silently
 * overwrites the first. The hub and logs windows share the default session,
 * so they must both route through one listener.
 *
 * When a dep 504 is seen, find the matching webContents (via its id) and
 * reload it, up to a per-window cap with a debounce so a genuine failure
 * can't loop.
 */

import { BrowserWindow, session } from 'electron';
import { mainLogger } from './logger';

const MAX_RELOADS_PER_WINDOW = 8;
const RELOAD_DEBOUNCE_MS = 600;

interface WindowState {
  win: BrowserWindow;
  label: string;
  reloads: number;
  pending: ReturnType<typeof setTimeout> | null;
}

// Keyed by origin (e.g. "http://localhost:5173") since each Vite dev server
// runs on its own port. `details.webContentsId` turned out to be undefined
// in practice for Vite dep requests, so we dispatch by matching the 504's
// URL origin to the registered window's current URL origin.
const byOrigin = new Map<string, WindowState>();
let listenerInstalled = false;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode !== 504) return;
    if (!details.url.includes('/node_modules/.vite/deps/')) return;
    const origin = originOf(details.url);
    if (!origin) return;
    const state = byOrigin.get(origin);
    if (!state) return;
    if (state.reloads >= MAX_RELOADS_PER_WINDOW) return;
    if (state.pending) return;
    state.reloads += 1;
    mainLogger.warn('viteDepStaleHeal.reload', {
      window: state.label,
      url: details.url,
      attempt: state.reloads,
      cap: MAX_RELOADS_PER_WINDOW,
    });
    state.pending = setTimeout(() => {
      state.pending = null;
      if (!state.win.isDestroyed()) state.win.webContents.reload();
    }, RELOAD_DEBOUNCE_MS);
  });
}

export function registerViteDepStaleHeal(win: BrowserWindow, label: string): void {
  installListener();
  // Defer origin capture until the URL is known — loadURL may fire after
  // register. did-start-navigation is the first point where getURL() is set.
  const capture = (): void => {
    const url = win.webContents.getURL();
    const origin = originOf(url);
    if (!origin) return;
    byOrigin.set(origin, { win, label, reloads: 0, pending: null });
    mainLogger.debug('viteDepStaleHeal.register', { window: label, origin });
  };
  if (win.webContents.getURL()) capture();
  else win.webContents.once('did-start-navigation', capture);
  win.on('closed', () => {
    for (const [origin, state] of byOrigin) {
      if (state.win === win) {
        if (state.pending) clearTimeout(state.pending);
        byOrigin.delete(origin);
      }
    }
  });
}
