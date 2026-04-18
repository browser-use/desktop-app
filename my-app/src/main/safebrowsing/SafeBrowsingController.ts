/**
 * SafeBrowsingController — Google Safe Browsing integration.
 *
 * Three protection levels:
 *   - Enhanced:  real-time URL lookup via Google Safe Browsing API v4
 *   - Standard:  local hash-prefix list updated periodically (default)
 *   - Disabled:  no protection
 *
 * Threat types:
 *   - SOCIAL_ENGINEERING  → "Deceptive site ahead" (phishing)
 *   - MALWARE             → "The site ahead contains malware"
 *   - UNWANTED_SOFTWARE   → "The site ahead contains harmful programs"
 *
 * Interstitial: full-page red warning with Details expand and
 * "Visit this unsafe site" bypass.  Communication with main process
 * uses console.log prefix (same pattern as HttpsFirstController).
 */

import { mainLogger } from '../logger';
import { readPrefs } from '../settings/ipc';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFS_KEY = 'safeBrowsing';
const DEFAULT_LEVEL: SafeBrowsingLevel = 'standard';

const SAFE_BROWSING_API_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const SAFE_BROWSING_UPDATE_URL = 'https://safebrowsing.googleapis.com/v4/threatListUpdates:fetch';
const SAFE_BROWSING_CLIENT_ID = 'agenticbrowser';
const SAFE_BROWSING_CLIENT_VERSION = '1.0.0';

const LIST_UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const API_TIMEOUT_MS = 5000;

export const SAFE_BROWSING_PROCEED_PREFIX = '__SAFE_BROWSING_PROCEED__';
export const SAFE_BROWSING_BACK_PREFIX = '__SAFE_BROWSING_BACK__';

export type SafeBrowsingLevel = 'enhanced' | 'standard' | 'disabled';

export type ThreatType = 'SOCIAL_ENGINEERING' | 'MALWARE' | 'UNWANTED_SOFTWARE';

export interface ThreatMatch {
  threatType: ThreatType;
  url: string;
}

