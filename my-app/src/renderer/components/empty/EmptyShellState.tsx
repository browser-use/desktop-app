/**
 * EmptyShellState — shown when no browser tabs are open.
 *
 * Mascot idle float + copy nudging the user toward their first action.
 * Uses CSS classes from theme.shell.css + empty-states.css.
 * No !important, no Inter font, no sparkles icon.
 */

import React from 'react';
import idleUrl from '../../../../assets/brand/mascot/mascot-idle.svg';
import { KeyHint } from '../base';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASCOT_WIDTH  = 96;
const MASCOT_HEIGHT = 108;

const HEADING_COPY  = 'No tabs open' as const;
const BODY_COPY     = 'Open a tab or ask your agent to get started.' as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmptyShellState(): React.ReactElement {
  return (
    <div className="empty-state" data-variant="shell" role="status" aria-label={HEADING_COPY}>
      {/* Mascot — idle float via CSS animation class */}
      <div className="empty-state__mascot mascot-anim-idle" aria-hidden="true">
        <img
          src={idleUrl}
          alt=""
          width={MASCOT_WIDTH}
          height={MASCOT_HEIGHT}
          draggable={false}
        />
      </div>

      {/* Copy */}
      <p className="empty-state__heading">{HEADING_COPY}</p>
      <p className="empty-state__body">{BODY_COPY}</p>

      {/* Key hints */}
      <div className="empty-state__hints">
        <span className="empty-state__hint-row">
          <KeyHint keys={['Cmd', 'T']} size="xs" label="New tab" />
          <span className="empty-state__hint-label">new tab</span>
        </span>
        <span className="empty-state__hint-row">
          <KeyHint keys={['Cmd', 'K']} size="xs" label="Ask agent" />
          <span className="empty-state__hint-label">ask me</span>
        </span>
      </div>
    </div>
  );
}

export default EmptyShellState;
