# Agentic Browser — Design System Reference

Single source of truth for all renderer surfaces. Generated from `tokens.ts`, `fonts.ts`, `theme.shell.css`, and `theme.onboarding.css`.

---

## Themes

The app ships two distinct themes applied via `data-theme` on `<html>`:

| Theme | `data-theme` value | Character |
|---|---|---|
| Shell | `shell` | Linear + Obsidian dark. Dense, keyboard-first, neon-accent, no decorative shadows. |
| Onboarding | `onboarding` | Warm dark. Character-forward, rounded, generous padding, pastel capability pills. |

Switch at runtime:
```ts
document.documentElement.dataset.theme = 'shell'       // main app
document.documentElement.dataset.theme = 'onboarding'  // onboarding flow
```

Import:
```ts
import { tokens, SHELL_COLORS, ONBOARDING_COLORS, loadFonts } from '@/design'
import '@/design/theme.global.css'
import '@/design/theme.shell.css'      // or theme.onboarding.css
```

---

## Typography

### Font Families

| Role | CSS var | Primary | Fallback 1 | Fallback 2 | Fallback 3 |
|---|---|---|---|---|---|
| UI / Display / Body | `--font-ui` | Geist | Söhne | system-ui | sans-serif |
| Monospace | `--font-mono` | Berkeley Mono | JetBrains Mono | ui-monospace | monospace |

Font files belong in `public/fonts/<family>/<file>.woff2`. See `fonts.ts` for exact paths.

### Font Sizes

| Token | CSS var | px value | Typical use |
|---|---|---|---|
| `2xs` | `--font-size-2xs` | 10px | Status labels, badge counts |
| `xs` | `--font-size-xs` | 11px | Key hint chips, metadata |
| `sm` | `--font-size-sm` | 12px | Tab labels, secondary copy, URL bar |
| `md` | `--font-size-md` | 13px | List rows, compact UI |
| `base` | `--font-size-base` | 14px | Body text, form fields |
| `lg` | `--font-size-lg` | 15px | Subheadings, emphasized body |
| `xl` | `--font-size-xl` | 17px | Section headings |
| `2xl` | `--font-size-2xl` | 20px | Page subheadings |
| `3xl` | `--font-size-3xl` | 24px | Page headings |
| `4xl` | `--font-size-4xl` | 30px | Hero subheadings |
| `5xl` | `--font-size-5xl` | 38px | Hero / display headings |

### Font Weights

| Token | CSS var | Value |
|---|---|---|
| `regular` | `--font-weight-regular` | 400 |
| `medium` | `--font-weight-medium` | 500 |
| `semibold` | `--font-weight-semibold` | 600 |
| `bold` | `--font-weight-bold` | 700 |

### Line Heights

| Token | CSS var | Value | Use |
|---|---|---|---|
| `tight` | `--line-height-tight` | 1.2 | Display headings |
| `snug` | `--line-height-snug` | 1.35 | Subheadings |
| `normal` | `--line-height-normal` | 1.45 (shell) / 1.5 (onboarding) | Body text |
| `relaxed` | `--line-height-relaxed` | 1.6 (shell) / 1.65 (onboarding) | Long-form prose |

---

## Color Tokens

### Shell Theme (`data-theme="shell"`)

#### Backgrounds

| Token | CSS var | Hex | Semantic role |
|---|---|---|---|
| `bgBase` | `--color-bg-base` | `#0a0a0d` | Root window background |
| `bgElevated` | `--color-bg-elevated` | `#111114` | Raised surfaces (tab bar, sidebar) |
| `bgOverlay` | `--color-bg-overlay` | `#16161a` | Overlays, pill, active tab |
| `bgSunken` | `--color-bg-sunken` | `#070709` | Recessed wells, input backgrounds |

#### Foregrounds

| Token | CSS var | Hex | Semantic role |
|---|---|---|---|
| `fgPrimary` | `--color-fg-primary` | `#f0f0f2` | Primary text, active labels |
| `fgSecondary` | `--color-fg-secondary` | `#8a8f98` | Secondary text, inactive tabs |
| `fgTertiary` | `--color-fg-tertiary` | `#5a5f68` | Section headers, placeholders |
| `fgDisabled` | `--color-fg-disabled` | `#3a3f48` | Disabled controls |
| `fgInverse` | `--color-fg-inverse` | `#0a0a0d` | Text on accent backgrounds |