const ALLOWED_LEVELS: readonly SafeBrowsingLevel[] = ['enhanced', 'standard', 'disabled'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Origins the user has explicitly bypassed this session
const bypassedOrigins = new Set<string>();

// Local hash-prefix set for Standard mode
const localHashPrefixes = new Map<string, ThreatType>();

// API key for Enhanced mode (set externally via setSafeBrowsingApiKey)
let safeBrowsingApiKey: string | null = null;

let listUpdateTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSafeBrowsingLevel(): SafeBrowsingLevel {
  const prefs = readPrefs();
  const level = prefs[PREFS_KEY];
  if (typeof level === 'string' && (ALLOWED_LEVELS as readonly string[]).includes(level)) {
    return level as SafeBrowsingLevel;
  }
  return DEFAULT_LEVEL;
}

export function isValidLevel(level: string): level is SafeBrowsingLevel {
  return (ALLOWED_LEVELS as readonly string[]).includes(level);
}

export function setSafeBrowsingApiKey(key: string | null): void {
  safeBrowsingApiKey = key;
  mainLogger.info('SafeBrowsingController.setApiKey', { hasKey: key !== null });
}

/**
 * Check a URL against Safe Browsing threats.
 * Returns null if safe, or a ThreatMatch if dangerous.
 */
export async function checkUrl(url: string): Promise<ThreatMatch | null> {
  const level = getSafeBrowsingLevel();

  if (level === 'disabled') {
    mainLogger.debug('SafeBrowsingController.checkUrl.disabled', { url });
    return null;
  }

  // Skip internal/data/about URLs
  if (shouldSkipUrl(url)) {
    mainLogger.debug('SafeBrowsingController.checkUrl.skip', { url });
    return null;
  }

  // Check bypass list
  const origin = extractOrigin(url);
  if (bypassedOrigins.has(origin)) {
    mainLogger.info('SafeBrowsingController.checkUrl.bypassed', { url, origin });
    return null;
  }

  if (level === 'enhanced') {
    return checkUrlEnhanced(url);
  }

  return checkUrlStandard(url);
}

export function bypassOrigin(origin: string): void {
  mainLogger.info('SafeBrowsingController.bypassOrigin', { origin });
  bypassedOrigins.add(origin);
}

export function isBypassed(origin: string): boolean {
  return bypassedOrigins.has(origin);
}

export function clearBypasses(): void {
  mainLogger.info('SafeBrowsingController.clearBypasses', { count: bypassedOrigins.size });
  bypassedOrigins.clear();
}

export function startListUpdates(): void {
  if (listUpdateTimer) return;
  mainLogger.info('SafeBrowsingController.startListUpdates');
  void updateLocalLists();
  listUpdateTimer = setInterval(() => void updateLocalLists(), LIST_UPDATE_INTERVAL_MS);
}

export function stopListUpdates(): void {
  if (listUpdateTimer) {
    clearInterval(listUpdateTimer);
    listUpdateTimer = null;
    mainLogger.info('SafeBrowsingController.stopListUpdates');
  }
}

// ---------------------------------------------------------------------------
// URL checking implementations
// ---------------------------------------------------------------------------

async function checkUrlEnhanced(url: string): Promise<ThreatMatch | null> {
  if (!safeBrowsingApiKey) {
    mainLogger.debug('SafeBrowsingController.checkUrlEnhanced.noApiKey', { url });
    return checkUrlStandard(url);
  }

  mainLogger.info('SafeBrowsingController.checkUrlEnhanced', { url });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const apiUrl = `${SAFE_BROWSING_API_URL}?key=${encodeURIComponent(safeBrowsingApiKey)}`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client: {
          clientId: SAFE_BROWSING_CLIENT_ID,
          clientVersion: SAFE_BROWSING_CLIENT_VERSION,
        },
        threatInfo: {
          threatTypes: ['SOCIAL_ENGINEERING', 'MALWARE', 'UNWANTED_SOFTWARE'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      mainLogger.warn('SafeBrowsingController.checkUrlEnhanced.apiError', {
        url,
        status: response.status,
      });
      return checkUrlStandard(url);
    }

    const body = await response.json() as { matches?: Array<{ threatType: string }> };

    if (body.matches && body.matches.length > 0) {
      const threatType = body.matches[0].threatType as ThreatType;
      mainLogger.warn('SafeBrowsingController.checkUrlEnhanced.threatFound', {
        url,
        threatType,
        matchCount: body.matches.length,
      });
      return { threatType, url };
    }

    mainLogger.debug('SafeBrowsingController.checkUrlEnhanced.safe', { url });
    return null;
  } catch (err) {
    clearTimeout(timeoutId);
    mainLogger.warn('SafeBrowsingController.checkUrlEnhanced.fetchFailed', {
      url,
      error: (err as Error).message,
    });
    return checkUrlStandard(url);
  }
}

function checkUrlStandard(url: string): ThreatMatch | null {
  const hash = hashUrl(url);
  const prefix = hash.slice(0, 8);

  const threatType = localHashPrefixes.get(prefix);
  if (threatType) {
    mainLogger.warn('SafeBrowsingController.checkUrlStandard.threatFound', {
      url,
      threatType,
      hashPrefix: prefix,
    });
    return { threatType, url };
  }

  mainLogger.debug('SafeBrowsingController.checkUrlStandard.safe', { url });
  return null;
}

// ---------------------------------------------------------------------------
// Local list management
// ---------------------------------------------------------------------------

async function updateLocalLists(): Promise<void> {
  const level = getSafeBrowsingLevel();
  if (level === 'disabled') return;

  mainLogger.info('SafeBrowsingController.updateLocalLists.start');

  if (!safeBrowsingApiKey) {
    mainLogger.debug('SafeBrowsingController.updateLocalLists.noApiKey');
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS * 2);

  try {
    const apiUrl = `${SAFE_BROWSING_UPDATE_URL}?key=${encodeURIComponent(safeBrowsingApiKey)}`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client: {
          clientId: SAFE_BROWSING_CLIENT_ID,
          clientVersion: SAFE_BROWSING_CLIENT_VERSION,
        },
        listUpdateRequests: [
          { threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM', threatEntryType: 'URL', constraints: { maxUpdateEntries: 500 } },
          { threatType: 'MALWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL', constraints: { maxUpdateEntries: 500 } },
          { threatType: 'UNWANTED_SOFTWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL', constraints: { maxUpdateEntries: 500 } },
        ],
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      mainLogger.warn('SafeBrowsingController.updateLocalLists.apiError', {
        status: response.status,
      });
      return;
    }

    const body = await response.json() as {
      listUpdateResponses?: Array<{
        threatType: string;
        additions?: Array<{
          rawHashes?: { prefixSize: number; rawHashes: string };
        }>;
      }>;
    };

    if (body.listUpdateResponses) {
      let addedCount = 0;
      for (const update of body.listUpdateResponses) {
        const threatType = update.threatType as ThreatType;
        if (update.additions) {
          for (const addition of update.additions) {
            if (addition.rawHashes?.rawHashes) {
              const prefixSize = addition.rawHashes.prefixSize || 4;
              const raw = Buffer.from(addition.rawHashes.rawHashes, 'base64');
              for (let i = 0; i < raw.length; i += prefixSize) {
                const prefix = raw.slice(i, i + prefixSize).toString('hex');
                localHashPrefixes.set(prefix, threatType);
                addedCount++;
              }
            }
          }
        }
      }
      mainLogger.info('SafeBrowsingController.updateLocalLists.complete', {
        addedCount,
        totalPrefixes: localHashPrefixes.size,
      });
    }
  } catch (err) {
    clearTimeout(timeoutId);
    mainLogger.warn('SafeBrowsingController.updateLocalLists.fetchFailed', {
      error: (err as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldSkipUrl(url: string): boolean {
  return /^(data:|about:|chrome:|devtools:|view-source:|file:)/i.test(url);
}

function extractOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

function hashUrl(url: string): string {
  let canonical = url;
  try {
    const u = new URL(url);
    canonical = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // use as-is
  }
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Threat metadata for interstitials
// ---------------------------------------------------------------------------

interface ThreatMeta {
  title: string;
  heading: string;
  description: string;
  detailsText: string;
  iconColor: string;
}

const THREAT_META: Record<ThreatType, ThreatMeta> = {
  SOCIAL_ENGINEERING: {
    title: 'Deceptive site ahead',
    heading: 'Deceptive site ahead',
    description:
      'Attackers on <strong>{{hostname}}</strong> may trick you into doing something ' +
      'dangerous like installing software or revealing your personal information ' +
      '(for example, passwords, phone numbers, or credit cards).',
    detailsText:
      'Google Safe Browsing recently detected phishing on <strong>{{hostname}}</strong>. ' +
      'Phishing sites pretend to be other websites to trick you.',
    iconColor: '#dc2626',
  },
  MALWARE: {
    title: 'Dangerous site',
    heading: 'The site ahead contains malware',
    description:
      'Attackers currently on <strong>{{hostname}}</strong> might attempt to install ' +
      'dangerous programs on your computer that steal or delete your information ' +
      '(for example, photos, passwords, messages, and credit cards).',
    detailsText:
      'Google Safe Browsing recently found malware on <strong>{{hostname}}</strong>. ' +
      'Websites that are normally safe are sometimes infected with malware.',
    iconColor: '#dc2626',
  },
  UNWANTED_SOFTWARE: {
    title: 'Harmful programs ahead',
    heading: 'The site ahead contains harmful programs',
    description:
      'Attackers on <strong>{{hostname}}</strong> might try to trick you into ' +
      'installing programs that harm your browsing experience (for example, by ' +
      'changing your homepage or showing extra ads on sites you visit).',
    detailsText:
      'Google Safe Browsing recently found harmful programs on <strong>{{hostname}}</strong>. ' +
      'Harmful software can be bundled with programs you download.',
    iconColor: '#ea580c',
  },
};

// ---------------------------------------------------------------------------
// Interstitial HTML builder
// ---------------------------------------------------------------------------

export function buildSafeBrowsingInterstitial(
  threatType: ThreatType,
  url: string,
  hostname: string,
): string {
  const meta = THREAT_META[threatType];

  const escapedUrl = url
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const escapedHostname = hostname
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const desc = meta.description.replace(/\{\{hostname\}\}/g, escapedHostname);
  const details = meta.detailsText.replace(/\{\{hostname\}\}/g, escapedHostname);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${meta.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      background: #c0392b;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
    }
    .container {
      max-width: 640px;
      margin: 0 auto;
      padding: 64px 40px 40px;
      flex: 1;
    }
    .icon-row {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    .warning-icon {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      color: #fff;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      line-height: 1.3;
    }
    .desc {
      font-size: 15px;
      line-height: 1.7;
      color: rgba(255,255,255,0.9);
      margin-bottom: 24px;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    button {
      padding: 10px 24px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: background-color 0.15s ease;
    }
    .btn-back {
      background: #fff;
      color: #c0392b;
    }
    .btn-back:hover { background: #f0f0f0; }
    .details-toggle {
      background: none;
      border: none;
      color: rgba(255,255,255,0.7);
      font-size: 13px;
      cursor: pointer;
      padding: 8px 0;
      text-decoration: underline;
      margin-top: 16px;
      display: inline-block;
    }
    .details-toggle:hover { color: #fff; }
    .details-panel {
      display: none;
      margin-top: 16px;
      padding: 20px;
      background: rgba(0,0,0,0.15);
      border-radius: 6px;
    }
    .details-panel.open { display: block; }
    .details-panel p {
      font-size: 14px;
      line-height: 1.6;
      color: rgba(255,255,255,0.85);
      margin-bottom: 12px;
    }
    .url-display {
      font-size: 12px;
      color: rgba(255,255,255,0.6);
      word-break: break-all;
      font-family: ui-monospace, "SF Mono", Monaco, monospace;
      padding: 8px 12px;
      background: rgba(0,0,0,0.1);
      border-radius: 4px;
      margin-bottom: 16px;
    }
    .bypass-link {
      background: none;
      border: none;
      color: rgba(255,255,255,0.5);
      font-size: 13px;
      cursor: pointer;
      padding: 0;
      text-decoration: underline;
    }
    .bypass-link:hover { color: rgba(255,255,255,0.7); }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon-row">
      <svg class="warning-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L1 21h22L12 2z" fill="#fff" fill-opacity="0.2" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
        <line x1="12" y1="9" x2="12" y2="14" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        <circle cx="12" cy="17.5" r="1" fill="#fff"/>
      </svg>
      <h1>${meta.heading}</h1>
    </div>

    <p class="desc">${desc}</p>

    <div class="actions">
      <button class="btn-back" onclick="goBack()">Back to safety</button>
    </div>

    <button class="details-toggle" onclick="toggleDetails()" id="detailsBtn">Details</button>

    <div class="details-panel" id="detailsPanel">
      <p>${details}</p>
      <div class="url-display">${escapedUrl}</div>
      <p style="font-size: 13px; color: rgba(255,255,255,0.6);">
        If you understand the risks to your security, you can
        <button class="bypass-link" onclick="proceed()">visit this unsafe site</button>.
      </p>
    </div>
  </div>
  <script>
    function goBack() {
      console.log('${SAFE_BROWSING_BACK_PREFIX}');
      if (history.length > 1) {
        history.back();
      }
    }
    function toggleDetails() {
      var panel = document.getElementById('detailsPanel');
      var btn = document.getElementById('detailsBtn');
      var isOpen = panel.classList.contains('open');
      if (isOpen) {
        panel.classList.remove('open');
        btn.textContent = 'Details';
      } else {
        panel.classList.add('open');
        btn.textContent = 'Hide details';
      }
    }
    function proceed() {
      console.log('${SAFE_BROWSING_PROCEED_PREFIX}' + ${JSON.stringify(url).replace(/</g, '\\u003c')});
    }
  </script>
</body>
</html>`;
}
