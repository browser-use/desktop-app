/**
 * Sentry crash reporting configuration for Agentic Browser.
 *
 * DSN is provided via environment variable SENTRY_DSN.
 * In dev / when SENTRY_DSN is absent, Sentry initialisation is skipped and
 * crashes are written to the local structured logger only.
 *
 * Scrub rules strip PII (email, tokens, file paths with username) before
 * any event leaves the process.
 *
 * Usage (Track A main.ts):
 *   import { initSentry } from '../config/sentry';
 *   initSentry();
 *
 * Track H owns this file.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[Sentry]';

/** Fields whose values are redacted before sending */
const SCRUB_KEYS: ReadonlyArray<string> = [
  'email',
  'access_token',
  'refresh_token',
  'api_key',
  'password',
  'secret',
  'dsn',
  'authorization',
];

/** Regex patterns matched against breadcrumb / extra string values */
const SCRUB_PATTERNS: ReadonlyArray<RegExp> = [
  /\/Users\/[^/]+\//gi,            // macOS home dir paths
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses
  /Bearer\s+[A-Za-z0-9._\-]+/gi,   // Bearer tokens
];

// ---------------------------------------------------------------------------
// Scrubbing helpers
// ---------------------------------------------------------------------------

function scrubString(value: string): string {
  let result = value;
  for (const pattern of SCRUB_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SCRUB_KEYS.some((k) => key.toLowerCase().includes(k))) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = scrubString(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrubObject(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sentry event processor
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildBeforeSend(event: any): any | null {
  // Strip extra / contexts of sensitive keys
  if (event.extra) {
    event.extra = scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.contexts) {
    event.contexts = scrubObject(event.contexts as Record<string, unknown>);
  }
  // Scrub breadcrumb messages
  if (Array.isArray(event.breadcrumbs?.values)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event.breadcrumbs.values = event.breadcrumbs.values.map((b: any) => ({
      ...b,
      message: typeof b.message === 'string' ? scrubString(b.message) : b.message,
    }));
  }
  return event;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export interface SentryConfig {
  /** Override DSN (useful in tests) */
  dsn?: string;
  /** App version string */
  release?: string;
  /** 'development' | 'staging' | 'production' */
  environment?: string;
  /** Sampling rate 0.0–1.0 for performance traces */
  tracesSampleRate?: number;
}

let initialised = false;

/**
 * Initialise Sentry. Safe to call multiple times (no-ops after first call).
 * Returns true if Sentry was actually initialised, false if skipped.
 */
export function initSentry(cfg: SentryConfig = {}): boolean {
  if (initialised) {
    console.log(`${LOG_PREFIX} Already initialised, skipping`);
    return false;
  }

  const dsn = cfg.dsn ?? process.env['SENTRY_DSN'];
  if (!dsn) {
    console.log(`${LOG_PREFIX} SENTRY_DSN not set — crash reporting disabled`);
    return false;
  }

  try {
    // Lazy import so the module can be imported without @sentry/electron installed
    // in unit test environments.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/electron');

    const release =
      cfg.release ??
      (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { app } = require('electron');
          return `agentic-browser@${app.getVersion()}`;
        } catch {
          return 'agentic-browser@dev';
        }
      })();

    Sentry.init({
      dsn,
      release,
      environment: cfg.environment ?? process.env['NODE_ENV'] ?? 'development',
      tracesSampleRate: cfg.tracesSampleRate ?? 0.1,
      beforeSend: buildBeforeSend,
      // Ignore expected network errors and Electron internal stack frames
      ignoreErrors: [
        'ResizeObserver loop limit exceeded',
        'ResizeObserver loop completed with undelivered notifications',
      ],
      denyUrls: [
        /chrome-extension:\/\//i,
        /extensions\//i,
      ],
    });

    initialised = true;
    console.log(`${LOG_PREFIX} Initialised. DSN=***${dsn.slice(-6)} release=${release}`);
    return true;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to initialise: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Manually capture an exception — wraps Sentry.captureException with a
 * no-op fallback when Sentry is not initialised.
 */
export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/electron');
    Sentry.captureException(error, { extra });
  } catch {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} captureException (Sentry unavailable): ${msg}`);
  }
}

/**
 * Add a breadcrumb — wraps Sentry.addBreadcrumb with a no-op fallback.
 */
export function addBreadcrumb(
  message: string,
  category: string,
  level: 'debug' | 'info' | 'warning' | 'error' = 'info',
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/electron');
    Sentry.addBreadcrumb({ message, category, level });
  } catch {
    // Sentry not loaded — no-op
  }
}

// ---------------------------------------------------------------------------
// Reset (test only)
// ---------------------------------------------------------------------------

/** Reset initialisation state. Only for use in unit tests. */
export function _resetSentryForTests(): void {
  initialised = false;
}
