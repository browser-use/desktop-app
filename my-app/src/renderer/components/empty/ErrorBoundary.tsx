/**
 * ErrorBoundary — React error boundary.
 *
 * Shows "Something broke" + a reload button.
 * Uses CSS classes from empty-states.css.
 * No !important, no Inter font, no sparkles icon.
 */

import React, { Component, ErrorInfo } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADING_COPY   = 'Something broke'                                  as const;
const BODY_COPY      = 'An unexpected error occurred. You can try reloading.' as const;
const RELOAD_LABEL   = 'Reload'                                           as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional custom fallback. If provided, renders instead of the default UI. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  private handleReload = (): void => {
    // Reset state so subtree can remount
    this.setState({ hasError: false, errorMessage: null });
    // Also reload the window as a fallback
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <div className="empty-state" data-variant="error" role="alert" aria-label={HEADING_COPY}>
        <p className="empty-state__heading">{HEADING_COPY}</p>
        <p className="empty-state__body">{BODY_COPY}</p>

        <button
          type="button"
          className="empty-state__reload-btn"
          onClick={this.handleReload}
        >
          {RELOAD_LABEL}
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
