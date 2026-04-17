/**
 * Design tokens — single source of truth for all renderer surfaces.
 * Shell theme: Linear + Obsidian (dense, dark, keyboard-first).
 * Onboarding theme: warm, character-forward, rounded.
 *
 * Usage: import { colors, spacing, radii, durations } from './tokens'
 * CSS custom properties mirror these values; see theme.shell.css / theme.onboarding.css.
 */

// ---------------------------------------------------------------------------
// Spacing scale (px values as numbers; CSS vars also defined in theme files)
// ---------------------------------------------------------------------------
export const SPACING = {
  0: 0,
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  5: 12,
  6: 16,
  7: 20,
  8: 24,
  9: 32,
  10: 40,
  11: 48,
  12: 64,
  13: 80,
  14: 96,
  15: 128,
} as const;

export type SpacingKey = keyof typeof SPACING;

// ---------------------------------------------------------------------------
// Border radii
// ---------------------------------------------------------------------------
export const RADII = {
  none: 0,
  xs: 3,
  sm: 5,
  md: 7,
  lg: 10,
  xl: 14,
  '2xl': 18,
  '3xl': 24,
  full: 9999,
} as const;

export type RadiusKey = keyof typeof RADII;

// ---------------------------------------------------------------------------
// Animation durations (ms)
// ---------------------------------------------------------------------------
export const DURATIONS = {
  instant: 0,
  fast: 80,
  normal: 150,
  moderate: 220,
  slow: 350,
  crawl: 500,
} as const;

export type DurationKey = keyof typeof DURATIONS;

// ---------------------------------------------------------------------------
// Easing curves
// ---------------------------------------------------------------------------
export const EASINGS = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

export type EasingKey = keyof typeof EASINGS;

// ---------------------------------------------------------------------------
// Typography scale
// ---------------------------------------------------------------------------
export const FONT_SIZES = {
  '2xs': 10,
  xs: 11,
  sm: 12,
  md: 13,
  base: 14,
  lg: 15,
  xl: 17,
  '2xl': 20,
  '3xl': 24,
  '4xl': 30,
  '5xl': 38,
} as const;

export const LINE_HEIGHTS = {
  tight: 1.2,
  snug: 1.35,
  normal: 1.45,
  relaxed: 1.6,
} as const;

export const FONT_WEIGHTS = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

// ---------------------------------------------------------------------------
// Shell color palette — Linear + Obsidian dark
// ---------------------------------------------------------------------------
export const SHELL_COLORS = {
  // Backgrounds
  bgBase: '#0a0a0d',
  bgElevated: '#111114',
  bgOverlay: '#16161a',
  bgSunken: '#070709',

  // Foregrounds
  fgPrimary: '#f0f0f2',
  fgSecondary: '#8a8f98',
  fgTertiary: '#6e737d',   // was #5a5f68 — lightened to pass WCAG 3:1 (3.79:1 on bg-overlay)
  fgDisabled: '#3a3f48',
  fgInverse: '#0a0a0d',

  // Borders
  borderSubtle: '#1e1e24',
  borderDefault: '#282830',
  borderStrong: '#3a3a44',

  // Accent — yellow-green neon (one accent, sharp)
  accentDefault: '#c8f135',
  accentHover: '#d4f74e',
  accentActive: '#b8e020',
  accentSubtle: 'rgba(200, 241, 53, 0.1)',
  accentGlow: 'rgba(200, 241, 53, 0.18)',

  // Status
  statusSuccess: '#4ade80',
  statusWarning: '#f59e0b',
  statusError: '#f87171',
  statusInfo: '#60a5fa',

  // Surfaces / overlays
  surfaceGlass: 'rgba(22, 22, 26, 0.85)',
  surfaceScrim: 'rgba(0, 0, 0, 0.6)',

  // Shell-specific token aliases
  tabBg: '#111114',
  tabActiveBg: '#16161a',
  tabHoverBg: '#14141a',
  pillBg: '#16161a',
  pillBorder: '#2e2e38',
} as const;

