/**
 * mv3/ManifestValidator.ts — Validates MV3 manifest constraints.
 *
 * Enforces: no remotely-hosted code, bundled JS only, activeTab requires
 * explicit user invocation, and service_worker background type.
 */

import fs from 'node:fs';
import path from 'node:path';
import { mainLogger } from '../../logger';
import { MV3_LOG_PREFIX, MANIFEST_VERSION_3, BLOCKED_REMOTE_SCHEMES } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestValidationResult {
  valid: boolean;
  manifestVersion: number;
  errors: string[];
  warnings: string[];
  isServiceWorker: boolean;
  hasDeclarativeNetRequest: boolean;
  hasActionApi: boolean;
  hasActiveTab: boolean;
  usesBlockingWebRequest: boolean;
}

export interface ParsedManifest {
  manifest_version: number;
  name: string;
  version: string;
  description?: string;
  background?: {
    service_worker?: string;
    scripts?: string[];
    page?: string;
    type?: string;
  };
  action?: Record<string, unknown>;
  browser_action?: Record<string, unknown>;
  page_action?: Record<string, unknown>;
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  content_scripts?: Array<{
    matches: string[];
    js?: string[];
    css?: string[];
    run_at?: string;
  }>;
  declarative_net_request?: {
    rule_resources?: Array<{ id: string; enabled: boolean; path: string }>;
  };
  content_security_policy?: string | { extension_pages?: string; sandbox?: string };
  icons?: Record<string, string>;
  web_accessible_resources?: Array<{
    resources: string[];
    matches?: string[];
    extension_ids?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// ManifestValidator
// ---------------------------------------------------------------------------

const LOG = `${MV3_LOG_PREFIX}.ManifestValidator`;

export class ManifestValidator {
  validateManifest(extensionPath: string): ManifestValidationResult {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    const result: ManifestValidationResult = {
      valid: true,
      manifestVersion: 2,
      errors: [],
      warnings: [],
      isServiceWorker: false,
      hasDeclarativeNetRequest: false,
      hasActionApi: false,
      hasActiveTab: false,
      usesBlockingWebRequest: false,
    };

    if (!fs.existsSync(manifestPath)) {
      result.valid = false;
      result.errors.push('manifest.json not found');
      return result;
    }

    let manifest: ParsedManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ParsedManifest;
    } catch (err) {
      result.valid = false;
      result.errors.push(`Failed to parse manifest.json: ${(err as Error).message}`);
      return result;
    }

    result.manifestVersion = manifest.manifest_version ?? 2;

    if (result.manifestVersion !== MANIFEST_VERSION_3) {
      mainLogger.info(`${LOG}.validateManifest.notMV3`, {
        extensionPath,
        version: result.manifestVersion,
      });
      return result;
    }

    mainLogger.info(`${LOG}.validateManifest.mv3Detected`, { extensionPath });

    this.validateBackground(manifest, result);
    this.validateNoRemoteCode(manifest, extensionPath, result);
    this.validatePermissions(manifest, result);
    this.validateActionApi(manifest, result);
    this.validateDeclarativeNetRequest(manifest, result);

    mainLogger.info(`${LOG}.validateManifest.complete`, {
      extensionPath,
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      isServiceWorker: result.isServiceWorker,
      hasDeclarativeNetRequest: result.hasDeclarativeNetRequest,
      hasActionApi: result.hasActionApi,
      hasActiveTab: result.hasActiveTab,
    });

    return result;
  }

  parseManifest(extensionPath: string): ParsedManifest | null {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ParsedManifest;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Validation checks
  // -------------------------------------------------------------------------

  private validateBackground(manifest: ParsedManifest, result: ManifestValidationResult): void {
    if (!manifest.background) {
      mainLogger.info(`${LOG}.validateBackground.noBackground`);
      return;
    }

    if (manifest.background.service_worker) {
      result.isServiceWorker = true;
      mainLogger.info(`${LOG}.validateBackground.serviceWorker`, {
        script: manifest.background.service_worker,
      });
    }

    if (manifest.background.scripts) {
      result.errors.push(
        'MV3 does not support background.scripts — use background.service_worker instead',
      );
      result.valid = false;
    }

    if (manifest.background.page) {
      result.errors.push(
        'MV3 does not support background.page — use background.service_worker instead',
      );
      result.valid = false;
    }
  }

  private validateNoRemoteCode(
    manifest: ParsedManifest,
    extensionPath: string,
    result: ManifestValidationResult,
  ): void {
    if (manifest.content_scripts) {
      for (const cs of manifest.content_scripts) {
        if (cs.js) {
          for (const jsFile of cs.js) {
            if (this.isRemoteUrl(jsFile)) {
              result.errors.push(
                `Remotely-hosted code not allowed in MV3: content_scripts.js contains "${jsFile}"`,
              );
              result.valid = false;
            } else {
              const fullPath = path.join(extensionPath, jsFile);
              if (!fs.existsSync(fullPath)) {
                result.warnings.push(`Content script file not found: ${jsFile}`);
              }
            }
          }
        }
      }
    }

    if (manifest.background?.service_worker) {
      if (this.isRemoteUrl(manifest.background.service_worker)) {
        result.errors.push(
          `Remotely-hosted service worker not allowed in MV3: "${manifest.background.service_worker}"`,
        );
        result.valid = false;
      }
    }

    const csp = manifest.content_security_policy;
    if (typeof csp === 'string') {
      if (this.cspAllowsRemoteCode(csp)) {
        result.warnings.push(
          'Content security policy may allow remote code execution',
        );
      }
    } else if (csp?.extension_pages) {
      if (this.cspAllowsRemoteCode(csp.extension_pages)) {
        result.warnings.push(
          'Content security policy for extension_pages may allow remote code execution',
        );
      }
    }
  }

  private validatePermissions(manifest: ParsedManifest, result: ManifestValidationResult): void {
    const permissions = manifest.permissions ?? [];

    result.hasActiveTab = permissions.includes('activeTab');
    if (result.hasActiveTab) {
      mainLogger.info(`${LOG}.validatePermissions.activeTabDetected`);
    }

    if (permissions.includes('webRequestBlocking')) {
      result.usesBlockingWebRequest = true;
      result.errors.push(
        'webRequestBlocking is not available in MV3 — use declarativeNetRequest instead',
      );
      result.valid = false;
    }

    if (permissions.includes('webRequest')) {
      result.warnings.push(
        'webRequest in MV3 is observational only — use declarativeNetRequest for request modification',
      );
    }
  }

  private validateActionApi(manifest: ParsedManifest, result: ManifestValidationResult): void {
    if (manifest.action) {
      result.hasActionApi = true;
    }

    if (manifest.browser_action) {
      result.warnings.push(
        'browser_action is deprecated in MV3 — use action instead (will be auto-mapped)',
      );
      result.hasActionApi = true;
    }

    if (manifest.page_action) {
      result.warnings.push(
        'page_action is deprecated in MV3 — use action instead (will be auto-mapped)',
      );
      result.hasActionApi = true;
    }
  }

  private validateDeclarativeNetRequest(
    manifest: ParsedManifest,
    result: ManifestValidationResult,
  ): void {
    if (manifest.declarative_net_request) {
      result.hasDeclarativeNetRequest = true;

      const permissions = manifest.permissions ?? [];
      if (!permissions.includes('declarativeNetRequest') && !permissions.includes('declarativeNetRequestWithHostAccess')) {
        result.warnings.push(
          'declarative_net_request declared in manifest but missing declarativeNetRequest permission',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private isRemoteUrl(value: string): boolean {
    return BLOCKED_REMOTE_SCHEMES.some((scheme) => value.startsWith(scheme));
  }

  private cspAllowsRemoteCode(csp: string): boolean {
    const scriptSrc = csp.match(/script-src\s+([^;]+)/i);
    if (!scriptSrc) return false;

    const directives = scriptSrc[1].split(/\s+/);
    return directives.some((d) => {
      if (d === "'unsafe-eval'" || d === "'unsafe-inline'") return true;
      if (d.startsWith('http:') || d.startsWith('https:')) return true;
      return false;
    });
  }
}
