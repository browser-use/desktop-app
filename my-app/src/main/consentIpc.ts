import { ipcMain, shell } from 'electron';
import { getConsent, setTelemetryConsent, type ConsentState } from './consent';
import { mainLogger } from './logger';

const HANDLERS = [
  'consent:get',
  'consent:set-telemetry',
  'settings:open-system-notifications',
] as const;

export function registerConsentHandlers(): void {
  ipcMain.handle('consent:get', (): ConsentState => getConsent());

  ipcMain.handle('consent:set-telemetry', (_evt, optedIn: unknown): ConsentState => {
    if (typeof optedIn !== 'boolean') {
      throw new TypeError('consent:set-telemetry expects a boolean');
    }
    return setTelemetryConsent(optedIn);
  });

  // macOS-only deep link to the Notifications pane. On other platforms we
  // open the general Settings app (Windows) or do nothing (Linux). The UI
  // should hide/label this button per-platform; here we just do our best.
  ipcMain.handle('settings:open-system-notifications', async () => {
    try {
      if (process.platform === 'darwin') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
      } else if (process.platform === 'win32') {
        await shell.openExternal('ms-settings:notifications');
      }
      return { ok: true };
    } catch (err) {
      mainLogger.error('settings.open-system-notifications-failed', {
        error: (err as Error).message,
      });
      return { ok: false, error: (err as Error).message };
    }
  });
}

export function unregisterConsentHandlers(): void {
  for (const ch of HANDLERS) ipcMain.removeHandler(ch);
}
