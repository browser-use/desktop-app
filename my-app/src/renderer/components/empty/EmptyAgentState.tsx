/**
 * EmptyAgentState — shown in the pill before first agent task.
 *
 * Mascot idle + "Cmd+K ready" hint.
 * Compact — designed to sit inside the pill overlay.
 * No !important, no Inter font, no sparkles icon.
 */

import React from 'react';
import idleUrl from '../../../../assets/brand/mascot/mascot-idle.svg';
import { KeyHint } from '../base';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASCOT_WIDTH  = 48;
const MASCOT_HEIGHT = 54;

const READY_COPY = 'Type a task and press Enter' as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmptyAgentState(): React.ReactElement {
  return (
    <div className="empty-state empty-state--compact" data-variant="agent" role="status" aria-label={READY_COPY}>
      {/* Mascot — compact idle float */}
      <div className="empty-state__mascot mascot-anim-idle" aria-hidden="true">
        <img
          src={idleUrl}
          alt=""
          width={MASCOT_WIDTH}
          height={MASCOT_HEIGHT}
          draggable={false}
        />
      </div>

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
