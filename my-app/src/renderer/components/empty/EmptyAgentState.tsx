/**
 * EmptyAgentState — shown in the pill before first agent task.
 *
 * Empty state with Cmd+K hint.
 * Compact — designed to sit inside the pill overlay.
 * No !important, no Inter font, no sparkles icon.
 */

import React from 'react';
import { KeyHint } from '../base';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const READY_COPY = 'Type a task and press Enter' as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmptyAgentState(): React.ReactElement {
  return (
    <div className="empty-state empty-state--compact" data-variant="agent" role="status" aria-label={READY_COPY}>
      <p className="empty-state__body">{READY_COPY}</p>

      <div className="empty-state__hints">
        <span className="empty-state__hint-row">
          <KeyHint keys={['Cmd', 'K']} size="xs" label="Open agent" />
          <span className="empty-state__hint-label">to start</span>
        </span>
      </div>
    </div>
  );
}

export default EmptyAgentState;
