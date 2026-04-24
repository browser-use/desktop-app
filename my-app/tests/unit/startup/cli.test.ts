/**
 * Regression tests for startup CLI flag parsing.
 *
 * Covers the two issues bundled together:
 *   #206 — --user-data-dir=<path> must override AGB_USER_DATA_DIR env var
 *   #207 — --remote-debugging-port=<N> must be honored instead of the
 *          hardcoded 9222
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractFlagValue,
  resolveUserDataDir,
  resolveCdpPort,
  setAnnouncedCdpPort,
  getAnnouncedCdpPort,
} from '../../../src/main/startup/cli';

// ---------------------------------------------------------------------------
// extractFlagValue
// ---------------------------------------------------------------------------

describe('extractFlagValue', () => {
  it('returns value for --flag=value form', () => {
    expect(extractFlagValue(['--foo=bar'], 'foo')).toBe('bar');
  });

  it('returns value for --flag value form (two args)', () => {
    expect(extractFlagValue(['--foo', 'bar'], 'foo')).toBe('bar');
  });

  it('returns null when flag is absent', () => {
    expect(extractFlagValue(['--other=1'], 'foo')).toBeNull();
  });

  it('returns null when --flag= has empty value', () => {
    expect(extractFlagValue(['--foo='], 'foo')).toBeNull();
  });

  it('ignores flags with a matching prefix but different name', () => {
    expect(extractFlagValue(['--foobar=baz'], 'foo')).toBeNull();
  });

  it('picks the first occurrence when repeated', () => {
    expect(extractFlagValue(['--foo=a', '--foo=b'], 'foo')).toBe('a');
  });

  it('does not treat the next flag-like arg as a value', () => {
    expect(extractFlagValue(['--foo', '--bar'], 'foo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveUserDataDir — Issue #206
// ---------------------------------------------------------------------------

describe('resolveUserDataDir (#206)', () => {
  it('honors --user-data-dir CLI flag', () => {
    const r = resolveUserDataDir(['--user-data-dir=/tmp/cli-dir'], {});
    expect(r.value).toBe('/tmp/cli-dir');
    expect(r.source).toBe('cli');
  });

  it('honors AGB_USER_DATA_DIR env var when CLI flag absent', () => {
    const r = resolveUserDataDir([], { AGB_USER_DATA_DIR: '/tmp/env-dir' });
    expect(r.value).toBe('/tmp/env-dir');
    expect(r.source).toBe('env');
  });

  it('CLI flag wins over env var (documented precedence)', () => {
    const r = resolveUserDataDir(
      ['--user-data-dir=/tmp/cli-dir'],
      { AGB_USER_DATA_DIR: '/tmp/env-dir' },
    );
    expect(r.value).toBe('/tmp/cli-dir');
    expect(r.source).toBe('cli');
  });

  it('returns null source when neither CLI nor env is set', () => {
    const r = resolveUserDataDir([], {});
    expect(r.value).toBeNull();
    expect(r.source).toBeNull();
  });

  it('ignores an empty AGB_USER_DATA_DIR value', () => {
    const r = resolveUserDataDir([], { AGB_USER_DATA_DIR: '' });
    expect(r.value).toBeNull();
    expect(r.source).toBeNull();
  });

  it('handles the exact launcher-shaped argv (Playwright electron.launch)', () => {
    // Shape matches tests/setup/electron-launcher.ts line ~109
    const argv = [
      '/path/to/electron',
      '/path/to/main.js',
      '--user-data-dir=/tmp/agb-test-abc',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
    ];
    const r = resolveUserDataDir(argv, {});
    expect(r.value).toBe('/tmp/agb-test-abc');
    expect(r.source).toBe('cli');
  });
});

// ---------------------------------------------------------------------------
// resolveCdpPort — Issue #207
// ---------------------------------------------------------------------------

const DYNAMIC_RANGE = { min: 49152, max: 65535 } as const;

describe('resolveCdpPort', () => {
  it('picks a random port in the IANA dynamic range when no override is given', () => {
    // No CLI flag, no AGB_CDP_PORT env → random avoids colliding with any
    // user-run Chrome on 9222. We assert the range, not the exact value.
    delete process.env.AGB_CDP_PORT;
    const r = resolveCdpPort([]);
    expect(r.port).toBeGreaterThanOrEqual(DYNAMIC_RANGE.min);
    expect(r.port).toBeLessThanOrEqual(DYNAMIC_RANGE.max);
    expect(r.source).toBe('random');
  });

  it('honors --remote-debugging-port=9225', () => {
    const r = resolveCdpPort(['--remote-debugging-port=9225']);
    expect(r.port).toBe(9225);
    expect(r.source).toBe('cli');
  });

  it('honors --remote-debugging-port=0 (OS-assigned)', () => {
    const r = resolveCdpPort(['--remote-debugging-port=0']);
    expect(r.port).toBe(0);
    expect(r.source).toBe('cli');
  });

  it('honors two-arg form --remote-debugging-port 9226', () => {
    const r = resolveCdpPort(['--remote-debugging-port', '9226']);
    expect(r.port).toBe(9226);
    expect(r.source).toBe('cli');
  });

  it('falls through to random for malformed port value', () => {
    delete process.env.AGB_CDP_PORT;
    const r = resolveCdpPort(['--remote-debugging-port=not-a-number']);
    expect(r.port).toBeGreaterThanOrEqual(DYNAMIC_RANGE.min);
    expect(r.source).toBe('random');
  });

  it('falls through to random for out-of-range port value', () => {
    delete process.env.AGB_CDP_PORT;
    const r = resolveCdpPort(['--remote-debugging-port=99999']);
    expect(r.port).toBeGreaterThanOrEqual(DYNAMIC_RANGE.min);
    expect(r.source).toBe('random');
  });

  it('falls through to random for negative port value', () => {
    delete process.env.AGB_CDP_PORT;
    const r = resolveCdpPort(['--remote-debugging-port=-1']);
    expect(r.port).toBeGreaterThanOrEqual(DYNAMIC_RANGE.min);
    expect(r.source).toBe('random');
  });

  it('honors AGB_CDP_PORT env when no CLI flag is given', () => {
    process.env.AGB_CDP_PORT = '9227';
    try {
      const r = resolveCdpPort([]);
      expect(r.port).toBe(9227);
      expect(r.source).toBe('env');
    } finally {
      delete process.env.AGB_CDP_PORT;
    }
  });

  it('CLI flag beats AGB_CDP_PORT env', () => {
    process.env.AGB_CDP_PORT = '9227';
    try {
      const r = resolveCdpPort(['--remote-debugging-port=9225']);
      expect(r.port).toBe(9225);
      expect(r.source).toBe('cli');
    } finally {
      delete process.env.AGB_CDP_PORT;
    }
  });

  it('handles exact multi-instance test argv (explicit port)', () => {
    // tests/e2e/multi-instance.spec.ts uses explicit 9225/9226
    const argv = [
      '/electron',
      '/main.js',
      '--user-data-dir=/tmp/inst-a',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=9225',
    ];
    const r = resolveCdpPort(argv);
    expect(r.port).toBe(9225);
    expect(r.source).toBe('cli');
  });
});

// ---------------------------------------------------------------------------
// Announced CDP port module-level store
// ---------------------------------------------------------------------------

describe('announced CDP port', () => {
  beforeEach(() => {
    setAnnouncedCdpPort(9222);  // arbitrary seed for the tests below
  });

  it('returns whatever seed was set', () => {
    expect(getAnnouncedCdpPort()).toBe(9222);
  });

  it('returns whatever was last set', () => {
    setAnnouncedCdpPort(9225);
    expect(getAnnouncedCdpPort()).toBe(9225);
  });

  it('preserves 0 so consumers know to fall back to discovery', () => {
    setAnnouncedCdpPort(0);
    expect(getAnnouncedCdpPort()).toBe(0);
  });
});
