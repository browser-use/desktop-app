# Figma Import Guide — The Browser Design System

This folder contains portable design artifacts you can import into a Figma file without any OAuth or live-sync setup. The artifacts are generated from `src/renderer/design/tokens.ts` (the authoritative source) and are ready to drag in.

---

## What is in This Folder

| File / Folder | What It Contains |
|---|---|
| `figma-tokens.json` | Full design token set in [Tokens Studio](https://tokens.studio) format |
| `assets/MANIFEST.md` | Inventory of all SVG brand assets and PNG screen baselines with source paths |
| `../scripts/export-to-figma.ts` | Automated Figma REST API importer (run once you have a personal access token) |

---

## Step 1 — Import Design Tokens with Tokens Studio

Tokens Studio (formerly Figma Tokens) is a free Figma plugin that reads the JSON format used here.

### Install the Plugin

1. Open Figma → **Plugins** → search **Tokens Studio for Figma** → Install.
2. Open any Figma file (or create a blank one titled "The Browser Design System v1").
3. Launch the plugin: **Plugins → Tokens Studio for Figma**.

### Load the Token File

1. In the Tokens Studio panel choose **Sync → Local file / JSON**.
2. Click **Load from file** and select `my-app/design/figma-tokens.json`.
3. The plugin will parse three token sets: `shell`, `onboarding`, and `shared`.
4. Enable all three sets in the left column (toggle on).
5. Click **Apply to document** — Tokens Studio will create Figma Variables for every token.

### Token Set Activation Rules

- For shell/app screens: activate `shell` + `shared`.
- For onboarding screens: activate `onboarding` + `shared`.
- Never activate both `shell` and `onboarding` simultaneously — they define conflicting `bg.base` and `fg.primary` values.

### Verify the Import

After applying, open **Assets → Local variables** in Figma. You should see variable collections named:
- `shell/colors/bg`, `shell/colors/fg`, `shell/colors/accent`, etc.
- `onboarding/colors/bg`, `onboarding/colors/pill`, etc.
- `shared/spacing`, `shared/radii`, `shared/motion`, `shared/semantic`

---

## Step 2 — Import SVG Brand Assets

All SVG assets live in `my-app/assets/brand/`. Figma accepts SVGs dragged directly onto the canvas.


### Wordmarks

| File | Suggested Use |
|---|---|
| `assets/brand/wordmarks/wordmark-dark.svg` | On dark backgrounds (`#0a0a0d`, `#1a1a1f`) |
| `assets/brand/wordmarks/wordmark-light.svg` | On light backgrounds (marketing, export) |

### App Icon

| File | Suggested Use |
|---|---|
| `assets/brand/icons/app-icon-1024.svg` | App icon reference, macOS marketing |

### Diagrams

| File | Suggested Use |
|---|---|
| `assets/brand/diagrams/agent-flow.svg` | Architecture reference frame |
| `assets/brand/diagrams/cdp-bridge.svg` | Architecture reference frame |
| `assets/brand/diagrams/pill-states.svg` | State machine reference frame |

### Organize Into Components

After dragging in each SVG:
1. Select the SVG layer → press **Ctrl/Cmd+Alt+K** to create a component.
2. Name it using the slash convention: `Brand/Mascot/Idle`, `Brand/Wordmark/Dark`, etc.
3. Move all brand components to a dedicated **"Brand Assets"** page in your Figma file.

---

## Step 3 — Drop in Screen Baselines as Reference Frames

The PNG screenshots in `my-app/tests/visual/references/` are the current UI baselines. Use them as reference frames to trace over or annotate.

### Drag and Drop

1. In Figma, create a new page called **"Screen Baselines"**.
2. Drag each PNG file onto the canvas:

| File | Suggested Frame Label | Resolution |
|---|---|---|
| `tests/visual/references/onboarding-welcome.png` | Screen / Onboarding / Welcome | 1280×800 |
| `tests/visual/references/onboarding-naming.png` | Screen / Onboarding / Naming | 1280×800 |
| `tests/visual/references/onboarding-account.png` | Screen / Onboarding / Account | 1280×800 |
| `tests/visual/references/onboarding-account-scopes.png` | Screen / Onboarding / Scopes | 1280×800 |
| `tests/visual/references/shell-empty.png` | Screen / Shell / Empty | 1280×800 |
| `tests/visual/references/shell-3-tabs.png` | Screen / Shell / Three Tabs | 1280×800 |
| `tests/visual/references/pill-idle.png` | Screen / Pill / Idle | varies |
| `tests/visual/references/pill-streaming.png` | Screen / Pill / Streaming | varies |
| `tests/visual/references/pill-done.png` | Screen / Pill / Done | varies |
| `tests/visual/references/pill-error.png` | Screen / Pill / Error | varies |

3. Select each image → press **F** to convert to a frame at the image's native dimensions.
4. Lock the image layer (right-click → Lock) to prevent accidental moves while tracing.

---

## Step 4 — Token-to-CSS Variable Mapping

The following table maps every Figma variable (Tokens Studio path) to its CSS custom property counterpart in the app. Use this when building components in Figma that need to match the live codebase.

### Shell Theme — Colors

| Tokens Studio path | CSS custom property | Value |
|---|---|---|
| `shell.colors.bg.base` | `--color-bg-base` | `#0a0a0d` |
| `shell.colors.bg.elevated` | `--color-bg-elevated` | `#111114` |
| `shell.colors.bg.overlay` | `--color-bg-overlay` | `#16161a` |
| `shell.colors.bg.sunken` | `--color-bg-sunken` | `#070709` |
| `shell.colors.fg.primary` | `--color-fg-primary` | `#f0f0f2` |
| `shell.colors.fg.secondary` | `--color-fg-secondary` | `#8a8f98` |
| `shell.colors.fg.tertiary` | `--color-fg-tertiary` | `#6e737d` |
| `shell.colors.fg.disabled` | `--color-fg-disabled` | `#3a3f48` |
| `shell.colors.fg.inverse` | `--color-fg-inverse` | `#0a0a0d` |
| `shell.colors.border.subtle` | `--color-border-subtle` | `#1e1e24` |
| `shell.colors.border.default` | `--color-border-default` | `#282830` |
| `shell.colors.border.strong` | `--color-border-strong` | `#3a3a44` |
| `shell.colors.accent.default` | `--color-accent-default` | `#c8f135` |
| `shell.colors.accent.hover` | `--color-accent-hover` | `#d4f74e` |
| `shell.colors.accent.active` | `--color-accent-active` | `#b8e020` |
| `shell.colors.accent.subtle` | `--color-accent-subtle` | `rgba(200,241,53,0.10)` |
| `shell.colors.accent.glow` | `--color-accent-glow` | `rgba(200,241,53,0.18)` |
| `shell.colors.status.success` | `--color-status-success` | `#4ade80` |
| `shell.colors.status.warning` | `--color-status-warning` | `#f59e0b` |
| `shell.colors.status.error` | `--color-status-error` | `#f87171` |
| `shell.colors.status.info` | `--color-status-info` | `#60a5fa` |
| `shell.colors.surface.glass` | `--color-surface-glass` | `rgba(22,22,26,0.85)` |
| `shell.colors.surface.scrim` | `--color-surface-scrim` | `rgba(0,0,0,0.60)` |
| `shell.colors.tab.bg` | `--color-tab-bg` | `#111114` |
| `shell.colors.tab.activeBg` | `--color-tab-active-bg` | `#16161a` |
| `shell.colors.tab.hoverBg` | `--color-tab-hover-bg` | `#14141a` |
| `shell.colors.pill.bg` | `--color-pill-bg` | `#16161a` |
| `shell.colors.pill.border` | `--color-pill-border` | `#2e2e38` |

### Onboarding Theme — Colors

| Tokens Studio path | CSS custom property | Value |
|---|---|---|
| `onboarding.colors.bg.base` | `--color-bg-base` | `#1a1a1f` |
| `onboarding.colors.bg.elevated` | `--color-bg-elevated` | `#22222a` |
| `onboarding.colors.bg.overlay` | `--color-bg-overlay` | `#2a2a34` |
| `onboarding.colors.bg.card` | `--color-bg-card` | `#1e1e26` |
| `onboarding.colors.fg.primary` | `--color-fg-primary` | `#f2f0ee` |
| `onboarding.colors.fg.secondary` | `--color-fg-secondary` | `#9a96a0` |
| `onboarding.colors.fg.tertiary` | `--color-fg-tertiary` | `#7a7580` |
| `onboarding.colors.accent.default` | `--color-accent-default` | `#c8f135` |

### Shared — Spacing

CSS custom property pattern: `--spacing-{key}` (e.g. `--spacing-4` = 8px).

| Tokens Studio path | CSS custom property | px |
|---|---|---|
| `shared.spacing.0` | `--spacing-0` | 0 |
| `shared.spacing.1` | `--spacing-1` | 2 |
| `shared.spacing.2` | `--spacing-2` | 4 |
| `shared.spacing.3` | `--spacing-3` | 6 |
| `shared.spacing.4` | `--spacing-4` | 8 |
| `shared.spacing.5` | `--spacing-5` | 12 |
| `shared.spacing.6` | `--spacing-6` | 16 |
| `shared.spacing.7` | `--spacing-7` | 20 |
| `shared.spacing.8` | `--spacing-8` | 24 |
| `shared.spacing.9` | `--spacing-9` | 32 |
| `shared.spacing.10` | `--spacing-10` | 40 |
| `shared.spacing.11` | `--spacing-11` | 48 |
| `shared.spacing.12` | `--spacing-12` | 64 |
| `shared.spacing.13` | `--spacing-13` | 80 |
| `shared.spacing.14` | `--spacing-14` | 96 |
| `shared.spacing.15` | `--spacing-15` | 128 |

### Shared — Radii

CSS custom property pattern: `--radius-{key}`.

| Tokens Studio path | CSS custom property | px |
|---|---|---|
| `shared.radii.none` | `--radius-none` | 0 |
| `shared.radii.xs` | `--radius-xs` | 3 |
| `shared.radii.sm` | `--radius-sm` | 5 |
| `shared.radii.md` | `--radius-md` | 7 |
| `shared.radii.lg` | `--radius-lg` | 10 |
| `shared.radii.xl` | `--radius-xl` | 14 |
| `shared.radii.2xl` | `--radius-2xl` | 18 |
| `shared.radii.3xl` | `--radius-3xl` | 24 |
| `shared.radii.full` | `--radius-full` | 9999 |

### Shared — Motion

CSS custom property patterns: `--duration-{key}` and `--ease-{key}`.

| Tokens Studio path | CSS custom property | Value |
|---|---|---|
| `shared.motion.duration.instant` | `--duration-instant` | 0ms |
| `shared.motion.duration.fast` | `--duration-fast` | 80ms |
| `shared.motion.duration.normal` | `--duration-normal` | 150ms |
| `shared.motion.duration.moderate` | `--duration-moderate` | 220ms |
| `shared.motion.duration.slow` | `--duration-slow` | 350ms |
| `shared.motion.duration.crawl` | `--duration-crawl` | 500ms |
| `shared.motion.easing.standard` | `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |
| `shared.motion.easing.decelerate` | `--ease-decelerate` | `cubic-bezier(0, 0, 0.2, 1)` |
| `shared.motion.easing.accelerate` | `--ease-accelerate` | `cubic-bezier(0.4, 0, 1, 1)` |
| `shared.motion.easing.spring` | `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` |

---

## Typography Notes for Figma

- **Shell UI / body:** Use `Geist` (download from [vercel.com/font](https://vercel.com/font)). Fallback: Söhne, then system-ui.
- **Monospace:** Use `Berkeley Mono` (commercial) or `JetBrains Mono` (free, Google Fonts) as a stand-in.
- **Brand / hero:** Use `Instrument Serif` (free, Google Fonts) — for onboarding headlines and wordmark only.
- **Never use Inter.** The app design system explicitly bans Inter.

---

## Automated Import (When You Have a Figma PAT)

Once you have a Figma Personal Access Token, run the automated importer to create the file programmatically:

```bash
FIGMA_TOKEN=your_token_here npx ts-node my-app/scripts/export-to-figma.ts
```

This script creates a file called "The Browser Design System v1" in your Figma drafts, populates local variables, uploads SVG components, and adds PNG frames. See `scripts/export-to-figma.ts` for details.
