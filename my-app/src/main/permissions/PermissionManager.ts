/**
 * PermissionManager — intercepts Electron permission requests from WebContents,
 * checks the PermissionStore for cached decisions, and dispatches prompts to
 * the shell renderer when user input is needed.
 *
 * One-time ("Allow this time") grants are tracked per tab and expire on tab close.
 */

import { BrowserWindow, Session, session, systemPreferences } from 'electron';
import { mainLogger } from '../logger';
import { PermissionStore, PermissionType, PermissionState } from './PermissionStore';

// Map Electron's permission strings to our PermissionType enum
const ELECTRON_PERMISSION_MAP: Record<string, PermissionType> = {
  'media': 'media',
  'mediaKeySystem': 'media',
  'geolocation': 'geolocation',
  'notifications': 'notifications',
  'midi': 'midi',
  'midiSysex': 'midi',
  'pointerLock': 'pointerLock',
  'fullscreen': 'fullscreen',
  'openExternal': 'openExternal',
  'clipboard-read': 'clipboard-read',
  'clipboard-sanitized-write': 'clipboard-sanitized-write',
  'idle-detection': 'idle-detection',
  'sensors': 'sensors',
  'camera': 'camera',
  'microphone': 'microphone',
};

// Permissions that are auto-granted without prompting.
// Sensors auto-grant on desktop (Chrome-parity: granted silently unless blocked).
const AUTO_GRANT: Set<PermissionType> = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'media',
  'pointerLock',
  'sensors',
]);

// How long to wait for a paired camera+mic request before prompting individually (ms)
const MEDIA_COALESCE_WINDOW_MS = 150;

// How many recent notification denials (within 5 min) before enabling quiet UI
const QUIET_UI_DENY_THRESHOLD = 3;

export interface PermissionPromptRequest {
  id: string;
  tabId: string | null;
  origin: string;
  permissionType: PermissionType;
  isMainFrame: boolean;
  combinedTypes?: PermissionType[];
  quietUI?: boolean;
}

export type PermissionDecision = 'allow' | 'allow-once' | 'deny';

interface PendingPrompt {
  request: PermissionPromptRequest;
  resolve: (granted: boolean) => void;
  pairedResolve?: (granted: boolean) => void;
}

interface DeferredMediaRequest {
  origin: string;
  tabId: string | null;
  permissionType: 'camera' | 'microphone';
  isMainFrame: boolean;
  callback: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionManager {
  private store: PermissionStore;
  private getShellWindow: () => BrowserWindow | null;
  private getTabIdForWebContents: (wcId: number) => string | null;
  private pending: Map<string, PendingPrompt> = new Map();
  private sessionGrants: Map<string, Set<string>> = new Map();
  private promptCounter = 0;
  private deferredMedia: Map<string, DeferredMediaRequest> = new Map();
  private recentNotificationDenials: number[] = [];

  constructor(opts: {
    store: PermissionStore;
    getShellWindow: () => BrowserWindow | null;
    getTabIdForWebContents: (wcId: number) => string | null;
  }) {
    this.store = opts.store;
    this.getShellWindow = opts.getShellWindow;
    this.getTabIdForWebContents = opts.getTabIdForWebContents;

    this.attachToSession(session.defaultSession);
    mainLogger.info('PermissionManager.init');
  }

  // ---------------------------------------------------------------------------
  // macOS system-level permission checks
  // ---------------------------------------------------------------------------

  private checkMacOSSystemPermission(permissionType: PermissionType): 'granted' | 'denied' | 'not-applicable' {
    if (process.platform !== 'darwin') return 'not-applicable';

    if (permissionType === 'camera') {
      const status = systemPreferences.getMediaAccessStatus('camera');
      mainLogger.info('PermissionManager.macOS.camera', { status });
      if (status === 'denied' || status === 'restricted') return 'denied';
      return 'granted';
    }

    if (permissionType === 'microphone') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      mainLogger.info('PermissionManager.macOS.microphone', { status });
      if (status === 'denied' || status === 'restricted') return 'denied';
      return 'granted';
    }

    return 'not-applicable';
  }

  // ---------------------------------------------------------------------------
  // Notifications quiet-UI heuristic
  // ---------------------------------------------------------------------------

  private shouldUseQuietUI(origin: string, isMainFrame: boolean): boolean {
    if (!isMainFrame) {
      mainLogger.info('PermissionManager.quietUI.iframe', { origin });
      return true;
    }

    const cutoff = Date.now() - 5 * 60 * 1000;
    this.recentNotificationDenials = this.recentNotificationDenials.filter((t) => t > cutoff);

    if (this.recentNotificationDenials.length >= QUIET_UI_DENY_THRESHOLD) {
      mainLogger.info('PermissionManager.quietUI.manyDenials', {
        origin,
        recentDenials: this.recentNotificationDenials.length,
      });
      return true;
    }

    return false;
  }

