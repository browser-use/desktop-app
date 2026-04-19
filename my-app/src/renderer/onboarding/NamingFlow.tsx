/**
 * NamingFlow — Screen 2 of onboarding.
 * User gives the agent a name. Clean, minimal form.
 */

import React, { useState, useRef, useEffect } from 'react';
import { StepIndicator } from './StepIndicator';
import { KeyHint } from '../components/base';

const TOTAL_STEPS = 5;
const CURRENT_STEP = 2;
const MAX_NAME_LENGTH = 32;

interface NamingFlowProps {
  onNext: (name: string) => void;
  onBack: () => void;
}

export function NamingFlow({ onNext, onBack }: NamingFlowProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Give your companion a name to continue.');
      return;
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      setError(`Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
      return;
    }
    setError(null);
    onNext(trimmed);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setValue(e.target.value);
    if (error) setError(null);
  }

  return (
    <div className="onboarding-root onboarding-fade-in">
      <div
        style={{
          position: 'absolute',
          top: 20,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          zIndex: 10,
        }}
      >
        <StepIndicator step={CURRENT_STEP} total={TOTAL_STEPS} />
      </div>

      <div className="onboarding-panel-left">
        <div>
          <h1 className="onboarding-headline">Name your agent</h1>
          <p className="onboarding-subhead" style={{ marginTop: 8 }}>
            Pick a name. You can always change it later.
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="auth-input-group">
            <label className="auth-label" htmlFor="agent-name-input">
              Agent name
            </label>
            <input
              ref={inputRef}
              id="agent-name-input"
              className="auth-input"
              type="text"
              value={value}
              onChange={handleChange}
              placeholder="e.g. Atlas, Nova, Scout"
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={error ? 'name-error' : undefined}
              aria-invalid={error ? 'true' : 'false'}
            />
            {error && (
              <p
                id="name-error"
                className="onboarding-subhead"
                style={{ color: 'var(--color-status-error)', marginTop: 4, fontSize: 'var(--font-size-xs)' }}
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onBack}
              className="google-btn"
              style={{ flex: 1 }}
              aria-label="Back"
            >
              Back
            </button>
            <button
              type="submit"
              className="auth-submit"
              style={{ flex: 2 }}
              disabled={!value.trim()}
              aria-label="Continue"
            >
              Continue
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <KeyHint keys={['Enter']} size="xs" />
              <span className="onboarding-eyebrow" style={{ textTransform: 'none', letterSpacing: 0 }}>submit</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <KeyHint keys={['Esc']} size="xs" />
              <span className="onboarding-eyebrow" style={{ textTransform: 'none', letterSpacing: 0 }}>back</span>
            </span>
          </div>
        </form>
      </div>

      <div className="onboarding-panel-right">
      </div>
    </div>
  );
}
