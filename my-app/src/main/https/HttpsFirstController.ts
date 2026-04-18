/**
 * HttpsFirstController — HTTPS-First mode for the browser.
 *
 * When enabled:
 *   1. Typed/navigated http:// URLs are upgraded to https://
 *   2. If the HTTPS load fails, a full-page interstitial is shown
 *   3. The user can proceed to the HTTP version from the interstitial
 *   4. Allowed HTTP origins are remembered for the session
 *
 * When disabled:
 *   - HTTP URLs are loaded directly without upgrade or interstitial
 */

import { mainLogger } from '../logger';
import { readPrefs } from '../settings/ipc';

const PREFS_KEY = 'httpsFirst';

// Origins the user has explicitly allowed HTTP for this session
const allowedHttpOrigins = new Set<string>();

// Per-tab tracking of pending HTTPS upgrades (tabId → original http URL)
const pendingUpgrades = new Map<string, string>();

export function isHttpsFirstEnabled(): boolean {
  const prefs = readPrefs();
  const enabled = prefs[PREFS_KEY] === true;
  mainLogger.debug('HttpsFirstController.isEnabled', { enabled });
  return enabled;
}

/**
 * Try to upgrade an http:// URL to https://.
 * Returns the upgraded URL if applicable, or the original URL if:
 *   - The URL is not http://
 *   - HTTPS-First mode is disabled
 *   - The origin has been allowed for HTTP this session
 */
export function maybeUpgradeUrl(url: string): { upgraded: boolean; url: string } {
  if (!url.startsWith('http://')) {
    return { upgraded: false, url };
  }

  if (!isHttpsFirstEnabled()) {
    mainLogger.debug('HttpsFirstController.maybeUpgrade.disabled', { url });
    return { upgraded: false, url };
  }

  const origin = extractOrigin(url);
  if (allowedHttpOrigins.has(origin)) {
    mainLogger.info('HttpsFirstController.maybeUpgrade.allowedOrigin', { url, origin });
    return { upgraded: false, url };
  }

  const httpsUrl = 'https://' + url.slice('http://'.length);
  mainLogger.info('HttpsFirstController.maybeUpgrade.upgrading', {
    originalUrl: url,
    upgradedUrl: httpsUrl,
  });
  return { upgraded: true, url: httpsUrl };
}

export function trackPendingUpgrade(tabId: string, originalHttpUrl: string): void {
  mainLogger.info('HttpsFirstController.trackPendingUpgrade', { tabId, originalHttpUrl });
  pendingUpgrades.set(tabId, originalHttpUrl);
}

export function getPendingUpgrade(tabId: string): string | undefined {
  return pendingUpgrades.get(tabId);
}

export function clearPendingUpgrade(tabId: string): void {
  const had = pendingUpgrades.delete(tabId);
  if (had) {
    mainLogger.debug('HttpsFirstController.clearPendingUpgrade', { tabId });
  }
}

export function allowHttpForOrigin(origin: string): void {
  mainLogger.info('HttpsFirstController.allowHttpForOrigin', { origin });
  allowedHttpOrigins.add(origin);
}

export function isHttpAllowedForOrigin(origin: string): boolean {
  return allowedHttpOrigins.has(origin);
}

export function clearAllowedHttpOrigins(): void {
  mainLogger.info('HttpsFirstController.clearAllowedHttpOrigins', { count: allowedHttpOrigins.size });
  allowedHttpOrigins.clear();
}

function extractOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url;
  }
}

/**
 * Build the full-page interstitial HTML shown when HTTPS upgrade fails.
 * The page includes a "Continue to HTTP" button that posts a message
 * via console.log with a known prefix so the main process can intercept it.
 */
export function buildInterstitialHtml(httpUrl: string, hostname: string): string {
  const escapedUrl = httpUrl
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const escapedHostname = hostname
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connection is not secure</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100vh;
      background: #0a0a0d;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 520px;
      padding: 48px 40px;
      text-align: center;
    }
    .shield {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      color: #ef4444;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 12px;
      line-height: 1.3;
    }
    .desc {
      font-size: 14px;
      line-height: 1.6;
      color: #a0a0a0;
      margin-bottom: 8px;
    }
    .url-display {
      font-size: 13px;
      color: #ef4444;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 6px;
      padding: 8px 16px;
      margin: 16px 0 32px;
      word-break: break-all;
      font-family: ui-monospace, "SF Mono", Monaco, monospace;
    }
    .actions {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    button {
      padding: 10px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    .btn-back {
      background: #6366f1;
      color: #fff;
    }
    .btn-proceed {
      background: transparent;
      color: #a0a0a0;
      border: 1px solid #333;
    }
    .btn-proceed:hover {
      color: #e0e0e0;
      border-color: #555;
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <h1>Your connection to this site is not secure</h1>
    <p class="desc">
      You should not enter any sensitive information on this site (for example,
      passwords or credit cards) because it could be stolen by attackers.
    </p>
    <div class="url-display">${escapedUrl}</div>
    <p class="desc" style="margin-bottom: 24px; font-size: 13px;">
      <strong>${escapedHostname}</strong> does not support HTTPS.
      Your data will be sent unencrypted.
    </p>
    <div class="actions">
      <button class="btn-back" onclick="history.back()">Go back</button>
      <button class="btn-proceed" onclick="proceedToHttp()">Continue to HTTP site</button>
    </div>
  </div>
  <script>
    function proceedToHttp() {
      console.log('__HTTPS_FIRST_PROCEED__' + ${JSON.stringify(httpUrl)});
    }
  </script>
</body>
</html>`;
}

export const HTTPS_PROCEED_PREFIX = '__HTTPS_FIRST_PROCEED__';
