/**
 * DevToolsBridge — attaches Electron's debugger API to a tab's webContents
 * and proxies CDP commands/events between the DevTools renderer and the page.
 */

import { BrowserWindow, WebContents } from 'electron';
import { mainLogger } from '../logger';

const CDP_VERSION = '1.3';

export class DevToolsBridge {
  private attached = false;
  private enabledDomains = new Set<string>();
  private targetWebContents: WebContents | null = null;
  private devtoolsWindow: BrowserWindow | null = null;
  private messageHandler: ((_event: Electron.Event, method: string, params: unknown) => void) | null = null;
  private detachHandler: ((_event: Electron.Event, reason: string) => void) | null = null;

  attach(webContents: WebContents, devtoolsWindow: BrowserWindow): void {
    if (this.attached && this.targetWebContents === webContents) {
      mainLogger.debug('DevToolsBridge.attach — already attached to same target');
      return;
    }

    this.detach();

    this.targetWebContents = webContents;
    this.devtoolsWindow = devtoolsWindow;

    try {
      webContents.debugger.attach(CDP_VERSION);
      this.attached = true;
      mainLogger.info('DevToolsBridge.attach', { targetId: webContents.id });
    } catch (err) {
      mainLogger.error('DevToolsBridge.attach.failed', {
        error: (err as Error).message,
        targetId: webContents.id,
      });
      this.targetWebContents = null;
      this.devtoolsWindow = null;
      return;
    }

    this.messageHandler = (_event, method, params) => {
      if (this.devtoolsWindow && !this.devtoolsWindow.isDestroyed()) {
        this.devtoolsWindow.webContents.send('devtools:cdp-event', method, params);
      }
    };
    this.detachHandler = (_event, reason) => {
      mainLogger.info('DevToolsBridge.detach.event', { reason });
      this.attached = false;
      this.enabledDomains.clear();
      this.targetWebContents = null;
    };

    webContents.debugger.on('message', this.messageHandler);
    webContents.debugger.on('detach', this.detachHandler);
  }

  detach(): void {
    if (!this.attached || !this.targetWebContents) return;

    if (this.messageHandler) {
      this.targetWebContents.debugger.removeListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.detachHandler) {
      this.targetWebContents.debugger.removeListener('detach', this.detachHandler);
      this.detachHandler = null;
    }

    try {
      this.targetWebContents.debugger.detach();
      mainLogger.info('DevToolsBridge.detach');
    } catch (err) {
      mainLogger.warn('DevToolsBridge.detach.failed', {
        error: (err as Error).message,
      });
    }

    this.attached = false;
    this.enabledDomains.clear();
    this.targetWebContents = null;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.attached || !this.targetWebContents) {
      mainLogger.warn('DevToolsBridge.send — not attached', { method });
      throw new Error('DevTools bridge not attached to any target');
    }

    mainLogger.debug('DevToolsBridge.send', { method, hasParams: !!params });

    try {
      const result = await this.targetWebContents.debugger.sendCommand(method, params);

      const domain = method.split('.')[0];
      if (method.endsWith('.enable') && domain) {
        this.enabledDomains.add(domain);
      } else if (method.endsWith('.disable') && domain) {
        this.enabledDomains.delete(domain);
      }

      return result;
    } catch (err) {
      mainLogger.error('DevToolsBridge.send.failed', {
        method,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  isAttached(): boolean {
    return this.attached;
  }

  getEnabledDomains(): string[] {
    return Array.from(this.enabledDomains);
  }
}