  private recordNotificationDenial(): void {
    this.recentNotificationDenials.push(Date.now());
  }

  // ---------------------------------------------------------------------------
  // Camera + Microphone coalescing
  // ---------------------------------------------------------------------------

  private deferredMediaKey(tabId: string | null, origin: string): string {
    return `${tabId ?? 'null'}::${origin}`;
  }

  private handleMediaCoalesce(
    origin: string,
    tabId: string | null,
    permissionType: 'camera' | 'microphone',
    isMainFrame: boolean,
    callback: (granted: boolean) => void,
  ): void {
    const key = this.deferredMediaKey(tabId, origin);
    const existing = this.deferredMedia.get(key);

    if (existing && existing.permissionType !== permissionType) {
      clearTimeout(existing.timer);
      this.deferredMedia.delete(key);

      mainLogger.info('PermissionManager.coalesce.combined', {
        origin,
        tabId,
        types: [existing.permissionType, permissionType],
      });

      const promptId = `perm-${++this.promptCounter}`;
      const request: PermissionPromptRequest = {
        id: promptId,
        tabId,
        origin,
        permissionType: 'camera',
        isMainFrame: isMainFrame && existing.isMainFrame,
        combinedTypes: ['camera', 'microphone'],
      };

      this.pending.set(promptId, {
        request,
        resolve: existing.permissionType === 'camera' ? existing.callback : callback,
        pairedResolve: existing.permissionType === 'camera' ? callback : existing.callback,
      });
      this.sendPromptToRenderer(request);
      return;
    }

    const timer = setTimeout(() => {
      this.deferredMedia.delete(key);
      mainLogger.info('PermissionManager.coalesce.timeout', { origin, tabId, permissionType });
      this.dispatchSinglePrompt(origin, tabId, permissionType, isMainFrame, callback);
    }, MEDIA_COALESCE_WINDOW_MS);

    this.deferredMedia.set(key, { origin, tabId, permissionType, isMainFrame, callback, timer });
  }

  // ---------------------------------------------------------------------------
  // Prompt dispatch
  // ---------------------------------------------------------------------------

  private dispatchSinglePrompt(
    origin: string,
    tabId: string | null,
    permissionType: PermissionType,
    isMainFrame: boolean,
    callback: (granted: boolean) => void,
  ): void {
    const promptId = `perm-${++this.promptCounter}`;
    const request: PermissionPromptRequest = {
      id: promptId,
      tabId,
      origin,
      permissionType,
      isMainFrame,
    };

    if (permissionType === 'notifications') {
      request.quietUI = this.shouldUseQuietUI(origin, isMainFrame);
    }

    this.pending.set(promptId, { request, resolve: callback });
    this.sendPromptToRenderer(request);
  }

  // ---------------------------------------------------------------------------
  // Electron session handlers
  // ---------------------------------------------------------------------------

  private attachToSession(ses: Session): void {
    ses.setPermissionRequestHandler((webContents, electronPermission, callback, details) => {
      const origin = this.extractOrigin(details?.requestingUrl ?? webContents.getURL());
      const permissionType = ELECTRON_PERMISSION_MAP[electronPermission] ?? 'unknown';
      const wcId = webContents.id;
      const tabId = this.getTabIdForWebContents(wcId);
      const isMainFrame = details?.isMainFrame ?? true;

      mainLogger.info('PermissionManager.request', {
        origin,
        electronPermission,
        permissionType,
        tabId,
        wcId,
        isMainFrame,
      });

      if (AUTO_GRANT.has(permissionType)) {
        mainLogger.debug('PermissionManager.autoGrant', { origin, permissionType });
        callback(true);
        return;
      }

      // macOS Privacy & Security denials override any in-app grant
      const osCheck = this.checkMacOSSystemPermission(permissionType);
      if (osCheck === 'denied') {
        mainLogger.warn('PermissionManager.macOS.systemDenied', { origin, permissionType });
        callback(false);
        return;
      }

      if (this.hasSessionGrant(tabId, origin, permissionType)) {
        mainLogger.info('PermissionManager.sessionGrant', { origin, permissionType, tabId });
        callback(true);
        return;
      }

      const stored = this.store.getSitePermission(origin, permissionType);
      if (stored === 'allow') {
        mainLogger.info('PermissionManager.storedAllow', { origin, permissionType });
        callback(true);
        return;
      }
      if (stored === 'deny') {
        mainLogger.info('PermissionManager.storedDeny', { origin, permissionType });
        callback(false);
        return;
      }

      // Coalesce camera+mic into a single combined prompt when getUserMedia requests both
      if (permissionType === 'camera' || permissionType === 'microphone') {
        this.handleMediaCoalesce(origin, tabId, permissionType, isMainFrame, callback);
        return;
      }

      this.dispatchSinglePrompt(origin, tabId, permissionType, isMainFrame, callback);
    });

    ses.setPermissionCheckHandler((_webContents, electronPermission, requestingOrigin) => {
      const permissionType = ELECTRON_PERMISSION_MAP[electronPermission] ?? 'unknown';
      if (AUTO_GRANT.has(permissionType)) return true;

      // macOS system denials override stored grants
      const osCheck = this.checkMacOSSystemPermission(permissionType);
      if (osCheck === 'denied') return false;

      const origin = this.extractOrigin(requestingOrigin);
      const stored = this.store.getSitePermission(origin, permissionType);
      return stored === 'allow';
    });
  }

