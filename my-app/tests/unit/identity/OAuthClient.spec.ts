/**
 * OAuthClient unit tests.
 *
 * Tests cover:
 *   - PKCE code_verifier + code_challenge generation (RFC 7636)
 *   - Scope mapping (service names → Google OAuth scope strings)
 *
 * The loopback server + full OAuth flow are tested via integration tests,
 * not unit tests, since they require a real HTTP server lifecycle.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual };
});

vi.mock('node:https', () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-userData'),
  },
}));

import {
  generatePKCE,
  SERVICE_SCOPE_MAP,
} from '../../../src/main/identity/OAuthClient';

// ---------------------------------------------------------------------------
// generatePKCE
// ---------------------------------------------------------------------------

describe('generatePKCE', () => {
  it('returns a code_verifier of length 43–128 characters (RFC 7636 §4.1)', () => {
    const { codeVerifier } = generatePKCE();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it('code_verifier uses only unreserved characters [A-Za-z0-9-._~]', () => {
    const { codeVerifier } = generatePKCE();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('code_challenge is base64url-encoded SHA-256 of code_verifier', async () => {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const { createHash } = await import('crypto');
    const expected = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('two calls produce distinct code_verifiers (entropy check)', () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

// ---------------------------------------------------------------------------
// SERVICE_SCOPE_MAP
// ---------------------------------------------------------------------------

describe('SERVICE_SCOPE_MAP', () => {
  it('maps gmail to gmail.readonly scope', () => {
    expect(SERVICE_SCOPE_MAP.gmail).toContain(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
  });

  it('maps calendar to calendar scope', () => {
    expect(SERVICE_SCOPE_MAP.calendar).toContain(
      'https://www.googleapis.com/auth/calendar',
    );
  });

  it('maps sheets to spreadsheets scope', () => {
    expect(SERVICE_SCOPE_MAP.sheets).toContain(
      'https://www.googleapis.com/auth/spreadsheets',
    );
  });

  it('maps drive to drive scope', () => {
    expect(SERVICE_SCOPE_MAP.drive).toContain(
      'https://www.googleapis.com/auth/drive',
    );
  });

  it('maps docs to documents scope', () => {
    expect(SERVICE_SCOPE_MAP.docs).toContain(
      'https://www.googleapis.com/auth/documents',
    );
  });
});
