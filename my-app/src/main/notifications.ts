import { Notification, app, BrowserWindow } from 'electron';
import { mainLogger } from './logger';

// Keep notification references alive — otherwise GC kills click handlers.
const active = new Set<Notification>();
const RECENT_IN_APP_FOCUS_MS = 5000;
let lastInAppFocusAt = 0;

app.on('browser-window-focus', () => {
  lastInAppFocusAt = Date.now();
});

function hasFocusedAppWindow(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return true;

  return BrowserWindow.getAllWindows().some((win) => (
    !win.isDestroyed() && win.isFocused()
  ));
}

function shouldSuppressInAppNotification(): 'focused-window' | 'recent-focus' | null {
  if (hasFocusedAppWindow()) return 'focused-window';
  if (Date.now() - lastInAppFocusAt < RECENT_IN_APP_FOCUS_MS) return 'recent-focus';
  return null;
}

export function sendSessionNotification(opts: {
  title: string;
  body: string;
  sessionId: string;
  shellWindow: BrowserWindow | null;
}): void {
  if (!Notification.isSupported()) {
    mainLogger.debug('notifications.unsupported');
    return;
  }

  const suppressedReason = shouldSuppressInAppNotification();
  if (suppressedReason) {
    mainLogger.debug('notifications.suppressed_in_app', {
      sessionId: opts.sessionId,
      reason: suppressedReason,
    });
    return;
  }

  const notif = new Notification({
    title: opts.title,
    subtitle: app.name,
    body: opts.body.slice(0, 200),
    sound: 'default',
  });

  active.add(notif);

  notif.on('click', () => {
    mainLogger.info('notifications.clicked', { sessionId: opts.sessionId });
    const win = opts.shellWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('select-session', opts.sessionId);
    }
    active.delete(notif);
  });

  notif.on('close', () => active.delete(notif));
  notif.show();

  mainLogger.info('notifications.sent', {
    sessionId: opts.sessionId,
    title: opts.title,
  });
}
