import React from 'react';
import type { KeyBinding, ActionId, ScreenId } from './keybindings';
import { SCREEN_COMMANDS } from './keybindings';

interface CommandBarProps {
  screen: ScreenId;
  keybindings: KeyBinding[];
  onClose: () => void;
  onInvoke?: (id: ActionId) => void;
}

export function CommandBar({ screen, keybindings, onClose, onInvoke }: CommandBarProps): React.ReactElement {
  const actionIds = SCREEN_COMMANDS[screen] ?? [];
  const items = actionIds
    .map((id) => keybindings.find((kb) => kb.id === id))
    .filter((kb): kb is KeyBinding => Boolean(kb));

  return (
    <footer className="cmdhints" role="toolbar" aria-label="Available commands">
      <div className="cmdhints__items">
        {items.map((kb) => (
          <button
            key={kb.id}
            type="button"
            className="cmdhints__item"
            onClick={() => onInvoke?.(kb.id)}
            title={kb.label}
          >
            <span className="cmdhints__keys">
              {kb.keys[0]?.split(' ').map((token, i) => (
                <kbd key={i} className="cmdhints__kbd">{token}</kbd>
              ))}
            </span>
            <span className="cmdhints__label">{kb.label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="cmdhints__close"
        onClick={onClose}
        aria-label="Hide command bar"
        title="Hide command bar"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </footer>
  );
}
