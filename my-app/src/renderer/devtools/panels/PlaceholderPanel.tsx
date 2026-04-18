import React from 'react';

interface PlaceholderPanelProps {
  name: string;
  description: string;
}

export function PlaceholderPanel({ name, description }: PlaceholderPanelProps): React.ReactElement {
  return (
    <div className="panel-placeholder">
      <div className="panel-placeholder-icon">🔧</div>
      <div className="panel-placeholder-title">{name}</div>
      <div className="panel-placeholder-desc">
        {description || `The ${name} panel is not yet implemented.`}
      </div>
      <div className="panel-placeholder-desc" style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
        Coming soon
      </div>
    </div>
  );
}
