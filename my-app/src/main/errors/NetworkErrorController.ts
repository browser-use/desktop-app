/**
 * NetworkErrorController — branded error pages for common network failures.
 *
 * Covers:
 *   - ERR_CONNECTION_REFUSED      — server actively refused connection
 *   - ERR_NAME_NOT_RESOLVED       — DNS lookup failed
 *   - ERR_INTERNET_DISCONNECTED   — no network interface
 *   - ERR_TOO_MANY_REDIRECTS      — redirect loop
 *   - Certificate errors           — separate handler via certificate-error event
 *
 * Error pages communicate back to main via console.log prefix so the
 * main process can intercept retry/back actions (same pattern as
 * HttpsFirstController and SafeBrowsingController).
 *
 * Cert bypass uses the "thisisunsafe" session pattern: the interstitial
 * listens for the user typing "thisisunsafe" on the page, then emits a
 * console prefix so main can allow the cert for the session and reload.
 */

import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Public prefixes (used in TabManager console-message handler)
// ---------------------------------------------------------------------------

export const NET_ERROR_RETRY_PREFIX = '__NET_ERROR_RETRY__';
export const CERT_ERROR_PROCEED_PREFIX = '__CERT_ERROR_PROCEED__';
export const CERT_ERROR_BACK_PREFIX = '__CERT_ERROR_BACK__';

// ---------------------------------------------------------------------------
// Per-session cert bypass registry
// ---------------------------------------------------------------------------

const certBypassOrigins = new Set<string>();

export function allowCertForOrigin(origin: string): void {
  mainLogger.info('NetworkErrorController.allowCertForOrigin', { origin });
  certBypassOrigins.add(origin);
}

export function isCertAllowedForOrigin(origin: string): boolean {
  return certBypassOrigins.has(origin);
}

export function clearCertBypasses(): void {
  mainLogger.info('NetworkErrorController.clearCertBypasses', { count: certBypassOrigins.size });
  certBypassOrigins.clear();
}

// ---------------------------------------------------------------------------
// Error code classification
// ---------------------------------------------------------------------------

interface ErrorMeta {
  title: string;
  heading: string;
  description: string;
  iconType: 'wifi-off' | 'plug' | 'dns' | 'redirect' | 'generic';
  /** If true, show a Retry button */
  showRetry: boolean;
}

// Chromium net error codes used in did-fail-load
const ERROR_META: Record<number, ErrorMeta> = {
  [-102]: {
    title: "Connection refused",
    heading: "This site can't be reached",
    description: "<strong>{{hostname}}</strong> refused to connect.",
    iconType: 'plug',
    showRetry: true,
  },
  [-105]: {
    title: "Server not found",
    heading: "This site can't be reached",
    description: "The DNS address for <strong>{{hostname}}</strong> could not be found.",
    iconType: 'dns',
    showRetry: true,
  },
  [-106]: {
    title: "No internet",
    heading: "No internet connection",
    description: "There is no internet connection. Check your network cables, modem, and router or reconnect to Wi-Fi.",
    iconType: 'wifi-off',
    showRetry: true,
  },
  [-310]: {
    title: "Too many redirects",
    heading: "This page isn't working",
    description: "<strong>{{hostname}}</strong> redirected you too many times. Try clearing your cookies.",
    iconType: 'redirect',
    showRetry: false,
  },
  // ERR_CONNECTION_TIMED_OUT
  [-118]: {
    title: "Connection timed out",
    heading: "This site can't be reached",
    description: "<strong>{{hostname}}</strong> took too long to respond.",
    iconType: 'plug',
    showRetry: true,
  },
  // ERR_CONNECTION_RESET
  [-101]: {
    title: "Connection reset",
    heading: "This site can't be reached",
    description: "The connection to <strong>{{hostname}}</strong> was reset.",
    iconType: 'plug',
    showRetry: true,
  },
  // ERR_ADDRESS_UNREACHABLE
  [-109]: {
    title: "Address unreachable",
    heading: "This site can't be reached",
    description: "<strong>{{hostname}}</strong> is unreachable.",
    iconType: 'plug',
    showRetry: true,
  },
};

const GENERIC_META: ErrorMeta = {
  title: "Page not available",
  heading: "This page isn't available",
  description: "The page at <strong>{{hostname}}</strong> could not be loaded.",
  iconType: 'generic',
  showRetry: true,
};

// Error codes that should NOT show a branded page (aborts, cancels, no-ops)
const SKIP_CODES = new Set([-3, -2, -1, 0]);

