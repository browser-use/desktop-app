/**
 * ipc-validators.ts — runtime input validators for IPC handlers.
 *
 * Keeps validation logic separate from handler implementations so it
 * can be unit-tested independently.
 */

export function assertString(value: unknown, field: string, max = 10000): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} chars`);
  return value;
}

export function assertOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

import {
  classifyMime,
  maxBytesForMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from './sessions/db-constants';

export interface ValidatedAttachment {
  name: string;
  mime: string;
  bytes: Buffer;
}

/**
 * Validate an attachment payload array from the renderer.
 * Accepts ArrayBuffer / Uint8Array / Buffer for `bytes` (Electron IPC passes
 * typed arrays as Uint8Array after structured clone).
 *
 * Throws with a user-displayable message on violation. Logs nothing — callers
 * log metadata only, never bytes.
 */
export function assertAttachments(value: unknown, field = 'attachments'): ValidatedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length === 0) return [];
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`);
  }
  const out: ValidatedAttachment[] = [];
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const raw = value[i] as { name?: unknown; mime?: unknown; bytes?: unknown };
    if (!raw || typeof raw !== 'object') throw new Error(`${field}[${i}] must be an object`);
    const name = assertString(raw.name, `${field}[${i}].name`, 255);
    const mime = assertString(raw.mime, `${field}[${i}].mime`, 255);
    const kind = classifyMime(mime);
    if (kind === null) throw new Error(`Unsupported file type: ${mime} (${name})`);

    let buf: Buffer;
    if (raw.bytes instanceof Uint8Array) buf = Buffer.from(raw.bytes);
    else if (raw.bytes instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(raw.bytes));
    else if (Buffer.isBuffer(raw.bytes)) buf = raw.bytes;
    else throw new Error(`${field}[${i}].bytes must be bytes (Uint8Array/ArrayBuffer/Buffer)`);

    const max = maxBytesForMime(mime) ?? 0;
    if (buf.byteLength > max) {
      throw new Error(`${name} is ${Math.round(buf.byteLength / 1024 / 1024 * 10) / 10}MB — exceeds ${Math.round(max / 1024 / 1024)}MB limit for ${kind}`);
    }
    if (buf.byteLength === 0) throw new Error(`${name} is empty`);

    total += buf.byteLength;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Total attachment size exceeds ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
    }
    out.push({ name, mime, bytes: buf });
  }
  return out;
}
