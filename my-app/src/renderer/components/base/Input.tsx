/**
 * Input.tsx — base text input component
 * Variants: default | ghost
 * Sizes: sm | md | lg
 * forwardRef, accessible, supports leading/trailing adornments.
 * No !important, no Inter references.
 */

import React, { forwardRef, InputHTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOCK = 'agb-input' as const;

const SIZE_CLASSES = {
  sm: `${BLOCK}--sm`,
  md: `${BLOCK}--md`,
  lg: `${BLOCK}--lg`,
} as const;

const VARIANT_CLASSES = {
  default: `${BLOCK}--default`,
  ghost:   `${BLOCK}--ghost`,
  mono:    `${BLOCK}--mono`,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputVariant = keyof typeof VARIANT_CLASSES;
export type InputSize    = keyof typeof SIZE_CLASSES;

// Omit the native HTML `size` attribute (which is typed as a `number`) so
// we can use `size` as a design-system size token ('sm' | 'md' | 'lg')
// without a structural conflict.
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: InputVariant;
  size?: InputSize;
  error?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  label?: string;
  hint?: string;
  errorMessage?: string;
  containerClassName?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(
    {
      variant = 'default',
      size = 'md',
      error = false,
      leading,
      trailing,
      label,
      hint,
      errorMessage,
      containerClassName = '',
      className = '',
      id,
      disabled,
      ...rest
    },
    ref,
  ) {
    const inputId = id ?? `agb-input-${Math.random().toString(36).slice(2, 9)}`;
    const hintId  = hint          ? `${inputId}-hint`  : undefined;
    const errorId = errorMessage  ? `${inputId}-error` : undefined;

    const wrapperClasses = [
      `${BLOCK}__wrapper`,
      SIZE_CLASSES[size],
      VARIANT_CLASSES[variant],
      error    ? `${BLOCK}--error`    : '',
      disabled ? `${BLOCK}--disabled` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const inputClasses = [
      BLOCK,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={[`${BLOCK}__root`, containerClassName].filter(Boolean).join(' ')}>
        {label && (
          <label htmlFor={inputId} className={`${BLOCK}__label`}>
            {label}
          </label>
        )}
        <div className={wrapperClasses}>
          {leading && (
            <span className={`${BLOCK}__adornment ${BLOCK}__adornment--leading`} aria-hidden="true">
              {leading}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={inputClasses}
            disabled={disabled}
            aria-invalid={error || undefined}
            aria-describedby={
              [hintId, errorId].filter(Boolean).join(' ') || undefined
            }
            {...rest}
          />
          {trailing && (
            <span className={`${BLOCK}__adornment ${BLOCK}__adornment--trailing`} aria-hidden="true">
              {trailing}
            </span>
          )}
        </div>
        {hint && !errorMessage && (
          <span id={hintId} className={`${BLOCK}__hint`}>
            {hint}
          </span>
        )}
        {errorMessage && (
          <span id={errorId} className={`${BLOCK}__error-msg`} role="alert">
            {errorMessage}
          </span>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';

export default Input;
