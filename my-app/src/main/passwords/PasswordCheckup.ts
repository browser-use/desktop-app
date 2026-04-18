/**
 * PasswordCheckup — batch breach check using k-anonymity, plus weak/reused detection.
 *
 * Breach checking uses the Have I Been Pwned Passwords API:
 *   1. SHA-1 hash the password
 *   2. Send the first 5 hex chars (k-anonymity prefix) to the API
 *   3. Check if the remaining suffix appears in the response
 *
 * Also detects:
 *   - Reused passwords (same plaintext across multiple credentials)
 *   - Weak passwords (short, common patterns, low entropy)
 */

import crypto from 'node:crypto';
import { net } from 'electron';
import { mainLogger } from '../logger';

const HIBP_API_BASE = 'https://api.pwnedpasswords.com/range/';
const REQUEST_TIMEOUT_MS = 10_000;

export type CheckupFlag = 'compromised' | 'reused' | 'weak';

export interface PasswordCheckupResult {
  id: string;
  flags: CheckupFlag[];
  breachCount: number;
}

export interface CheckupInput {
  id: string;
  plaintext: string;
  origin: string;
  username: string;
}

const COMMON_PASSWORDS = new Set([
  'password', '123456', '12345678', '1234567890', 'qwerty', 'abc123',
  'password1', 'iloveyou', 'admin', 'welcome', 'letmein', 'monkey',
  'dragon', 'master', 'login', 'princess', 'football', 'shadow',
  'sunshine', 'trustno1', 'passw0rd', '123456789', '1234567', '12345',
  '1234', '123123', '111111', '000000', 'password123', 'qwerty123',
]);

const MIN_LENGTH = 8;
const MIN_CHAR_CLASSES = 3;

function sha1(input: string): string {
  return crypto.createHash('sha1').update(input, 'utf-8').digest('hex').toUpperCase();
}

function isWeak(plaintext: string): boolean {
  if (plaintext.length < MIN_LENGTH) {
    mainLogger.info('PasswordCheckup.isWeak.tooShort', { length: plaintext.length });
    return true;
  }

  if (COMMON_PASSWORDS.has(plaintext.toLowerCase())) {
    mainLogger.info('PasswordCheckup.isWeak.common');
    return true;
  }

  let classes = 0;
  if (/[a-z]/.test(plaintext)) classes++;
  if (/[A-Z]/.test(plaintext)) classes++;
  if (/[0-9]/.test(plaintext)) classes++;
  if (/[^a-zA-Z0-9]/.test(plaintext)) classes++;

  if (classes < MIN_CHAR_CLASSES) {
    mainLogger.info('PasswordCheckup.isWeak.lowComplexity', { classes });
    return true;
  }

  return false;
}

function findReused(inputs: CheckupInput[]): Set<string> {
  const passwordToIds = new Map<string, string[]>();
  for (const input of inputs) {
    const hash = sha1(input.plaintext);
    const existing = passwordToIds.get(hash) ?? [];
    existing.push(input.id);
    passwordToIds.set(hash, existing);
  }

  const reusedIds = new Set<string>();
  for (const ids of passwordToIds.values()) {
    if (ids.length > 1) {
      for (const id of ids) {
        reusedIds.add(id);
      }
    }
  }

  mainLogger.info('PasswordCheckup.findReused', {
    totalPasswords: inputs.length,
    reusedCount: reusedIds.size,
  });

  return reusedIds;
}

