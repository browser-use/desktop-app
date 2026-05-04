import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loggerSpy,
  mockGlobalShortcut,
  userDataPath,
} = vi.hoisted(() => ({
  loggerSpy: { info: vi.fn(), warn: vi.fn() },
  mockGlobalShortcut: {
    register: vi.fn((_accelerator: string, _callback: () => void) => true),
    isRegistered: vi.fn((_accelerator: string) => true),
    unregister: vi.fn(),
  },
  userDataPath: `/tmp/BrowserUseDesktop-hotkeys-test-${process.pid}`,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => userDataPath),
  },
  globalShortcut: mockGlobalShortcut,
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const EXPECTED_DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space';

const CUSTOM_ACCELERATOR = 'CommandOrControl+Alt+Space';

function hotkeysStorePath(): string {
  return path.join(userDataPath, 'hotkeys.json');
}

async function loadHotkeys() {
  vi.resetModules();
  return import('../../../src/main/hotkeys');
}

function readSavedAccelerator(): string | null {
  try {
    const raw = fs.readFileSync(hotkeysStorePath(), 'utf-8');
    return (JSON.parse(raw) as { globalCmdbar?: string }).globalCmdbar ?? null;
  } catch {
    return null;
  }
}

describe('main/hotkeys.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(userDataPath, { recursive: true, force: true });
    fs.mkdirSync(userDataPath, { recursive: true });
    mockGlobalShortcut.register.mockReturnValue(true);
    mockGlobalShortcut.isRegistered.mockReturnValue(true);
  });

  it('persists onboarding-selected shortcuts before the app hotkey callback exists', async () => {
    const hotkeys = await loadHotkeys();

    const result = hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    expect(result).toEqual({ ok: true, accelerator: CUSTOM_ACCELERATOR });
    expect(readSavedAccelerator()).toBe(CUSTOM_ACCELERATOR);
    expect(mockGlobalShortcut.register).not.toHaveBeenCalled();

    const reloadedHotkeys = await loadHotkeys();
    const callback = vi.fn();

    expect(reloadedHotkeys.registerHotkeys(callback)).toBe(true);
    expect(mockGlobalShortcut.register).toHaveBeenLastCalledWith(CUSTOM_ACCELERATOR, expect.any(Function));
  });

  it('re-registers and saves settings changes once the app callback exists', async () => {
    const hotkeys = await loadHotkeys();
    const callback = vi.fn();
    hotkeys.registerHotkeys(callback);

    const result = hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    expect(result).toEqual({ ok: true, accelerator: CUSTOM_ACCELERATOR });
    expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith(EXPECTED_DEFAULT_ACCELERATOR);
    expect(mockGlobalShortcut.register).toHaveBeenLastCalledWith(CUSTOM_ACCELERATOR, expect.any(Function));
    expect(readSavedAccelerator()).toBe(CUSTOM_ACCELERATOR);
    expect(hotkeys.getGlobalCmdbarAccelerator()).toBe(CUSTOM_ACCELERATOR);
  });

  it('swaps callbacks without re-registering an already active shortcut', async () => {
    const hotkeys = await loadHotkeys();
    const onboardingCallback = vi.fn();
    const shellCallback = vi.fn();

    expect(hotkeys.registerHotkeys(onboardingCallback)).toBe(true);
    expect(hotkeys.registerHotkeys(shellCallback)).toBe(true);

    expect(mockGlobalShortcut.unregister).not.toHaveBeenCalled();
    expect(mockGlobalShortcut.register).toHaveBeenCalledTimes(1);

    const registeredCallback = mockGlobalShortcut.register.mock.calls[0][1] as () => void;
    registeredCallback();

    expect(onboardingCallback).not.toHaveBeenCalled();
    expect(shellCallback).toHaveBeenCalledTimes(1);
  });

  it('normalizes duplicated modifiers from older saved shortcuts before registering', async () => {
    fs.writeFileSync(
      hotkeysStorePath(),
      JSON.stringify({ globalCmdbar: 'CommandOrControl+CommandOrControl+Alt+Space' }),
      'utf-8',
    );
    const hotkeys = await loadHotkeys();

    expect(hotkeys.registerHotkeys(vi.fn())).toBe(true);

    expect(mockGlobalShortcut.register).toHaveBeenLastCalledWith(CUSTOM_ACCELERATOR, expect.any(Function));
    expect(hotkeys.getGlobalCmdbarAccelerator()).toBe(CUSTOM_ACCELERATOR);
    expect(readSavedAccelerator()).toBe(CUSTOM_ACCELERATOR);
  });

  it('repairs a saved shortcut when Electron no longer reports it registered', async () => {
    const hotkeys = await loadHotkeys();
    const callback = vi.fn();
    hotkeys.registerHotkeys(callback);
    hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    mockGlobalShortcut.register.mockClear();
    mockGlobalShortcut.unregister.mockClear();
    mockGlobalShortcut.isRegistered.mockImplementation((accelerator: string) => accelerator !== CUSTOM_ACCELERATOR);

    const result = hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    expect(result).toEqual({ ok: false, accelerator: EXPECTED_DEFAULT_ACCELERATOR });
    expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith(CUSTOM_ACCELERATOR);
    expect(mockGlobalShortcut.register).toHaveBeenCalledWith(CUSTOM_ACCELERATOR, expect.any(Function));
    expect(mockGlobalShortcut.register).toHaveBeenLastCalledWith(EXPECTED_DEFAULT_ACCELERATOR, expect.any(Function));
    expect(readSavedAccelerator()).toBe(EXPECTED_DEFAULT_ACCELERATOR);
  });

  it('falls back to the default when the saved startup shortcut is unavailable', async () => {
    const hotkeys = await loadHotkeys();
    hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    const reloadedHotkeys = await loadHotkeys();
    const callback = vi.fn();
    mockGlobalShortcut.register.mockImplementation((accelerator: string) => accelerator !== CUSTOM_ACCELERATOR);

    expect(reloadedHotkeys.registerHotkeys(callback)).toBe(true);
    expect(mockGlobalShortcut.register).toHaveBeenCalledWith(CUSTOM_ACCELERATOR, expect.any(Function));
    expect(mockGlobalShortcut.register).toHaveBeenLastCalledWith(EXPECTED_DEFAULT_ACCELERATOR, expect.any(Function));
    expect(reloadedHotkeys.getGlobalCmdbarAccelerator()).toBe(EXPECTED_DEFAULT_ACCELERATOR);
    expect(readSavedAccelerator()).toBe(EXPECTED_DEFAULT_ACCELERATOR);
  });

  it('rolls back to the previously registered shortcut when a settings change fails', async () => {
    const hotkeys = await loadHotkeys();
    const callback = vi.fn();
    hotkeys.registerHotkeys(callback);

    mockGlobalShortcut.register.mockImplementation((accelerator: string) => accelerator !== CUSTOM_ACCELERATOR);

    const result = hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    expect(result).toEqual({ ok: false, accelerator: EXPECTED_DEFAULT_ACCELERATOR });
    expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith(EXPECTED_DEFAULT_ACCELERATOR);
    expect(mockGlobalShortcut.register).toHaveBeenLastCalledWith(EXPECTED_DEFAULT_ACCELERATOR, expect.any(Function));
    expect(readSavedAccelerator()).not.toBe(CUSTOM_ACCELERATOR);
    expect(hotkeys.getGlobalCmdbarAccelerator()).toBe(EXPECTED_DEFAULT_ACCELERATOR);
  });

  it('does not unregister a failed rollback that Electron never actually registered', async () => {
    const hotkeys = await loadHotkeys();
    const callback = vi.fn();
    hotkeys.registerHotkeys(callback);

    mockGlobalShortcut.register.mockReturnValue(true);
    mockGlobalShortcut.isRegistered.mockImplementation((accelerator: string) => {
      return accelerator !== CUSTOM_ACCELERATOR && accelerator !== EXPECTED_DEFAULT_ACCELERATOR;
    });

    const result = hotkeys.setGlobalCmdbarAccelerator(CUSTOM_ACCELERATOR);

    expect(result).toEqual({ ok: false, accelerator: EXPECTED_DEFAULT_ACCELERATOR });
    expect(loggerSpy.warn).toHaveBeenCalledWith('hotkeys.set.failed', { hotkey: CUSTOM_ACCELERATOR });

    mockGlobalShortcut.unregister.mockClear();
    hotkeys.unregisterHotkeys();

    expect(mockGlobalShortcut.unregister).not.toHaveBeenCalled();
  });
});
