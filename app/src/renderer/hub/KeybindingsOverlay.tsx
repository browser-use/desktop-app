import React from 'react';
import type { KeyBinding } from './keybindings';

interface KeybindingsOverlayProps {
  open: boolean;
  onClose: () => void;
  keybindings: KeyBinding[];
  onOpenSettings: () => void;
  formatShortcut: (shortcut: string) => string;
}

export function KeybindingsOverlay({ open, onClose, keybindings, onOpenSettings, formatShortcut }: KeybindingsOverlayProps): React.ReactElement | null {
  if (!open) return null;

  const categories = new Map<string, KeyBinding[]>();
  for (const kb of keybindings) {
    const arr = categories.get(kb.category);
    if (arr) arr.push(kb);
    else categories.set(kb.category, [kb]);
  }

  return (
    <div className="cmdbar__scrim" onClick={onClose}>
      <div className="kb-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="kb-overlay__header">
          <span className="kb-overlay__title">Keyboard shortcuts</span>
          <button className="kb-overlay__settings" onClick={onOpenSettings}>Customize</button>
        </div>
        <div className="kb-overlay__body">
          {Array.from(categories, ([category, bindings]) => (
            <div key={category} className="kb-overlay__section">
              <span className="kb-overlay__category">{category}</span>
              {bindings.map((kb) => (
                <div key={kb.id} className="kb-overlay__row">
                  <span className="kb-overlay__label">{kb.label}</span>
                  <span className="kb-overlay__keys">
                    {kb.keys.map((k, i) => (
                      <kbd key={i} className="kb-overlay__kbd">{formatShortcut(k)}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
