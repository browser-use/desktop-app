import { app, globalShortcut } from 'electron';
import fs from 'fs';
import path from 'path';
import { mainLogger } from './logger';
import { DEFAULT_GLOBAL_CMDBAR_ACCELERATOR } from '../shared/hotkeys';

const log = {
  info: (comp: string, ctx: object) => mainLogger.info(comp, ctx as Record<string, unknown>),
  warn: (comp: string, ctx: object) => mainLogger.warn(comp, ctx as Record<string, unknown>),
};

const STORE_FILE = 'hotkeys.json';

interface HotkeyStore {
  globalCmdbar: string;
}

let currentAccelerator: string = DEFAULT_GLOBAL_CMDBAR_ACCELERATOR;
let currentCallback: (() => void) | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function loadStore(): HotkeyStore {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HotkeyStore>;
    if (typeof parsed.globalCmdbar === 'string' && parsed.globalCmdbar.length > 0) {
      return { globalCmdbar: parsed.globalCmdbar };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      log.warn('hotkeys.load.failed', { error: (err as Error).message });
    }
  }
  return { globalCmdbar: DEFAULT_GLOBAL_CMDBAR_ACCELERATOR };
}

function saveStore(store: HotkeyStore): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    log.warn('hotkeys.save.failed', { error: (err as Error).message });
  }
}

export function getGlobalCmdbarAccelerator(): string {
  return currentAccelerator;
}

export function registerHotkeys(callback: () => void): boolean {
  const { globalCmdbar } = loadStore();
  currentAccelerator = globalCmdbar;
  currentCallback = callback;
  log.info('hotkeys.register', { hotkey: currentAccelerator });

  const ok = globalShortcut.register(currentAccelerator, () => {
    log.info('hotkeys.fired', { hotkey: currentAccelerator });
    callback();
  });

  if (!ok) {
    log.warn('hotkeys.register.failed', {
      message: 'Failed to register global shortcut',
      hotkey: currentAccelerator,
    });
  }

  return ok;
}

export function setGlobalCmdbarAccelerator(accel: string): { ok: boolean; accelerator: string } {
  if (!accel || typeof accel !== 'string') {
    return { ok: false, accelerator: currentAccelerator };
  }
  if (accel === currentAccelerator) {
    return { ok: true, accelerator: currentAccelerator };
  }
  const callback = currentCallback;
  if (!callback) {
    log.warn('hotkeys.set.noCallback', { hotkey: accel });
    return { ok: false, accelerator: currentAccelerator };
  }

  log.info('hotkeys.set', { from: currentAccelerator, to: accel });
  globalShortcut.unregister(currentAccelerator);

  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => {
      log.info('hotkeys.fired', { hotkey: accel });
      callback();
    });
  } catch (err) {
    log.warn('hotkeys.set.threw', { error: (err as Error).message, hotkey: accel });
    ok = false;
  }

  if (!ok) {
    log.warn('hotkeys.set.failed', { hotkey: accel });
    // Rollback: try to re-register the previous accelerator so we don't leave
    // the user without any global trigger.
    globalShortcut.register(currentAccelerator, () => {
      log.info('hotkeys.fired', { hotkey: currentAccelerator });
      callback();
    });
    return { ok: false, accelerator: currentAccelerator };
  }

  currentAccelerator = accel;
  saveStore({ globalCmdbar: accel });
  return { ok: true, accelerator: currentAccelerator };
}

export function unregisterHotkeys(): void {
  log.info('hotkeys.unregister', { hotkey: currentAccelerator });
  globalShortcut.unregister(currentAccelerator);
  currentCallback = null;
}
