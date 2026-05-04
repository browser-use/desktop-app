/**
 * Shared utilities for the global command-bar accelerator.
 *
 * Two formats are in play:
 *  - Electron accelerator: "CommandOrControl+Shift+Space", "CommandOrControl+K"
 *  - Renderer shortcut: "Cmd+Shift+Space" (mac) or "Ctrl+Shift+Space" (win/linux)
 *  - Renderer display: "\u2318+\u21E7+Space" (mac) or "Ctrl+Shift+Space" (win/linux)
 */

export const DEFAULT_GLOBAL_CMDBAR_ACCELERATOR = 'CommandOrControl+Shift+Space';
export const DEFAULT_LINUX_GLOBAL_CMDBAR_ACCELERATOR = 'Alt+Space';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);
const SPACE_KEYS = new Set([' ', '\u00A0', 'Spacebar']);
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Super', 'Alt', 'Shift'];

type ShortcutPlatform = 'darwin' | 'win32' | 'linux';

export function normalizeShortcutPlatform(platform?: string): ShortcutPlatform {
  const detected = platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '');
  if (/darwin|mac/i.test(detected)) return 'darwin';
  if (/win/i.test(detected)) return 'win32';
  return 'linux';
}

export function fallbackShortcutPlatform(platform?: string): string {
  return normalizeShortcutPlatform(platform);
}

export function defaultGlobalCmdbarAccelerator(platform?: string): string {
  return normalizeShortcutPlatform(platform) === 'linux'
    ? DEFAULT_LINUX_GLOBAL_CMDBAR_ACCELERATOR
    : DEFAULT_GLOBAL_CMDBAR_ACCELERATOR;
}

function displayModifier(part: string, platform: string): string {
  const normalizedPlatform = normalizeShortcutPlatform(platform);
  const isMac = normalizedPlatform === 'darwin';
  switch (part) {
    case 'CommandOrControl':
    case 'Cmd':
      return isMac ? '\u2318' : 'Ctrl';
    case 'Command':
      return isMac ? '\u2318' : 'Cmd';
    case 'Meta':
    case 'Super':
      return isMac ? '\u2318' : normalizedPlatform === 'win32' ? 'Win' : 'Super';
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
  const normalizedPlatform = normalizeShortcutPlatform(platform);
  const modKey = normalizedPlatform === 'darwin' ? 'Cmd' : 'Ctrl';
  return shortcut
    .replace(/CommandOrControl/gi, modKey)
    .replace(/\bCommand\b/gi, 'Cmd')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\bMeta\b/gi, normalizedPlatform === 'win32' ? 'Win' : 'Super')
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

function normalizeAcceleratorPart(part: string, platform?: string): string {
  const normalizedPlatform = platform ? normalizeShortcutPlatform(platform) : null;
  switch (part.toLowerCase()) {
    case 'commandorcontrol':
      return 'CommandOrControl';
    case 'cmd':
    case 'command':
      return normalizedPlatform && normalizedPlatform !== 'darwin' ? 'Command' : 'CommandOrControl';
    case 'ctrl':
    case 'control':
      return normalizedPlatform === 'darwin' ? 'Control' : 'CommandOrControl';
    case 'win':
    case 'meta':
      return 'Super';
    case 'option':
    case 'alt':
      return 'Alt';
    case 'shift':
      return 'Shift';
    case 'spacebar':
    case ' ':
    case '\u00a0':
      return 'Space';
    default:
      return part.length === 1 ? part.toUpperCase() : part;
  }
}

export function normalizeAccelerator(accel: string, platform?: string): string {
  return accel
    .split(' ')
    .map((chordPart) => {
      const modifiers = new Set<string>();
      const keys: string[] = [];

      for (const rawPart of chordPart.split('+')) {
        const part = normalizeAcceleratorPart(rawPart.trim(), platform);
        if (!part) continue;
        if (MODIFIER_ORDER.includes(part)) {
          modifiers.add(part);
        } else {
          keys.push(part);
        }
      }

      return [
        ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
        ...keys,
      ].join('+');
    })
    .filter(Boolean)
    .join(' ');
}

export function rendererToAccelerator(combo: string, platform?: string): string {
  return normalizeAccelerator(combo, platform);
}

function keyboardEventKeyName(e: KeyboardEvent): string | null {
  if (e.code === 'Space' || SPACE_KEYS.has(e.key)) return 'Space';
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.key.length === 0) return null;
  return e.key;
}

export function keyboardEventToShortcut(e: KeyboardEvent, platform: string): string | null {
  if (e.key === 'Escape' || e.key === 'Tab') return null;
  if (e.key === 'Unidentified') return null;
  if (MODIFIER_KEYS.has(e.key)) return null;

  const key = keyboardEventKeyName(e);
  if (!key) return null;

  const normalizedPlatform = normalizeShortcutPlatform(platform);
  const parts: string[] = [];
  if (e.metaKey) parts.push(normalizedPlatform === 'darwin' ? 'Cmd' : normalizedPlatform === 'win32' ? 'Win' : 'Super');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  parts.push(key);
  return parts.join('+');
}
