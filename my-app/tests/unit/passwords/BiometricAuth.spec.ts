/**
 * BiometricAuth unit tests.
 *
 * Tests cover:
 *   - isBiometricAvailable: returns false on non-darwin
 *   - isBiometricAvailable: defers to systemPreferences.canPromptTouchID on darwin
 *   - isBiometricEnabled: reads the biometricPasswordLock pref
 *   - promptBiometric: skipped (resolves true) when disabled
 *   - promptBiometric: skipped (resolves true) when enabled but unavailable
 *   - promptBiometric: success path resolves true
 *   - promptBiometric: failure (promptTouchID throws) resolves false
 *   - requireBiometric: throws on failure, returns void on success
 *
 * No real Touch ID hardware is exercised — systemPreferences is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { systemPreferencesStub, readPrefsSpy, loggerSpy } = vi.hoisted(() => ({
  systemPreferencesStub: {
    canPromptTouchID: vi.fn(() => true),
    promptTouchID: vi.fn(() => Promise.resolve()),
  },
  readPrefsSpy: vi.fn<() => Record<string, unknown>>(() => ({})),
  loggerSpy: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  systemPreferences: systemPreferencesStub,
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: loggerSpy,
}));

vi.mock('../../../src/main/settings/ipc', () => ({
  readPrefs: readPrefsSpy,
}));

import {
  isBiometricAvailable,
  isBiometricEnabled,
  promptBiometric,
  requireBiometric,
} from '../../../src/main/passwords/BiometricAuth';

beforeEach(() => {
  systemPreferencesStub.canPromptTouchID.mockReset();
  systemPreferencesStub.canPromptTouchID.mockReturnValue(true);
  systemPreferencesStub.promptTouchID.mockReset();
  systemPreferencesStub.promptTouchID.mockResolvedValue(undefined);
  readPrefsSpy.mockReset();
  readPrefsSpy.mockReturnValue({});
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

describe('isBiometricAvailable', () => {
  it('returns false on non-darwin platforms without touching systemPreferences', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(isBiometricAvailable()).toBe(false);
    expect(systemPreferencesStub.canPromptTouchID).not.toHaveBeenCalled();
  });

  it('defers to systemPreferences.canPromptTouchID on darwin (true)', () => {
    systemPreferencesStub.canPromptTouchID.mockReturnValue(true);
    expect(isBiometricAvailable()).toBe(true);
    expect(systemPreferencesStub.canPromptTouchID).toHaveBeenCalledTimes(1);
  });

  it('defers to systemPreferences.canPromptTouchID on darwin (false)', () => {
    systemPreferencesStub.canPromptTouchID.mockReturnValue(false);
    expect(isBiometricAvailable()).toBe(false);
  });
});

describe('isBiometricEnabled', () => {
  it('returns true when prefs.biometricPasswordLock is true', () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: true });
    expect(isBiometricEnabled()).toBe(true);
  });

  it('returns false when prefs.biometricPasswordLock is missing', () => {
    readPrefsSpy.mockReturnValue({});
    expect(isBiometricEnabled()).toBe(false);
  });

  it('returns false when prefs.biometricPasswordLock is false', () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: false });
    expect(isBiometricEnabled()).toBe(false);
  });
});

describe('promptBiometric', () => {
  it('resolves true and skips the prompt when biometric is not enabled', async () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: false });
    await expect(promptBiometric('reveal a saved password')).resolves.toBe(true);
    expect(systemPreferencesStub.promptTouchID).not.toHaveBeenCalled();
  });

  it('resolves true when enabled but biometric is unavailable (graceful degrade)', async () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: true });
    systemPreferencesStub.canPromptTouchID.mockReturnValue(false);
    await expect(promptBiometric('reveal')).resolves.toBe(true);
    expect(systemPreferencesStub.promptTouchID).not.toHaveBeenCalled();
  });

  it('resolves true on Touch ID success', async () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: true });
    systemPreferencesStub.canPromptTouchID.mockReturnValue(true);
    systemPreferencesStub.promptTouchID.mockResolvedValueOnce(undefined);
    await expect(promptBiometric('reveal')).resolves.toBe(true);
    expect(systemPreferencesStub.promptTouchID).toHaveBeenCalledWith('reveal');
  });

  it('resolves false on Touch ID failure', async () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: true });
    systemPreferencesStub.canPromptTouchID.mockReturnValue(true);
    systemPreferencesStub.promptTouchID.mockRejectedValueOnce(new Error('user cancelled'));
    await expect(promptBiometric('reveal')).resolves.toBe(false);
  });
});

describe('requireBiometric', () => {
  it('returns void on success', async () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: true });
    await expect(requireBiometric('reveal')).resolves.toBeUndefined();
  });

  it('throws when biometric prompt fails', async () => {
    readPrefsSpy.mockReturnValue({ biometricPasswordLock: true });
    systemPreferencesStub.promptTouchID.mockRejectedValueOnce(new Error('cancelled'));
    await expect(requireBiometric('reveal')).rejects.toThrow(/Biometric authentication required/);
  });
});
