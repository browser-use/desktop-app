/**
 * Welcome — Screen 1 of onboarding.
 *
 * Layout (matches screenshot):
 *   Left panel: headline, subhead, capability pills, name placeholder, CTA button
 *   Right panel: mascot with float animation
 *
 * StepIndicator is rendered at top-center spanning both panels.
 * Uses only CSS classes from theme.onboarding.css — no hardcoded styles.
 */

import React from 'react';
import { StepIndicator } from './StepIndicator';
import { CapabilitiesGrid } from './CapabilitiesGrid';
import { CharacterMascot } from './CharacterMascot';
import { KeyHint } from '../components/base';
import wordmarkLightUrl from '../../../assets/brand/wordmarks/wordmark-light.svg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 5;
const CURRENT_STEP = 1;

// Wordmark rendered at this width; height scales proportionally from the
// SVG viewBox (420×64 → ~220×33.5 at display size).
const WORDMARK_WIDTH = 220;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WelcomeProps {
  onNext: () => void;
  agentName: string | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Welcome({ onNext, agentName }: WelcomeProps): React.ReactElement {
  return (
    <div className="onboarding-root">
      {/* Step indicator — top-center, spans both panels */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          zIndex: 10,
        }}
      >
        <StepIndicator step={CURRENT_STEP} total={TOTAL_STEPS} />
      </div>

      {/* Left panel */}
      <div className="onboarding-panel-left">
        <div>
          {/* Wordmark — visually hidden h1 preserved for screen readers */}
          <h1 className="onboarding-headline sr-only" aria-label="Agentic Browser">
            Agentic Browser
          </h1>
          <img
            src={wordmarkLightUrl}
            alt="Agentic Browser"
            width={WORDMARK_WIDTH}
            aria-hidden="true"
            draggable={false}
            style={{ display: 'block', marginBottom: 16 }}
          />
          <p className="onboarding-subhead" style={{ marginTop: 0 }}>
            Your very own personal assistant that can help you with
          </p>
        </div>

        <CapabilitiesGrid />

        <p className="onboarding-subhead">
          I have{' '}
          <span className="name-placeholder">
            {agentName ?? 'no name yet'}
          </span>
          .
        </p>
        {!agentName && (
          <p className="onboarding-subhead" style={{ marginTop: -12 }}>
            I'll get one when we've gotten to know each other!
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            className="cta-button"
            onClick={onNext}
            type="button"
            aria-label="Get Started"
          >
            Get Started
            <span aria-hidden="true">→</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <KeyHint keys={['Enter']} size="xs" />
            <span className="onboarding-eyebrow" style={{ textTransform: 'none', letterSpacing: 0 }}>
              to continue
            </span>
          </div>
        </div>
      </div>

      {/* Right panel — mascot */}
      <div className="onboarding-panel-right">
        <CharacterMascot state="idle" />
      </div>
    </div>
  );
}
