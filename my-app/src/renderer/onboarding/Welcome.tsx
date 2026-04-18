/**
 * Welcome — Screen 1 of onboarding.
 *
 * Linear-inspired: clean layout, accent CTA pill, no playful elements.
 * Left panel: wordmark, subhead, capabilities, CTA
 * Right panel: mascot
 */

import React from 'react';
import { StepIndicator } from './StepIndicator';
import { CapabilitiesGrid } from './CapabilitiesGrid';
import { CharacterMascot } from './CharacterMascot';
import { KeyHint } from '../components/base';
import wordmarkDarkUrl from '../../../assets/brand/wordmarks/wordmark-dark.svg';

const TOTAL_STEPS = 5;
const CURRENT_STEP = 1;
const WORDMARK_WIDTH = 200;

interface WelcomeProps {
  onNext: () => void;
  agentName: string | undefined;
}

export function Welcome({ onNext }: WelcomeProps): React.ReactElement {
  return (
    <div className="onboarding-root onboarding-fade-in">
      <div
        style={{
          position: 'absolute',
          top: 20,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          zIndex: 10,
        }}
      >
        <StepIndicator step={CURRENT_STEP} total={TOTAL_STEPS} />
      </div>

      <div className="onboarding-panel-left">
        <div>
          <h1 className="onboarding-headline sr-only" aria-label="Agentic Browser">
            Agentic Browser
          </h1>
          <img
            src={wordmarkDarkUrl}
            alt="Agentic Browser"
            width={WORDMARK_WIDTH}
            aria-hidden="true"
            draggable={false}
            style={{ display: 'block', marginBottom: 20, opacity: 0.9 }}
          />
          <p className="onboarding-subhead">
            A browser agent that acts on your behalf.
          </p>
        </div>

        <CapabilitiesGrid />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            className="cta-button"
            onClick={onNext}
            type="button"
            aria-label="Get started with setup"
          >
            Get started
            <span aria-hidden="true" style={{ fontSize: 13, opacity: 0.7 }}>&#8594;</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <KeyHint keys={['Enter']} size="xs" />
            <span className="onboarding-eyebrow" style={{ textTransform: 'none', letterSpacing: 0 }}>
              to continue
            </span>
          </div>
        </div>
      </div>

      <div className="onboarding-panel-right">
        <CharacterMascot state="idle" width={180} height={200} />
      </div>
    </div>
  );
}
