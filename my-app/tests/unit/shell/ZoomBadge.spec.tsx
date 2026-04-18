/**
 * @vitest-environment jsdom
 *
 * ZoomBadge renderer smoke tests — backfilled coverage for the shell zoom UI.
 *
 * Tests cover:
 *   - mounts and renders the current zoom percentage label
 *   - opens the popover on click and closes on Escape
 *   - +/− buttons call onZoomIn / onZoomOut
 *   - Reset button calls onReset and closes the popover
 *   - zoom-in disabled at the upper clamp (≥ 500%)
 *   - zoom-out disabled at the lower clamp (≤ 25%)
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { ZoomBadge } from '../../../src/renderer/shell/ZoomBadge';

function renderBadge(percent: number) {
  const onZoomIn = vi.fn();
  const onZoomOut = vi.fn();
  const onReset = vi.fn();
  const utils = render(
    <ZoomBadge
      percent={percent}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onReset={onReset}
    />,
  );
  return { ...utils, onZoomIn, onZoomOut, onReset };
}

describe('ZoomBadge', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the current zoom percentage on the badge', () => {
    renderBadge(125);
    expect(screen.getByRole('button', { name: /zoom 125%/i })).toBeTruthy();
  });

  it('opens the popover when the badge is clicked', () => {
    renderBadge(150);
    fireEvent.click(screen.getByRole('button', { name: /zoom 150%/i }));
    expect(screen.getByRole('dialog', { name: /zoom controls/i })).toBeTruthy();
  });

  it('toggles the popover closed on a second click', () => {
    renderBadge(150);
    const badge = screen.getByRole('button', { name: /zoom 150%/i });
    fireEvent.click(badge);
    fireEvent.click(badge);
    expect(screen.queryByRole('dialog', { name: /zoom controls/i })).toBeNull();
  });

  it('closes the popover when Escape is pressed', () => {
    renderBadge(150);
    fireEvent.click(screen.getByRole('button', { name: /zoom 150%/i }));
    expect(screen.getByRole('dialog', { name: /zoom controls/i })).toBeTruthy();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('dialog', { name: /zoom controls/i })).toBeNull();
  });

  it('+ button calls onZoomIn', () => {
    const { onZoomIn } = renderBadge(150);
    fireEvent.click(screen.getByRole('button', { name: /zoom 150%/i }));
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(onZoomIn).toHaveBeenCalled();
  });

  it('− button calls onZoomOut', () => {
    const { onZoomOut } = renderBadge(150);
    fireEvent.click(screen.getByRole('button', { name: /zoom 150%/i }));
    fireEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    expect(onZoomOut).toHaveBeenCalled();
  });

  it('Reset button calls onReset and closes the popover', () => {
    const { onReset } = renderBadge(150);
    fireEvent.click(screen.getByRole('button', { name: /zoom 150%/i }));
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: /zoom controls/i })).toBeNull();
  });

  it('disables zoom-out when at the lower clamp (≤25%)', () => {
    renderBadge(25);
    fireEvent.click(screen.getByRole('button', { name: /zoom 25%/i }));
    const out = screen.getByRole('button', { name: /zoom out/i }) as HTMLButtonElement;
    expect(out.disabled).toBe(true);
  });

  it('disables zoom-in when at the upper clamp (≥500%)', () => {
    renderBadge(500);
    fireEvent.click(screen.getByRole('button', { name: /zoom 500%/i }));
    const inBtn = screen.getByRole('button', { name: /zoom in/i }) as HTMLButtonElement;
    expect(inBtn.disabled).toBe(true);
  });
});
