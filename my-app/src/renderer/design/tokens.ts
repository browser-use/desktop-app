/**
 * Design tokens — single source of truth for all renderer surfaces.
 * Shell theme: Linear + Obsidian (dense, dark, keyboard-first).
 * Onboarding theme: warm, character-forward, rounded.
 *
 * RULE: Hex literals live ONLY in this file and in CSS token definition blocks.
 * Every component CSS file uses CSS custom properties — never raw hex.
 *
 * Usage: import { tokens, SHELL_COLORS, ONBOARDING_COLORS } from './tokens'
 * CSS custom properties mirror these values; see theme.global.css / theme.shell.css / theme.onboarding.css.
 */

// ---------------------------------------------------------------------------
// Color primitives — slate scale (0 = darkest, 12 = lightest)
// These are the ONLY place hex literals for the slate ramp appear.
// ---------------------------------------------------------------------------
export const SLATE = {
  0:  '#030305',
  1:  '#070709',
  2:  '#0a0a0d',
  3:  '#0f0f12',
  4:  '#111114',
  5:  '#14141a',
  6:  '#16161a',
  7:  '#1e1e24',
  8:  '#282830',
  9:  '#3a3a44',
  10: '#6e737d',
  11: '#8a8f98',
  12: '#f0f0f2',
} as const;

export type SlateKey = keyof typeof SLATE;

// ---------------------------------------------------------------------------
// Accent primitives — neon yellow-green (ONE accent colour)
// ---------------------------------------------------------------------------
export const ACCENT = {
  base:  '#6D8196',   // --accent-base
  dim:   '#5C7085',   // --accent-dim  (pressed/active — darker)
  hover: '#7E92A7',   // --accent-hover
} as const;

// ---------------------------------------------------------------------------
// Status primitives
// ---------------------------------------------------------------------------
export const STATUS = {
  danger:  '#f87171',
  success: '#4ade80',
  warning: '#f59e0b',
  info:    '#60a5fa',
} as const;

// ---------------------------------------------------------------------------
// Shell semantic tokens (mapped from primitives above)
// ---------------------------------------------------------------------------
export const SHELL_COLORS = {
  // Backgrounds
  bgBase:    SLATE[2],   // #0a0a0d
  bgElevated: SLATE[4],  // #111114
  bgOverlay: SLATE[6],   // #16161a
  bgSunken:  SLATE[1],   // #070709

  // Foregrounds
  fgPrimary:   SLATE[12],  // #f0f0f2
  fgSecondary: SLATE[11],  // #8a8f98
  fgTertiary:  SLATE[10],  // #6e737d — WCAG 3.79:1 on bg-overlay
  fgDisabled:  '#3a3f48',
  fgInverse:   SLATE[2],   // #0a0a0d — text on accent backgrounds

  // Borders
  borderSubtle:  SLATE[7],  // #1e1e24
  borderDefault: SLATE[8],  // #282830
  borderStrong:  SLATE[9],  // #3a3a44

  // Accent
  accentDefault: ACCENT.base,   // #6D8196
  accentHover:   ACCENT.hover,  // #7E92A7
  accentActive:  ACCENT.dim,    // #5C7085
  accentSubtle:  'rgba(109, 129, 150, 0.10)',
  accentGlow:    'rgba(109, 129, 150, 0.18)',

  // Status
  statusSuccess: STATUS.success,  // #4ade80
  statusWarning: STATUS.warning,  // #f59e0b
  statusError:   STATUS.danger,   // #f87171
  statusInfo:    STATUS.info,     // #60a5fa

  // Surfaces / overlays
  surfaceGlass: 'rgba(22, 22, 26, 0.85)',
  surfaceScrim: 'rgba(0, 0, 0, 0.60)',

  // Shell-specific token aliases
  tabBg:        SLATE[4],   // #111114
  tabActiveBg:  SLATE[6],   // #16161a
  tabHoverBg:   SLATE[5],   // #14141a
  pillBg:       SLATE[6],   // #16161a
  pillBorder:   '#2e2e38',
} as const;

// ---------------------------------------------------------------------------
// Onboarding semantic tokens — warm dark, character-forward
// ---------------------------------------------------------------------------
export const ONBOARDING_COLORS = {
  // Backgrounds (warmer dark — slightly purple-shifted)
  bgBase:    '#1a1a1f',
  bgElevated: '#22222a',
  bgOverlay: '#2a2a34',
  bgCard:    '#1e1e26',

  // Foregrounds
  fgPrimary:   '#f2f0ee',
  fgSecondary: '#9a96a0',
  fgTertiary:  '#7a7580',   // WCAG 3.52:1 on bg-elevated
  fgDisabled:  '#4a4550',
  fgInverse:   '#1a1a1f',

  // Borders
  borderSubtle:  '#2a2a34',
  borderDefault: '#34343f',
  borderStrong:  '#44444f',

  // Accent (shared with shell)
  accentDefault: ACCENT.base,
  accentHover:   ACCENT.hover,
  accentActive:  ACCENT.dim,
  accentSubtle:  'rgba(109, 129, 150, 0.12)',
  accentGlow:    'rgba(109, 129, 150, 0.20)',

  // Status
  statusSuccess: STATUS.success,
  statusWarning: STATUS.warning,
  statusError:   STATUS.danger,
  statusInfo:    STATUS.info,

  // Capability pill palette (pastel — matches screenshot)
  pillResearch:    '#a78bfa',
  pillResearchBg:  'rgba(167, 139, 250, 0.18)',
  pillSourcing:    '#fbbf24',
  pillSourcingBg:  'rgba(251, 191, 36, 0.18)',
  pillAutomation:  '#34d399',
  pillAutomationBg: 'rgba(52, 211, 153, 0.18)',
  pillEmails:      STATUS.info,   // #60a5fa
  pillEmailsBg:    'rgba(96, 165, 250, 0.18)',
  pillScraping:    STATUS.danger, // #f87171
  pillScrapingBg:  'rgba(248, 113, 113, 0.18)',
  pillMore:        '#fb923c',
  pillMoreBg:      'rgba(251, 146, 60, 0.18)',


  // Modal
  modalBg:     '#22222a',
  modalBorder: '#34343f',
  modalScrim:  'rgba(10, 10, 13, 0.75)',

  // Google service brand colors (third-party — cannot be tokenized to our palette)
  gmailRed:      '#ea4335',
  calendarBlue:  '#4285f4',
  sheetsGreen:   '#34a853',
  driveYellow:   '#fbbc05',
  docsBlueDark:  '#1967d2',
} as const;

