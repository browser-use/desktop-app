/**
 * PasswordCheckup unit tests.
 *
 * Tests cover:
 *   - Empty inputs returns empty results
 *   - Weak password detection: too short, common passwords, low complexity
 *   - Reused password detection across multiple credentials
 *   - Breach detection via mocked HIBP response
 *   - HIBP fetch failure: returns results with weak/reused flags, breachCount=0
 *   - onProgress callback fires for each checked credential
 *   - Multiple flags can be set on one entry (compromised + reused + weak)
 *   - No flags for a strong, unique, uncompromised password
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

// Build a controllable mock for electron.net.request
const { mockNetRequest } = vi.hoisted(() => ({ mockNetRequest: vi.fn() }));

vi.mock('electron', () => ({
  net: {
    request: mockNetRequest,
  },
}));

import { runPasswordCheckup, type CheckupInput } from '../../../src/main/passwords/PasswordCheckup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input, 'utf-8').digest('hex').toUpperCase();
}

/** Build a HIBP-style response body that includes a match for the given plaintext. */
function hibpBodyWithMatch(plaintext: string, count = 5): string {
  const hash = sha1Hex(plaintext);
  const suffix = hash.substring(5);
  // Include a few padding lines plus the actual match
  return `AAAAABBBBBCCCCC:0\n${suffix}:${count}\nDDDDDEEEEEFFFFF:0\n`;
}

/** Build a HIBP-style response body with no match for any of the plaintexts. */
function hibpBodyNoMatch(): string {
  return 'AAAAABBBBBCCCCC:0\nDDDDDEEEEEFFFFF:0\n';
}

function makeInput(overrides: Partial<CheckupInput> & { id: string; plaintext: string }): CheckupInput {
  return {
    origin: 'https://example.com',
    username: 'user@example.com',
    ...overrides,
  };
}

/**
 * Set up the net.request mock to return a successful HIBP response with the
 * given body. Each call to `net.request` fires its response handler synchronously.
 */
function setupNetSuccess(body: string): void {
  mockNetRequest.mockImplementation(() => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    return {
      setHeader: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = cb;
      }),
      end: vi.fn(() => {
        // Simulate successful response
        const responseCbs: Record<string, (data?: unknown) => void> = {};
        const response = {
          statusCode: 200,
          on: (event: string, cb: (data?: unknown) => void) => {
            responseCbs[event] = cb;
          },
        };
        listeners['response']?.(response);
        responseCbs['data']?.(Buffer.from(body, 'utf-8'));
        responseCbs['end']?.();
      }),
    };
  });
}