async function fetchHibpRange(prefix: string): Promise<string> {
  mainLogger.info('PasswordCheckup.fetchHibpRange', { prefix });

  return new Promise<string>((resolve, reject) => {
    const request = net.request({
      url: `${HIBP_API_BASE}${prefix}`,
      method: 'GET',
    });

    request.setHeader('User-Agent', 'AgenticBrowser-PasswordCheckup');
    request.setHeader('Add-Padding', 'true');

    let body = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        request.abort();
        mainLogger.warn('PasswordCheckup.fetchHibpRange.timeout', { prefix });
        reject(new Error(`HIBP request timed out for prefix ${prefix}`));
      }
    }, REQUEST_TIMEOUT_MS);

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        settled = true;
        mainLogger.warn('PasswordCheckup.fetchHibpRange.httpError', {
          prefix,
          statusCode: response.statusCode,
        });
        reject(new Error(`HIBP returned status ${response.statusCode}`));
        return;
      }

      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });


      response.on('error', (err) => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          mainLogger.error('PasswordCheckup.fetchHibpRange.responseError', {
            prefix,
            error: err.message,
          });
          reject(err);
        }
      });
      response.on('end', () => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          mainLogger.info('PasswordCheckup.fetchHibpRange.ok', {
            prefix,
            responseBytes: body.length,
          });
          resolve(body);
        }
      });
    });

    request.on('error', (err) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        mainLogger.error('PasswordCheckup.fetchHibpRange.error', {
          prefix,
          error: err.message,
        });
        reject(err);
      }
    });

    request.end();
  });
}

function parseBreachCount(responseBody: string, suffix: string): number {
  const lines = responseBody.split('\n');
  for (const line of lines) {
    const [hashSuffix, countStr] = line.split(':');
    if (hashSuffix?.trim().toUpperCase() === suffix) {
      const count = parseInt(countStr?.trim() ?? '0', 10);
      return isNaN(count) ? 0 : count;
    }
  }
  return 0;
}

export async function runPasswordCheckup(
  inputs: CheckupInput[],
  onProgress?: (checked: number, total: number) => void,
): Promise<PasswordCheckupResult[]> {
  mainLogger.info('PasswordCheckup.run.start', { credentialCount: inputs.length });

  if (inputs.length === 0) {
    mainLogger.info('PasswordCheckup.run.empty');
    return [];
  }

  const reusedIds = findReused(inputs);

  const results: PasswordCheckupResult[] = [];

  const prefixGroups = new Map<string, Array<{ id: string; suffix: string; input: CheckupInput }>>();
  for (const input of inputs) {
    const hash = sha1(input.plaintext);
    const prefix = hash.substring(0, 5);
    const suffix = hash.substring(5);
    const group = prefixGroups.get(prefix) ?? [];
    group.push({ id: input.id, suffix, input });
    prefixGroups.set(prefix, group);
  }

  mainLogger.info('PasswordCheckup.run.prefixGroups', {
    uniquePrefixes: prefixGroups.size,
    totalCredentials: inputs.length,
  });

  let checked = 0;

  for (const [prefix, group] of prefixGroups) {
    let responseBody: string;
    try {
      responseBody = await fetchHibpRange(prefix);
    } catch (err) {
      mainLogger.error('PasswordCheckup.run.prefixFailed', {
        prefix,
        error: (err as Error).message,
      });
      for (const entry of group) {
        const flags: CheckupFlag[] = [];
        if (reusedIds.has(entry.id)) flags.push('reused');
        if (isWeak(entry.input.plaintext)) flags.push('weak');
        results.push({ id: entry.id, flags, breachCount: 0 });
        checked++;
        onProgress?.(checked, inputs.length);
      }
      continue;
    }

    for (const entry of group) {
      const flags: CheckupFlag[] = [];
      const breachCount = parseBreachCount(responseBody, entry.suffix);

      if (breachCount > 0) {
        flags.push('compromised');
        mainLogger.info('PasswordCheckup.run.compromised', {
          id: entry.id,
          breachCount,
        });
      }

      if (reusedIds.has(entry.id)) {
        flags.push('reused');
      }

      if (isWeak(entry.input.plaintext)) {
        flags.push('weak');
      }

      results.push({ id: entry.id, flags, breachCount });
      checked++;
      onProgress?.(checked, inputs.length);
    }
  }

  const compromisedCount = results.filter((r) => r.flags.includes('compromised')).length;
  const reusedCount = results.filter((r) => r.flags.includes('reused')).length;
  const weakCount = results.filter((r) => r.flags.includes('weak')).length;
  const safeCount = results.filter((r) => r.flags.length === 0).length;

  mainLogger.info('PasswordCheckup.run.complete', {
    total: results.length,
    compromisedCount,
    reusedCount,
    weakCount,
    safeCount,
  });

  return results;
}
