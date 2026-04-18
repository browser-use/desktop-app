/**
 * mv3/DeclarativeNetRequestEngine.ts — declarativeNetRequest rule engine.
 *
 * Replaces blocking webRequest with a declarative rule-based system.
 * Extensions declare static rules in rule JSON files and can add dynamic/session
 * rules at runtime. The engine evaluates rules against each request and returns
 * the matching action (block, redirect, modify headers, etc.).
 */

import fs from 'node:fs';
import path from 'node:path';
import { session } from 'electron';
import { mainLogger } from '../../logger';
import { MV3_LOG_PREFIX } from './constants';
import type { DnrResourceType, DnrActionType } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DnrRuleCondition {
  urlFilter?: string;
  regexFilter?: string;
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  domains?: string[];
  excludedDomains?: string[];
  requestMethods?: string[];
  excludedRequestMethods?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  isUrlFilterCaseSensitive?: boolean;
  tabIds?: number[];
  excludedTabIds?: number[];
}

export interface DnrHeaderOperation {
  header: string;
  operation: 'append' | 'set' | 'remove';
  value?: string;
}

export interface DnrRuleAction {
  type: DnrActionType;
  redirect?: { url?: string; extensionPath?: string; regexSubstitution?: string };
  requestHeaders?: DnrHeaderOperation[];
  responseHeaders?: DnrHeaderOperation[];
}

export interface DnrRule {
  id: number;
  priority?: number;
  condition: DnrRuleCondition;
  action: DnrRuleAction;
}

export interface DnrRuleset {
  extensionId: string;
  rulesetId: string;
  source: 'static' | 'dynamic' | 'session';
  rules: DnrRule[];
  enabled: boolean;
}

export interface DnrMatchResult {
  matched: boolean;
  rule: DnrRule | null;
  ruleset: DnrRuleset | null;
  action: DnrRuleAction | null;
}

// ---------------------------------------------------------------------------
// DeclarativeNetRequestEngine
// ---------------------------------------------------------------------------

const LOG = `${MV3_LOG_PREFIX}.DNR`;

export class DeclarativeNetRequestEngine {
  private rulesets = new Map<string, DnrRuleset[]>();
  private dynamicRules = new Map<string, DnrRule[]>();
  private sessionRules = new Map<string, DnrRule[]>();

  constructor() {
    mainLogger.info(`${LOG}.init`);
  }

  // -------------------------------------------------------------------------
  // Static rules: loaded from extension manifest + rule files
  // -------------------------------------------------------------------------

  loadStaticRules(extensionId: string, extensionPath: string): void {
    mainLogger.info(`${LOG}.loadStaticRules`, { extensionId, extensionPath });

    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      mainLogger.warn(`${LOG}.loadStaticRules.noManifest`, { extensionId });
      return;
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      mainLogger.error(`${LOG}.loadStaticRules.manifestParseFailed`, {
        extensionId,
        error: (err as Error).message,
      });
      return;
    }

    const dnrSection = manifest.declarative_net_request as
      | { rule_resources?: Array<{ id: string; enabled: boolean; path: string }> }
      | undefined;

    if (!dnrSection?.rule_resources) {
      mainLogger.info(`${LOG}.loadStaticRules.noRuleResources`, { extensionId });
      return;
    }

    const rulesets: DnrRuleset[] = [];

    for (const resource of dnrSection.rule_resources) {
      const rulePath = path.join(extensionPath, resource.path);
      if (!fs.existsSync(rulePath)) {
        mainLogger.warn(`${LOG}.loadStaticRules.ruleFileMissing`, {
          extensionId,
          rulesetId: resource.id,
          path: rulePath,
        });
        continue;
      }

      try {
        const rawRules = JSON.parse(fs.readFileSync(rulePath, 'utf-8')) as DnrRule[];
        const ruleset: DnrRuleset = {
          extensionId,
          rulesetId: resource.id,
          source: 'static',
          rules: rawRules,
          enabled: resource.enabled,
        };
        rulesets.push(ruleset);

        mainLogger.info(`${LOG}.loadStaticRules.loaded`, {
          extensionId,
          rulesetId: resource.id,
          ruleCount: rawRules.length,
          enabled: resource.enabled,
        });
      } catch (err) {
        mainLogger.error(`${LOG}.loadStaticRules.ruleParseError`, {
          extensionId,
          rulesetId: resource.id,
          error: (err as Error).message,
        });
      }
    }

