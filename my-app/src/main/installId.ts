/**
 * Stable, anonymous install identifier used as PostHog's `distinct_id`.
 *
 * Generated once on first launch, stored in <userData>/install-id.json, and
 * reused for the lifetime of the install. Contains no PII — it's a random
 * UUID with no link to user identity. Deleting userData resets it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { mainLogger } from './logger';

const FILE = 'install-id.json';

let cached: string | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

export function getInstallId(): string {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { id?: string };
    if (parsed.id && typeof parsed.id === 'string') {
      cached = parsed.id;
      return cached;
    }
  } catch {
    // file missing or corrupt — fall through to create a new one
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2),
      'utf-8',
    );
    mainLogger.info('installId.created', { id });
  } catch (err) {
    mainLogger.error('installId.write-failed', { error: (err as Error).message });
  }
  cached = id;
  return id;
}
