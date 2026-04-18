# desktop-app

An Electron-based browser built on Chromium with Chrome-parity features, an AI agent pill (Cmd+K), and a full tab management surface.

## Features

### Tabs
- Tab strip with shrink-to-fit overflow — tabs compress as count grows, never clip off screen
- Tab audio indicator with per-tab mute (click the favicon to mute/unmute)
- Tab hover card with live thumbnail screenshot
- Tab search dropdown (Cmd+Shift+A) — fuzzy search across all open tabs
- Tab context menu (right-click) — pin, duplicate, mute, close, close others, close to right
- Pinned tabs — favicon-only width, Cmd+W protected, session-persisted
- Middle-click to close tab; middle-click a link to open in new tab
- Reopen closed tab (Cmd+Shift+T) with full history stack
- Recently closed tab dropdown
- Switch to tab 1–8 with Cmd+1–8; Cmd+9 jumps to last tab
- Cycle tabs with Cmd+Shift+] / Cmd+Shift+[

### Navigation
- Omnibox autocomplete dropdown — history, bookmarks, and open tab suggestions with fuzzy matching
- URL display elision — strips `https://`, `www.`, trailing slash in the address bar
- Did-you-mean typo correction for misspelled hostnames
- Back/forward long-press and right-click menus for full history stack
- Find-in-page (Cmd+F) with next/prev/selection-for-find
- Status bar on link hover (bottom-left)
- Zoom per site — Cmd+= / Cmd+- / Cmd+0 with persistent ZoomStore and badge indicator
- Print preview window (Cmd+P)
- Save page as (Cmd+S)
- Share menu — copy link, email page

### Windows
- New window (Cmd+N)
- Incognito window (Cmd+Shift+N) — ephemeral session, no data persistence
- Guest browsing mode — no profile data written
- Window naming
- Fullscreen mode (Ctrl+Cmd+F on macOS, F11 on Windows/Linux) — chrome hides, content fills screen
- Window bounds persist across restarts with off-screen guard

### Security and Privacy
- HTTPS-First mode with interstitial upgrade warning
- HSTS store — remembers HSTS policy per origin, cert error handling
- Secure DNS (DNS-over-HTTPS) — configurable DoH resolver in settings
- Mixed content handling with URL bar indicator
- Safe Browsing interstitials — three-tier settings (standard / enhanced / off)
- Safe Browsing download warnings — tiered dangerous/suspicious file classification
- Privacy Sandbox toggles in settings
- Do Not Track header toggle
- Global Privacy Control (GPC) header toggle
- Prediction service and preload pages settings
- Branded error pages — DNS failure, connection refused, timeout, cert errors
- Sign-out dialog with choice to clear or keep local data

### Bookmarks
- Bookmark bar (Cmd+Shift+B toggle)
- Bookmark current page (Cmd+D) and edit dialog
- Bookmark all tabs dialog (Cmd+Shift+D)
- Cmd+click a bookmark folder opens all tabs in that folder
- Bookmark manager (chrome://bookmarks) — folder tree, search, rename, delete
- Import and export bookmarks in Netscape HTML format
- Bookmark context menu (right-click)

### Downloads
- Download bubble toolbar with progress ring
- Dock badge and progress bar for active downloads
- Downloads page (chrome://downloads) with search and per-item actions (open, show in Finder, pause, resume, cancel, remove)
- Downloads settings tab — default save location, ask-where-to-save toggle
- Safe Browsing tiered download warnings

### History
- History page (chrome://history) — date-grouped, search, delete
- Journey clusters — topic-grouped browsing sessions
- Tabs from other devices tab in chrome://history
- Full history (Cmd+Y) and clear browsing data (Cmd+Shift+Delete)

### Passwords
- Save-password prompt and password manager page (chrome://settings/passwords)
- Password checkup with breach detection
- Biometric unlock (Touch ID) for password operations
- Password-field context menu

### Autofill
- Address autofill — save and fill postal addresses (chrome://settings/addresses)
- Payment autofill — save and fill payment methods (chrome://settings/payments)

### Extensions
- Manifest V3 runtime integration
- Extensions page (chrome://extensions) — card grid, enable/disable toggle, details drawer, developer mode
- Extension toolbar with pin/unpin
- Extension keyboard shortcuts page (chrome://extensions/shortcuts)

### Permissions
- Permission prompt framework with infobar UI
- Device API permissions with picker and persistence — camera, microphone, MIDI, USB, Bluetooth, serial
- Media permissions with combined prompts and quiet UI
- File System Access API permissions
- Content category toggles — JavaScript, images, cookies, pop-ups, notifications per site
- Permission auto-revoke for unused permissions
- Protocol handler store
- Niche permissions for Chrome parity

### Site Settings and Security
- Page Info bubble — certificates, permissions, cookies, site settings
- Cookies and site data settings
- HTTPS upgrade per-site override

### Identity and Profiles
- Profile picker on launch with settings toggle
- Sign-out with clear vs. keep local data

### Developer Tools
- DevTools panel (Cmd+Alt+I / Cmd+Shift+I / F12) with dock modes — right, bottom, detached
- Inspect element via right-click context menu
- View source (Cmd+Alt+U)
- JavaScript console (Cmd+Alt+J)
- chrome://inspect — remote debugging targets with network target add/remove

### Media and Accessibility
- Picture-in-Picture (Cmd+Shift+P) via Chromium native API
- Global Media Controls (Cmd+Shift+M) — play/pause/seek from toolbar
- Screen reader / ARIA passthrough — keyboard navigation and region cycling (F7)
- QR code dialog for sharing the current URL

### New Tab Page
- Customize Chrome side panel — wallpaper, shortcuts, color scheme customization

### AI Agent
- Agent pill (Cmd+K) — toggleable AI assistant overlay on every tab
- Daemon background process with WebSocket bridge to agent API

### Shell UI
- Unified toolbar and tab-strip color
- Bookmark bar
- Side panel (bookmarks, history, reading list)
- Find bar
- Permission infobar
- Download bubble
- Zoom badge
- Device picker bar
- Password prompt bar
- Status bar
- Profile menu
- Share menu
- Sign-out dialog

---

## Keyboard Shortcuts

### Navigation
| Action | macOS | Windows / Linux |
|---|---|---|
| Open location / focus address bar | Cmd+L | Ctrl+L |
| Go back | Cmd+Left, Cmd+[ | Alt+Left |
| Go forward | Cmd+Right, Cmd+] | Alt+Right |
| Reload | Cmd+R | Ctrl+R / F5 |
| Hard reload (bypass cache) | Cmd+Shift+R | Ctrl+Shift+R / Shift+F5 |
| Stop | Escape | Escape |
| Find in page | Cmd+F | Ctrl+F |
| Find next | Cmd+G | Ctrl+G |
| Find previous | Cmd+Shift+G | Ctrl+Shift+G |
| Use selection for find | Cmd+E | Ctrl+E |

### Tabs and Windows
| Action | macOS | Windows / Linux |
|---|---|---|
| New tab | Cmd+T | Ctrl+T |
| Close tab | Cmd+W | Ctrl+W |
| Reopen closed tab | Cmd+Shift+T | Ctrl+Shift+T |
| Tab search | Cmd+Shift+A | Ctrl+Shift+A |
| Next tab | Cmd+Shift+] | Ctrl+Shift+] |
| Previous tab | Cmd+Shift+[ | Ctrl+Shift+[ |
| Switch to tab 1–8 | Cmd+1–8 | Ctrl+1–8 |
| Switch to last tab | Cmd+9 | Ctrl+9 |
| New window | Cmd+N | Ctrl+N |
| Incognito window | Cmd+Shift+N | Ctrl+Shift+N |
| Close window | Cmd+Shift+W | Ctrl+Shift+W |
| Toggle fullscreen | Ctrl+Cmd+F | F11 |

### Page and Bookmarks
| Action | macOS | Windows / Linux |
|---|---|---|
| Zoom in | Cmd+= | Ctrl+= |
| Zoom out | Cmd+- | Ctrl+- |
| Reset zoom | Cmd+0 | Ctrl+0 |
| Print | Cmd+P | Ctrl+P |
| Picture-in-Picture | Cmd+Shift+P | Ctrl+Shift+P |
| Save page as | Cmd+S | Ctrl+S |
| Bookmark page | Cmd+D | Ctrl+D |
| Bookmark all tabs | Cmd+Shift+D | Ctrl+Shift+D |
| Toggle bookmarks bar | Cmd+Shift+B | Ctrl+Shift+B |
| Bookmark manager | Cmd+Shift+O | Ctrl+Shift+O |
| Open file | Cmd+O | Ctrl+O |

### History and Tools
| Action | macOS | Windows / Linux |
|---|---|---|
| History | Cmd+Y | Ctrl+Y |
| Full history | Cmd+Shift+H | Ctrl+Shift+H |
| Clear browsing data | Cmd+Shift+Delete | Ctrl+Shift+Delete |
| Downloads | Cmd+Shift+J | Ctrl+Shift+J |
| DevTools | Cmd+Alt+I / Cmd+Shift+I / F12 | Ctrl+Shift+I / F12 |
| JavaScript console | Cmd+Alt+J | Ctrl+Shift+J |
| View source | Cmd+Alt+U | Ctrl+U |
| Settings | Cmd+, | Ctrl+, |
| Toggle agent pill | Cmd+K | Ctrl+K |
| Global Media Controls | Cmd+Shift+M | Ctrl+Shift+M |
| Caret browsing | F7 | F7 |
| Emoji and symbols | Cmd+Ctrl+Space | — |

---

## chrome:// Pages

| URL | Description |
|---|---|
| chrome://about | Index of all internal pages |
| chrome://version | App, Electron, Chromium, Node, V8 versions |
| chrome://gpu | Graphics hardware and driver info |
| chrome://downloads | Download history with search and per-item actions |
| chrome://history | Browsing history with date grouping, search, and journeys |
| chrome://bookmarks | Bookmark manager with folder tree and search |
| chrome://settings | Full settings surface |
| chrome://settings/passwords | Password manager |
| chrome://settings/addresses | Address autofill |
| chrome://settings/payments | Payment autofill |
| chrome://extensions | Extension manager |
| chrome://extensions/shortcuts | Extension keyboard shortcuts |
| chrome://inspect | Remote DevTools debugging targets |
| chrome://accessibility | Accessibility support status |
| chrome://sandbox | Sandbox and security status |
| chrome://dino | Classic dinosaur game |

---

## Project Structure

```
my-app/
  src/
    main/                    # Main process (Node / Electron)
      index.ts               # App entry, menu, IPC wiring
      window.ts              # BrowserWindow lifecycle and bounds
      hotkeys.ts             # Cmd+K registration (Menu accelerator)
      navigation.ts          # Navigation helpers
      logger.ts              # Structured logger
      agentApiKey.ts         # Agent API key management
      oauth.ts               # OAuth helpers
      presence.ts            # Window presence / focus tracking
      pill.ts                # Agent pill bridge
      telemetry.ts           # Usage telemetry
      updater.ts             # Auto-updater

      autofill/              # Address and payment autofill
      bookmarks/             # Bookmark store, import/export
      chrome/                # chrome:// IPC handlers
      content-categories/    # Per-site content category toggles
      contextMenu/           # Right-click context menus
      daemon/                # Background agent daemon
      devices/               # Device API permission picker
      devtools/              # DevTools panel management
      downloads/             # Download manager
      errors/                # Branded error page renderer
      extensions/            # Extension manager + MV3 runtime
      history/               # History store and journey clusters
      hl/                    # Highlight / annotation system
      https/                 # HTTPS-First mode, HSTS store
      identity/              # Sign-in, sign-out, profile
      navigation/            # Back/forward, session history
      ntp/                   # New tab page customization store
      omnibox/               # Autocomplete, typo correction, elision
      passwords/             # Password manager, breach detection
      permissions/           # Permission manager, auto-revoke
      pip/                   # Picture-in-Picture
      print/                 # Print preview window
      privacy/               # DNT, GPC, Privacy Sandbox, Safe Browsing
      profiles/              # Multi-profile support
      safebrowsing/          # Safe Browsing interstitials
      settings/              # Settings IPC
      share/                 # Share menu
      tabs/                  # TabManager, SessionStore, MutedSitesStore, ZoomStore
      telemetry.ts

    preload/                 # Context bridge scripts
      shell.ts               # Shell window preload
      settings.ts            # Settings window preload
      extensions.ts          # Extensions window preload
      newtab.ts              # New tab page preload

    renderer/                # React renderer processes
      shell/                 # Browser chrome (toolbar, tabs, bars)
        WindowChrome.tsx     # Root shell layout
        TabStrip.tsx         # Tab strip with overflow
        URLBar.tsx           # Address bar with elision and autocomplete
        NavButtons.tsx       # Back/forward/reload buttons
        BookmarksBar.tsx     # Bookmark bar
        FindBar.tsx          # Find-in-page
        StatusBar.tsx        # Link hover status bar
        DownloadBubble.tsx   # Download progress bubble
        TabHoverCard.tsx     # Tab thumbnail hover card
        TabSearchDropdown.tsx # Tab search overlay
        PermissionBar.tsx    # Permission prompt infobar
        DevicePickerBar.tsx  # Device picker prompt
        SidePanel.tsx        # Side panel (bookmarks/history/reading list)
        CustomizePanel.tsx   # NTP Customize Chrome side panel
        ProfileMenu.tsx      # Profile menu
        ShareMenu.tsx        # Share menu
        SignOutDialog.tsx     # Sign-out with clear/keep dialog
        ZoomBadge.tsx        # Per-site zoom indicator
        BookmarkDialog.tsx   # Bookmark save/edit dialog
        BookmarkAllTabsDialog.tsx
        RecentlyClosedDropdown.tsx
        DownloadButton.tsx
        QRCodeDialog.tsx

      bookmarks/             # chrome://bookmarks
      downloads/             # chrome://downloads
      history/               # chrome://history (history + journeys + other devices)
      settings/              # chrome://settings
      extensions/            # chrome://extensions
      chrome/                # chrome://version, gpu, inspect, dino, etc.
      devtools/              # DevTools panel surface
      newtab/                # New tab page
      onboarding/            # First-run onboarding flow
      print-preview/         # Print preview renderer
      profile-picker/        # Profile picker on launch
      pill/                  # Agent pill overlay
      design/                # Design tokens, global CSS
      components/            # Shared React components

  tests/
    unit/                    # Vitest unit tests
    integration/             # Vitest integration tests
    e2e/                     # Playwright end-to-end tests
    parity/                  # Chrome-parity automated checks
    visual/                  # Visual QA screenshot diffing
```

---

## Development

```bash
# Install dependencies
yarn install

# Run (do not run yarn dev — start manually via Electron Forge)
yarn start

# Lint
yarn lint

# Type check
yarn typecheck

# Unit and integration tests
yarn test

# End-to-end tests
yarn e2e

# Chrome-parity checks
yarn parity

# Visual QA
yarn visual:qa

# Full QA gate (lint + typecheck + test)
yarn qa
```

## Tech Stack

- **Electron** 41 with context isolation and renderer sandbox
- **React** 19 with Vite 5 for renderer bundles
- **TypeScript** 5.4 throughout main, preload, and renderer
- **Electron Forge** 7 for packaging and distribution — DMG, DEB, RPM, ZIP, Squirrel
- **Vitest** 4 for unit and integration tests
- **Playwright** for end-to-end tests
- **keytar** for OS keychain integration (Touch ID, password storage)
- **Anthropic SDK** for AI agent integration
- **GitHub Actions** — parallel lint / typecheck / unit / python / e2e / release workflows
