/**
 * CharacterMascot — renders the real brand mascot SVGs with state-switching.
 *
 * States:
 *   idle        — gentle sinusoidal float (3s, 6px Y range)
 *   thinking    — accelerated bounce (0.8s)
 *   celebrating — scale-pop once then returns to idle float
 *   error       — horizontal shake (0.3s) then settles
 *
 * All animations respect prefers-reduced-motion via CSS media queries.
 * The component never plays SMIL animations — those are self-contained
 * inside the SVG files; we only layer CSS keyframes via the wrapper class.
 *
 * API is backward-compatible: the old `state="loading"` prop is kept as
 * an alias for `state="thinking"`.
 */

import React, { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Asset imports — Vite resolves these to hashed URLs at build time
// ---------------------------------------------------------------------------

import idleUrl      from '../../../assets/brand/mascot/mascot-idle.svg';
import thinkingUrl  from '../../../assets/brand/mascot/mascot-thinking.svg';
import celebratingUrl from '../../../assets/brand/mascot/mascot-celebrating.svg';
import errorUrl     from '../../../assets/brand/mascot/mascot-error.svg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASCOT_URLS = {
  idle:        idleUrl,
  thinking:    thinkingUrl,
  celebrating: celebratingUrl,
  error:       errorUrl,
} as const;

const MASCOT_ALT_LABELS = {
  idle:        'Companion mascot — idle',
  thinking:    'Companion mascot — thinking',
  celebrating: 'Companion mascot — celebrating',
  error:       'Companion mascot — error',
} as const;

// After celebrating or error one-shot animations, revert to idle float timing
const CELEBRATING_RESET_MS = 1200;
const ERROR_RESET_MS = 900;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MascotState = 'idle' | 'thinking' | 'celebrating' | 'error' | 'loading';

interface CharacterMascotProps {
  /** Mascot emotional state — controls which SVG renders and which animation plays. */
  state?: MascotState;
  /** Accessible label for screen readers (overrides auto label). */
  ariaLabel?: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CharacterMascot({
  state = 'idle',
  ariaLabel,
  width = 160,
  height = 180,
}: CharacterMascotProps): React.ReactElement {
  // Normalize legacy "loading" alias to "thinking"
  const normalizedState: Exclude<MascotState, 'loading'> =
    state === 'loading' ? 'thinking' : state;

  // After a one-shot animation (celebrating / error), we keep showing that
  // SVG but swap the animation class back to the idle float so the mascot
  // settles naturally without a hard cut.
  const [animClass, setAnimClass] = useState<string>(
    toAnimClass(normalizedState)
  );

  useEffect(() => {
    const cls = toAnimClass(normalizedState);
    setAnimClass(cls);

    if (normalizedState === 'celebrating') {
      const timer = setTimeout(() => {
        setAnimClass('mascot-anim-idle');
      }, CELEBRATING_RESET_MS);
      return () => clearTimeout(timer);
    }

    if (normalizedState === 'error') {
      const timer = setTimeout(() => {
        setAnimClass('mascot-anim-idle');
      }, ERROR_RESET_MS);
      return () => clearTimeout(timer);
    }

    return undefined;
  }, [normalizedState]);

  const src    = MASCOT_URLS[normalizedState];
  const altMsg = ariaLabel ?? MASCOT_ALT_LABELS[normalizedState];

  // Mascot is decorative by default (right-panel visual storytelling).
  // Pass ariaLabel explicitly to make it meaningful to screen readers.
  const isDecorative = !ariaLabel;

  return (
    <div
      className="mascot-stage"
      aria-hidden={isDecorative ? 'true' : undefined}
      tabIndex={-1}
    >
      <div
        className={`mascot-wrapper ${animClass}`}
        data-state={normalizedState}
      >
        <img
          src={src}
          alt={isDecorative ? '' : altMsg}
          width={width}
          height={height}
          draggable={false}
          style={{ display: 'block' }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAnimClass(state: Exclude<MascotState, 'loading'>): string {
  switch (state) {
    case 'thinking':    return 'mascot-anim-thinking';
    case 'celebrating': return 'mascot-anim-celebrating';
    case 'error':       return 'mascot-anim-error';
    case 'idle':
    default:            return 'mascot-anim-idle';
  }
}
