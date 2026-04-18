/**
 * CertErrorController — certificate error interstitial.
 *
 * When Chromium raises a certificate error for a page load:
 *   - Non-HSTS hosts: show a red interstitial with a "thisisunsafe" bypass
 *     mechanism (same as Chrome — the user types the phrase into the page and
 *     it is intercepted via console.log prefix).
 *   - HSTS hosts: show the same interstitial but WITHOUT the bypass option,
 *     because RFC 6797 §12.1 requires hard-failing HSTS violations.
 *
 * The bypass is session-level only — bypassed origins are forgotten when the
 * app quits.
 */

import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CERT_BYPASS_PREFIX = '__CERT_ERROR_BYPASS__';
export const CERT_BACK_PREFIX   = '__CERT_ERROR_BACK__';

// The magic phrase Chrome uses — kept identical for muscle-memory compatibility.
const BYPASS_PHRASE = 'thisisunsafe';

// ---------------------------------------------------------------------------
// Session-level bypass set
// ---------------------------------------------------------------------------

const bypassedOrigins = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function allowCertBypassForOrigin(origin: string): void {
  mainLogger.info('CertErrorController.allowBypass', { origin });
  bypassedOrigins.add(origin);
}

export function isCertBypassed(origin: string): boolean {
  return bypassedOrigins.has(origin);
}

export function clearCertBypasses(): void {
  mainLogger.info('CertErrorController.clearBypasses', { count: bypassedOrigins.size });
  bypassedOrigins.clear();
}

// ---------------------------------------------------------------------------
// Interstitial HTML
// ---------------------------------------------------------------------------

/**
 * Build the cert-error full-page interstitial.
 *
 * @param url       The URL that failed certificate validation.
 * @param hostname  Extracted hostname for display.
 * @param isHSTS    When true, the "proceed anyway" bypass is hidden (HSTS hard-fail).
 * @param errorCode Chromium net error code (e.g. -202 for ERR_CERT_AUTHORITY_INVALID).
 */
