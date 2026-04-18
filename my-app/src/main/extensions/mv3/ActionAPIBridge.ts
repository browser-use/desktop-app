/**
 * mv3/ActionAPIBridge.ts — Unified chrome.action API bridge.
 *
 * MV3 merges chrome.browserAction and chrome.pageAction into chrome.action.
 * This bridge stores per-extension action state (badge, title, popup, icon)
 * and emits updates to the shell renderer for toolbar display.
 */

import { mainLogger } from '../../logger';
import { MV3_LOG_PREFIX } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionState {
  extensionId: string;
  title: string;
  popup: string;
  badgeText: string;
  badgeBackgroundColor: string;
  badgeTextColor: string;
  enabled: boolean;
  icon: Record<string, string>;
}

export type ActionStateUpdate = Partial<Omit<ActionState, 'extensionId'>> & {
  tabId?: number;
};

// ---------------------------------------------------------------------------
// ActionAPIBridge
// ---------------------------------------------------------------------------

const LOG = `${MV3_LOG_PREFIX}.ActionAPI`;

export class ActionAPIBridge {
  private defaultStates = new Map<string, ActionState>();
  private tabOverrides = new Map<string, Map<number, ActionStateUpdate>>();
  private onStateChanged: ((extensionId: string, state: ActionState) => void) | null = null;

  constructor() {
    mainLogger.info(`${LOG}.init`);
  }

  setOnStateChanged(callback: (extensionId: string, state: ActionState) => void): void {
    this.onStateChanged = callback;
  }

  registerExtension(
    extensionId: string,
    manifest: Record<string, unknown>,
  ): void {
    const action = (manifest.action ?? manifest.browser_action ?? manifest.page_action) as
      | Record<string, unknown>
      | undefined;

    const state: ActionState = {
      extensionId,
      title: (action?.default_title as string) ?? (manifest.name as string) ?? '',
      popup: (action?.default_popup as string) ?? '',
      badgeText: '',
      badgeBackgroundColor: '#4688F1',
      badgeTextColor: '#FFFFFF',
      enabled: true,
      icon: (action?.default_icon as Record<string, string>) ?? {},
    };

    this.defaultStates.set(extensionId, state);
    mainLogger.info(`${LOG}.registerExtension`, {
      extensionId,
      title: state.title,
      hasPopup: state.popup !== '',
    });
  }

  unregisterExtension(extensionId: string): void {
    mainLogger.info(`${LOG}.unregisterExtension`, { extensionId });
    this.defaultStates.delete(extensionId);
    this.tabOverrides.delete(extensionId);
  }

  // -------------------------------------------------------------------------
  // Setters (called by extension API shim)
  // -------------------------------------------------------------------------

  setTitle(extensionId: string, title: string, tabId?: number): void {
    mainLogger.info(`${LOG}.setTitle`, { extensionId, title, tabId });
    this.applyUpdate(extensionId, { title }, tabId);
  }

  setPopup(extensionId: string, popup: string, tabId?: number): void {
    mainLogger.info(`${LOG}.setPopup`, { extensionId, popup, tabId });
    this.applyUpdate(extensionId, { popup }, tabId);
  }

  setBadgeText(extensionId: string, text: string, tabId?: number): void {
    mainLogger.info(`${LOG}.setBadgeText`, { extensionId, text, tabId });
    this.applyUpdate(extensionId, { badgeText: text }, tabId);
  }

  setBadgeBackgroundColor(extensionId: string, color: string, tabId?: number): void {
    mainLogger.info(`${LOG}.setBadgeBackgroundColor`, { extensionId, color, tabId });
    this.applyUpdate(extensionId, { badgeBackgroundColor: color }, tabId);
  }

  setBadgeTextColor(extensionId: string, color: string, tabId?: number): void {
    mainLogger.info(`${LOG}.setBadgeTextColor`, { extensionId, color, tabId });
    this.applyUpdate(extensionId, { badgeTextColor: color }, tabId);
  }

  setIcon(extensionId: string, icon: Record<string, string>, tabId?: number): void {
    mainLogger.info(`${LOG}.setIcon`, { extensionId, tabId });
    this.applyUpdate(extensionId, { icon }, tabId);
  }

  setEnabled(extensionId: string, enabled: boolean, tabId?: number): void {
    mainLogger.info(`${LOG}.setEnabled`, { extensionId, enabled, tabId });
    this.applyUpdate(extensionId, { enabled }, tabId);
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  getState(extensionId: string, tabId?: number): ActionState | null {
    const defaultState = this.defaultStates.get(extensionId);
    if (!defaultState) return null;

    if (tabId === undefined) return { ...defaultState };

    const overrides = this.tabOverrides.get(extensionId)?.get(tabId);
    if (!overrides) return { ...defaultState };

    return { ...defaultState, ...overrides };
  }

  getAllStates(): ActionState[] {
    return Array.from(this.defaultStates.values()).map((s) => ({ ...s }));
  }

  isEnabled(extensionId: string, tabId?: number): boolean {
    const state = this.getState(extensionId, tabId);
    return state?.enabled ?? false;
  }

  // -------------------------------------------------------------------------
  // Tab lifecycle
  // -------------------------------------------------------------------------

  clearTabOverrides(tabId: number): void {
    for (const [, overrides] of this.tabOverrides) {
      overrides.delete(tabId);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private applyUpdate(
    extensionId: string,
    update: ActionStateUpdate,
    tabId?: number,
  ): void {
    if (tabId !== undefined) {
      let extOverrides = this.tabOverrides.get(extensionId);
      if (!extOverrides) {
        extOverrides = new Map();
        this.tabOverrides.set(extensionId, extOverrides);
      }
      const existing = extOverrides.get(tabId) ?? {};
      extOverrides.set(tabId, { ...existing, ...update });
    } else {
      const current = this.defaultStates.get(extensionId);
      if (current) {
        Object.assign(current, update);
      }
    }

    const resolvedState = this.getState(extensionId, tabId);
    if (resolvedState && this.onStateChanged) {
      this.onStateChanged(extensionId, resolvedState);
    }
  }

  dispose(): void {
    mainLogger.info(`${LOG}.dispose`);
    this.defaultStates.clear();
    this.tabOverrides.clear();
    this.onStateChanged = null;
  }
}
