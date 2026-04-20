import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { session } from 'electron';
import { mainLogger } from '../logger';
import { getChromeUserDataDir } from './profiles';

const PBKDF2_ITERATIONS = 1003;
const PBKDF2_KEY_LEN = 16;
const PBKDF2_SALT = 'saltysalt';
const AES_IV = Buffer.alloc(16, 0x20);

// Chrome epoch: microseconds since 1601-01-01
// Unix epoch: seconds since 1970-01-01
// Difference in microseconds: 11644473600 * 1_000_000
const CHROME_EPOCH_OFFSET = 11644473600n;

function getChromeSafeStoragePassword(): string {
  try {
    const password = execSync(
      'security find-generic-password -s "Chrome Safe Storage" -w',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    mainLogger.info('chromeImport.getKeychainPassword.ok', {
      passwordLength: password.length,
    });
    return password;
  } catch (err) {
    mainLogger.error('chromeImport.getKeychainPassword.failed', {
      error: (err as Error).message,
    });
    throw new Error('Failed to read Chrome Safe Storage password from Keychain');
  }
}

function deriveKey(password: string): Buffer {
  return crypto.pbkdf2Sync(
    password,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    'sha1',
  );
}

function decryptCookieValue(encryptedValue: Buffer, key: Buffer): string {
  if (encryptedValue.length === 0) return '';

  // v10 prefix = AES-128-CBC with PBKDF2-derived key
  if (encryptedValue.length >= 3 && encryptedValue.subarray(0, 3).toString('ascii') === 'v10') {
    const ciphertext = encryptedValue.subarray(3);
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, AES_IV);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString('utf-8');
    } catch (err) {
      mainLogger.debug('chromeImport.decryptCookie.v10Failed', {
        error: (err as Error).message,
        length: encryptedValue.length,
      });
      return '';
    }
  }

  // Unencrypted value (no prefix)
  return encryptedValue.toString('utf-8');
}

function chromeTimestampToUnix(chromeTimestamp: bigint | number): number {
  const ts = BigInt(chromeTimestamp);
  if (ts === 0n) return 0;
  const unixSeconds = Number(ts / 1000000n - CHROME_EPOCH_OFFSET);
  return unixSeconds > 0 ? unixSeconds : 0;
}

function chromeSameSiteToElectron(value: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  switch (value) {
    case -1: return 'unspecified';
    case 0: return 'no_restriction';
    case 1: return 'lax';
    case 2: return 'strict';
    default: return 'unspecified';
  }
}

interface ChromeCookieRow {
  host_key: string;
  name: string;
  path: string;
  encrypted_value: Buffer;
  value: string;
  is_secure: number;
  is_httponly: number;
  expires_utc: number | bigint;
  samesite: number;
}

export interface CookieImportResult {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
  domains: string[];
  failedDomains: string[];
}

export async function importChromeProfileCookies(profileDir: string): Promise<CookieImportResult> {
  const cookiesDbPath = path.join(getChromeUserDataDir(), profileDir, 'Cookies');

  mainLogger.info('chromeImport.importCookies.start', {
    profileDir,
    dbPath: cookiesDbPath,
  });

  // Dynamic import to avoid bundling issues — better-sqlite3 is a native module
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  let db;

  try {
    db = new Database(cookiesDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    mainLogger.error('chromeImport.importCookies.dbOpenFailed', {
      error: (err as Error).message,
      dbPath: cookiesDbPath,
    });
    throw new Error(`Cannot open Chrome cookies database: ${(err as Error).message}`);
  }

  const password = getChromeSafeStoragePassword();
  const key = deriveKey(password);

  let rows: ChromeCookieRow[];
  try {
    rows = db.prepare(
      'SELECT host_key, name, path, encrypted_value, value, is_secure, is_httponly, expires_utc, samesite FROM cookies',
    ).all() as ChromeCookieRow[];
  } catch (err) {
    db.close();
    mainLogger.error('chromeImport.importCookies.queryFailed', {
      error: (err as Error).message,
    });
    throw new Error(`Failed to query cookies: ${(err as Error).message}`);
  }

  db.close();

  mainLogger.info('chromeImport.importCookies.rowsRead', {
    totalRows: rows.length,
  });

  const electronSession = session.defaultSession;
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  const importedDomains = new Set<string>();
  const failedDomainSet = new Set<string>();

  for (const row of rows) {
    let value = row.value;
    if (!value && row.encrypted_value && row.encrypted_value.length > 0) {
      value = decryptCookieValue(row.encrypted_value, key);
    }

    if (!value) {
      skipped++;
      continue;
    }

    const domain = row.host_key.startsWith('.') ? row.host_key.substring(1) : row.host_key;
    const scheme = row.is_secure ? 'https' : 'http';
    const url = `${scheme}://${domain}${row.path}`;

    const expirationDate = chromeTimestampToUnix(row.expires_utc);

    // Skip expired cookies — Chrome keeps them but Electron rejects them
    const now = Math.floor(Date.now() / 1000);
    if (expirationDate > 0 && expirationDate < now) {
      skipped++;
      continue;
    }

    try {
      await electronSession.cookies.set({
        url,
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path,
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
        sameSite: chromeSameSiteToElectron(row.samesite),
        ...(expirationDate > 0 ? { expirationDate } : {}),
      });
      imported++;
      importedDomains.add(domain);
    } catch (err) {
      failed++;
      failedDomainSet.add(domain);
      if (failed <= 20) {
        mainLogger.debug('chromeImport.importCookies.setCookieFailed', {
          name: row.name,
          domain: row.host_key,
          url,
          secure: row.is_secure,
          error: (err as Error).message,
        });
      }
    }
  }

  const domains = Array.from(importedDomains);
  const failedDomains = Array.from(failedDomainSet).filter((d) => !importedDomains.has(d));

  const result: CookieImportResult = {
    total: rows.length,
    imported,
    failed,
    skipped,
    domains,
    failedDomains,
  };

  mainLogger.info('chromeImport.importCookies.done', {
    total: result.total,
    imported: result.imported,
    failed: result.failed,
    skipped: result.skipped,
  });
  return result;
}
