import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_KEYBINDINGS } from './keybindings';
import type { ActionId, KeyBinding } from './keybindings';
import {
  acceleratorToRenderer,
  defaultGlobalCmdbarAccelerator,
  fallbackShortcutPlatform,
  formatShortcutForPlatform,
  keyboardEventToShortcut,
  rendererToAccelerator,
  shortcutToRenderer,
} from '../../shared/hotkeys';

export interface VimKeysReturn {
  chordPrefix: string | null;
  keybindings: KeyBinding[];
  overrides: Record<string, string[]>;
  updateBinding: (id: ActionId, keys: string[]) => Promise<boolean>;
  resetBinding: (id: ActionId) => void;
  resetAll: () => void;
  platform: string;
  formatShortcut: (shortcut: string) => string;
}

export function useVimKeys(handlers: Partial<Record<ActionId, () => void>>): VimKeysReturn {
  const [overrides, setOverrides] = useState<Record<string, string[]>>({});
  const [chordPrefix, setChordPrefix] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string>(() => window.electronAPI?.shell?.platform ?? fallbackShortcutPlatform());
  const chordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const keybindings = DEFAULT_KEYBINDINGS.map((kb) => ({
    ...kb,
    keys: (overrides[kb.id] ?? kb.keys).map((key) => shortcutToRenderer(key, platform)),
  }));

  useEffect(() => {
    if (window.electronAPI?.shell?.platform) return;
    const api = window.electronAPI;
    api?.shell?.getPlatform?.().then((p: string) => setPlatform(p)).catch(() => {});
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.hotkeys?.getGlobalCmdbar) return;
    let cancelled = false;
    api.hotkeys.getGlobalCmdbar()
      .then((accel: string) => {
        if (cancelled) return;
        const display = acceleratorToRenderer(accel || defaultGlobalCmdbarAccelerator(platform), platform);
        console.log('[useVimKeys] loaded global cmdbar accel', { accel, display });
        setOverrides((prev) => ({ ...prev, 'action.createPane': [display] }));
      })
      .catch((err: Error) => console.warn('[useVimKeys] getGlobalCmdbar failed', err));
    return () => { cancelled = true; };
  }, [platform]);

  useEffect(() => {
    const unsub = window.electronAPI?.on?.globalCmdbarChanged?.((accel: string) => {
      const display = acceleratorToRenderer(accel, platform);
      console.log('[useVimKeys] global cmdbar changed', { accel, display });
      setOverrides((prev) => ({ ...prev, 'action.createPane': [display] }));
    });
    return unsub;
  }, [platform]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const pressed = keyboardEventToShortcut(e, platform);
      if (!pressed) return;

      const createPaneBinding = keybindings.find((kb) => kb.id === 'action.createPane');
      if (createPaneBinding?.keys.includes(pressed)) {
        e.preventDefault();
        setChordPrefix(null);
        if (chordTimer.current) clearTimeout(chordTimer.current);
        handlersRef.current['action.createPane']?.();
        return;
      }

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      const combo = chordPrefix ? `${chordPrefix} ${pressed}` : pressed;

      for (const kb of keybindings) {
        for (const keyStr of kb.keys) {
          if (keyStr === combo) {
            e.preventDefault();
            setChordPrefix(null);
            if (chordTimer.current) clearTimeout(chordTimer.current);
            handlersRef.current[kb.id]?.();
            return;
          }
          if (keyStr.startsWith(combo + ' ')) {
            e.preventDefault();
            setChordPrefix(combo);
            if (chordTimer.current) clearTimeout(chordTimer.current);
            chordTimer.current = setTimeout(() => setChordPrefix(null), 1500);
            return;
          }
        }
      }

      if (chordPrefix) {
        setChordPrefix(null);
        if (chordTimer.current) clearTimeout(chordTimer.current);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keybindings, chordPrefix, platform]);

  const updateBinding = useCallback(async (id: ActionId, keys: string[]): Promise<boolean> => {
    if (id === 'action.createPane') {
      const api = window.electronAPI;
      const accel = rendererToAccelerator(keys[0] ?? '', platform);
      if (!accel || !api?.hotkeys?.setGlobalCmdbar) {
        console.warn('[useVimKeys] cannot set global cmdbar', { accel, hasApi: !!api });
        return false;
      }
      try {
        const result = await api.hotkeys.setGlobalCmdbar(accel);
        console.log('[useVimKeys] setGlobalCmdbar result', result);
        const display = acceleratorToRenderer(result.accelerator, platform);
        setOverrides((prev) => ({ ...prev, 'action.createPane': [display] }));
        return result.ok;
      } catch (err) {
        console.warn('[useVimKeys] setGlobalCmdbar failed', err);
        return false;
      }
    }
    setOverrides((prev) => ({ ...prev, [id]: keys }));
    return true;
  }, [platform]);

  const resetBinding = useCallback((id: ActionId) => {
    if (id === 'action.createPane') {
      const api = window.electronAPI;
      if (!api?.hotkeys?.setGlobalCmdbar) return;
      api.hotkeys.setGlobalCmdbar(defaultGlobalCmdbarAccelerator(platform))
        .then((result: { ok: boolean; accelerator: string }) => {
          console.log('[useVimKeys] resetGlobalCmdbar result', result);
        })
        .catch((err: Error) => console.warn('[useVimKeys] resetGlobalCmdbar failed', err));
      return;
    }
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [platform]);

  const resetAll = useCallback(() => {
    setOverrides((prev) => {
      const preserved: Record<string, string[]> = {};
      if (prev['action.createPane']) preserved['action.createPane'] = prev['action.createPane'];
      return preserved;
    });
    const api = window.electronAPI;
    api?.hotkeys?.setGlobalCmdbar?.(defaultGlobalCmdbarAccelerator(platform))
      .catch((err: Error) => console.warn('[useVimKeys] resetAll global cmdbar failed', err));
  }, [platform]);

  const formatShortcut = useCallback((shortcut: string) => formatShortcutForPlatform(shortcut, platform), [platform]);

  return { chordPrefix, keybindings, overrides, updateBinding, resetBinding, resetAll, platform, formatShortcut };
}
