import React, { useCallback, useEffect, useRef, useState } from 'react';

interface CommandBarProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
}

function ArrowUpIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12V3M3 6.5L7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CommandBar({ open, onClose, onSubmit }: CommandBarProps): React.ReactElement | null {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [open]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    console.log('[CommandBar] submit', { prompt: trimmed });
    onSubmit(trimmed);
    setValue('');
    onClose();
  }, [value, onSubmit, onClose]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit, onClose],
  );

  if (!open) return null;

  return (
    <div className="cmdbar__scrim" onClick={onClose}>
      <div className="cmdbar" onClick={(e) => e.stopPropagation()}>
        <div className="cmdbar__input-row">
          <textarea
            ref={ref}
            className="cmdbar__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="What should the agent do?"
            rows={1}
            aria-label="New agent task"
          />
          <button
            className="cmdbar__send"
            onClick={submit}
            disabled={!value.trim()}
            aria-label="Start agent"
          >
            <ArrowUpIcon />
          </button>
        </div>
        <div className="cmdbar__footer">
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">Enter</kbd> to send
          </span>
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

export default CommandBar;
