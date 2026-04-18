/**
 * ContentPolicyEnforcer — the missing runtime consumer for
 * {@link ContentCategoryStore}. Issue #222: the Settings > Content tab
 * persisted policies for popups / JavaScript / images / sound but nothing
 * applied them to live browsing. This class is the "enforcement" side.
 *
 * Scope (wave 1 — categories we actually wire here):
 *   - images:     webRequest.onBeforeRequest cancels image resource types
 *                 when the resolved policy (origin override -> default) is 'block'.
 *   - popups:     a predicate + allow(origin) escape hatch. TabManager's
 *                 setWindowOpenHandler must call shouldBlockPopup() before
 *                 creating a new tab from window.open / target=_blank.
 *   - javascript: read at tab-creation time to set WebPreferences.javascript.
 *                 Changing JS policy does NOT retroactively affect already-open
 *                 tabs; a reload is required (consistent with Chrome).
 *   - sound:      setAudioMuted() on the tab's webContents after each
 *                 navigation, OR'd with MutedSitesStore (any mute source wins).
 *
 * Out of scope for this wave (UI now labels these "Not enforced yet" and
 * the select is disabled):
 *   - ads, automatic-downloads, protected-content, clipboard-read,
 *     clipboard-write.
 *
 * Design notes:
 *   - Electron session.webRequest allows a single listener per event type.
 *     The extensions DNR engine also wants onBeforeRequest. We grab the slot
 *     eagerly on install(); if DNR later calls onBeforeRequest again, its
 *     listener will replace ours and image blocking stops. This is noted
 *     as a follow-up — coordinating the slot needs a shared dispatcher,
 *     out of scope for this bug-fix.
 *   - Resolution order: per-origin override > default. An override of 'allow'
 *     beats a default of 'block' and vice-versa.
 */

import type { Session, OnBeforeRequestListenerDetails, CallbackResponse } from 'electron';
import { mainLogger } from '../logger';
import {
  ContentCategoryStore,
  ContentCategory,
  CategoryState,
} from './ContentCategoryStore';

const LOG = 'ContentPolicyEnforcer';

// Electron resourceType values that represent "images" for our purposes.
// 'imageSet' is not a standard Electron resourceType (that's a DNR/chrome
// concept), so we stick to 'image'. 'favicon' is separate — users usually
// do want favicons even with images blocked; Chrome behaves the same way.
const IMAGE_RESOURCE_TYPES = new Set(['image']);

export interface ContentPolicyEnforcerOptions {
  store: ContentCategoryStore;
}

export class ContentPolicyEnforcer {
  private readonly store: ContentCategoryStore;
  private installedSession: Session | null = null;

  constructor(opts: ContentPolicyEnforcerOptions) {
    this.store = opts.store;
    mainLogger.info(`${LOG}.ctor`);
  }

  // -------------------------------------------------------------------------
  // Session wiring
  // -------------------------------------------------------------------------

  /**
   * Register the image-blocking listener on the given session. Replaces
   * any previous onBeforeRequest listener on that session — callers that
   * also install web-request interceptors need to coordinate (see class
   * note above).
   */
  install(session: Session): void {
    mainLogger.info(`${LOG}.install`);
    session.webRequest.onBeforeRequest((details, callback) => {
      this.handleBeforeRequest(details, callback);
    });
    this.installedSession = session;
  }

  /**
   * Remove the listener. Called on teardown / profile switch.
   */
  uninstall(): void {
    if (!this.installedSession) return;
    mainLogger.info(`${LOG}.uninstall`);
    // Electron's API: passing null clears the listener.
    this.installedSession.webRequest.onBeforeRequest(null);
    this.installedSession = null;
  }

  // Exposed for unit tests — lets us invoke the registered listener without
  // going through a real Session.
  handleBeforeRequest(
    details: Pick<OnBeforeRequestListenerDetails, 'url' | 'resourceType'>,
    callback: (response: CallbackResponse) => void,
  ): void {
    const resourceType = String(details.resourceType ?? 'other');
    if (!IMAGE_RESOURCE_TYPES.has(resourceType)) {
      callback({});
      return;
    }

    const origin = this.extractOrigin(details.url);
    const state = this.resolvedState(origin, 'images');
    if (state === 'block') {
      mainLogger.debug(`${LOG}.block.image`, { origin, url: details.url.slice(0, 120) });
      callback({ cancel: true });
      return;
    }
    callback({});
  }

  // -------------------------------------------------------------------------
  // Public predicates (called from TabManager and tab creation)
  // -------------------------------------------------------------------------

  /**
   * Popups: return true if window.open / target=_blank should be denied for
   * the given initiator origin. Default Chrome-parity policy is 'block'.
   */
  shouldBlockPopup(initiatorUrl: string): boolean {
    const origin = this.extractOrigin(initiatorUrl);
    return this.resolvedState(origin, 'popups') === 'block';
  }

  /**
   * JavaScript: resolved policy for a given URL. Consulted at tab-creation
   * time to flip WebPreferences.javascript off. Because WebPreferences are
   * immutable after BrowserWindow/WebContentsView creation, runtime policy
   * changes only take effect on the next navigation that spawns a new
   * WebContents (or after a full reload on some Electron versions).
   */
  isJavaScriptAllowed(url: string): boolean {
    const origin = this.extractOrigin(url);
    // An explicit default of 'allow' is the Chrome-parity norm; any non-block
    // state counts as allowed (there's no 'ask' UX for JS yet).
    return this.resolvedState(origin, 'javascript') !== 'block';
  }

  /**
   * Sound: return true if the tab at this URL should be muted per content
   * policy. The caller should OR this with other mute sources (tab-mute,
   * site-mute) — any source saying "mute" wins.
   */
  shouldMuteForSoundPolicy(url: string): boolean {
    const origin = this.extractOrigin(url);
    return this.resolvedState(origin, 'sound') === 'block';
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolvedState(origin: string, category: ContentCategory): CategoryState {
    // getSiteOverride already falls through to the default when no override
    // exists, so we only need the one call here.
    return this.store.getSiteOverride(origin, category);
  }

  private extractOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }
}