  private sendPromptToRenderer(request: PermissionPromptRequest): void {
    const win = this.getShellWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      mainLogger.warn('PermissionManager.sendPrompt.noWindow', { promptId: request.id });
      const p = this.pending.get(request.id);
      if (p) {
        p.resolve(false);
        if (p.pairedResolve) p.pairedResolve(false);
        this.pending.delete(request.id);
      }
      return;
    }

    mainLogger.info('PermissionManager.sendPrompt', {
      promptId: request.id,
      origin: request.origin,
      permissionType: request.permissionType,
      combinedTypes: request.combinedTypes,
      quietUI: request.quietUI,
    });
    win.webContents.send('permission-prompt', request);
  }

  // Called from IPC when the renderer user makes a decision
  handleDecision(promptId: string, decision: PermissionDecision): void {
    const p = this.pending.get(promptId);
    if (!p) {
      mainLogger.warn('PermissionManager.handleDecision.notFound', { promptId });
      return;
    }
    this.pending.delete(promptId);

    const { request } = p;
    const types = request.combinedTypes ?? [request.permissionType];

    mainLogger.info('PermissionManager.handleDecision', {
      promptId,
      decision,
      origin: request.origin,
      permissionType: request.permissionType,
      combinedTypes: request.combinedTypes,
    });

    switch (decision) {
      case 'allow':
        for (const t of types) {
          this.store.setSitePermission(request.origin, t, 'allow');
        }
        p.resolve(true);
        if (p.pairedResolve) p.pairedResolve(true);
        break;
      case 'allow-once':
        if (request.tabId) {
          for (const t of types) {
            this.addSessionGrant(request.tabId, request.origin, t);
          }
        }
        p.resolve(true);
        if (p.pairedResolve) p.pairedResolve(true);
        break;
      case 'deny':
        for (const t of types) {
          this.store.setSitePermission(request.origin, t, 'deny');
        }
        if (types.includes('notifications')) {
          this.recordNotificationDenial();
        }
        p.resolve(false);
        if (p.pairedResolve) p.pairedResolve(false);
        break;
    }
  }

  // Called when a tab is closed — expire one-time grants
  expireSessionGrants(tabId: string): void {
    const count = this.sessionGrants.get(tabId)?.size ?? 0;
    if (count > 0) {
      mainLogger.info('PermissionManager.expireSessionGrants', { tabId, count });
    }
    this.sessionGrants.delete(tabId);

    // Clear deferred media requests for this tab
    for (const [key, deferred] of this.deferredMedia) {
      if (deferred.tabId === tabId) {
        clearTimeout(deferred.timer);
        deferred.callback(false);
        this.deferredMedia.delete(key);
        mainLogger.info('PermissionManager.expireDeferredMedia', { tabId, key });
      }
    }

    // Also dismiss any pending prompts for this tab
    for (const [id, p] of this.pending) {
      if (p.request.tabId === tabId) {
        mainLogger.info('PermissionManager.dismissPending', { promptId: id, tabId });
        p.resolve(false);
        if (p.pairedResolve) p.pairedResolve(false);
        this.pending.delete(id);
        const win = this.getShellWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('permission-prompt-dismiss', id);
        }
      }
    }
  }

  // Dismiss a prompt without a user decision (e.g. navigation away)
  dismissPrompt(promptId: string): void {
    const p = this.pending.get(promptId);
    if (p) {
      mainLogger.info('PermissionManager.dismissPrompt', { promptId });
      p.resolve(false);
      if (p.pairedResolve) p.pairedResolve(false);
      this.pending.delete(promptId);
    }
  }

  private addSessionGrant(tabId: string, origin: string, permissionType: PermissionType): void {
    const key = `${origin}::${permissionType}`;
    let grants = this.sessionGrants.get(tabId);
    if (!grants) {
      grants = new Set();
      this.sessionGrants.set(tabId, grants);
    }
    grants.add(key);
    mainLogger.info('PermissionManager.addSessionGrant', { tabId, origin, permissionType });
  }

  private hasSessionGrant(tabId: string | null, origin: string, permissionType: PermissionType): boolean {
    if (!tabId) return false;
    const key = `${origin}::${permissionType}`;
    return this.sessionGrants.get(tabId)?.has(key) ?? false;
  }

  private extractOrigin(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.origin;
    } catch {
      return url;
    }
  }
}
