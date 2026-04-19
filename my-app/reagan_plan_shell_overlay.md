# Plan: Shell as Overlay WebContentsView

## Goal
Make the shell (chrome UI) render ON TOP of tab WebContentsViews so popups naturally overlay page content — matching Chrome's behavior.

## Current Architecture
- BrowserWindow loads shell.html in its own webContents (BOTTOM layer)
- Tab WebContentsViews added as children (TOP layer — paints over shell)
- Result: shell popups hidden behind tabs

## New Architecture  
- BrowserWindow loads nothing (dark background only)
- Tab WebContentsViews added as children (MIDDLE layer)
- Shell WebContentsView loads shell.html with transparent background (TOP layer)
- Result: shell popups naturally render over tabs

## Changes

### 1. TabManager.ts — Create shellView
- Add `private shellView: WebContentsView` property
- In constructor: create shellView with same webPreferences as current BrowserWindow
- Load shell.html into shellView (move URL/path logic from window.ts)
- `shellView.setBackgroundColor('#00000000')` (transparent)
- Position shellView full-window
- Add shellView AFTER tab views
- Expose `get shellWebContents()` getter
- After every `addChildView(tabView)`, re-add shellView to keep it on top
- Update `safeSend()` to use `this.shellView.webContents`
- Update all other `this.win.webContents` → `this.shellView.webContents` (except session at L2640)
- Update `broadcastTabGroups()` to use TabManager instances' shellWebContents
- Add `relayoutShell()` to reposition shellView on window resize
- Add IPC handler for mouse event forwarding

### 2. window.ts — Stop loading shell.html
- Remove shell.html loading (loadURL/loadFile)
- Remove shell webContents event listeners (did-fail-load, did-finish-load, console-message)
- Remove openDevTools call
- Remove zoom-level lock on win.webContents
- Keep: BrowserWindow creation, bounds persistence, traffic light position, webPreferences for preload

### 3. index.ts — Update IPC routing
- `win.webContents.once('did-finish-load', ...)` → listen on `tabManager.shellWebContents`
- `win.webContents.send('window-ready')` → `tabManager.shellWebContents.send(...)`
- `win.webContents.send('ntp-customization-updated', ...)` → same
- Wait: these fire BEFORE tabManager exists? Check ordering.

### 4. Shell CSS — Transparent background
- shell.html or shell CSS: `html, body { background: transparent; }`
- `.window-chrome` keeps its opaque `background: var(--color-bg-base)`

### 5. Mouse event forwarding
- Shell renderer: track mouse position, detect transparent vs UI area
- Send IPC `shell:set-ignore-mouse` when transitioning
- Main process: toggle `shellView.webContents.setIgnoreMouseEvents(ignore, { forward: true })`
- Add to preload: `setIgnoreMouseEvents` IPC channel

### 6. PopupLayerContext — Simplify
- Remove ALL `setContentVisible` calls (no longer needed)
- Dropdowns now naturally render over page content
- Keep ESC stack management
- Keep `setChromeHeight` for bars (still need to push tab view down)

## Execution Order
1. Create shellView in TabManager (additive)
2. Move shell loading from window.ts to TabManager
3. Update IPC routing in TabManager + index.ts
4. Add mouse forwarding
5. Update shell CSS for transparency
6. Simplify PopupLayerContext
7. Test