#### Borders

| Token | CSS var | Hex | Semantic role |
|---|---|---|---|
| `borderSubtle` | `--color-border-subtle` | `#1e1e24` | Tab strip underlines, dividers |
| `borderDefault` | `--color-border-default` | `#282830` | Input borders, card outlines |
| `borderStrong` | `--color-border-strong` | `#3a3a44` | Emphasized separators |

#### Accent (neon yellow-green — one accent, sharp)

| Token | CSS var | Value | Use |
|---|---|---|---|
| `accentDefault` | `--color-accent-default` | `#c8f135` | Primary CTA, active state indicator |
| `accentHover` | `--color-accent-hover` | `#d4f74e` | Hover state of accent elements |
| `accentActive` | `--color-accent-active` | `#b8e020` | Pressed/active state |
| `accentSubtle` | `--color-accent-subtle` | `rgba(200,241,53,0.10)` | Selected row backgrounds |
| `accentGlow` | `--color-accent-glow` | `rgba(200,241,53,0.18)` | Glow ring on focused inputs, pill |

#### Status

| Token | CSS var | Hex | Semantic role |
|---|---|---|---|
| `statusSuccess` | `--color-status-success` | `#4ade80` | Connected, completed, ok |
| `statusWarning` | `--color-status-warning` | `#f59e0b` | Degraded, needs attention |
| `statusError` | `--color-status-error` | `#f87171` | Error, disconnected, failed |
| `statusInfo` | `--color-status-info` | `#60a5fa` | Informational, in-progress |

#### Surfaces

| Token | CSS var | Value | Use |
|---|---|---|---|
| `surfaceGlass` | `--color-surface-glass` | `rgba(22,22,26,0.85)` | Frosted glass panels |
| `surfaceScrim` | `--color-surface-scrim` | `rgba(0,0,0,0.60)` | Modal/overlay backdrop |

#### Shell-specific aliases

| Token | CSS var | Hex | Use |
|---|---|---|---|
| `tabBg` | `--color-tab-bg` | `#111114` | Inactive tab |
| `tabActiveBg` | `--color-tab-active-bg` | `#16161a` | Active tab |
| `tabHoverBg` | `--color-tab-hover-bg` | `#14141a` | Hovered tab |
| `pillBg` | `--color-pill-bg` | `#16161a` | Pill window background |
| `pillBorder` | `--color-pill-border` | `#2e2e38` | Pill window border |

---

### Onboarding Theme (`data-theme="onboarding"`)

#### Backgrounds

| Token | CSS var | Hex | Semantic role |
|---|---|---|---|
| `bgBase` | `--color-bg-base` | `#1a1a1f` | Onboarding root background |
| `bgElevated` | `--color-bg-elevated` | `#22222a` | Cards, modals |
| `bgOverlay` | `--color-bg-overlay` | `#2a2a34` | Dropdowns, tooltips |
| `bgCard` | `--color-bg-card` | `#1e1e26` | Content cards |

#### Capability Pill Palette

| Capability | Text color | Hex | Background | Hex |
|---|---|---|---|---|
| Research | `pillResearch` | `#a78bfa` | `pillResearchBg` | `rgba(167,139,250,0.18)` |
| Sourcing | `pillSourcing` | `#fbbf24` | `pillSourcingBg` | `rgba(251,191,36,0.18)` |
| Automation | `pillAutomation` | `#34d399` | `pillAutomationBg` | `rgba(52,211,153,0.18)` |
| Emails | `pillEmails` | `#60a5fa` | `pillEmailsBg` | `rgba(96,165,250,0.18)` |
| Scraping | `pillScraping` | `#f87171` | `pillScrapingBg` | `rgba(248,113,113,0.18)` |
| More | `pillMore` | `#fb923c` | `pillMoreBg` | `rgba(251,146,60,0.18)` |

#### Mascot Colors

| Token | Hex | Use |
|---|---|---|
| `mascotBody` | `#7fb3d0` | Blue-grey mascot fill |
| `mascotBodyShadow` | `#5a9abf` | Shadow underside |
| `mascotEye` | `#1a1a2e` | Eye fill |
| `mascotHighlight` | `#b0d4e8` | Specular highlight |

#### Google Service Colors

