/**
 * ExtensionManager.ts — manages Chrome extensions via Electron's session API.
 *
 * Handles loading, enabling, disabling, and removing extensions.
 * Persists extension state (enabled/disabled, paths) to a JSON file in userData.
 * Uses session.defaultSession.loadExtension / removeExtension under the hood.
 * Delegates MV3-specific lifecycle to ManifestV3Runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, session, globalShortcut, BrowserWindow } from 'electron';
import { mainLogger } from '../logger';
import { ManifestV3Runtime } from './mv3/ManifestV3Runtime';
import type { MV3ExtensionInfo } from './mv3/ManifestV3Runtime';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Host-access mode.
 *
 * NOTE: Only `all-sites` is currently enforced — that matches Electron's
 * default `session.loadExtension` behavior (extensions run against whatever
 * `host_permissions` their manifest declares). `specific-sites` and
 * `on-click` would require per-origin request filtering and activation
 * gating that Electron does not expose out of the box, so those values
 * are intentionally rejected by the IPC layer and hidden from the UI
 * until real enforcement is wired up. See issue #234.
 */
export type HostAccessMode = 'all-sites' | 'specific-sites' | 'on-click';

/** Modes that the app actually enforces today. Kept in sync with ipc.ts. */
export const SUPPORTED_HOST_ACCESS_MODES: readonly HostAccessMode[] = ['all-sites'] as const;

/**
 * Default host-access mode for newly loaded extensions. Must be a supported
 * mode; defaulting to a non-enforced value would repeat the bug #234 reports.
 */
export const DEFAULT_HOST_ACCESS: HostAccessMode = 'all-sites';

export function isSupportedHostAccess(value: unknown): value is HostAccessMode {
  return typeof value === 'string'
    && (SUPPORTED_HOST_ACCESS_MODES as readonly string[]).includes(value);
}

/** Normalize a persisted/host-access value to one we can actually enforce. */
export function coerceHostAccess(value: unknown): HostAccessMode {
  return isSupportedHostAccess(value) ? value : DEFAULT_HOST_ACCESS;
}

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  enabled: boolean;
  permissions: string[];
  hostPermissions: string[];
  hostAccess: HostAccessMode;
  icons: Record<string, string>;
  manifestVersion: number;
}

export interface ExtensionCommandEntry {
  extensionId: string;
  extensionName: string;
  commandName: string;
  description: string;
  shortcut: string;
  isAction: boolean;
}

interface PersistedState {
  extensions: Array<{
    id: string;
    path: string;
    enabled: boolean;
    hostAccess: string;
  }>;
  developerMode: boolean;
  shortcuts: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE_NAME = 'extensions-state.json';
const LOG_PREFIX = 'ExtensionManager';

// Shortcut key: "<extensionId>/<commandName>"
const SHORTCUT_KEY_SEP = '/';

// ---------------------------------------------------------------------------
// ExtensionManager
// ---------------------------------------------------------------------------

export class ExtensionManager {
  private statePath: string;
  private state: PersistedState;
  readonly mv3Runtime: ManifestV3Runtime;

  /** Tracks accelerator strings currently registered via globalShortcut */
  private registeredShortcuts = new Set<string>();

  /** Optional getter for the shell window — injected after window creation */
  private getShellWindow: (() => BrowserWindow | null) | null = null;

  constructor() {
    this.statePath = path.join(app.getPath('userData'), STATE_FILE_NAME);
    this.state = this.loadState();
    this.mv3Runtime = new ManifestV3Runtime();
    mainLogger.info(`${LOG_PREFIX}.init`, {
      statePath: this.statePath,
      extensionCount: this.state.extensions.length,
      developerMode: this.state.developerMode,
    });
  }

