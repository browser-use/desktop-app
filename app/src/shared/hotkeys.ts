/**
 * Shared utilities for the global command-bar accelerator.
 *
 * Two formats are in play:
 *  - Electron accelerator: "CommandOrControl+Shift+Space", "CommandOrControl+K"
 *  - Renderer shortcut: "Cmd+Shift+Space" (mac) or "Ctrl+Shift+Space" (win/linux)
 *  - Renderer display: "\u2318+\u21E7+Space" (mac) or "Ctrl+Shift+Space" (win/linux)
 */

export const DEFAULT_GLOBAL_CMDBAR_ACCELERATOR = 'CommandOrControl+Shift+Space';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

export function fallbackShortcutPlatform(platform?: string): string {
  const detected = platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '');
  return /Mac/i.test(detected) ? 'darwin' : 'linux';
}

function displayModifier(part: string, platform: string): string {
  const isMac = platform === 'darwin';
  switch (part) {
    case 'CommandOrControl':
    case 'Cmd':
      return isMac ? '\u2318' : 'Ctrl';
    case 'Command':
      return isMac ? '\u2318' : 'Cmd';
    case 'Control':
    case 'Ctrl':
      return isMac ? '\u2303' : 'Ctrl';
    case 'Shift':
      return isMac ? '\u21E7' : 'Shift';
    case 'Alt':
    case 'Option':
      return isMac ? '\u2325' : 'Alt';
    default:
      return part;
  }
}

export function shortcutToRenderer(shortcut: string, platform: string): string {
  const modKey = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return shortcut
    .replace(/CommandOrControl/gi, modKey)
    .replace(/\bCommand\b/gi, 'Cmd')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\bOption\b/gi, 'Alt');
}

export function formatShortcutForPlatform(shortcut: string, platform: string): string {
  return shortcutToRenderer(shortcut, platform)
    .split(' ')
    .map((chordPart) => chordPart.split('+').map((part) => displayModifier(part, platform)).join('+'))
    .join(' ');
}

export function acceleratorToDisplayParts(accel: string, platform: string): string[] {
  return acceleratorToRenderer(accel, platform).split('+').map((part) => displayModifier(part, platform));
}

export function acceleratorToRenderer(accel: string, platform: string): string {
  return shortcutToRenderer(accel, platform);
}

export function rendererToAccelerator(combo: string): string {
  return combo
    .replace(/\bCommandOrControl\b/gi, 'CommandOrControl')
    .replace(/\bCmd\b/gi, 'CommandOrControl')
    .replace(/\bCtrl\b/gi, 'CommandOrControl');
}

export function keyboardEventToShortcut(e: KeyboardEvent, platform: string): string | null {
  if (e.key === 'Escape' || e.key === 'Tab') return null;
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push(platform === 'darwin' ? 'Cmd' : 'Meta');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift');

  const key = e.key === ' ' ? 'Space' : e.key;
  parts.push(key);
  return parts.join('+');
}