| Service | Token | Hex |
|---|---|---|
| Gmail | `gmailRed` | `#ea4335` |
| Calendar | `calendarBlue` | `#4285f4` |
| Sheets | `sheetsGreen` | `#34a853` |
| Drive | `driveYellow` | `#fbbc05` |
| Docs | `docsBlueDark` | `#1967d2` |

---

## Spacing Scale

All values in px. CSS vars: `--spacing-{key}` (not yet in CSS files — apply inline or extend theme files).

| Key | px | Typical use |
|---|---|---|
| `0` | 0 | No spacing |
| `1` | 2 | Icon gap minimum |
| `2` | 4 | Tight inline gap |
| `3` | 6 | Icon-to-label gap |
| `4` | 8 | Compact padding |
| `5` | 12 | Standard gap |
| `6` | 16 | Section internal padding |
| `7` | 20 | Card padding |
| `8` | 24 | Section gap |
| `9` | 32 | Large section gap |
| `10` | 40 | Layout breathing room |
| `11` | 48 | Section heading spacing |
| `12` | 64 | Page section gap |
| `13` | 80 | Hero section padding |
| `14` | 96 | Large layout spacing |
| `15` | 128 | Max layout gap |

---

## Border Radius Scale

| Token | CSS var | px | Use |
|---|---|---|---|
| `none` | `--radius-none` | 0 | Sharp corners (tables, inset elements) |
| `xs` | `--radius-xs` | 3 | Key hint chips, badges |
| `sm` | `--radius-sm` | 5 | Tabs, nav buttons, list row hover |
| `md` | `--radius-md` | 7 | Inputs, URL bar, buttons |
| `lg` | `--radius-lg` | 10 | Cards |
| `xl` | `--radius-xl` | 14 | Pill overlay, modals |
| `2xl` | `--radius-2xl` | 18 | Large cards |
| `3xl` | `--radius-3xl` | 24 | Hero cards, onboarding panels |
| `full` | `--radius-full` | 9999 | Circular avatars, toggle thumbs |

---

## Animation

### Durations

| Token | CSS var | ms | Use |
|---|---|---|---|
| `instant` | `--duration-instant` | 0 | No animation (reduced-motion, skip) |
| `fast` | `--duration-fast` | 80 | Hover color changes, tab switches |
| `normal` | `--duration-normal` | 150 | Button states, input focus rings |
| `moderate` | `--duration-moderate` | 220 | Sidebar expand/collapse, dropdowns |
| `slow` | `--duration-slow` | 350 | Page transitions, modal enter/exit |
| `crawl` | `--duration-crawl` | 500 | Pulse animations, mascot idle loops |

### Easing Curves

| Token | CSS var | Cubic bezier | Character |
|---|---|---|---|
| `standard` | `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Default — fast out, authoritative |
| `decelerate` | `--ease-decelerate` | `cubic-bezier(0, 0, 0.2, 1)` | Element enters screen — starts fast, settles |
| `accelerate` | `--ease-accelerate` | `cubic-bezier(0.4, 0, 1, 1)` | Element leaves screen — starts slow, exits fast |
| `spring` | `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful overshoot — mascot entrance, success state |

### Animation Principles

- **Shell**: glow pulses only. No translate/scale animations on functional UI. `agent-active` class pulses `box-shadow` on the accent glow. Status dots pulse on `busy`.
- **Onboarding**: spring easing on mascot entrance, decelerate on step transitions, standard on all interactive feedback.
- **Respect `prefers-reduced-motion`**: wrap all keyframe animations in `@media (prefers-reduced-motion: no-preference)`.

---

## Shadow & Glow

The Shell theme uses **zero decorative shadows** — glow only.

| Token | CSS var | Value | Use |
|---|---|---|---|
| `glow-accent` | `--glow-accent` | `0 0 12px rgba(200,241,53,0.18)` | Pill border, focused URL bar |
| `focusRing` | (semantic) | `0 0 0 2px var(--color-accent-default)` | Keyboard focus ring on interactive elements |
| `shadowSm` | (onboarding only) | `0 1px 3px rgba(0,0,0,0.4)` | Card elevation |
| `shadowMd` | (onboarding only) | `0 4px 12px rgba(0,0,0,0.5)` | Modal elevation |
| `shadowLg` | (onboarding only) | `0 8px 32px rgba(0,0,0,0.6)` | Fullscreen overlay elevation |

---

## Z-Index Layers

