/**
 * HSTSStore — in-memory HSTS (HTTP Strict Transport Security) store.
 *
 * Captures Strict-Transport-Security response headers and persists them
 * for the duration of the session. HTTP navigations to known HSTS hosts
 * are upgraded to HTTPS before the request is made (RFC 6797).
 *
 * Session-only: entries are cleared on app quit (no disk persistence).
 */

import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HSTSEntry {
  host: string;
  maxAge: number;
  includeSubdomains: boolean;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const hstsStore = new Map<string, HSTSEntry>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and store a Strict-Transport-Security header value for the given URL.
 * Ignores HTTP URLs per RFC 6797 §8.1.
 */
export function processHSTSHeader(url: string, headerValue: string): void {
  if (!url.startsWith('https://')) return;

  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return;
  }

  const maxAgeMatch = /max-age\s*=\s*(\d+)/i.exec(headerValue);
  if (!maxAgeMatch) return;

  const maxAge = parseInt(maxAgeMatch[1], 10);

  // max-age=0 means delete the entry (RFC 6797 §6.1.1)
  if (maxAge === 0) {
    hstsStore.delete(host);
    mainLogger.info('HSTSStore.processHeader.deleted', { host });
    return;
  }

  const includeSubdomains = /includeSubDomains/i.test(headerValue);
  const entry: HSTSEntry = {
    host,
    maxAge,
    includeSubdomains,
    capturedAt: Date.now(),
  };

  hstsStore.set(host, entry);
  mainLogger.info('HSTSStore.processHeader', { host, maxAge, includeSubdomains });
}

/**
 * Returns true if the given URL's host (or a parent domain with includeSubdomains)
 * has a known HSTS entry that hasn't expired.
 */
export function isHSTSHost(url: string): boolean {
  let host = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  // Direct match
  if (checkEntry(host)) return true;

  // Parent domain with includeSubdomains
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    const entry = hstsStore.get(parent);
    if (entry && entry.includeSubdomains && !isExpired(entry)) return true;
  }

  return false;
}

/**
 * Returns the HSTS entry for the given URL's host, or null if not known/expired.
 */
export function getHSTSEntry(url: string): HSTSEntry | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  const entry = hstsStore.get(host);
  if (!entry || isExpired(entry)) return null;
  return entry;
}

/**
 * Remove all HSTS entries (e.g. on app quit or when clearing browsing data).
 */
export function clearHSTSEntries(): void {
  mainLogger.info('HSTSStore.clearAll', { count: hstsStore.size });
  hstsStore.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkEntry(host: string): boolean {
  const entry = hstsStore.get(host);
  if (!entry) return false;
  if (isExpired(entry)) {
    hstsStore.delete(host);
    return false;
  }
  return true;
}

function isExpired(entry: HSTSEntry): boolean {
  const ageSeconds = (Date.now() - entry.capturedAt) / 1000;
  return ageSeconds > entry.maxAge;
}
