/**
 * ZoomBadge: shows current zoom % in the toolbar when zoom != 100%.
 * Click opens a popover with +/- buttons and a reset-to-100% action.
 * Chrome parity: the badge appears right of the URL bar.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ZoomBadgeProps {
  percent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export function ZoomBadge({
  percent,
  onZoomIn,
  onZoomOut,
  onReset,
}: ZoomBadgeProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        badgeRef.current &&
        !badgeRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className="zoom-badge-anchor">
      <button
        ref={badgeRef}
        type="button"
        className="zoom-badge"
        onClick={toggle}
        aria-label={`Zoom ${percent}%`}
        title={`Zoom: ${percent}% — click to adjust`}
      >
        {percent}%
      </button>

      {open && (
        <div ref={popoverRef} className="zoom-popover" role="dialog" aria-label="Zoom controls">
          <button
            type="button"
            className="zoom-popover__btn"
            onClick={onZoomOut}
            aria-label="Zoom out"
            disabled={percent <= 25}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>

          <span className="zoom-popover__level">{percent}%</span>

          <button
            type="button"
            className="zoom-popover__btn"
            onClick={onZoomIn}
            aria-label="Zoom in"
            disabled={percent >= 500}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <line x1="6" y1="2" x2="6" y2="10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>

          <div className="zoom-popover__divider" />

          <button
            type="button"
            className="zoom-popover__reset"
            onClick={() => { onReset(); setOpen(false); }}
            aria-label="Reset zoom to 100%"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
