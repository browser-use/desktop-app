import { app, globalShortcut } from 'electron';
import fs from 'fs';
import path from 'path';
import { mainLogger } from './logger';
import { defaultGlobalCmdbarAccelerator } from '../shared/hotkeys';

const log = {
  info: (comp: string, ctx: object) => mainLogger.info(comp, ctx as Record<string, unknown>),
  warn: (comp: string, ctx: object) => mainLogger.warn(comp, ctx as Record<string, unknown>),
};

const STORE_FILE = 'hotkeys.json';

interface HotkeyStore {
  globalCmdbar: string;
}

let currentAccelerator: string = defaultGlobalCmdbarAccelerator(process.platform);
let currentCallback: (() => void) | null = null;
let registeredAccelerator: string | null = null;

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
  return { globalCmdbar: defaultGlobalCmdbarAccelerator(process.platform) };
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

function isRegistered(accel: string): boolean {
  return globalShortcut.isRegistered(accel);
}

function tryRegister(accel: string, callback: () => void): boolean {
  try {
    const ok = globalShortcut.register(accel, () => {
      log.info('hotkeys.fired', { hotkey: accel });
      callback();
    });
    return ok && isRegistered(accel);
  } catch (err) {
    log.warn('hotkeys.register.threw', { error: (err as Error).message, hotkey: accel });
    return false;
  }
}

function unregisterRegistered(): void {
  if (!registeredAccelerator) return;
  globalShortcut.unregister(registeredAccelerator);
  registeredAccelerator = null;
}

function activeRegisteredAccelerator(): string | null {
  if (!registeredAccelerator) return null;
  return isRegistered(registeredAccelerator) ? registeredAccelerator : null;
}

function tryRestore(accel: string, callback: () => void): boolean {
  const ok = tryRegister(accel, callback);
  if (!ok) return false;
  currentAccelerator = accel;
  registeredAccelerator = accel;
  saveStore({ globalCmdbar: accel });
  return true;
}

export function registerHotkeys(callback: () => void): boolean {
  const { globalCmdbar } = loadStore();
  currentAccelerator = globalCmdbar;
  currentCallback = callback;
  log.info('hotkeys.register', { hotkey: currentAccelerator });

  unregisterRegistered();
  const ok = tryRegister(currentAccelerator, callback);

  if (!ok) {
    log.warn('hotkeys.register.failed', {
      message: 'Failed to register global shortcut',
      hotkey: currentAccelerator,
    });
    registeredAccelerator = null;
    const fallbackAccelerator = defaultGlobalCmdbarAccelerator(process.platform);
    const failedAccelerator = currentAccelerator;
    if (fallbackAccelerator !== failedAccelerator && tryRestore(fallbackAccelerator, callback)) {
      log.warn('hotkeys.register.fallback', {
        from: failedAccelerator,
        to: fallbackAccelerator,
      });
      return true;
    }
    return false;
  }

  registeredAccelerator = currentAccelerator;
  return true;
}

export function setGlobalCmdbarAccelerator(accel: string): { ok: boolean; accelerator: string } {
  if (!accel || typeof accel !== 'string') {
    return { ok: false, accelerator: currentAccelerator };
  }
  const callback = currentCallback;
  if (!callback) {
    currentAccelerator = accel;
    saveStore({ globalCmdbar: accel });
    log.info('hotkeys.set.deferred', { hotkey: accel });
    return { ok: true, accelerator: currentAccelerator };
  }
  if (accel === currentAccelerator && activeRegisteredAccelerator() === accel) {
    saveStore({ globalCmdbar: currentAccelerator });
    return { ok: true, accelerator: currentAccelerator };
  }

  const previousAccelerator = currentAccelerator;
  const previousRegisteredAccelerator = activeRegisteredAccelerator();

  log.info('hotkeys.set', { from: previousAccelerator, to: accel });
  unregisterRegistered();

  const ok = tryRegister(accel, callback);
  if (ok) {
    currentAccelerator = accel;
    registeredAccelerator = accel;
    saveStore({ globalCmdbar: accel });
    return { ok: true, accelerator: currentAccelerator };
  }

  log.warn('hotkeys.set.failed', { hotkey: accel });
  currentAccelerator = previousAccelerator;
  registeredAccelerator = null;

  if (previousRegisteredAccelerator && tryRestore(previousRegisteredAccelerator, callback)) {
    return { ok: false, accelerator: currentAccelerator };
  }
  if (previousRegisteredAccelerator) {
    log.warn('hotkeys.rollback.failed', { hotkey: previousRegisteredAccelerator });
  }

  const fallbackAccelerator = defaultGlobalCmdbarAccelerator(process.platform);
  if (fallbackAccelerator !== accel && tryRestore(fallbackAccelerator, callback)) {
    log.warn('hotkeys.set.fallback', {
      failed: accel,
      fallback: fallbackAccelerator,
    });
    return { ok: false, accelerator: currentAccelerator };
  }

  return { ok: false, accelerator: currentAccelerator };
}

export function unregisterHotkeys(): void {
  log.info('hotkeys.unregister', { hotkey: registeredAccelerator ?? currentAccelerator });
  unregisterRegistered();
  currentCallback = null;
}
