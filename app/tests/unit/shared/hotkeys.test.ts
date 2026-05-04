import { describe, expect, it } from 'vitest';
import {
  acceleratorToDisplayParts,
  defaultGlobalCmdbarAccelerator,
  formatShortcutForPlatform,
  keyboardEventToShortcut,
  normalizeAccelerator,
  normalizeShortcutPlatform,
  rendererToAccelerator,
  shortcutToRenderer,
} from '../../../src/shared/hotkeys';

describe('acceleratorToDisplayParts', () => {
  it('uses text labels for Linux and Windows modifiers', () => {
    expect(acceleratorToDisplayParts('Alt+Space', 'linux')).toEqual(['Alt', 'Space']);
    expect(acceleratorToDisplayParts('CommandOrControl+Shift+Space', 'win32')).toEqual(['Ctrl', 'Shift', 'Space']);
    expect(acceleratorToDisplayParts('Super+Space', 'linux')).toEqual(['Super', 'Space']);
    expect(acceleratorToDisplayParts('Super+Space', 'win32')).toEqual(['Win', 'Space']);
  });

  it('uses macOS glyphs only on macOS', () => {
    expect(acceleratorToDisplayParts('CommandOrControl+Alt+Space', 'darwin')).toEqual(['\u2318', '\u2325', 'Space']);
  });
});

describe('shortcut platform normalization', () => {
  it('normalizes Electron and browser platform names', () => {
    expect(normalizeShortcutPlatform('darwin')).toBe('darwin');
    expect(normalizeShortcutPlatform('MacIntel')).toBe('darwin');
    expect(normalizeShortcutPlatform('win32')).toBe('win32');
    expect(normalizeShortcutPlatform('Win32')).toBe('win32');
    expect(normalizeShortcutPlatform('Linux x86_64')).toBe('linux');
  });

  it('uses the same global command-bar default on desktop platforms', () => {
    expect(defaultGlobalCmdbarAccelerator('linux')).toBe('CommandOrControl+Shift+Space');
    expect(defaultGlobalCmdbarAccelerator('Linux x86_64')).toBe('CommandOrControl+Shift+Space');
    expect(defaultGlobalCmdbarAccelerator('darwin')).toBe('CommandOrControl+Shift+Space');
    expect(defaultGlobalCmdbarAccelerator('win32')).toBe('CommandOrControl+Shift+Space');
  });


  it('keeps shortcuts platform-neutral until renderer normalization', () => {
    expect(shortcutToRenderer('CommandOrControl+,', 'darwin')).toBe('Cmd+,');
    expect(shortcutToRenderer('CommandOrControl+,', 'linux')).toBe('Ctrl+,');
    expect(shortcutToRenderer('Meta+Space', 'linux')).toBe('Super+Space');
    expect(shortcutToRenderer('Meta+Space', 'win32')).toBe('Win+Space');
  });

  it('formats all shortcut labels through the same platform policy', () => {
    expect(formatShortcutForPlatform('CommandOrControl+Shift+Space', 'darwin')).toBe('\u2318+\u21E7+Space');
    expect(formatShortcutForPlatform('CommandOrControl+Shift+Space', 'linux')).toBe('Ctrl+Shift+Space');
    expect(formatShortcutForPlatform('Alt+Space', 'win32')).toBe('Alt+Space');
  });

  it('captures keyboard events into renderer shortcut strings', () => {
    const event = {
      key: ' ',
      code: 'Space',
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    } as KeyboardEvent;

    expect(keyboardEventToShortcut(event, 'linux')).toBe('Alt+Space');
  });

  it('captures macOS option-space as Space instead of a non-breaking-space glyph', () => {
    const event = {
      key: '\u00A0',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    } as KeyboardEvent;

    const shortcut = keyboardEventToShortcut(event, 'darwin');

    expect(shortcut).toBe('Cmd+Alt+Space');
    expect(rendererToAccelerator(shortcut ?? '')).toBe('CommandOrControl+Alt+Space');
  });

  it('normalizes duplicated command modifiers in saved accelerators', () => {
    expect(normalizeAccelerator('CommandOrControl+CommandOrControl+Alt+Space', 'darwin')).toBe(
      'CommandOrControl+Alt+Space',
    );
  });

  it('preserves a physical Control modifier on macOS when platform is explicit', () => {
    expect(rendererToAccelerator('Cmd+Ctrl+Alt+Space', 'darwin')).toBe(
      'CommandOrControl+Control+Alt+Space',
    );
  });

  it('keeps renderer Cmd labels ctrl-equivalent on Windows and Linux', () => {
    expect(rendererToAccelerator('Cmd+Shift+Space', 'linux')).toBe('CommandOrControl+Shift+Space');
    expect(rendererToAccelerator('Command+Shift+Space', 'win32')).toBe('CommandOrControl+Shift+Space');
  });

  it('keeps shift when capturing space shortcuts', () => {
    const event = {
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    } as KeyboardEvent;

    const shortcut = keyboardEventToShortcut(event, 'darwin');

    expect(shortcut).toBe('Cmd+Shift+Space');
    expect(rendererToAccelerator(shortcut ?? '')).toBe('CommandOrControl+Shift+Space');
  });

  it('ignores unidentified keys during shortcut capture', () => {
    const event = {
      key: 'Unidentified',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;

    expect(keyboardEventToShortcut(event, 'linux')).toBeNull();
  });

  it('captures non-macOS meta shortcuts with platform-native labels', () => {
    const event = {
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;

    expect(keyboardEventToShortcut(event, 'linux')).toBe('Super+Space');
    expect(keyboardEventToShortcut(event, 'win32')).toBe('Win+Space');
    expect(rendererToAccelerator('Win+Space')).toBe('Super+Space');
  });
});
