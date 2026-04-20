# Zoom (Cmd+/Cmd-) Implementation Plan

## Problem
No zoom support. Cmd+,Cmd- do nothing useful. Users need to scale the entire UI — text, spacing, cards, grid — smoothly and persistently.

## Requirements
1. Cmd+= zooms in, Cmd+- zooms out, Cmd+0 resets to 100%
2. Scales everything uniformly — text, spacing, cards, borders, icons
3. Grid column count adapts at zoom breakpoints (zoomed in = fewer columns)
4. Feels native (matches browser Cmd+/- behavior)
5. Persists across app restarts
6. Zoom level visible in UI (optional status indicator)

## Acceptance Criteria
- [ ] Cmd+= increases zoom by 10% per press (capped at 200%)
- [ ] Cmd+- decreases zoom by 10% per press (capped at 50%)
- [ ] Cmd+0 resets to 100%
- [ ] Grid view: 4 columns at 100%, 2 at 150%+, 1 at 175%+
- [ ] Dashboard, list view, command bar all scale uniformly
- [ ] Zoom level persists in localStorage and restores on launch
- [ ] Smooth transition between zoom levels (no jank)
- [ ] Pinch-to-zoom on trackpad works identically
- [ ] Current zoom % displayed in toolbar when != 100%

---

## Design Decision: Electron `webContents.setZoomFactor()` vs CSS scaling

### Option A: Electron `webContents.setZoomFactor()` (CHOSEN)
- **How:** Chromium's built-in page zoom — scales the entire renderer uniformly
- **Pros:** Native browser zoom feel, zero CSS changes needed, handles text/images/SVGs/spacing, pinch-to-zoom works automatically, battle-tested in every Chromium browser
- **Cons:** Grid `data-count` won't auto-adapt (need JS breakpoints based on effective viewport width)
- **Grid fix:** Compute `effectiveWidth = window.innerWidth` (already accounts for zoom in Chromium) and derive column count from that

### Option B: CSS custom property recalculation
- **How:** Multiply every `--space-*` and `--font-size-*` token by a scale factor
- **Pros:** Full control, grid naturally responds
- **Cons:** Fragile — must recalculate ~25 tokens, misses any hardcoded px values, needs `calc()` wrapper on every var, animation during zoom is complex
- **Rejected:** Too much surface area, too easy to miss values

### Option C: CSS `transform: scale()` on root
- **How:** Scale the root element
- **Pros:** Single CSS property
- **Cons:** Doesn't change layout flow — content clips instead of reflows, scrollbars break, fixed-position overlays misaligned
- **Rejected:** Layout-breaking

---

## Implementation Steps

### Step 1: Main process — zoom IPC handlers and menu accelerators
**File:** `src/main/index.ts`

Register three IPC handlers:
- `zoom:set` — calls `shellWindow.webContents.setZoomFactor(factor)`
- `zoom:get` — returns current zoom factor
- `zoom:reset` — sets zoom factor to 1.0

Update `buildApplicationMenu()` to add zoom menu items:
```
{ label: 'Zoom In',  accelerator: 'CmdOrCtrl+=' }  → send 'zoom-changed' to renderer
{ label: 'Zoom Out', accelerator: 'CmdOrCtrl+-' }  → send 'zoom-changed' to renderer
{ label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0' } → send 'zoom-changed' to renderer
```

The menu items call `webContents.setZoomFactor()` directly, then send the new factor to the renderer via IPC so React can update grid breakpoints.

Also handle pinch-to-zoom: listen for the `'zoom-changed'` event on `webContents` (Electron emits this when Chromium zoom changes from any source including trackpad pinch).

**Lines to modify:**
- `index.ts:512-600` — `buildApplicationMenu()`, add Zoom submenu after Edit
- `index.ts:406-420` — IPC handler section, add zoom handlers

### Step 2: Preload — expose zoom API
**File:** `src/preload/shell.ts`

Add to the `electronAPI` bridge:
```ts
zoom: {
  set: (factor: number) => ipcRenderer.invoke('zoom:set', factor),
  get: () => ipcRenderer.invoke('zoom:get'),
  reset: () => ipcRenderer.invoke('zoom:reset'),
},
on: {
  // ...existing handlers...
  zoomChanged: (cb: (factor: number) => void) => {
    const handler = (_event: unknown, factor: number) => cb(factor);
    ipcRenderer.on('zoom-changed', handler);
    return () => ipcRenderer.removeListener('zoom-changed', handler);
  },
}
```

### Step 3: Zoom persistence
**File:** `src/main/index.ts` (inline, no new file)

Store zoom factor in `userData/preferences.json` (already has read/write helpers in `settings/ipc.ts:223-238`):
- On `zoom:set`: save factor to prefs
- On app launch: read saved factor, apply to shellWindow after `did-finish-load`
- Default: `1.0`

