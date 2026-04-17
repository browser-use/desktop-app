/**
 * Modal.tsx — base modal / dialog component
 * Uses a React portal to render at document.body.
 * Focus-trapped, Escape to close, backdrop click to close (optional).
 * forwardRef on the panel element, accessible via role="dialog".
 * No !important, no Inter references.
 */

import React, {
  forwardRef,
  HTMLAttributes,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOCK = 'agb-modal' as const;

const SIZE_CLASSES = {
  sm: `${BLOCK}--sm`,
  md: `${BLOCK}--md`,
  lg: `${BLOCK}--lg`,
  full: `${BLOCK}--full`,
} as const;

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModalSize = keyof typeof SIZE_CLASSES;

export interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  size?: ModalSize;
  title?: string;
  description?: string;
  closeOnBackdrop?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Modal = forwardRef<HTMLDivElement, ModalProps>(
  function Modal(
    {
      open,
      onClose,
      size = 'md',
      title,
      description,
      closeOnBackdrop = true,
      children,
      footer,
      className = '',
      ...rest
    },
    ref,
  ) {
    const panelRef = useRef<HTMLDivElement>(null);
    const panelId  = useRef(`agb-modal-${Math.random().toString(36).slice(2, 9)}`);
    const titleId  = title       ? `${panelId.current}-title` : undefined;
    const descId   = description ? `${panelId.current}-desc`  : undefined;

    // Close on Escape
    const handleKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (!open) return;

        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          return;
        }

        // Focus trap
        if (e.key === 'Tab') {
          const panel = panelRef.current;
          if (!panel) return;
          const focusable = Array.from(
            panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
          ).filter((el) => !el.hasAttribute('disabled'));
          if (focusable.length === 0) { e.preventDefault(); return; }
          const first = focusable[0];
          const last  = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      },
      [open, onClose],
    );

    // Lock scroll + add key listener when open
    useEffect(() => {
      if (!open) return;
      document.addEventListener('keydown', handleKeyDown);
      // Focus first focusable element
      requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
        first?.focus();
      });
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, [open, handleKeyDown]);

    if (!open) return null;

    const panelClasses = [
      `${BLOCK}__panel`,
      SIZE_CLASSES[size],
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdrop && e.target === e.currentTarget) {
        onClose();
      }
    };

    return createPortal(
      <div
        className={`${BLOCK}__scrim`}
        role="presentation"
        onClick={handleBackdropClick}
      >
        <div
          ref={(node) => {
            panelRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
          }}
          id={panelId.current}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          className={panelClasses}
          {...rest}
        >
          {/* Header */}
          {(title || description) && (
            <div className={`${BLOCK}__header`}>
              {title && (
                <h2 id={titleId} className={`${BLOCK}__title`}>
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className={`${BLOCK}__description`}>
                  {description}
                </p>
              )}
              <button
                type="button"
                className={`${BLOCK}__close-btn`}
                onClick={onClose}
                aria-label="Close dialog"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M1 1L13 13M13 1L1 13"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          )}

          {/* Body */}
          <div className={`${BLOCK}__body`}>{children}</div>

          {/* Footer */}
          {footer && (
            <div className={`${BLOCK}__footer`}>{footer}</div>
          )}
        </div>
      </div>,
      document.body,
    );
  },
);

Modal.displayName = 'Modal';

export default Modal;
