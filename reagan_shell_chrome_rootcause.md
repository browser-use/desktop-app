# Shell Chrome Root-Cause Report

## Summary

Two bugs in combination made the shell window chrome (tab strip + URL bar + nav buttons) invisible. Both were confirmed with a live Playwright-Electron boot probe, not grep guesses.

---

## Evidence Collected

### Probe run 1 — before any fix (fresh userData, onboarding gate fires)
- `electronAPI.firstWindow()` returned the onboarding window at `http://localhost:5175/src/renderer/onboarding/onboarding.html` (404)
- Only 2 windows: onboarding + DevTools. Shell window never opened (onboarding gate blocked it).

### Probe run 2 — after seeding `account.json` to bypass onboarding gate
Shell window found at `http://localhost:5173/shell.html`:
```
electronAPIType: undefined
windowChromeEl: NOT FOUND
reactFiber: REACT_FIBER:__reactContainer$7dmxznp60a
rootInnerHTML: (empty string)
domNodeCount: 13
```
React was mounted but `window.electronAPI` was `undefined`. `WindowChrome` calls `electronAPI.tabs.getState()` on mount, which throws immediately. React tree crashed before rendering anything into `#root`.

### Probe run 3 — after preload path fix, CSP still wrong
```
electronAPIType: object        ← preload now loads
domNodeCount: 1                ← only <html>, NO body
bodyHTML: NO BODY
windowChromeEl: NOT FOUND
```
Screenshot timed out waiting for fonts. The page stalled completely. Root cause: `script-src 'self'` in the CSP meta tag blocks Vite's injected inline `<script type="module">` (the `/@react-refresh` hook). Vite injects this inline script before the CSP meta tag in `<head>` but Chromium still evaluates and enforces the CSP, blocking inline modules from executing. Vite initialization never completes, leaving the page as a bare `<html>` element.

### Probe run 4 — after both fixes (re-probe confirmation)
```
URL:            http://localhost:5173/shell.html
electronAPIType: object
windowChromeEl: FOUND
reactFiber:     REACT_FIBER:__reactContainer$n3nyuyt77x
chromeStyles:   {"display":"flex","visibility":"visible","opacity":"1","height":"72px","width":"1280px",...}
domNodeCount:   42
bodyHTML:       <div id="root"><div class="window-chrome">
                  <div class="window-chrome__tab-row">...TabStrip with "Google" tab...
                  <div class="window-chrome__toolbar">...NavButtons...URLBar...
```

Chrome renders at exactly 72px height, fully visible, with live tab data.

---

## Root Causes

### Bug 1 — Wrong preload path
**File**: `src/main/window.ts:78`

The Forge VitePlugin builds ALL outputs (main, preloads) into `.vite/build/`. The path `'../preload/shell.js'` resolves at runtime to `.vite/preload/shell.js` which does not exist. Electron silently ignores a missing preload. With no preload, `contextBridge.exposeInMainWorld` never runs, `window.electronAPI` stays `undefined`, and `WindowChrome`'s first `useEffect` throws `TypeError: Cannot read properties of undefined (reading 'tabs')`, crashing the React tree before any DOM is produced.

**Fix** (`src/main/window.ts:78`):
```diff
- preload: path.join(__dirname, '../preload/shell.js'),
+ preload: path.join(__dirname, 'shell.js'),
```

### Bug 2 — CSP meta tag blocks Vite's inline script injection
**File**: `src/renderer/shell/shell.html:8-10`

The CSP `script-src 'self'` blocks all inline scripts. Vite's dev server injects an inline `<script type="module">` at the top of `<head>` for the React refresh hook. Even though Vite inserts it before the CSP meta tag, Chromium's Blink engine enforces the CSP retroactively for all scripts in the document. The inline module is blocked, Vite's HMR client cannot initialize, `index.tsx` never executes, and the page is left as a bare `<html>` node (1 DOM element) with no body or head content rendered.

**Fix** (`src/renderer/shell/shell.html:9`):
```diff
- content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ..."
+ content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; ..."
```

---

## Files Changed

| File | Line | Change |
|------|------|--------|
| `src/main/window.ts` | 78 | `'../preload/shell.js'` → `'shell.js'` |
| `src/renderer/shell/shell.html` | 9 | Added `'unsafe-inline' 'unsafe-eval'` to `script-src` |

Both changes are minimal (1 line each). No logic flow altered.

---

## Similar Patterns Elsewhere

The same wrong preload path pattern exists in:
- `src/main/pill.ts:133` — `path.join(__dirname, '../preload/pill.js')` (same bug, pill window)
- `src/main/identity/onboardingWindow.ts:25` — `path.join(__dirname, '../preload/onboarding.js')` (same bug, onboarding window)

These are outside the allowed edit scope per task rules but should be fixed the same way.

The same CSP `script-src 'self'` pattern may block Vite HMR in the pill and onboarding renderers too (check `src/renderer/pill/pill.html` and `src/renderer/onboarding/onboarding.html` for identical meta tags).

---

## Verification

Re-probe output after both fixes:
```
windowChromeEl: FOUND
chromeStyles.height: 72px
chromeStyles.display: flex
chromeStyles.visibility: visible
domNodeCount: 42
bodyHTML contains: .window-chrome > .window-chrome__tab-row + .window-chrome__toolbar
```

Build command: `electron-forge start` exits clean with all 4 Vite targets built successfully.