Uses existing `readPrefs()` / `mergePrefs()` from `settings/ipc.ts:223,232`.

### Step 4: Hub renderer — zoom-aware grid breakpoints
**File:** `src/renderer/hub/HubApp.tsx`

Add a `useZoom()` hook or inline effect:
```ts
const [zoomFactor, setZoomFactor] = useState(1.0);

useEffect(() => {
  // Get initial zoom
  const api = (window as any).electronAPI;
  api?.zoom?.get().then((f: number) => setZoomFactor(f));
  // Listen for changes
  const unsub = api?.on?.zoomChanged((f: number) => setZoomFactor(f));
  return unsub;
}, []);
```

Grid column count calculation (replaces static `data-count`):
```ts
function getGridColumns(sessionCount: number, zoomFactor: number): number {
  const effectiveWidth = window.innerWidth;
  // At higher zoom, innerWidth shrinks (Chromium reports CSS pixels)
  if (effectiveWidth < 600 || sessionCount === 1) return 1;
  if (effectiveWidth < 900 || sessionCount === 2) return 2;
  if (effectiveWidth < 1200 || sessionCount === 3) return 3;
  return Math.min(sessionCount, 4);
}
```

The key insight: `window.innerWidth` in Chromium automatically reflects the zoom factor. At 150% zoom on a 1280px window, `innerWidth` reports ~853px. So the grid naturally adapts without needing `zoomFactor` in the calculation — just use width breakpoints.

Also add a resize observer to recalculate on window resize.

### Step 5: Zoom indicator in toolbar
**File:** `src/renderer/hub/HubApp.tsx` + `hub.css`

When zoom != 100%, show a subtle indicator in the toolbar:
```tsx
{zoomFactor !== 1.0 && (
  <button
    className="hub-toolbar__zoom"
    onClick={() => api?.zoom?.reset()}
    title="Reset zoom (Cmd+0)"
  >
    {Math.round(zoomFactor * 100)}%
  </button>
)}
```

Clicking it resets to 100%. Styled as a subtle, dismissible badge.

### Step 6: Vim keybinding integration
**File:** `src/renderer/hub/keybindings.ts`

Zoom bindings are handled by Electron menu accelerators (they must work even when the renderer isn't focused). No vim key additions needed — Cmd+=/Cmd-/Cmd+0 are system-level shortcuts handled by the menu.

### Step 7: Smooth zoom transitions
**File:** `src/renderer/design/theme.global.css`

Add a transition on the root element for smooth scaling:
```css
.hub-root {
  transition: font-size var(--duration-normal) var(--ease-out);
}
```

Chromium's `setZoomFactor()` applies zoom instantly (like browser zoom) — it's already smooth because it's native Chromium rendering. No additional CSS transitions needed for the zoom itself. The grid column count change should animate:
```css
.hub-grid {
  transition: grid-template-columns var(--duration-normal) var(--ease-out);
}
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Fixed-position overlays (CommandBar, modals) misaligned | Not a risk — `setZoomFactor` scales the entire viewport uniformly, fixed positioning works correctly |
| Zoom level too extreme | Clamp to [0.5, 2.0] range (50%-200%) |
| Scroll position jumps on zoom | Chromium handles scroll position preservation natively during zoom |
| Performance at high zoom | Native Chromium zoom is GPU-accelerated, no performance risk |
| Grid column transition looks choppy | CSS grid transitions are well-supported; fallback to instant if needed |
| Existing Electron menu zoom roles conflict | Remove the default `{ role: 'zoomIn' }` / `{ role: 'zoomOut' }` / `{ role: 'resetZoom' }` menu items, replace with custom handlers |

## Verification Steps

1. Launch app, press Cmd+= three times → UI scales to ~130%, grid reduces to 2 columns on a 1280px window
2. Press Cmd+0 → resets to 100%, grid returns to original column count
3. Press Cmd+- twice → UI scales to ~80%, grid stays at max columns (more space)
4. Quit and relaunch → zoom level persists at 80%
5. Pinch-to-zoom on trackpad → same behavior as Cmd+/-
6. Open CommandBar (Cmd+K) while zoomed → overlay renders correctly
7. Open keybindings overlay (?) while zoomed → renders correctly
8. Toolbar shows "80%" badge, clicking it resets to 100%

## File Change Summary

| File | Change |
|------|--------|
| `src/main/index.ts` | Add zoom IPC handlers, menu items, persistence, pinch listener |
| `src/preload/shell.ts` | Add zoom API to bridge |
| `src/renderer/hub/HubApp.tsx` | Add zoom state, responsive grid breakpoints, zoom indicator |
| `src/renderer/hub/hub.css` | Grid transition, zoom indicator styles |
| No new files needed | — |
