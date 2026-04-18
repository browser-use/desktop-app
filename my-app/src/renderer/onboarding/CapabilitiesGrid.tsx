/**
 * CapabilitiesGrid — clean monochromatic capability list for the Welcome screen.
 * No rainbow pills, no custom icons. Simple text list with subtle separators.
 */

import React from 'react';

const CAPABILITIES = [
  'Research & analysis',
  'Lead sourcing',
  'Task automation',
  'Email management',
  'Web scraping',
  'And much more',
];

export function CapabilitiesGrid(): React.ReactElement {
  return (
    <div className="capability-list" role="list" aria-label="Agent capabilities">
      {CAPABILITIES.map((label) => (
        <div key={label} className="capability-item" role="listitem">
          <span className="capability-label">{label}</span>
        </div>
      ))}
    </div>
  );
}
