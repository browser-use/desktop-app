/**
 * User consent storage for telemetry and other app-level privacy preferences.
 *
 * Persisted to <userData>/consent.json as plain JSON (not Keychain — a boolean
 * preference doesn't need encryption, and we want it readable by renderers
 * via IPC without re-prompting the OS for Keychain access).
 *
 * Consent defaults to *declined* until the user actively opts in. This matches
 * GDPR's opt-in requirement: no pre-selected "yes".
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { mainLogger } from './logger';

const CONSENT_FILE = 'consent.json';
const CURRENT_VERSION = 1;

export interface ConsentState {
  telemetry: boolean;
  /** ISO timestamp of the last explicit user action (opt-in or opt-out). */
  telemetryUpdatedAt: string | null;
  /** Schema version — bump if the consent surface meaningfully changes and
   *  we need to re-prompt users (e.g. adding new event categories). */
  version: number;
}

const DEFAULT_STATE: ConsentState = {
  telemetry: false,
  telemetryUpdatedAt: null,
  version: CURRENT_VERSION,
};

function consentFilePath(): string {
  return path.join(app.getPath('userData'), CONSENT_FILE);
}

export function getConsent(): ConsentState {
  // Env-level override: DO_NOT_TRACK=1 hard-disables telemetry regardless of
  // the stored preference. Honors the informal web convention.
  if (process.env.DO_NOT_TRACK === '1') {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = fs.readFileSync(consentFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ConsentState>;
    return {
      telemetry: Boolean(parsed.telemetry),
      telemetryUpdatedAt: parsed.telemetryUpdatedAt ?? null,
      version: parsed.version ?? CURRENT_VERSION,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function setTelemetryConsent(optedIn: boolean): ConsentState {
  const next: ConsentState = {
    telemetry: optedIn,
    telemetryUpdatedAt: new Date().toISOString(),
    version: CURRENT_VERSION,
  };
  try {
    fs.mkdirSync(path.dirname(consentFilePath()), { recursive: true });
    fs.writeFileSync(consentFilePath(), JSON.stringify(next, null, 2), 'utf-8');
    mainLogger.info('consent.set', { telemetry: optedIn });
  } catch (err) {
    mainLogger.error('consent.set-failed', { error: (err as Error).message });
  }
  return next;
}

export function isTelemetryConsented(): boolean {
  return getConsent().telemetry;
}