export function shouldShowErrorPage(errorCode: number): boolean {
  if (SKIP_CODES.has(errorCode)) return false;
  // Skip codes -400 and above (HTTP errors handled at app level)
  if (errorCode >= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// SVG icons (inline, no external assets needed)
// ---------------------------------------------------------------------------

function getIcon(type: ErrorMeta['iconType']): string {
  switch (type) {
    case 'wifi-off':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="err-icon" aria-hidden="true">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
      </svg>`;
    case 'plug':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="err-icon" aria-hidden="true">
        <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
      </svg>`;
    case 'dns':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="err-icon" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>`;
    case 'redirect':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="err-icon" aria-hidden="true">
        <polyline points="17 1 21 5 17 9"/>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
        <polyline points="7 23 3 19 7 15"/>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
      </svg>`;
    default:
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="err-icon" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>`;
  }
}

// ---------------------------------------------------------------------------
// Shared CSS for all error pages
// ---------------------------------------------------------------------------

const ERROR_PAGE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 100%;
    background: #0a0a0d;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    max-width: 560px;
    padding: 48px 40px;
    text-align: center;
  }
  .err-icon {
    width: 64px;
    height: 64px;
    margin: 0 auto 24px;
    color: #555;
    display: block;
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
    color: #888;
    margin-bottom: 8px;
  }
  .err-code {
    font-size: 12px;
    color: #444;
    font-family: ui-monospace, "SF Mono", Monaco, monospace;
    margin: 16px 0 32px;
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
  .btn-primary {
    background: #6366f1;
    color: #fff;
  }
  .btn-secondary {
    background: transparent;
    color: #888;
    border: 1px solid #2a2a2a;
  }
  .btn-secondary:hover {
    color: #e0e0e0;
    border-color: #444;
  }
  /* Cert page extras */
  .cert-details-toggle {
    background: none;
    border: none;
    color: #555;
    font-size: 13px;
    cursor: pointer;
    padding: 8px 0;
    text-decoration: underline;
    margin-top: 20px;
    display: inline-block;
  }
  .cert-details-toggle:hover { color: #888; }
  .cert-details-panel {
    display: none;
    margin-top: 16px;
    padding: 20px;
    background: rgba(255,255,255,0.03);
    border: 1px solid #1e1e1e;
    border-radius: 8px;
    text-align: left;
  }
  .cert-details-panel.open { display: block; }
  .cert-details-panel p {
    font-size: 13px;
    line-height: 1.6;
    color: #666;
    margin-bottom: 12px;
  }
  .cert-details-panel .cert-url {
    font-size: 12px;
    color: #444;
    word-break: break-all;
    font-family: ui-monospace, "SF Mono", Monaco, monospace;
    padding: 8px 12px;
    background: rgba(0,0,0,0.3);
    border-radius: 4px;
    margin-bottom: 16px;
  }
  .bypass-link {
    background: none;
    border: none;
    color: #444;
    font-size: 13px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .bypass-link:hover { color: #666; }
  .thisisunsafe-hint {
    font-size: 11px;
    color: #333;
    margin-top: 24px;
  }
`;

// ---------------------------------------------------------------------------
// Network error page builder
// ---------------------------------------------------------------------------

export function buildNetworkErrorPage(
  errorCode: number,
  errorDescription: string,
  failedUrl: string,
): string {
  const meta = ERROR_META[errorCode] ?? GENERIC_META;

  let hostname = failedUrl;
  try { hostname = new URL(failedUrl).hostname; } catch { /* use raw url */ }

  const escapedHostname = hostname
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const escapedUrl = failedUrl
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const desc = meta.description.replace(/\{\{hostname\}\}/g, escapedHostname);
  const retryButton = meta.showRetry
    ? `<button class="btn-primary" onclick="retryNavigation()">Retry</button>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${meta.title}</title>
  <style>${ERROR_PAGE_CSS}</style>
</head>
<body>
  <div class="container">
    ${getIcon(meta.iconType)}
    <h1>${meta.heading}</h1>
    <p class="desc">${desc}</p>
    <p class="err-code">${errorDescription || `ERR_${errorCode}`}</p>
    <div class="actions">
      ${retryButton}
      <button class="btn-secondary" onclick="history.back()">Go back</button>
    </div>
  </div>
  <script>
    function retryNavigation() {
      console.log(${JSON.stringify(NET_ERROR_RETRY_PREFIX + failedUrl).replace(/</g, '\\u003c')});
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Certificate error page builder
// ---------------------------------------------------------------------------

export function buildCertErrorPage(
  failedUrl: string,
  certError: string,
): string {
  let hostname = failedUrl;
  try { hostname = new URL(failedUrl).hostname; } catch { /* use raw url */ }

  const escapedHostname = hostname
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const escapedUrl = failedUrl
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const escapedCertError = certError
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Your connection is not private</title>
  <style>${ERROR_PAGE_CSS}</style>
</head>
<body>
  <div class="container">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="err-icon" style="color:#ef4444" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <h1>Your connection is not private</h1>
    <p class="desc">
      Attackers might be trying to steal your information from
      <strong>${escapedHostname}</strong> (for example, passwords, messages, or credit cards).
    </p>
    <p class="err-code">NET::${escapedCertError}</p>
    <div class="actions">
      <button class="btn-primary" onclick="goBack()">Back to safety</button>
    </div>

    <button class="cert-details-toggle" onclick="toggleDetails()" id="detailsBtn">Details</button>

    <div class="cert-details-panel" id="detailsPanel">
      <p>
        This server could not prove that it is <strong>${escapedHostname}</strong>;
        its security certificate is not trusted by your device. This may be caused by a
        misconfiguration or an attacker intercepting your connection.
      </p>
      <div class="cert-url">${escapedUrl}</div>
      <p style="font-size:13px; color:#555;">
        Certificate error: <code>${escapedCertError}</code>
      </p>
      <p>
        If you understand the risks,
        <button class="bypass-link" onclick="proceedUnsafe()">proceed to ${escapedHostname} (unsafe)</button>.
      </p>
    </div>

    <p class="thisisunsafe-hint" id="thisisunsafeHint"></p>
  </div>
  <script>
    var typedChars = '';
    var TARGET = 'thisisunsafe';

    document.addEventListener('keydown', function(e) {
      typedChars += e.key.toLowerCase();
      if (typedChars.length > TARGET.length) {
        typedChars = typedChars.slice(-TARGET.length);
      }
      if (typedChars === TARGET) {
        proceedUnsafe();
      }
    });

    function goBack() {
      console.log(${JSON.stringify(CERT_ERROR_BACK_PREFIX).replace(/</g, '\\u003c')});
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

    function proceedUnsafe() {
      console.log(${JSON.stringify(CERT_ERROR_PROCEED_PREFIX + failedUrl).replace(/</g, '\\u003c')});
    }
  </script>
</body>
</html>`;
}