/** Set up net.request to fail with a network error. */
function setupNetError(message = 'Network error'): void {
  mockNetRequest.mockImplementation(() => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    return {
      setHeader: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = cb;
      }),
      end: vi.fn(() => {
        listeners['error']?.(new Error(message));
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPasswordCheckup()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty inputs', async () => {
    const results = await runPasswordCheckup([]);
    expect(results).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Weak password detection
  // ---------------------------------------------------------------------------

  describe('weak password detection', () => {
    it('flags passwords shorter than 8 characters as weak', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'Ab1!' })]);
      expect(result[0].flags).toContain('weak');
    });

    it('flags common passwords as weak', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'password' })]);
      expect(result[0].flags).toContain('weak');
    });

    it('flags passwords with fewer than 3 character classes as weak', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      // Only lowercase: 1 class
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'abcdefghij' })]);
      expect(result[0].flags).toContain('weak');
    });

    it('does not flag a strong password as weak', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'Str0ng!Pass#2' })]);
      expect(result[0].flags).not.toContain('weak');
    });

    it('does not flag a password with 3+ char classes as weak (even if 8 chars)', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      // lowercase + uppercase + number = 3 classes
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'Abcde123' })]);
      expect(result[0].flags).not.toContain('weak');
    });
  });

  // ---------------------------------------------------------------------------
  // Reused password detection
  // ---------------------------------------------------------------------------

  describe('reused password detection', () => {
    it('flags two entries with the same password as reused', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const inputs = [
        makeInput({ id: '1', plaintext: 'Str0ng!Pass#2', origin: 'https://a.com' }),
        makeInput({ id: '2', plaintext: 'Str0ng!Pass#2', origin: 'https://b.com' }),
      ];
      const results = await runPasswordCheckup(inputs);
      const r1 = results.find((r) => r.id === '1')!;
      const r2 = results.find((r) => r.id === '2')!;
      expect(r1.flags).toContain('reused');
      expect(r2.flags).toContain('reused');
    });

    it('does not flag unique passwords as reused', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const inputs = [
        makeInput({ id: '1', plaintext: 'Uniq!Pass#A1' }),
        makeInput({ id: '2', plaintext: 'Diff!Pass#B2' }),
      ];
      const results = await runPasswordCheckup(inputs);
      expect(results[0].flags).not.toContain('reused');
      expect(results[1].flags).not.toContain('reused');
    });

    it('three entries with the same password are all reused', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const inputs = [
        makeInput({ id: '1', plaintext: 'Same!Pass#X9', origin: 'https://a.com' }),
        makeInput({ id: '2', plaintext: 'Same!Pass#X9', origin: 'https://b.com' }),
        makeInput({ id: '3', plaintext: 'Same!Pass#X9', origin: 'https://c.com' }),
      ];
      const results = await runPasswordCheckup(inputs);
      for (const r of results) {
        expect(r.flags).toContain('reused');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Breach detection
  // ---------------------------------------------------------------------------

  describe('breach detection', () => {
    it('flags a compromised password', async () => {
      const plain = 'Str0ng!Pass#2';
      setupNetSuccess(hibpBodyWithMatch(plain, 100));
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: plain })]);
      expect(result[0].flags).toContain('compromised');
      expect(result[0].breachCount).toBe(100);
    });

    it('does not flag a password not in the breach database', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'Str0ng!Pass#2' })]);
      expect(result[0].flags).not.toContain('compromised');
      expect(result[0].breachCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple flags
  // ---------------------------------------------------------------------------

  describe('multiple flags', () => {
    it('can have both compromised and weak flags', async () => {
      const plain = 'password'; // common + in breach DB
      setupNetSuccess(hibpBodyWithMatch(plain, 50));
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: plain })]);
      expect(result[0].flags).toContain('compromised');
      expect(result[0].flags).toContain('weak');
    });

    it('can have reused + weak flags', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const inputs = [
        makeInput({ id: '1', plaintext: 'weakpwd', origin: 'https://a.com' }), // short → weak
        makeInput({ id: '2', plaintext: 'weakpwd', origin: 'https://b.com' }), // reused + weak
      ];
      const results = await runPasswordCheckup(inputs);
      for (const r of results) {
        expect(r.flags).toContain('reused');
        expect(r.flags).toContain('weak');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // HIBP fetch failure
  // ---------------------------------------------------------------------------

  describe('when HIBP fetch fails', () => {
    it('still returns results (breachCount=0)', async () => {
      setupNetError('Connection refused');
      const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'Str0ng!Pass#2' })]);
      expect(result).toHaveLength(1);
      expect(result[0].breachCount).toBe(0);
      expect(result[0].flags).not.toContain('compromised');
    });

    it('still reports weak/reused flags when HIBP fails', async () => {
      setupNetError();
      const inputs = [
        makeInput({ id: '1', plaintext: 'short', origin: 'https://a.com' }), // weak
        makeInput({ id: '2', plaintext: 'short', origin: 'https://b.com' }), // reused + weak
      ];
      const results = await runPasswordCheckup(inputs);
      expect(results.find((r) => r.id === '1')!.flags).toContain('weak');
      expect(results.find((r) => r.id === '2')!.flags).toContain('reused');
    });
  });

  // ---------------------------------------------------------------------------
  // onProgress callback
  // ---------------------------------------------------------------------------

  describe('onProgress callback', () => {
    it('fires once per credential', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const onProgress = vi.fn();
      const inputs = [
        makeInput({ id: '1', plaintext: 'Uniq!Pass#A1' }),
        makeInput({ id: '2', plaintext: 'Diff!Pass#B2' }),
      ];
      await runPasswordCheckup(inputs, onProgress);
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('reports correct checked/total values', async () => {
      setupNetSuccess(hibpBodyNoMatch());
      const calls: Array<[number, number]> = [];
      const inputs = [
        makeInput({ id: '1', plaintext: 'Uniq!Pass#A1' }),
        makeInput({ id: '2', plaintext: 'Diff!Pass#B2' }),
        makeInput({ id: '3', plaintext: 'Anot!Pass#C3' }),
      ];
      await runPasswordCheckup(inputs, (checked, total) => calls.push([checked, total]));
      expect(calls.every(([, total]) => total === 3)).toBe(true);
      const checkedValues = calls.map(([checked]) => checked).sort((a, b) => a - b);
      expect(checkedValues).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // No flags for safe password
  // ---------------------------------------------------------------------------

  it('returns no flags for a strong, unique, uncompromised password', async () => {
    setupNetSuccess(hibpBodyNoMatch());
    const result = await runPasswordCheckup([makeInput({ id: '1', plaintext: 'Str0ng!Pass#2' })]);
    expect(result[0].flags).toHaveLength(0);
    expect(result[0].breachCount).toBe(0);
  });
});