// ---------------------------------------------------------------------------
// Spacing scale (8pt-ish; px values as numbers)
// Token names match the CSS vars: --space-{key}
// ---------------------------------------------------------------------------
export const SPACING = {
  0:  0,   // 0px   no spacing
  1:  2,   // 2px   icon gap minimum
  2:  4,   // 4px   tight inline gap
  3:  6,   // 6px   icon-to-label gap
  4:  8,   // 8px   compact padding
  5:  10,  // 10px  small nudge
  6:  12,  // 12px  standard gap
  8:  16,  // 16px  section internal padding
  10: 20,  // 20px  card padding
  12: 24,  // 24px  section gap
  16: 32,  // 32px  large section gap
  20: 40,  // 40px  layout breathing room
  24: 48,  // 48px  section heading spacing
  32: 64,  // 64px  page section gap
} as const;

export type SpacingKey = keyof typeof SPACING;

// ---------------------------------------------------------------------------
// Border radii
// ---------------------------------------------------------------------------
export const RADII = {
  xs:   2,    // 2px    badges, tight chips
  sm:   4,    // 4px    tabs, nav buttons
  md:   6,    // 6px    inputs, buttons, URL bar
  lg:   8,    // 8px    cards
  xl:   12,   // 12px   modals
  '2xl': 16,  // 16px   pill overlay, large cards
  full: 9999, // 9999px circular avatars, toggle thumbs
} as const;

export type RadiusKey = keyof typeof RADII;

// ---------------------------------------------------------------------------
// Animation durations (ms)
// ---------------------------------------------------------------------------
export const DURATIONS = {
  fast:   80,   // Hover color changes, tab switches
  normal: 180,  // Button states, input focus
  slow:   320,  // Page transitions, modal enter/exit
} as const;

export type DurationKey = keyof typeof DURATIONS;

// ---------------------------------------------------------------------------
// Easing curves
// ---------------------------------------------------------------------------
export const EASINGS = {
  out:      'cubic-bezier(0.2, 0, 0, 1)',
  spring:   'cubic-bezier(0.34, 1.56, 0.64, 1)',
  inOut:    'cubic-bezier(0.4, 0, 0.6, 1)',
  // Aliases for backward compatibility
  standard:   'cubic-bezier(0.2, 0, 0, 1)',
  decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

export type EasingKey = keyof typeof EASINGS;

// ---------------------------------------------------------------------------
// Typography scale
// ---------------------------------------------------------------------------
export const FONT_SIZES = {
  '2xs': 10,
  xs:    11,
  sm:    12,
  md:    13,
  base:  14,
  lg:    15,
  xl:    17,
  '2xl': 20,
  '3xl': 24,
  '4xl': 30,
  '5xl': 38,
} as const;

export const LINE_HEIGHTS = {
  tight:   1.2,
  snug:    1.35,
  normal:  1.45,
  relaxed: 1.6,
} as const;

export const FONT_WEIGHTS = {
  regular:  400,
  medium:   500,
  semibold: 600,
  bold:     700,
} as const;

// ---------------------------------------------------------------------------
// Z-index layers
// ---------------------------------------------------------------------------
export const Z_INDEX = {
  base:     0,
  raised:   10,
  dropdown: 100,
  sticky:   200,
  overlay:  300,
  modal:    400,
  toast:    500,
  pill:     600,
  tooltip:  700,
  max:      9999,
} as const;

// ---------------------------------------------------------------------------
// Shadow / Glow tokens (values, not CSS vars — CSS vars defined in theme files)
// ---------------------------------------------------------------------------
export const SHADOWS = {
  xs: '0 1px 2px rgba(0, 0, 0, 0.30)',
  sm: '0 1px 4px rgba(0, 0, 0, 0.35)',
  md: '0 4px 16px rgba(0, 0, 0, 0.45)',
  lg: '0 8px 40px rgba(0, 0, 0, 0.55)',
  xl: '0 16px 64px rgba(0, 0, 0, 0.65)',
} as const;

export const GLOWS = {
  accentSm: '0 0 8px rgba(109, 129, 150, 0.12)',
  accentMd: '0 0 16px rgba(109, 129, 150, 0.20)',
  accentLg: '0 0 32px rgba(109, 129, 150, 0.30)',
} as const;

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------
export const tokens = {
  slate:    SLATE,
  accent:   ACCENT,
  status:   STATUS,
  spacing:  SPACING,
  radii:    RADII,
  durations: DURATIONS,
  easings:  EASINGS,
  fontSizes: FONT_SIZES,
  lineHeights: LINE_HEIGHTS,
  fontWeights: FONT_WEIGHTS,
  shell:    SHELL_COLORS,
  onboarding: ONBOARDING_COLORS,
  zIndex:   Z_INDEX,
  shadows:  SHADOWS,
  glows:    GLOWS,
} as const;

export type Tokens = typeof tokens;