  /**
   * Provide a getter for the shell BrowserWindow so that shortcut handlers
   * can dispatch extension-command events to the renderer.
   * Call this once the shell window has been created.
   */
  setShellWindowGetter(getter: () => BrowserWindow | null): void {
    this.getShellWindow = getter;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private loadState(): PersistedState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedState;
        mainLogger.info(`${LOG_PREFIX}.loadState.ok`, {
          extensionCount: parsed.extensions?.length ?? 0,
        });
        return {
          extensions: Array.isArray(parsed.extensions) ? parsed.extensions : [],
          developerMode: parsed.developerMode === true,
          shortcuts: (parsed.shortcuts && typeof parsed.shortcuts === 'object') ? parsed.shortcuts : {},
        };
      }
    } catch (err) {
      mainLogger.warn(`${LOG_PREFIX}.loadState.failed`, {
        error: (err as Error).message,
      });
    }
    return { extensions: [], developerMode: false, shortcuts: {} };
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
      mainLogger.info(`${LOG_PREFIX}.saveState.ok`, {
        extensionCount: this.state.extensions.length,
      });
    } catch (err) {
      mainLogger.error(`${LOG_PREFIX}.saveState.failed`, {
        error: (err as Error).message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // MV3 lifecycle hook — called after Electron loads an extension
  // -------------------------------------------------------------------------

  private notifyMV3Loaded(extensionId: string, extensionPath: string): MV3ExtensionInfo | null {
    mainLogger.info(`${LOG_PREFIX}.notifyMV3Loaded`, { extensionId, extensionPath });
    const info = this.mv3Runtime.onExtensionLoaded(extensionId, extensionPath);
    if (info) {
      mainLogger.info(`${LOG_PREFIX}.notifyMV3Loaded.mv3Active`, {
        extensionId,
        isServiceWorker: info.isServiceWorker,
        hasDeclarativeNetRequest: info.hasDeclarativeNetRequest,
        hasActionApi: info.hasActionApi,
        hasActiveTab: info.hasActiveTab,
      });
    }
    return info;
  }

  private notifyMV3Unloaded(extensionId: string): void {
    if (this.mv3Runtime.isMV3Extension(extensionId)) {
      mainLogger.info(`${LOG_PREFIX}.notifyMV3Unloaded`, { extensionId });
      this.mv3Runtime.onExtensionUnloaded(extensionId);
    }
  }

  // -------------------------------------------------------------------------
  // Startup: load all enabled extensions into the session
  // -------------------------------------------------------------------------

  async loadAllEnabled(): Promise<void> {
    mainLogger.info(`${LOG_PREFIX}.loadAllEnabled`, {
      total: this.state.extensions.length,
    });

    for (const record of this.state.extensions) {
      if (!record.enabled) {
        mainLogger.info(`${LOG_PREFIX}.loadAllEnabled.skip`, {
          id: record.id,
          reason: 'disabled',
        });
        continue;
      }

      if (!fs.existsSync(record.path)) {
        mainLogger.warn(`${LOG_PREFIX}.loadAllEnabled.pathMissing`, {
          id: record.id,
          path: record.path,
        });
        continue;
      }

      try {
        const ext = await session.defaultSession.loadExtension(record.path, {
          allowFileAccess: true,
        });
        record.id = ext.id;
        mainLogger.info(`${LOG_PREFIX}.loadAllEnabled.loaded`, {
          id: ext.id,
          name: ext.name,
        });
        this.notifyMV3Loaded(ext.id, record.path);
      } catch (err) {
        mainLogger.error(`${LOG_PREFIX}.loadAllEnabled.loadFailed`, {
          id: record.id,
          path: record.path,
          error: (err as Error).message,
        });
      }
    }

    this.saveState();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  listExtensions(): ExtensionRecord[] {
    const loaded = session.defaultSession.getAllExtensions();
    const loadedMap = new Map(loaded.map((e) => [e.id, e]));

    const results: ExtensionRecord[] = [];

    for (const record of this.state.extensions) {
      const live = loadedMap.get(record.id);
      const manifest = live?.manifest as Record<string, unknown> | undefined;
      const manifestVersion = (manifest?.manifest_version as number) ?? 2;

      results.push({
        id: record.id,
        name: live?.name ?? (manifest?.name as string) ?? 'Unknown',
        version: live?.version ?? (manifest?.version as string) ?? '0.0.0',
        description: (manifest?.description as string) ?? '',
        path: record.path,
        enabled: record.enabled,
        permissions: (manifest?.permissions as string[]) ?? [],
        hostPermissions: (manifest?.host_permissions as string[]) ?? [],
        // Coerce any legacy/unsupported persisted value (e.g. on-click, specific-sites)
        // to the only mode we actually enforce today. See issue #234.
        hostAccess: coerceHostAccess(record.hostAccess),
        icons: this.extractIcons(manifest, record.path),
        manifestVersion,
      });
    }

    mainLogger.info(`${LOG_PREFIX}.listExtensions`, { count: results.length });
    return results;
  }

  async loadUnpacked(extensionPath: string): Promise<ExtensionRecord> {
    mainLogger.info(`${LOG_PREFIX}.loadUnpacked`, { path: extensionPath });

    const resolvedPath = path.resolve(extensionPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Extension path does not exist: ${resolvedPath}`);
    }

    const manifestPath = path.join(resolvedPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No manifest.json found at: ${resolvedPath}`);
    }

    const ext = await session.defaultSession.loadExtension(resolvedPath, {
      allowFileAccess: true,
    });

    const existing = this.state.extensions.find((e) => e.path === resolvedPath);
    if (existing) {
      existing.id = ext.id;
      existing.enabled = true;
    } else {
      this.state.extensions.push({
        id: ext.id,
        path: resolvedPath,
        enabled: true,
        // Default to the only mode we actually enforce. See issue #234.
        hostAccess: DEFAULT_HOST_ACCESS,
      });
    }

    this.saveState();
    this.notifyMV3Loaded(ext.id, resolvedPath);

    const manifest = ext.manifest as Record<string, unknown>;
    const record: ExtensionRecord = {
      id: ext.id,
      name: ext.name,
      version: ext.version ?? (manifest?.version as string) ?? '0.0.0',
      description: (manifest?.description as string) ?? '',
      path: resolvedPath,
      enabled: true,
      permissions: (manifest?.permissions as string[]) ?? [],
      hostPermissions: (manifest?.host_permissions as string[]) ?? [],
      hostAccess: DEFAULT_HOST_ACCESS,
      icons: this.extractIcons(manifest, resolvedPath),
      manifestVersion: (manifest?.manifest_version as number) ?? 2,
    };

    mainLogger.info(`${LOG_PREFIX}.loadUnpacked.ok`, {
      id: ext.id,
      name: ext.name,
    });

    return record;
  }

  async enableExtension(id: string): Promise<void> {
    mainLogger.info(`${LOG_PREFIX}.enableExtension`, { id });

    const record = this.state.extensions.find((e) => e.id === id);
    if (!record) throw new Error(`Extension not found: ${id}`);

    if (!fs.existsSync(record.path)) {
      throw new Error(`Extension path missing: ${record.path}`);
    }

    await session.defaultSession.loadExtension(record.path, {
      allowFileAccess: true,
    });

    record.enabled = true;
    this.saveState();
    this.notifyMV3Loaded(id, record.path);
    mainLogger.info(`${LOG_PREFIX}.enableExtension.ok`, { id });
  }

  disableExtension(id: string): void {
    mainLogger.info(`${LOG_PREFIX}.disableExtension`, { id });

    const record = this.state.extensions.find((e) => e.id === id);
    if (!record) throw new Error(`Extension not found: ${id}`);

    this.notifyMV3Unloaded(id);

    try {
      session.defaultSession.removeExtension(id);
    } catch (err) {
      mainLogger.warn(`${LOG_PREFIX}.disableExtension.removeFailed`, {
        id,
        error: (err as Error).message,
      });
    }

    record.enabled = false;
    this.saveState();
    mainLogger.info(`${LOG_PREFIX}.disableExtension.ok`, { id });
  }

  removeExtension(id: string): void {
    mainLogger.info(`${LOG_PREFIX}.removeExtension`, { id });

    this.notifyMV3Unloaded(id);

    try {
      session.defaultSession.removeExtension(id);
    } catch (err) {
      mainLogger.warn(`${LOG_PREFIX}.removeExtension.sessionRemoveFailed`, {
        id,
        error: (err as Error).message,
      });
    }

    this.state.extensions = this.state.extensions.filter((e) => e.id !== id);
    // Clean up persisted shortcuts for removed extension
    for (const key of Object.keys(this.state.shortcuts)) {
      if (key.startsWith(`${id}${SHORTCUT_KEY_SEP}`)) {
        delete this.state.shortcuts[key];
      }
    }
    this.saveState();
    mainLogger.info(`${LOG_PREFIX}.removeExtension.ok`, { id });
  }

  async updateExtension(id: string): Promise<void> {
    mainLogger.info(`${LOG_PREFIX}.updateExtension`, { id });

    const record = this.state.extensions.find((e) => e.id === id);
    if (!record) throw new Error(`Extension not found: ${id}`);

    this.notifyMV3Unloaded(id);

    try {
      session.defaultSession.removeExtension(id);
    } catch {
      // may not be loaded
    }

    await session.defaultSession.loadExtension(record.path, {
      allowFileAccess: true,
    });

    this.notifyMV3Loaded(id, record.path);
    mainLogger.info(`${LOG_PREFIX}.updateExtension.ok`, { id });
  }

  setHostAccess(id: string, hostAccess: HostAccessMode): void {
    mainLogger.info(`${LOG_PREFIX}.setHostAccess`, { id, hostAccess });

    const record = this.state.extensions.find((e) => e.id === id);
    if (!record) throw new Error(`Extension not found: ${id}`);

    // Only accept modes we can actually enforce at runtime. Accepting a
    // value we will never enforce is the bug issue #234 flags.
    if (!isSupportedHostAccess(hostAccess)) {
      throw new Error(
        `hostAccess '${hostAccess}' is not supported yet. Supported modes: ${SUPPORTED_HOST_ACCESS_MODES.join(', ')}`,
      );
    }

    record.hostAccess = hostAccess;
    this.saveState();
    mainLogger.info(`${LOG_PREFIX}.setHostAccess.ok`, { id, hostAccess });
  }

  getDeveloperMode(): boolean {
    return this.state.developerMode;
  }

  setDeveloperMode(enabled: boolean): void {
    mainLogger.info(`${LOG_PREFIX}.setDeveloperMode`, { enabled });
    this.state.developerMode = enabled;
    this.saveState();
  }

  getExtensionDetails(id: string): ExtensionRecord | null {
    const all = this.listExtensions();
    return all.find((e) => e.id === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Extension commands / shortcuts
  // -------------------------------------------------------------------------

  listAllCommands(): ExtensionCommandEntry[] {
    mainLogger.info(`${LOG_PREFIX}.listAllCommands`);

    const loaded = session.defaultSession.getAllExtensions();
    const results: ExtensionCommandEntry[] = [];

    for (const ext of loaded) {
      const manifest = ext.manifest as Record<string, unknown> | undefined;
      if (!manifest) continue;

      const commands = manifest.commands as Record<string, unknown> | undefined;
      if (!commands) continue;

      const extName = ext.name ?? (manifest.name as string) ?? 'Unknown';

      for (const [commandName, rawCmd] of Object.entries(commands)) {
        const cmd = rawCmd as Record<string, unknown>;
        const description = (cmd.description as string) ?? '';
        const isAction = commandName === '_execute_action' || commandName === '_execute_browser_action' || commandName === '_execute_page_action';
        const manifestDefault = (cmd.suggested_key as Record<string, string> | undefined)?.default ?? '';
        const stateKey = `${ext.id}${SHORTCUT_KEY_SEP}${commandName}`;
        const shortcut = this.state.shortcuts[stateKey] ?? manifestDefault;

        results.push({
          extensionId: ext.id,
          extensionName: extName,
          commandName,
          description,
          shortcut,
          isAction,
        });
      }
    }

    mainLogger.info(`${LOG_PREFIX}.listAllCommands.ok`, { count: results.length });
    return results;
  }

  setExtensionShortcut(extensionId: string, commandName: string, shortcut: string): void {
    mainLogger.info(`${LOG_PREFIX}.setExtensionShortcut`, { extensionId, commandName, shortcut });

    const stateKey = `${extensionId}${SHORTCUT_KEY_SEP}${commandName}`;
    if (shortcut === '') {
      delete this.state.shortcuts[stateKey];
    } else {
      this.state.shortcuts[stateKey] = shortcut;
    }
    this.saveState();

    // Re-bind all shortcuts so the new mapping takes effect immediately.
    this.bindShortcuts();

    mainLogger.info(`${LOG_PREFIX}.setExtensionShortcut.ok`, { extensionId, commandName, shortcut });
  }

  /**
   * Register all persisted extension shortcuts as Electron global shortcuts.
   *
   * Each entry in `state.shortcuts` maps "<extensionId>/<commandName>" to an
   * Electron accelerator string (e.g. "Ctrl+Shift+F").  When the shortcut
   * fires we:
   *   - For action-trigger commands: send `extensions:command-triggered` to the
   *     shell window so the renderer can open the extension's action popup.
   *   - For all named commands: send the same message with the command name so
   *     the renderer (or the extension's service worker) can react.
   *
   * Any previously registered extension shortcuts are unregistered first so
   * this method is safe to call multiple times (e.g. after every mutation).
   */
  bindShortcuts(): void {
    mainLogger.info(`${LOG_PREFIX}.bindShortcuts`);

    // 1. Unregister shortcuts from the previous call.
    this.unbindShortcuts();

    // 2. Collect the effective shortcut for every command across loaded extensions.
    //    We use listAllCommands() because it merges manifest defaults with
    //    persisted overrides, and only covers currently-loaded extensions.
    const commands = this.listAllCommands();

    for (const cmd of commands) {
      const { extensionId, commandName, shortcut } = cmd;
      if (!shortcut) continue;

      // Avoid registering the same accelerator twice (e.g. two extensions
      // mapping to the same key — first one wins, which matches Chrome behaviour).
      if (this.registeredShortcuts.has(shortcut)) {
        mainLogger.warn(`${LOG_PREFIX}.bindShortcuts.duplicate`, {
          shortcut,
          extensionId,
          commandName,
          msg: 'Accelerator already registered; skipping',
        });
        continue;
      }

      const registered = globalShortcut.register(shortcut, () => {
        mainLogger.info(`${LOG_PREFIX}.shortcutFired`, { extensionId, commandName, shortcut });
        this.dispatchExtensionCommand(extensionId, commandName);
      });

      if (registered) {
        this.registeredShortcuts.add(shortcut);
        mainLogger.info(`${LOG_PREFIX}.bindShortcuts.registered`, {
          extensionId,
          commandName,
          shortcut,
        });
      } else {
        mainLogger.warn(`${LOG_PREFIX}.bindShortcuts.registerFailed`, {
          extensionId,
          commandName,
          shortcut,
          msg: 'globalShortcut.register returned false — accelerator may be claimed by another app',
        });
      }
    }

    mainLogger.info(`${LOG_PREFIX}.bindShortcuts.ok`, {
      registered: this.registeredShortcuts.size,
    });
  }

  /**
   * Unregister all extension shortcuts that were registered via `bindShortcuts`.
   * Safe to call even if no shortcuts are registered.
   */
  unbindShortcuts(): void {
    mainLogger.info(`${LOG_PREFIX}.unbindShortcuts`, { count: this.registeredShortcuts.size });
    for (const shortcut of this.registeredShortcuts) {
      globalShortcut.unregister(shortcut);
    }
    this.registeredShortcuts.clear();
  }

  /**
   * Dispatch an extension command to the shell renderer.
   *
   * For action-trigger commands (`_execute_action`, `_execute_browser_action`,
   * `_execute_page_action`) the renderer should open the extension's popup.
   * For all other commands the renderer forwards the named command to the
   * extension's content scripts / service worker.
   *
   * The IPC channel `extensions:command-triggered` carries:
   *   { extensionId: string; commandName: string }
   */
  private dispatchExtensionCommand(extensionId: string, commandName: string): void {
    const win = this.getShellWindow?.();
    if (!win || win.isDestroyed()) {
      mainLogger.warn(`${LOG_PREFIX}.dispatchExtensionCommand.noWindow`, {
        extensionId,
        commandName,
      });
      return;
    }

    win.webContents.send('extensions:command-triggered', { extensionId, commandName });
    mainLogger.info(`${LOG_PREFIX}.dispatchExtensionCommand.sent`, { extensionId, commandName });
  }

  // -------------------------------------------------------------------------
  // Tab lifecycle — forward to MV3 runtime for activeTab revocation
  // -------------------------------------------------------------------------

  onTabNavigated(tabId: number): void {
    this.mv3Runtime.onTabNavigated(tabId);
  }

  onTabClosed(tabId: number): void {
    this.mv3Runtime.onTabClosed(tabId);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  dispose(): void {
    mainLogger.info(`${LOG_PREFIX}.dispose`);
    this.unbindShortcuts();
    this.mv3Runtime.dispose();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private extractIcons(
    manifest: Record<string, unknown> | undefined,
    extPath: string,
  ): Record<string, string> {
    const icons: Record<string, string> = {};
    const manifestIcons = manifest?.icons as Record<string, string> | undefined;
    if (manifestIcons) {
      for (const [size, relativePath] of Object.entries(manifestIcons)) {
        const absPath = path.join(extPath, relativePath);
        if (fs.existsSync(absPath)) {
          icons[size] = absPath;
        }
      }
    }
    return icons;
  }
}