    this.rulesets.set(extensionId, rulesets);
    mainLogger.info(`${LOG}.loadStaticRules.complete`, {
      extensionId,
      rulesetCount: rulesets.length,
    });
  }

  // -------------------------------------------------------------------------
  // Dynamic rules: persisted across sessions
  // -------------------------------------------------------------------------

  updateDynamicRules(
    extensionId: string,
    addRules: DnrRule[],
    removeRuleIds: number[],
  ): void {
    mainLogger.info(`${LOG}.updateDynamicRules`, {
      extensionId,
      addCount: addRules.length,
      removeCount: removeRuleIds.length,
    });

    const existing = this.dynamicRules.get(extensionId) ?? [];
    const filtered = existing.filter((r) => !removeRuleIds.includes(r.id));
    const merged = [...filtered, ...addRules];
    this.dynamicRules.set(extensionId, merged);

    mainLogger.info(`${LOG}.updateDynamicRules.ok`, {
      extensionId,
      totalRules: merged.length,
    });
  }

  getDynamicRules(extensionId: string): DnrRule[] {
    return this.dynamicRules.get(extensionId) ?? [];
  }

  // -------------------------------------------------------------------------
  // Session rules: cleared when browser restarts
  // -------------------------------------------------------------------------

  updateSessionRules(
    extensionId: string,
    addRules: DnrRule[],
    removeRuleIds: number[],
  ): void {
    mainLogger.info(`${LOG}.updateSessionRules`, {
      extensionId,
      addCount: addRules.length,
      removeCount: removeRuleIds.length,
    });

    const existing = this.sessionRules.get(extensionId) ?? [];
    const filtered = existing.filter((r) => !removeRuleIds.includes(r.id));
    const merged = [...filtered, ...addRules];
    this.sessionRules.set(extensionId, merged);
  }

  getSessionRules(extensionId: string): DnrRule[] {
    return this.sessionRules.get(extensionId) ?? [];
  }

  // -------------------------------------------------------------------------
  // Rule evaluation
  // -------------------------------------------------------------------------

  evaluateRequest(request: {
    url: string;
    resourceType: DnrResourceType;
    method: string;
    initiatorDomain?: string;
    tabId?: number;
  }): DnrMatchResult {
    let bestMatch: { rule: DnrRule; ruleset: DnrRuleset; priority: number } | null = null;

    for (const [extensionId, rulesets] of this.rulesets) {
      for (const ruleset of rulesets) {
        if (!ruleset.enabled) continue;
        this.findBestMatch(request, ruleset, bestMatch);
      }

      const dynamic = this.dynamicRules.get(extensionId);
      if (dynamic?.length) {
        const dynRuleset: DnrRuleset = {
          extensionId,
          rulesetId: '_dynamic',
          source: 'dynamic',
          rules: dynamic,
          enabled: true,
        };
        this.findBestMatch(request, dynRuleset, bestMatch);
      }

      const sess = this.sessionRules.get(extensionId);
      if (sess?.length) {
        const sessRuleset: DnrRuleset = {
          extensionId,
          rulesetId: '_session',
          source: 'session',
          rules: sess,
          enabled: true,
        };
        this.findBestMatch(request, sessRuleset, bestMatch);
      }
    }

    if (!bestMatch) {
      return { matched: false, rule: null, ruleset: null, action: null };
    }

    return {
      matched: true,
      rule: bestMatch.rule,
      ruleset: bestMatch.ruleset,
      action: bestMatch.rule.action,
    };
  }

  private findBestMatch(
    request: {
      url: string;
      resourceType: DnrResourceType;
      method: string;
      initiatorDomain?: string;
      tabId?: number;
    },
    ruleset: DnrRuleset,
    currentBest: { rule: DnrRule; ruleset: DnrRuleset; priority: number } | null,
  ): { rule: DnrRule; ruleset: DnrRuleset; priority: number } | null {
    for (const rule of ruleset.rules) {
      if (!this.matchesCondition(rule.condition, request)) continue;

      const priority = rule.priority ?? 1;
      if (!currentBest || priority > currentBest.priority) {
        currentBest = { rule, ruleset, priority };
      }
    }
    return currentBest;
  }

  private matchesCondition(
    condition: DnrRuleCondition,
    request: {
      url: string;
      resourceType: DnrResourceType;
      method: string;
      initiatorDomain?: string;
      tabId?: number;
    },
  ): boolean {
    if (condition.resourceTypes?.length) {
      if (!condition.resourceTypes.includes(request.resourceType)) return false;
    }
    if (condition.excludedResourceTypes?.length) {
      if (condition.excludedResourceTypes.includes(request.resourceType)) return false;
    }

    if (condition.requestMethods?.length) {
      if (!condition.requestMethods.includes(request.method.toLowerCase())) return false;
    }
    if (condition.excludedRequestMethods?.length) {
      if (condition.excludedRequestMethods.includes(request.method.toLowerCase())) return false;
    }

    if (condition.tabIds?.length && request.tabId !== undefined) {
      if (!condition.tabIds.includes(request.tabId)) return false;
    }
    if (condition.excludedTabIds?.length && request.tabId !== undefined) {
      if (condition.excludedTabIds.includes(request.tabId)) return false;
    }

    if (condition.urlFilter) {
      if (!this.matchUrlFilter(condition.urlFilter, request.url, condition.isUrlFilterCaseSensitive)) {
        return false;
      }
    }

    if (condition.regexFilter) {
      try {
        const flags = condition.isUrlFilterCaseSensitive ? '' : 'i';
        const regex = new RegExp(condition.regexFilter, flags);
        if (!regex.test(request.url)) return false;
      } catch {
        return false;
      }
    }

    if (condition.domains?.length) {
      const urlDomain = this.extractDomain(request.url);
      if (!condition.domains.some((d) => urlDomain === d || urlDomain.endsWith(`.${d}`))) {
        return false;
      }
    }
    if (condition.excludedDomains?.length) {
      const urlDomain = this.extractDomain(request.url);
      if (condition.excludedDomains.some((d) => urlDomain === d || urlDomain.endsWith(`.${d}`))) {
        return false;
      }
    }

    if (condition.initiatorDomains?.length && request.initiatorDomain) {
      if (!condition.initiatorDomains.some(
        (d) => request.initiatorDomain === d || request.initiatorDomain!.endsWith(`.${d}`),
      )) {
        return false;
      }
    }

    return true;
  }

  private matchUrlFilter(filter: string, url: string, caseSensitive?: boolean): boolean {
    const testUrl = caseSensitive ? url : url.toLowerCase();
    const testFilter = caseSensitive ? filter : filter.toLowerCase();

    let pattern = testFilter;

    if (pattern.startsWith('||')) {
      const domain = this.extractDomain(testUrl);
      const rest = pattern.slice(2);
      return domain.includes(rest) || testUrl.includes(rest);
    }

    if (pattern.startsWith('|')) {
      return testUrl.startsWith(pattern.slice(1));
    }

    if (pattern.endsWith('|')) {
      return testUrl.endsWith(pattern.slice(0, -1));
    }

    const parts = pattern.split('*');
    if (parts.length === 1) {
      return testUrl.includes(pattern);
    }

    let pos = 0;
    for (const part of parts) {
      if (part === '') continue;
      const idx = testUrl.indexOf(part, pos);
      if (idx === -1) return false;
      pos = idx + part.length;
    }
    return true;
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Interceptor setup
  // -------------------------------------------------------------------------

  installRequestInterceptor(): void {
    mainLogger.info(`${LOG}.installRequestInterceptor`);

    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const resourceType = (details.resourceType ?? 'other') as DnrResourceType;
      const method = details.method ?? 'GET';

      let initiatorDomain: string | undefined;
      if (details.referrer) {
        try {
          initiatorDomain = new URL(details.referrer).hostname;
        } catch { /* ignore */ }
      }

      const result = this.evaluateRequest({
        url: details.url,
        resourceType,
        method,
        initiatorDomain,
      });

      if (!result.matched || !result.action) {
        callback({});
        return;
      }

      mainLogger.info(`${LOG}.requestIntercepted`, {
        url: details.url.slice(0, 120),
        actionType: result.action.type,
        ruleId: result.rule?.id,
      });

      switch (result.action.type) {
        case 'block':
          callback({ cancel: true });
          return;
        case 'redirect':
          if (result.action.redirect?.url) {
            callback({ redirectURL: result.action.redirect.url });
          } else {
            callback({});
          }
          return;
        case 'upgradeScheme':
          if (details.url.startsWith('http:')) {
            callback({ redirectURL: details.url.replace('http:', 'https:') });
          } else {
            callback({});
          }
          return;
        case 'allow':
        case 'allowAllRequests':
          callback({});
          return;
        default:
          callback({});
      }
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const resourceType = (details.resourceType ?? 'other') as DnrResourceType;
      const result = this.evaluateRequest({
        url: details.url,
        resourceType,
        method: details.method ?? 'GET',
      });

      if (!result.matched || !result.action || result.action.type !== 'modifyHeaders') {
        callback({});
        return;
      }

      const responseHeaders = { ...details.responseHeaders };

      if (result.action.responseHeaders) {
        for (const op of result.action.responseHeaders) {
          const headerLower = op.header.toLowerCase();
          switch (op.operation) {
            case 'remove':
              for (const key of Object.keys(responseHeaders)) {
                if (key.toLowerCase() === headerLower) {
                  delete responseHeaders[key];
                }
              }
              break;
            case 'set':
              responseHeaders[op.header] = [op.value ?? ''];
              break;
            case 'append':
              if (!responseHeaders[op.header]) {
                responseHeaders[op.header] = [];
              }
              responseHeaders[op.header].push(op.value ?? '');
              break;
          }
        }
      }

      callback({ responseHeaders });
    });

    mainLogger.info(`${LOG}.installRequestInterceptor.ok`);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  unloadExtension(extensionId: string): void {
    mainLogger.info(`${LOG}.unloadExtension`, { extensionId });
    this.rulesets.delete(extensionId);
    this.dynamicRules.delete(extensionId);
    this.sessionRules.delete(extensionId);
  }

  dispose(): void {
    mainLogger.info(`${LOG}.dispose`);
    this.rulesets.clear();
    this.dynamicRules.clear();
    this.sessionRules.clear();
  }
}
