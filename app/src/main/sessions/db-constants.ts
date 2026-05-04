export const DB_SCHEMA_VERSION = 11;

// Hard cap on attachments per session to prevent DB bloat from runaway
// follow-up uploads. Enforced in SessionDb.saveAttachment.
export const MAX_ATTACHMENTS_PER_SESSION = 200;

export const RECOVERY_ERROR = 'App exited unexpectedly';

export const TABLE_SESSIONS = 'sessions';
export const TABLE_EVENTS = 'session_events';
export const TABLE_ATTACHMENTS = 'session_attachments';

export const VALID_STATUSES = ['draft', 'running', 'stuck', 'idle', 'stopped'] as const;

// -- attachment constraints --------------------------------------------------

// Anthropic enforces size limits on the BASE64-ENCODED payload (~33% bigger
// than raw). Raw caps = floor(api_limit * 3/4) - 1024 for safety margin.
// Verified: log shows raw 4,708,304 → base64 6,277,740 (ratio 4:3 exact) →
// rejected with "exceeds 5MB maximum: 6277740 bytes > 5242880 bytes".
// Image: 5MB base64 → 3.75MB raw. PDF: 32MB base64 → 24MB raw (same pattern).
export const MAX_IMAGE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4) - 1024;   // ~3.75MB raw
export const MAX_PDF_BYTES = Math.floor(32 * 1024 * 1024 * 3 / 4) - 1024;    // ~24MB raw
export const MAX_TEXT_BYTES = 1 * 1024 * 1024;                        // 1MB raw (text, no base64)
export const MAX_OTHER_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;           // 50MB raw per message

export const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const SUPPORTED_DOC_MIMES = ['application/pdf'] as const;
// Extensible via prefix match: anything with `text/` MIME counts as text.
export const SUPPORTED_TEXT_MIME_PREFIX = 'text/';

export type ImageMime = typeof SUPPORTED_IMAGE_MIMES[number];
export type DocMime = typeof SUPPORTED_DOC_MIMES[number];

export function classifyMime(mime: string): 'image' | 'document' | 'text' | 'other' {
  if ((SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime)) return 'image';
  if ((SUPPORTED_DOC_MIMES as readonly string[]).includes(mime)) return 'document';
  if (mime.startsWith(SUPPORTED_TEXT_MIME_PREFIX)) return 'text';
  // Accept a handful of common text-ish MIMEs browsers apply to code/json/csv.
  if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/x-yaml') return 'text';
  return 'other';
}

export function maxBytesForMime(mime: string): number {
  const kind = classifyMime(mime);
  if (kind === 'image') return MAX_IMAGE_BYTES;
  if (kind === 'document') return MAX_PDF_BYTES;
  if (kind === 'text') return MAX_TEXT_BYTES;
  return MAX_OTHER_BYTES;
}
