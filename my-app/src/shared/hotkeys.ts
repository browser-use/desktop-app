/**
 * Shared utilities for the global command-bar accelerator.
 *
 * Two formats are in play:
 *  - Electron accelerator: "CommandOrControl+Shift+Space", "CommandOrControl+K"
 *  - Renderer display: "Cmd+Shift+Space" (mac) or "Ctrl+Shift+Space" (win/linux)
 */

export const DEFAULT_GLOBAL_CMDBAR_ACCELERATOR = 'CommandOrControl+Shift+Space';

export function acceleratorToRenderer(accel: string, platform: string): string {
  const modKey = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return accel.replace(/CommandOrControl/gi, modKey).replace(/^Command\b/, modKey);
}

export function rendererToAccelerator(combo: string): string {
  return combo
    .replace(/\bCmd\b/gi, 'CommandOrControl')
    .replace(/\bCtrl\b/gi, 'CommandOrControl');
}
