/**
 * mv3/ManifestV3Runtime.ts — Orchestrates all MV3 subsystems.
 *
 * Coordinates service worker lifecycle, declarativeNetRequest engine,
 * action API bridge, manifest validation, and activeTab enforcement.
 */

import { session } from 'electron';
import { mainLogger } from '../../logger';
import { MV3_LOG_PREFIX, MANIFEST_VERSION_3 } from './constants';
import { ServiceWorkerManager } from './ServiceWorkerManager';
import { DeclarativeNetRequestEngine } from './DeclarativeNetRequestEngine';
import { ActionAPIBridge } from './ActionAPIBridge';
import { ManifestValidator } from './ManifestValidator';
import type { ActionState } from './ActionAPIBridge';
import type { ManifestValidationResult, ParsedManifest } from './ManifestValidator';
import type { ServiceWorkerInfo, WorkerState } from './ServiceWorkerManager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MV3ExtensionInfo {
  extensionId: string;
  manifestVersion: number;
  isServiceWorker: boolean;
  hasDeclarativeNetRequest: boolean;
  hasActionApi: boolean;
  hasActiveTab: boolean;
  workerState: WorkerState | null;
  actionState: ActionState | null;
  validationResult: ManifestValidationResult;
}

// ---------------------------------------------------------------------------
// ActiveTab tracking
// ---------------------------------------------------------------------------

interface ActiveTabGrant {
  extensionId: string;
  tabId: number;
  url: string;
  grantedAt: number;
}

// ---------------------------------------------------------------------------
// ManifestV3Runtime
// ---------------------------------------------------------------------------

const LOG = MV3_LOG_PREFIX;

export class ManifestV3Runtime {
  readonly serviceWorkers: ServiceWorkerManager;
  readonly dnr: DeclarativeNetRequestEngine;
  readonly actionApi: ActionAPIBridge;
  readonly validator: ManifestValidator;

  private mv3Extensions = new Map<string, MV3ExtensionInfo>();
  private activeTabGrants = new Map<string, ActiveTabGrant>();
  private interceptorInstalled = false;

  constructor() {
    this.serviceWorkers = new ServiceWorkerManager();
    this.dnr = new DeclarativeNetRequestEngine();
    this.actionApi = new ActionAPIBridge();
    this.validator = new ManifestValidator();

    mainLogger.info(`${LOG}.init`);
  }

  // -------------------------------------------------------------------------
  // Extension lifecycle
  // -------------------------------------------------------------------------

  onExtensionLoaded(extensionId: string, extensionPath: string): MV3ExtensionInfo | null {
    mainLogger.info(`${LOG}.onExtensionLoaded`, { extensionId, extensionPath });

    const validation = this.validator.validateManifest(extensionPath);

    if (validation.manifestVersion !== MANIFEST_VERSION_3) {
      mainLogger.info(`${LOG}.onExtensionLoaded.notMV3`, {
        extensionId,
        version: validation.manifestVersion,
      });
      return null;
    }

    if (!validation.valid) {
      mainLogger.warn(`${LOG}.onExtensionLoaded.validationFailed`, {
        extensionId,
        errors: validation.errors,
      });
    }

    if (validation.warnings.length > 0) {
      mainLogger.warn(`${LOG}.onExtensionLoaded.warnings`, {
        extensionId,
        warnings: validation.warnings,
      });
    }

    const manifest = this.validator.parseManifest(extensionPath);

    if (validation.isServiceWorker) {
      this.serviceWorkers.registerWorker(extensionId);
      void this.serviceWorkers.startWorker(extensionId);
    }

    if (validation.hasDeclarativeNetRequest) {
      this.dnr.loadStaticRules(extensionId, extensionPath);
      if (!this.interceptorInstalled) {
        this.dnr.installRequestInterceptor();
        this.interceptorInstalled = true;
      }
    }

    if (validation.hasActionApi && manifest) {
      this.actionApi.registerExtension(extensionId, manifest as unknown as Record<string, unknown>);
    }

    const info: MV3ExtensionInfo = {
      extensionId,
      manifestVersion: validation.manifestVersion,
      isServiceWorker: validation.isServiceWorker,
      hasDeclarativeNetRequest: validation.hasDeclarativeNetRequest,
      hasActionApi: validation.hasActionApi,
      hasActiveTab: validation.hasActiveTab,
      workerState: this.serviceWorkers.getWorkerState(extensionId),
      actionState: this.actionApi.getState(extensionId),
      validationResult: validation,
    };

    this.mv3Extensions.set(extensionId, info);

    mainLogger.info(`${LOG}.onExtensionLoaded.ok`, {
      extensionId,
      isServiceWorker: info.isServiceWorker,
      hasDeclarativeNetRequest: info.hasDeclarativeNetRequest,
      hasActionApi: info.hasActionApi,
      hasActiveTab: info.hasActiveTab,
    });

    return info;
  }

