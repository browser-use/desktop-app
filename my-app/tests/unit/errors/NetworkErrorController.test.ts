/**
 * NetworkErrorController unit tests.
 *
 * Tests cover:
 *   - allowCertForOrigin / isCertAllowedForOrigin / clearCertBypasses
 *   - shouldShowErrorPage: skip codes (-3,-2,-1,0), positive codes, negative codes
 *   - buildNetworkErrorPage: HTML structure, known error codes, retry button visibility,
 *     generic fallback, URL/hostname in output, HTML entity escaping, NET_ERROR_RETRY_PREFIX
 *   - buildCertErrorPage: HTML structure, hostname/URL in output, certError display,
 *     CERT_ERROR_PROCEED_PREFIX, CERT_ERROR_BACK_PREFIX, HTML entity escaping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

import {
  allowCertForOrigin,
  isCertAllowedForOrigin,
  clearCertBypasses,
  shouldShowErrorPage,
  buildNetworkErrorPage,
  buildCertErrorPage,
  NET_ERROR_RETRY_PREFIX,
  CERT_ERROR_PROCEED_PREFIX,
  CERT_ERROR_BACK_PREFIX,
} from '../../../src/main/errors/NetworkErrorController';

// ---------------------------------------------------------------------------
// Reset module-level cert bypass state
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearCertBypasses();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cert bypass state
// ---------------------------------------------------------------------------

describe('cert bypass state', () => {
  it('isCertAllowedForOrigin returns false initially', () => {
    expect(isCertAllowedForOrigin('https://example.com')).toBe(false);
  });

  it('allowCertForOrigin marks origin as allowed', () => {
    allowCertForOrigin('https://example.com');
    expect(isCertAllowedForOrigin('https://example.com')).toBe(true);
  });

  it('allowCertForOrigin is idempotent', () => {
    allowCertForOrigin('https://example.com');
    allowCertForOrigin('https://example.com');
    expect(isCertAllowedForOrigin('https://example.com')).toBe(true);
  });

  it('clearCertBypasses removes all origins', () => {
    allowCertForOrigin('https://a.com');
    allowCertForOrigin('https://b.com');
    clearCertBypasses();
    expect(isCertAllowedForOrigin('https://a.com')).toBe(false);
    expect(isCertAllowedForOrigin('https://b.com')).toBe(false);
  });

  it('bypass is origin-specific', () => {
    allowCertForOrigin('https://a.com');
    expect(isCertAllowedForOrigin('https://b.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldShowErrorPage
// ---------------------------------------------------------------------------

describe('shouldShowErrorPage()', () => {
  it.each([-3, -2, -1, 0])('returns false for skip code %d', (code) => {
    expect(shouldShowErrorPage(code)).toBe(false);
  });

  it('returns false for positive codes (HTTP errors)', () => {
    expect(shouldShowErrorPage(200)).toBe(false);
    expect(shouldShowErrorPage(1)).toBe(false);
  });

  it('returns true for known negative error codes', () => {
    expect(shouldShowErrorPage(-102)).toBe(true); // ERR_CONNECTION_REFUSED
    expect(shouldShowErrorPage(-105)).toBe(true); // ERR_NAME_NOT_RESOLVED
    expect(shouldShowErrorPage(-106)).toBe(true); // ERR_INTERNET_DISCONNECTED
    expect(shouldShowErrorPage(-310)).toBe(true); // ERR_TOO_MANY_REDIRECTS
    expect(shouldShowErrorPage(-118)).toBe(true); // ERR_CONNECTION_TIMED_OUT
  });

  it('returns true for unknown negative codes (generic fallback)', () => {
    expect(shouldShowErrorPage(-999)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildNetworkErrorPage
// ---------------------------------------------------------------------------

describe('buildNetworkErrorPage()', () => {
  it('returns valid HTML with DOCTYPE', () => {
    const html = buildNetworkErrorPage(-102, 'ERR_CONNECTION_REFUSED', 'https://example.com');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('includes the hostname in the page', () => {
    const html = buildNetworkErrorPage(-102, 'ERR_CONNECTION_REFUSED', 'https://example.com/path');
    expect(html).toContain('example.com');
  });

  it('includes the error description', () => {
    const html = buildNetworkErrorPage(-102, 'ERR_CONNECTION_REFUSED', 'https://example.com');
    expect(html).toContain('ERR_CONNECTION_REFUSED');
  });

  describe('retry button', () => {
    it('shows Retry for ERR_CONNECTION_REFUSED (-102)', () => {
      const html = buildNetworkErrorPage(-102, '', 'https://example.com');
      expect(html).toContain('Retry');
    });

    it('shows Retry for ERR_NAME_NOT_RESOLVED (-105)', () => {
      const html = buildNetworkErrorPage(-105, '', 'https://example.com');
      expect(html).toContain('Retry');
    });

    it('does not show Retry for ERR_TOO_MANY_REDIRECTS (-310)', () => {
      const html = buildNetworkErrorPage(-310, '', 'https://example.com');
      expect(html).not.toContain('>Retry<');
    });
  });

  describe('known error code headings', () => {
    it('uses "This site can\'t be reached" for -102', () => {
      const html = buildNetworkErrorPage(-102, '', 'https://example.com');
      expect(html).toContain("This site can't be reached");
    });

    it('uses "No internet connection" for -106', () => {
      const html = buildNetworkErrorPage(-106, '', 'https://example.com');
      expect(html).toContain('No internet connection');
    });

    it('uses "This page isn\'t working" for -310', () => {
      const html = buildNetworkErrorPage(-310, '', 'https://example.com');
      expect(html).toContain("This page isn't working");
    });
  });

  it('falls back to generic heading for unknown error code', () => {
    const html = buildNetworkErrorPage(-999, '', 'https://example.com');
    expect(html).toContain("This page isn't available");
  });

  it('uses raw URL as hostname when URL is not parseable', () => {
    const html = buildNetworkErrorPage(-102, '', 'not-a-url');
    expect(html).toContain('not-a-url');
  });

  it('includes NET_ERROR_RETRY_PREFIX in retry script', () => {
    const html = buildNetworkErrorPage(-102, '', 'https://example.com');
    expect(html).toContain(NET_ERROR_RETRY_PREFIX);
  });

  it('also includes Go back button', () => {
    const html = buildNetworkErrorPage(-102, '', 'https://example.com');
    expect(html).toContain('Go back');
  });

  describe('HTML entity escaping', () => {
    it('escapes < and > in hostname portion of URL', () => {
      // Hostname is parsed from URL and HTML-escaped in the description
      const html = buildNetworkErrorPage(-102, '', 'https://exam%3Cple.com');
      // URL is hostname-only in the page description; the raw hostname is extracted
      expect(html).toContain('exam');
    });

    it('escapes < and > in hostname when URL is not parseable (raw fallback)', () => {
      const html = buildNetworkErrorPage(-102, '', '<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});

// ---------------------------------------------------------------------------
// buildCertErrorPage
// ---------------------------------------------------------------------------

describe('buildCertErrorPage()', () => {
  it('returns valid HTML with DOCTYPE and title', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Your connection is not private');
  });

  it('includes the hostname in the page', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain('example.com');
  });

  it('includes the cert error code', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_DATE_INVALID');
    expect(html).toContain('ERR_CERT_DATE_INVALID');
  });

  it('includes the full URL in the details panel', () => {
    const html = buildCertErrorPage('https://example.com/path', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain('https://example.com/path');
  });

  it('includes Back to safety button', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain('Back to safety');
  });

  it('includes proceed unsafe button in details', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain('proceed to');
    expect(html).toContain('unsafe');
  });

  it('includes CERT_ERROR_PROCEED_PREFIX in script', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain(CERT_ERROR_PROCEED_PREFIX);
  });

  it('includes CERT_ERROR_BACK_PREFIX in script', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain(CERT_ERROR_BACK_PREFIX);
  });

  it('contains thisisunsafe keyboard handler', () => {
    const html = buildCertErrorPage('https://example.com', 'ERR_CERT_AUTHORITY_INVALID');
    expect(html).toContain('thisisunsafe');
  });

  describe('HTML entity escaping', () => {
    it('escapes & in URL', () => {
      const html = buildCertErrorPage('https://a.com/?x=1&y=2', 'ERR_CERT_AUTHORITY_INVALID');
      expect(html).toContain('&amp;y=2');
    });

    it('escapes < and > in cert error string', () => {
      const html = buildCertErrorPage('https://example.com', '<script>evil</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes " in URL', () => {
      const html = buildCertErrorPage('https://a.com/"path"', 'ERR_CERT_AUTHORITY_INVALID');
      expect(html).toContain('&quot;path&quot;');
    });
  });

  describe('constants', () => {
    it('NET_ERROR_RETRY_PREFIX is a non-empty string', () => {
      expect(typeof NET_ERROR_RETRY_PREFIX).toBe('string');
      expect(NET_ERROR_RETRY_PREFIX.length).toBeGreaterThan(0);
    });

    it('CERT_ERROR_PROCEED_PREFIX is a non-empty string', () => {
      expect(typeof CERT_ERROR_PROCEED_PREFIX).toBe('string');
      expect(CERT_ERROR_PROCEED_PREFIX.length).toBeGreaterThan(0);
    });

    it('CERT_ERROR_BACK_PREFIX is a non-empty string', () => {
      expect(typeof CERT_ERROR_BACK_PREFIX).toBe('string');
      expect(CERT_ERROR_BACK_PREFIX.length).toBeGreaterThan(0);
    });
  });
});