// ---------------------------------------------------------------------------
// Onboarding color palette — warm character-forward
// ---------------------------------------------------------------------------
export const ONBOARDING_COLORS = {
  // Backgrounds (warmer dark)
  bgBase: '#1a1a1f',
  bgElevated: '#22222a',
  bgOverlay: '#2a2a34',
  bgCard: '#1e1e26',

  // Foregrounds
  fgPrimary: '#f2f0ee',
  fgSecondary: '#9a96a0',
  fgTertiary: '#7a7580',   // was #6a6570 — lightened to pass WCAG 3:1 (3.52:1 on bg-elevated)

  // Borders
  borderSubtle: '#2a2a34',
  borderDefault: '#34343f',
  borderStrong: '#44444f',

  // Primary action
  accentDefault: '#c8f135',
  accentHover: '#d4f74e',
  accentSubtle: 'rgba(200, 241, 53, 0.12)',

  // Capability pill palette (pastel — matches screenshot)
  pillResearch: '#a78bfa',       // purple
  pillResearchBg: 'rgba(167, 139, 250, 0.18)',
  pillSourcing: '#fbbf24',       // yellow/amber
  pillSourcingBg: 'rgba(251, 191, 36, 0.18)',
  pillAutomation: '#34d399',     // green
  pillAutomationBg: 'rgba(52, 211, 153, 0.18)',
  pillEmails: '#60a5fa',         // blue
  pillEmailsBg: 'rgba(96, 165, 250, 0.18)',
  pillScraping: '#f87171',       // red
  pillScrapingBg: 'rgba(248, 113, 113, 0.18)',
  pillMore: '#fb923c',           // orange
  pillMoreBg: 'rgba(251, 146, 60, 0.18)',

  // Mascot body — blue-grey character
  mascotBody: '#7fb3d0',
  mascotBodyShadow: '#5a9abf',
  mascotEye: '#1a1a2e',
  mascotHighlight: '#b0d4e8',

  // Modal
  modalBg: '#22222a',
  modalBorder: '#34343f',
  modalScrim: 'rgba(10, 10, 13, 0.75)',

  // Status
  statusSuccess: '#4ade80',
  statusError: '#f87171',

  // Google service icon placeholder colors
  gmailRed: '#ea4335',
  calendarBlue: '#4285f4',
  sheetsGreen: '#34a853',
  driveYellow: '#fbbc05',
  docsBlueDark: '#1967d2',
} as const;

// ---------------------------------------------------------------------------
// Shared semantic tokens (used in both themes via CSS vars)
// ---------------------------------------------------------------------------
export const SEMANTIC = {
  focusRing: '0 0 0 2px var(--color-accent-default)',
  glow: '0 0 12px var(--color-accent-glow)',
  shadowSm: '0 1px 3px rgba(0,0,0,0.4)',
  shadowMd: '0 4px 12px rgba(0,0,0,0.5)',
  shadowLg: '0 8px 32px rgba(0,0,0,0.6)',
} as const;

// ---------------------------------------------------------------------------
// Z-index layers
// ---------------------------------------------------------------------------
export const Z_INDEX = {
  base: 0,
  raised: 10,
  dropdown: 100,
  sticky: 200,
  overlay: 300,
  modal: 400,
  toast: 500,
  pill: 600,
  tooltip: 700,
} as const;

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------
export const tokens = {
  spacing: SPACING,
  radii: RADII,
  durations: DURATIONS,
  easings: EASINGS,
  fontSizes: FONT_SIZES,
  lineHeights: LINE_HEIGHTS,
  fontWeights: FONT_WEIGHTS,
  shell: SHELL_COLORS,
  onboarding: ONBOARDING_COLORS,
  semantic: SEMANTIC,
  zIndex: Z_INDEX,
} as const;

export type Tokens = typeof tokens;
