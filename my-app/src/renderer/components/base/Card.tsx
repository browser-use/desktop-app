/**
 * Card.tsx — base card / surface component
 * Variants: default | elevated | outline | ghost
 * forwardRef, accessible, interactive variant adds hover + focus states.
 * No !important, no Inter references.
 */

import React, { forwardRef, HTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOCK = 'agb-card' as const;

const VARIANT_CLASSES = {
  default:  `${BLOCK}--default`,
  elevated: `${BLOCK}--elevated`,
  outline:  `${BLOCK}--outline`,
  ghost:    `${BLOCK}--ghost`,
} as const;

const PADDING_CLASSES = {
  none: `${BLOCK}--pad-none`,
  sm:   `${BLOCK}--pad-sm`,
  md:   `${BLOCK}--pad-md`,
  lg:   `${BLOCK}--pad-lg`,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardVariant = keyof typeof VARIANT_CLASSES;
export type CardPadding = keyof typeof PADDING_CLASSES;

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  interactive?: boolean;
  as?: keyof React.JSX.IntrinsicElements;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Card = forwardRef<HTMLDivElement, CardProps>(
  function Card(
    {
      variant = 'default',
      padding = 'md',
      interactive = false,
      as: Tag = 'div',
      className = '',
      children,
      ...rest
    },
    ref,
  ) {
    const classes = [
      BLOCK,
      VARIANT_CLASSES[variant],
      PADDING_CLASSES[padding],
      interactive ? `${BLOCK}--interactive` : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const interactiveProps = interactive
      ? {
          role: rest.role ?? 'button',
          tabIndex: rest.tabIndex ?? 0,
        }
      : {};

    // `as` is typed as any IntrinsicElement, but the prop surface is
    // HTMLDivElement-shaped (see CardProps extending HTMLAttributes<HTMLDivElement>).
    // Cast Tag to ElementType so the union of per-element prop types doesn't
    // explode into "union type that is too complex to represent".
    const Component = Tag as React.ElementType;

    return (
      <Component
        ref={ref as React.Ref<HTMLDivElement>}
        className={classes}
        {...interactiveProps}
        {...rest}
      >
        {children}
      </Component>
    );
  },
);

Card.displayName = 'Card';

export default Card;
