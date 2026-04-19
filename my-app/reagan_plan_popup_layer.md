# Plan: Global Popup Layer System

## Problem
WebContentsView is a native Electron layer that paints above all shell DOM content.
Any popup extending below the 91px chrome boundary gets hidden behind the tab's page content.
Only ProfileMenu currently pushes the WebContentsView down via `setChromeHeight`.

## Solution: `usePopupLayer` hook + `PopupLayerProvider` context

### Architecture

```
PopupLayerProvider (in WindowChrome.tsx)
  ├── tracks a stack of open popups
  ├── computes WebContentsView strategy per popup type
  ├── calls setChromeHeight() or setContentVisible() via IPC
  └── handles global ESC key (dismisses topmost popup)

usePopupLayer(config) — consumed by each popup component
  ├── registers/unregisters with the provider on open/close
  ├── returns { open, close, isOpen }
  └── ESC key handled automatically by provider (no per-component listeners needed)
```

### Popup Types & Strategy

| Type | Strategy | When |
|------|----------|------|
| `dropdown` | Push WebContentsView down by `height` px | Omnibox, ProfileMenu, RecentlyClosed, ZoomPopover, Overflow menu, ShareMenu, DownloadBubble, PageInfo popover |
| `modal` | Hide WebContentsView entirely (`setContentVisible(false)`) | BookmarkDialog, BookmarkAllTabsDialog, TabSearch, QRCodeDialog, SignOutDialog |
| `bar` | Included in chrome flow — already pushes via setChromeHeight when in document flow | PermissionBar, PasswordPromptBar, DevicePickerBar, FindBar |

### Files to Create

1. **`src/renderer/shell/PopupLayerContext.tsx`** — Provider + hook
   - `PopupLayerProvider` component (wraps WindowChrome children)
   - `usePopupLayer(config: PopupLayerConfig)` hook
   - ESC key stack manager
   - IPC bridge to `setChromeHeight` / `setContentVisible`

### Files to Modify

2. **`WindowChrome.tsx`** — Wrap with `<PopupLayerProvider>`, remove existing `dropdownOpen` state + setChromeHeight effect (replaced by provider)
3. **`ProfileMenu.tsx`** — Replace manual ESC/outside-click + `onDropdownChange` with `usePopupLayer({ type: 'dropdown', height: 300 })`
4. **`OmniboxDropdown.tsx`** (or URLBar parent) — Add `usePopupLayer({ type: 'dropdown', height: 400 })`
5. **`RecentlyClosedDropdown.tsx`** — Replace manual ESC with `usePopupLayer({ type: 'dropdown', height: 350 })`
6. **`ZoomBadge.tsx`** — Replace manual ESC with `usePopupLayer({ type: 'dropdown', height: 120 })`
7. **`BookmarkDialog.tsx`** — Add `usePopupLayer({ type: 'modal' })`
8. **`BookmarkAllTabsDialog.tsx`** — Add `usePopupLayer({ type: 'modal' })`
9. **`TabSearchDropdown.tsx`** — Add `usePopupLayer({ type: 'modal' })`
10. **`FindBar.tsx`** — Add `usePopupLayer({ type: 'bar', height: 40 })`
11. **`PermissionBar.tsx`** — Add `usePopupLayer({ type: 'bar', height: 48 })`
12. **`PasswordPromptBar.tsx`** — Add `usePopupLayer({ type: 'bar', height: 48 })`
13. **`DevicePickerBar.tsx`** — Add `usePopupLayer({ type: 'bar', height: 200 })`
14. **`ShareMenu.tsx`** — Replace manual ESC with `usePopupLayer({ type: 'dropdown', height: 200 })`
15. **`DownloadBubble.tsx`** — Replace manual ESC with `usePopupLayer({ type: 'dropdown', height: 300 })`
16. **`QRCodeDialog.tsx`** — Add `usePopupLayer({ type: 'modal' })`
17. **`SignOutDialog.tsx`** — Add `usePopupLayer({ type: 'modal' })`

### Hook API

```tsx
interface PopupLayerConfig {
  type: 'dropdown' | 'modal' | 'bar';
  height?: number;       // px to push WebContentsView down (dropdown/bar only)
  onDismiss: () => void; // called on ESC or outside click
  escDismiss?: boolean;  // default true, set false for bars that need button clicks
}

function usePopupLayer(config: PopupLayerConfig): {
  layerRef: RefObject<HTMLDivElement>; // for outside-click detection
  register: () => void;   // call when popup opens
  unregister: () => void;  // call when popup closes
}
```

### Provider Logic

```tsx
function PopupLayerProvider({ children }) {
  const stack = useRef<PopupEntry[]>([]);

  // On stack change: compute IPC calls
  useEffect(() => {
    const hasModal = stack.current.some(p => p.type === 'modal');
    if (hasModal) {
      electronAPI.shell.setContentVisible(false);
    } else {
      electronAPI.shell.setContentVisible(true);
      const maxDropdownHeight = Math.max(0, ...stack.current
        .filter(p => p.type === 'dropdown')
        .map(p => p.height));
      const barHeight = stack.current
        .filter(p => p.type === 'bar')
        .reduce((sum, p) => sum + p.height, 0);
      const total = BASE_CHROME_HEIGHT + bookmarksBarHeight + maxDropdownHeight + barHeight;
      electronAPI.shell.setChromeHeight(total);
    }
  });

  // Global ESC handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const top = stack.current[stack.current.length - 1];
      if (top?.escDismiss !== false) {
        top?.onDismiss();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
```

### Migration Strategy

Migrate popups one at a time. Each migration:
1. Import `usePopupLayer`
2. Call `register()` where the popup opens
3. Call `unregister()` where it closes
4. Remove manual ESC key listener (provider handles it)
5. Remove manual `onDropdownChange` prop threading (provider handles IPC)
6. Test that popup appears above page content and ESC dismisses it

### Execution Order

1. Create `PopupLayerContext.tsx` with provider + hook
2. Wire provider into `WindowChrome.tsx`
3. Migrate ProfileMenu first (already has the `onDropdownChange` pattern — validates replacement)
4. Migrate remaining dropdowns
5. Migrate modals
6. Migrate bars
7. Remove old `dropdownOpen` state and `DROPDOWN_OVERFLOW_HEIGHT` constant from WindowChrome
