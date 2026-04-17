/**
 * Track B — PillInput component.
 *
 * Text input with autofocus. On Enter: submits prompt via pillAPI.submit().
 * On Escape: hides the pill via pillAPI.hide().
 *
 * Shows a disabled state while an agent task is running.
 */

import React, { useEffect, useRef } from 'react';
import { KeyHint } from '../components/base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PillInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (prompt: string) => void;
  onEscape: () => void;
  disabled: boolean;
  placeholder?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PillInput({
  value,
  onChange,
  onSubmit,
  onEscape,
  disabled,
  placeholder = 'What do you need done?',
}: PillInputProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Re-focus when disabled goes false (task completed, ready for next prompt)
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed && !disabled) {
        onSubmit(trimmed);
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    }
  }

  return (
    <div className="pill-input-row">
      {/* Search / agent icon */}
      <span className="pill-input-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>

      <input
        ref={inputRef}
        className="pill-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-label="Agent prompt input"
        data-testid="pill-input"
      />

      {/* Keyboard hints */}
      <div className="pill-input-hint">
        {!disabled && value.trim() && (
          <KeyHint keys={['Enter']} size="xs" />
        )}
        <KeyHint keys={['Esc']} size="xs" />
      </div>
    </div>
  );
}
