/**
 * Welcome component tests — written FIRST per D1 (TDD).
 *
 * Tests cover:
 *   - Renders headline "I'm your Companion!"
 *   - Renders capability pills (Research, Sourcing, Automation, Emails, Scraping, ...much more)
 *   - Renders step indicator
 *   - Renders "Get Started" button
 *   - "Get Started" calls onNext callback
 *   - Shows agent name when provided; shows placeholder when undefined
 *   - Mascot is present (img or svg with accessible alt)
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import React from 'react';

// Stub CSS imports so vitest doesn't choke on them
vi.mock('../../../src/renderer/design/theme.global.css', () => ({}));
vi.mock('../../../src/renderer/design/theme.onboarding.css', () => ({}));
vi.mock('../../../src/renderer/components/base/components.css', () => ({}));
vi.mock('../../../src/renderer/onboarding/onboarding.css', () => ({}));

// Stub the CharacterMascot so we don't need SVG parsing in jsdom
vi.mock('../../../src/renderer/onboarding/CharacterMascot', () => ({
  CharacterMascot: () => <div data-testid="mascot" aria-label="Companion mascot" />,
}));

vi.mock('../../../src/renderer/onboarding/StepIndicator', () => ({
  StepIndicator: ({ step, total }: { step: number; total: number }) => (
    <div data-testid="step-indicator" data-step={step} data-total={total} />
  ),
}));

vi.mock('../../../src/renderer/onboarding/CapabilitiesGrid', () => ({
  CapabilitiesGrid: () => (
    <div data-testid="capabilities-grid">
      <span>Research</span>
      <span>Sourcing leads</span>
      <span>Automation</span>
      <span>Emails</span>
      <span>Scraping</span>
      <span>...and much more</span>
    </div>
  ),
}));

import { Welcome } from '../../../src/renderer/onboarding/Welcome';

describe('Welcome screen', () => {
  it('renders the headline text', () => {
    render(<Welcome onNext={vi.fn()} agentName={undefined} />);
    expect(screen.getByText("I'm your Companion!")).toBeTruthy();
  });

  it('renders capability pills via CapabilitiesGrid', () => {
    render(<Welcome onNext={vi.fn()} agentName={undefined} />);
    expect(screen.getByTestId('capabilities-grid')).toBeTruthy();
    expect(screen.getByText('Research')).toBeTruthy();
    expect(screen.getByText('Scraping')).toBeTruthy();
  });

  it('renders the step indicator', () => {
    render(<Welcome onNext={vi.fn()} agentName={undefined} />);
    expect(screen.getByTestId('step-indicator')).toBeTruthy();
  });

  it('renders the mascot', () => {
    render(<Welcome onNext={vi.fn()} agentName={undefined} />);
    expect(screen.getByTestId('mascot')).toBeTruthy();
  });

  it('renders Get Started button', () => {
    render(<Welcome onNext={vi.fn()} agentName={undefined} />);
    expect(screen.getByRole('button', { name: /get started/i })).toBeTruthy();
  });

  it('calls onNext when Get Started is clicked', () => {
    const onNext = vi.fn();
    render(<Welcome onNext={onNext} agentName={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('shows "I have no name yet" placeholder when agentName is undefined', () => {
    render(<Welcome onNext={vi.fn()} agentName={undefined} />);
    expect(screen.getByText(/no name yet/i)).toBeTruthy();
  });

  it('shows the agent name when provided', () => {
    render(<Welcome onNext={vi.fn()} agentName="Atlas" />);
    expect(screen.getByText('Atlas')).toBeTruthy();
  });
});
