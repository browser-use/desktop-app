import { Notification, app, BrowserWindow } from 'electron';
import { mainLogger } from './logger';

// Keep notification references alive — otherwise GC kills click handlers.
const active = new Set<Notification>();

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

  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    mainLogger.debug('notifications.suppressed_focused', { sessionId: opts.sessionId });
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