  onExtensionUnloaded(extensionId: string): void {
    mainLogger.info(`${LOG}.onExtensionUnloaded`, { extensionId });

    this.serviceWorkers.unregisterWorker(extensionId);
    this.dnr.unloadExtension(extensionId);
    this.actionApi.unregisterExtension(extensionId);
    this.mv3Extensions.delete(extensionId);
    this.revokeActiveTab(extensionId);
  }

  // -------------------------------------------------------------------------
  // activeTab enforcement
  // -------------------------------------------------------------------------

  grantActiveTab(extensionId: string, tabId: number, url: string): void {
    const info = this.mv3Extensions.get(extensionId);
    if (!info?.hasActiveTab) {
      mainLogger.warn(`${LOG}.grantActiveTab.noActiveTabPermission`, { extensionId });
      return;
    }

    const grant: ActiveTabGrant = {
      extensionId,
      tabId,
      url,
      grantedAt: Date.now(),
    };

    const key = `${extensionId}:${tabId}`;
    this.activeTabGrants.set(key, grant);

    mainLogger.info(`${LOG}.grantActiveTab`, {
      extensionId,
      tabId,
      url: url.slice(0, 80),
    });
  }

  revokeActiveTab(extensionId: string, tabId?: number): void {
    if (tabId !== undefined) {
      const key = `${extensionId}:${tabId}`;
      this.activeTabGrants.delete(key);
      mainLogger.info(`${LOG}.revokeActiveTab`, { extensionId, tabId });
    } else {
      for (const key of [...this.activeTabGrants.keys()]) {
        if (key.startsWith(`${extensionId}:`)) {
          this.activeTabGrants.delete(key);
        }
      }
      mainLogger.info(`${LOG}.revokeActiveTab.allTabs`, { extensionId });
    }
  }

  hasActiveTabAccess(extensionId: string, tabId: number): boolean {
    const key = `${extensionId}:${tabId}`;
    return this.activeTabGrants.has(key);
  }

  onTabNavigated(tabId: number): void {
    for (const [key, grant] of this.activeTabGrants) {
      if (grant.tabId === tabId) {
        mainLogger.info(`${LOG}.onTabNavigated.revokeGrant`, {
          extensionId: grant.extensionId,
          tabId,
        });
        this.activeTabGrants.delete(key);
      }
    }

    this.actionApi.clearTabOverrides(tabId);
  }

  onTabClosed(tabId: number): void {
    for (const [key, grant] of this.activeTabGrants) {
      if (grant.tabId === tabId) {
        this.activeTabGrants.delete(key);
      }
    }

    this.actionApi.clearTabOverrides(tabId);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  isMV3Extension(extensionId: string): boolean {
    return this.mv3Extensions.has(extensionId);
  }

  getExtensionInfo(extensionId: string): MV3ExtensionInfo | null {
    const info = this.mv3Extensions.get(extensionId);
    if (!info) return null;

    return {
      ...info,
      workerState: this.serviceWorkers.getWorkerState(extensionId),
      actionState: this.actionApi.getState(extensionId),
    };
  }

  getManifestVersion(extensionPath: string): number {
    const validation = this.validator.validateManifest(extensionPath);
    return validation.manifestVersion;
  }

  getAllMV3Extensions(): MV3ExtensionInfo[] {
    return Array.from(this.mv3Extensions.values()).map((info) => ({
      ...info,
      workerState: this.serviceWorkers.getWorkerState(info.extensionId),
      actionState: this.actionApi.getState(info.extensionId),
    }));
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  dispose(): void {
    mainLogger.info(`${LOG}.dispose`, { extensionCount: this.mv3Extensions.size });

    this.serviceWorkers.dispose();
    this.dnr.dispose();
    this.actionApi.dispose();
    this.mv3Extensions.clear();
    this.activeTabGrants.clear();
  }
}
