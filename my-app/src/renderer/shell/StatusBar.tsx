/**
 * StatusBar — Issue #86
 * Chrome-parity bottom-left URL preview that appears while hovering a link.
 * Renders only when a non-empty hovered URL is provided.
 */

import React from 'react';

interface StatusBarProps {
  url: string;
}

export function StatusBar({ url }: StatusBarProps): React.ReactElement | null {
  if (!url) return null;
  return (
    <div className="status-bar" role="status" aria-live="polite">
      <span className="status-bar__url">{url}</span>
    </div>
  );
}