| Token | CSS var | Value | Layer |
|---|---|---|---|
| `base` | `--z-base` | 0 | Default document flow |
| `raised` | `--z-raised` | 10 | Sticky headers, floating labels |
| `dropdown` | `--z-dropdown` | 100 | Dropdowns, autocomplete |
| `sticky` | `--z-sticky` | 200 | Sticky nav, tab strip |
| `overlay` | `--z-overlay` | 300 | Drawers, side panels |
| `modal` | `--z-modal` | 400 | Dialog/modal windows |
| `toast` | `--z-toast` | 500 | Toast notifications |
| `pill` | `--z-pill` | 600 | Cmd+K pill overlay |
| `tooltip` | `--z-tooltip` | 700 | Tooltip (always on top) |

---

## Component Usage Rules

### Button vs Ghost

- **Button** (solid accent fill): primary CTA only. One per screen. Examples: "Continue", "Connect Google", "Save changes".
- **Ghost** (transparent, border on hover): secondary/tertiary actions. Nav buttons, icon actions, "Skip" links.
- Never use more than one solid accent button in a single view. If two equal-weight actions exist, both are ghost.

### Card vs Modal

- **Card**: persistent content container within the page flow. Rounded `lg`–`3xl`, no scrim, keyboard-navigable inline.
- **Modal**: interrupts the flow. Requires scrim (`surfaceScrim`), focus trap, Escape to dismiss, `aria-modal="true"`. Use only for destructive confirmations or OAuth flows.

### Tab vs Section

- **Tab** (`.tab`): navigates between browser pages. Always in the tab strip. Max width 220px, min 48px.
- **Section header** (`.section-header`): organizes content within a single view. Uppercase, 11px, tertiary color, 7% letter-spacing.

### Key Hint Chip (`.keyhint`)

Use for keyboard shortcut reminders adjacent to the action they trigger. Never use as a label alone. Always pair with an icon or text label. Example: `Cmd` `K` next to the search/pill trigger.

### Status Dot (`.status-dot`)

Use `data-status` attribute values: `active` (green glow), `busy` (accent pulse), `error` (red), default (disabled grey). Never use color alone — always accompany with a text label for accessibility.

### List Row (`.list-row`)

32px height, 8px inline padding. Use for dense command-palette-style lists. Selected state uses `accentSubtle` background. Never use for navigation between pages (use tabs or links).

### URL Bar

Monospace font (`--font-mono`). Shows glow on `:focus-within`. Do not use `--font-ui` for the URL bar — URLs must be rendered in a fixed-width face for character-by-character legibility.

---

## Absolutely Not

These rules are hard constraints. Any code that violates them will be rejected in review.

- **No Inter font.** The app uses Geist (UI) and Berkeley Mono (mono). Inter is banned. Never add it as a fallback, import, or `font-family` value.
- **No sparkles icon.** The app has no sparkle/stars decorative element. The mascot is the personality surface — not icons.
- **No `!important`.** All specificity is managed via `[data-theme]` attribute selectors. `!important` is a sign of specificity debt and will be reverted.
- **No left outline / left border emphasis.** Do not use `border-left` as a visual emphasis pattern (the "vibe coding" tell). Use background color, text weight, or icon state for active/selected emphasis.
- **No approximated numbers.** Token values are exact: `#c8f135` not `#c9f135`, `80ms` not `~80ms`, `cubic-bezier(0.2, 0, 0, 1)` not `ease-out`. Always copy from `tokens.ts` or the CSS variables.
- **No inline `style` overrides that duplicate a CSS var.** If a CSS var exists for the value, use the var. Inline styles are only for truly dynamic values (e.g. computed widths from JS).
- **No shadow in Shell theme.** `--shadow-sm/md/lg` are all `none` in the Shell theme. Elevation in the shell is expressed via background color steps (`bgBase` → `bgElevated` → `bgOverlay`), not shadows.

---

## File Map

| File | Purpose |
|---|---|
| `tokens.ts` | TypeScript constants — all raw values. Authoritative source. |
| `fonts.ts` | `@font-face` declarations + `loadFonts()` boot call |
| `index.ts` | Barrel export for all design tokens and utilities |
| `theme.global.css` | Global resets + shared base styles |
| `theme.shell.css` | Shell theme CSS custom properties + component classes |
| `theme.onboarding.css` | Onboarding theme CSS custom properties + component classes |
| `empty-states.css` | Empty and error state illustrations |
