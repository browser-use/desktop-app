/**
 * HttpsFirstController unit tests.
 *
 * Tests cover:
 *   - maybeUpgradeUrl: no-op for https/non-http, disabled mode, allowed origin, upgrade
 *   - trackPendingUpgrade / getPendingUpgrade / clearPendingUpgrade
 *   - allowHttpForOrigin / isHttpAllowedForOrigin / clearAllowedHttpOrigins
 *   - buildInterstitialHtml: contains key HTML content, escapes entities
 *   - HTTPS_PROCEED_PREFIX constant
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy, readPrefsMock } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  readPrefsMock: vi.fn(() => ({ httpsFirst: false })),
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));
vi.mock('../../../src/main/settings/ipc', () => ({ readPrefs: readPrefsMock }));

import {
  maybeUpgradeUrl,
  trackPendingUpgrade,
  getPendingUpgrade,
  clearPendingUpgrade,
  allowHttpForOrigin,
  isHttpAllowedForOrigin,
  clearAllowedHttpOrigins,
  buildInterstitialHtml,
  HTTPS_PROCEED_PREFIX,
} from '../../../src/main/https/HttpsFirstController';

// ---------------------------------------------------------------------------
// Reset module-level state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAllowedHttpOrigins();
  // Clear pending upgrades by clearing any added entries
  // The module doesn't expose a clearAll for pendingUpgrades, so we track
  // what we add in each test and clear individually.
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// maybeUpgradeUrl
// ---------------------------------------------------------------------------

describe('maybeUpgradeUrl()', () => {
  it('does not upgrade https:// URLs', () => {
    const result = maybeUpgradeUrl('https://example.com');
    expect(result.upgraded).toBe(false);
    expect(result.url).toBe('https://example.com');
  });

  it('does not upgrade ftp:// or other non-http URLs', () => {
    const result = maybeUpgradeUrl('ftp://example.com/file');
    expect(result.upgraded).toBe(false);
    expect(result.url).toBe('ftp://example.com/file');
  });

  it('does not upgrade when httpsFirst is disabled', () => {
    readPrefsMock.mockReturnValue({ httpsFirst: false });
    const result = maybeUpgradeUrl('http://example.com');
    expect(result.upgraded).toBe(false);
    expect(result.url).toBe('http://example.com');
  });

  it('upgrades http:// to https:// when httpsFirst is enabled', () => {
    readPrefsMock.mockReturnValue({ httpsFirst: true });
    const result = maybeUpgradeUrl('http://example.com/path?q=1');
    expect(result.upgraded).toBe(true);
    expect(result.url).toBe('https://example.com/path?q=1');
  });

  it('does not upgrade when origin is in allowedHttpOrigins', () => {
    readPrefsMock.mockReturnValue({ httpsFirst: true });
    allowHttpForOrigin('example.com');
    const result = maybeUpgradeUrl('http://example.com/page');
    expect(result.upgraded).toBe(false);
    expect(result.url).toBe('http://example.com/page');
  });

  it('upgrades a different origin not in allowed list', () => {
    readPrefsMock.mockReturnValue({ httpsFirst: true });
    allowHttpForOrigin('other.com');
    const result = maybeUpgradeUrl('http://example.com');
    expect(result.upgraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trackPendingUpgrade / getPendingUpgrade / clearPendingUpgrade
// ---------------------------------------------------------------------------

describe('pending upgrades', () => {
  afterEach(() => {
    clearPendingUpgrade('tab-1');
    clearPendingUpgrade('tab-2');
  });

  it('trackPendingUpgrade stores the original URL', () => {
    trackPendingUpgrade('tab-1', 'http://example.com');
    expect(getPendingUpgrade('tab-1')).toBe('http://example.com');
  });

  it('getPendingUpgrade returns undefined for unknown tab', () => {
    expect(getPendingUpgrade('unknown-tab')).toBeUndefined();
  });

  it('clearPendingUpgrade removes the entry', () => {
    trackPendingUpgrade('tab-1', 'http://example.com');
    clearPendingUpgrade('tab-1');
    expect(getPendingUpgrade('tab-1')).toBeUndefined();
  });

  it('clearPendingUpgrade is safe for unknown tab', () => {
    expect(() => clearPendingUpgrade('nonexistent')).not.toThrow();
  });

  it('overwriting a pending upgrade replaces the URL', () => {
    trackPendingUpgrade('tab-1', 'http://first.com');
    trackPendingUpgrade('tab-1', 'http://second.com');
    expect(getPendingUpgrade('tab-1')).toBe('http://second.com');
  });
});

// ---------------------------------------------------------------------------
// allowHttpForOrigin / isHttpAllowedForOrigin / clearAllowedHttpOrigins
// ---------------------------------------------------------------------------

describe('allowed HTTP origins', () => {
  it('isHttpAllowedForOrigin returns false initially', () => {
    expect(isHttpAllowedForOrigin('example.com')).toBe(false);
  });

  it('allowHttpForOrigin marks an origin as allowed', () => {
    allowHttpForOrigin('example.com');
    expect(isHttpAllowedForOrigin('example.com')).toBe(true);
  });

  it('allowHttpForOrigin is idempotent', () => {
    allowHttpForOrigin('example.com');
    allowHttpForOrigin('example.com');
    expect(isHttpAllowedForOrigin('example.com')).toBe(true);
  });

  it('clearAllowedHttpOrigins removes all allowed origins', () => {
    allowHttpForOrigin('a.com');
    allowHttpForOrigin('b.com');
    clearAllowedHttpOrigins();
    expect(isHttpAllowedForOrigin('a.com')).toBe(false);
    expect(isHttpAllowedForOrigin('b.com')).toBe(false);
  });

  it('does not affect other origins', () => {
    allowHttpForOrigin('a.com');
    expect(isHttpAllowedForOrigin('b.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildInterstitialHtml
// ---------------------------------------------------------------------------

describe('buildInterstitialHtml()', () => {
  it('contains the DOCTYPE and expected markup', () => {
    const html = buildInterstitialHtml('http://example.com', 'example.com');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Your connection to this site is not secure');
  });

  it('includes the HTTP URL in the page', () => {
    const html = buildInterstitialHtml('http://example.com/page', 'example.com');
    expect(html).toContain('http://example.com/page');
  });

  it('includes the hostname', () => {
    const html = buildInterstitialHtml('http://evil.com', 'evil.com');
    expect(html).toContain('evil.com');
  });

  it('escapes HTML entities in the URL', () => {
    const html = buildInterstitialHtml('http://a.com/?x=1&y=2', 'a.com');
    expect(html).toContain('&amp;y=2');
  });

  it('escapes HTML entities in the hostname', () => {
    const html = buildInterstitialHtml('http://a.com', '<script>a.com');
    expect(html).toContain('&lt;script&gt;a.com');
  });

  it('contains the HTTPS_PROCEED_PREFIX in the script', () => {
    const html = buildInterstitialHtml('http://example.com', 'example.com');
    expect(html).toContain(HTTPS_PROCEED_PREFIX);
  });

  it('includes "Go back" and "Continue to HTTP site" buttons', () => {
    const html = buildInterstitialHtml('http://example.com', 'example.com');
    expect(html).toContain('Go back');
    expect(html).toContain('Continue to HTTP site');
  });
});

// ---------------------------------------------------------------------------
// HTTPS_PROCEED_PREFIX constant
// ---------------------------------------------------------------------------

describe('HTTPS_PROCEED_PREFIX', () => {
  it('is a non-empty string', () => {
    expect(typeof HTTPS_PROCEED_PREFIX).toBe('string');
    expect(HTTPS_PROCEED_PREFIX.length).toBeGreaterThan(0);
  });
});
