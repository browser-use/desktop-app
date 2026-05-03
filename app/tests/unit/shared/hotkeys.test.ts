import { describe, expect, it } from 'vitest';
import {
  acceleratorToDisplayParts,
  formatShortcutForPlatform,
  keyboardEventToShortcut,
  shortcutToRenderer,
} from '../../../src/shared/hotkeys';

describe('acceleratorToDisplayParts', () => {
  it('uses text labels for Linux and Windows modifiers', () => {
    expect(acceleratorToDisplayParts('Alt+Space', 'linux')).toEqual(['Alt', 'Space']);
    expect(acceleratorToDisplayParts('CommandOrControl+Shift+Space', 'win32')).toEqual(['Ctrl', 'Shift', 'Space']);
  });

  it('uses macOS glyphs only on macOS', () => {
    expect(acceleratorToDisplayParts('CommandOrControl+Alt+Space', 'darwin')).toEqual(['\u2318', '\u2325', 'Space']);
  });
});

describe('shortcut platform normalization', () => {
  it('keeps shortcuts platform-neutral until renderer normalization', () => {
    expect(shortcutToRenderer('CommandOrControl+,', 'darwin')).toBe('Cmd+,');
    expect(shortcutToRenderer('CommandOrControl+,', 'linux')).toBe('Ctrl+,');
  });

  it('formats all shortcut labels through the same platform policy', () => {
    expect(formatShortcutForPlatform('CommandOrControl+Shift+Space', 'darwin')).toBe('\u2318+\u21E7+Space');
    expect(formatShortcutForPlatform('CommandOrControl+Shift+Space', 'linux')).toBe('Ctrl+Shift+Space');
    expect(formatShortcutForPlatform('Alt+Space', 'win32')).toBe('Alt+Space');
  });

  it('captures keyboard events into renderer shortcut strings', () => {
    const event = {
      key: ' ',
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    } as KeyboardEvent;

    expect(keyboardEventToShortcut(event, 'linux')).toBe('Alt+Space');
  });
});