export function buildCertErrorInterstitial(
  url: string,
  hostname: string,
  isHSTS: boolean,
  errorCode: number,
): string {
  const escapedUrl = url
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const escapedHostname = hostname
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const errorLabel = certErrorLabel(errorCode);

  // The bypass section is hidden entirely for HSTS hosts.
  const bypassSection = isHSTS
    ? `<p class="hsts-note">
        This site has security policy that prevents bypassing certificate errors.
        You cannot visit <strong>${escapedHostname}</strong> right now because
        the website uses HSTS which ensures your browser only connects securely.
      </p>`
    : `<div class="bypass-section">
        <p>
          If you understand the risks to your security, you may proceed.
          To bypass this warning, type <code class="bypass-phrase">thisisunsafe</code> anywhere on this page.
        </p>
      </div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your connection is not private</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      background: #0a0a0d;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      max-width: 560px;
      width: 100%;
      padding: 48px 40px;
    }
    .shield-icon {
      width: 56px;
      height: 56px;
      color: #ef4444;
      margin-bottom: 24px;
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
      line-height: 1.7;
      color: #a0a0a0;
      margin-bottom: 16px;
    }
    .error-code {
      display: inline-block;
      font-family: ui-monospace, "SF Mono", Monaco, monospace;
      font-size: 12px;
      color: #666;
      background: #111;
      border: 1px solid #222;
      border-radius: 4px;
      padding: 2px 8px;
      margin-bottom: 24px;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 24px;
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
    .details-toggle {
      background: transparent;
      color: #666;
      border: 1px solid #333;
      padding: 8px 20px;
      font-size: 13px;
    }
    .details-toggle:hover { color: #a0a0a0; border-color: #555; }
    .details-panel {
      display: none;
      margin-top: 8px;
      padding: 20px;
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
    }
    .details-panel.open { display: block; }
    .url-display {
      font-family: ui-monospace, "SF Mono", Monaco, monospace;
      font-size: 12px;
      color: #888;
      word-break: break-all;
      margin-bottom: 16px;
    }
    .bypass-section {
      margin-top: 16px;
      padding: 16px;
      background: rgba(239, 68, 68, 0.06);
      border: 1px solid rgba(239, 68, 68, 0.15);
      border-radius: 6px;
      font-size: 13px;
      color: #888;
      line-height: 1.6;
    }
    .bypass-phrase {
      font-family: ui-monospace, "SF Mono", Monaco, monospace;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 3px;
      padding: 1px 6px;
      color: #ef4444;
      font-size: 12px;
    }
    .hsts-note {
      margin-top: 16px;
      padding: 14px 16px;
      background: rgba(99, 102, 241, 0.06);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 6px;
      font-size: 13px;
      color: #888;
      line-height: 1.6;
    }
    .hsts-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(99, 102, 241, 0.12);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 16px;
    }
    #bypass-input-trap {
      position: fixed;
      left: -9999px;
      opacity: 0;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="shield-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>

    ${isHSTS ? `<div class="hsts-badge">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M5 1l3.5 1.5v3C8.5 7.5 5 9 5 9S1.5 7.5 1.5 5.5v-3L5 1z" fill="currentColor" opacity="0.7"/>
      </svg>
      HSTS Protected
    </div>` : ''}

    <h1>Your connection is not private</h1>
    <p class="desc">
      Attackers might be trying to steal your information from
      <strong>${escapedHostname}</strong> (for example, passwords, messages, or credit cards).
    </p>
    <div class="error-code">${errorLabel}</div>

    <div class="actions">
      <button class="btn-back" onclick="goBack()">Go back</button>
      <button class="details-toggle" onclick="toggleDetails()" id="detailsBtn">Details</button>
    </div>

    <div class="details-panel" id="detailsPanel">
      <div class="url-display">${escapedUrl}</div>
      ${bypassSection}
    </div>
  </div>

  <!-- Invisible input to capture keystrokes for the bypass phrase -->
  <input id="bypass-input-trap" type="text" aria-hidden="true" tabindex="-1" />

  <script>
    var bypassBuffer = '';
    var bypassPhrase = ${JSON.stringify(BYPASS_PHRASE)};
    var isHSTS = ${JSON.stringify(isHSTS)};

    document.addEventListener('keydown', function(e) {
      if (isHSTS) return;
      // Accumulate printable characters into a rolling buffer
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        bypassBuffer += e.key;
        if (bypassBuffer.length > bypassPhrase.length) {
          bypassBuffer = bypassBuffer.slice(-bypassPhrase.length);
        }
        if (bypassBuffer === bypassPhrase) {
          console.log(${JSON.stringify(CERT_BYPASS_PREFIX)} + ${JSON.stringify(url).replace(/</g, '\\u003c')});
        }
      }
    });

    function goBack() {
      console.log(${JSON.stringify(CERT_BACK_PREFIX)});
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
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Chromium net error code to a human-readable label.
 * Full list: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
 */
function certErrorLabel(errorCode: number): string {
  const labels: Record<number, string> = {
    [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
    [-201]: 'ERR_CERT_DATE_INVALID',
    [-202]: 'ERR_CERT_AUTHORITY_INVALID',
    [-203]: 'ERR_CERT_CONTAINS_ERRORS',
    [-204]: 'ERR_CERT_NO_REVOCATION_MECHANISM',
    [-205]: 'ERR_CERT_UNABLE_TO_CHECK_REVOCATION',
    [-206]: 'ERR_CERT_REVOKED',
    [-207]: 'ERR_CERT_INVALID',
    [-210]: 'ERR_CERT_WEAK_SIGNATURE_ALGORITHM',
    [-212]: 'ERR_CERT_NON_UNIQUE_NAME',
    [-213]: 'ERR_CERT_WEAK_KEY',
    [-214]: 'ERR_CERT_NAME_CONSTRAINT_VIOLATION',
    [-215]: 'ERR_CERT_VALIDITY_TOO_LONG',
    [-216]: 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED',
    [-217]: 'ERR_CERT_SYMANTEC_LEGACY',
    [-218]: 'ERR_CERT_KNOWN_INTERCEPTION_BLOCKED',
  };
  return labels[errorCode] ?? `NET_ERROR(${errorCode})`;
}
