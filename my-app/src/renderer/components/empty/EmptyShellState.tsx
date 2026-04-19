/**
 * EmptyShellState — shown when no browser tabs are open.
 *
 * Empty state nudging the user toward their first action.
 * Uses CSS classes from theme.shell.css + empty-states.css.
 * No !important, no Inter font, no sparkles icon.
 */

import React from 'react';
import { KeyHint } from '../base';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADING_COPY  = 'No tabs open' as const;
const BODY_COPY     = 'Open a tab or ask your agent to get started.' as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmptyShellState(): React.ReactElement {
  return (
    <div className="empty-state" data-variant="shell" role="status" aria-label={HEADING_COPY}>
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
