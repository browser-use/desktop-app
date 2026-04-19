/**
 * PopupLayerContext — global popup management for z-ordering and ESC dismissal.
 *
 * The shell is a WebContentsView that sits on top of tab views with a
 * transparent background, so popups naturally render over page content.
 * No WebContentsView visibility toggling is needed.
 *
 * Popup types:
 *   dropdown — overlay popup (profile menu, omnibox, zoom, etc.)
 *              Renders naturally above tab content via z-order.
 *   modal   — full-screen overlay (bookmark dialog, tab search, etc.)
 *              Renders naturally above tab content via z-order.
 *   bar     — inline info bar (permission, password, device picker)
 *              Pushes tab content down via setChromeHeight.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';

declare const electronAPI: {
  shell: {
    setChromeHeight: (height: number) => Promise<void>;
    setOverlay: (active: boolean) => void;
  };
};

const BASE_CHROME_HEIGHT = 91;
const BOOKMARKS_BAR_HEIGHT = 32;

interface PopupEntry {
  id: string;
  type: 'dropdown' | 'modal' | 'bar';
  height: number;
  onDismiss: () => void;
  escDismiss: boolean;
}

interface PopupLayerContextValue {
  register: (entry: PopupEntry) => void;
  unregister: (id: string) => void;
}

const PopupLayerContext = createContext<PopupLayerContextValue | null>(null);

interface PopupLayerProviderProps {
  children: React.ReactNode;
  bookmarksBarVisible: boolean;
}

export function PopupLayerProvider({ children, bookmarksBarVisible }: PopupLayerProviderProps): React.ReactElement {
  const stackRef = useRef<PopupEntry[]>([]);
  const bookmarksBarVisibleRef = useRef(bookmarksBarVisible);
  bookmarksBarVisibleRef.current = bookmarksBarVisible;

  const overlayActiveRef = useRef(false);

  const syncLayer = useCallback(() => {
    const stack = stackRef.current;
    const hasOverlay = stack.some(p => p.type === 'dropdown' || p.type === 'modal');

    if (hasOverlay !== overlayActiveRef.current) {
      overlayActiveRef.current = hasOverlay;
      electronAPI.shell.setOverlay(hasOverlay);
    }

    const barHeight = stack
      .filter(p => p.type === 'bar')
      .reduce((sum, p) => sum + p.height, 0);
    const total = BASE_CHROME_HEIGHT
      + (bookmarksBarVisibleRef.current ? BOOKMARKS_BAR_HEIGHT : 0)
      + barHeight;
    electronAPI.shell.setChromeHeight(total);
  }, []);

  const register = useCallback((entry: PopupEntry) => {
    stackRef.current = [...stackRef.current.filter(e => e.id !== entry.id), entry];
    syncLayer();
  }, [syncLayer]);

  const unregister = useCallback((id: string) => {
    stackRef.current = stackRef.current.filter(e => e.id !== id);
    syncLayer();
  }, [syncLayer]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const stack = stackRef.current;
      if (stack.length === 0) return;
      const top = stack[stack.length - 1];
      if (top.escDismiss) {
        e.preventDefault();
        e.stopPropagation();
        top.onDismiss();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  useEffect(() => {
    syncLayer();
  }, [bookmarksBarVisible, syncLayer]);

  return (
    <PopupLayerContext.Provider value={{ register, unregister }}>
      {children}
    </PopupLayerContext.Provider>
  );
}

interface UsePopupLayerConfig {
  id: string;
  type: 'dropdown' | 'modal' | 'bar';
  height?: number;
  onDismiss: () => void;
  escDismiss?: boolean;
  isOpen: boolean;
}

export function usePopupLayer(config: UsePopupLayerConfig): void {
  const ctx = useContext(PopupLayerContext);

  const onDismissRef = useRef(config.onDismiss);
  onDismissRef.current = config.onDismiss;

  const stableOnDismiss = useCallback(() => {
    onDismissRef.current();
  }, []);

  useEffect(() => {
    if (!ctx) return;
    if (config.isOpen) {
      ctx.register({
        id: config.id,
        type: config.type,
        height: config.height ?? 0,
        onDismiss: stableOnDismiss,
        escDismiss: config.escDismiss ?? true,
      });
    } else {
      ctx.unregister(config.id);
    }
    return () => ctx.unregister(config.id);
  }, [config.isOpen, config.id, config.type, config.height, config.escDismiss, stableOnDismiss, ctx]);
}
