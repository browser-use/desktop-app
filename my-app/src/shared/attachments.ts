// Anthropic's API enforces size limits on the BASE64-ENCODED payload
// (~33% larger than raw). Raw caps = floor(api_limit * 3/4) - 1024 safety.
export const MAX_IMAGE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4) - 1024;   // ~3.75MB raw
export const MAX_PDF_BYTES = Math.floor(32 * 1024 * 1024 * 3 / 4) - 1024;    // ~24MB raw
export const MAX_TEXT_BYTES = 1 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const SUPPORTED_DOC_MIMES = ['application/pdf'] as const;

export type AttachmentKind = 'image' | 'document' | 'text';

export function classifyAttachmentMime(mime: string): AttachmentKind | null {
  if ((SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime)) return 'image';
  if ((SUPPORTED_DOC_MIMES as readonly string[]).includes(mime)) return 'document';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/x-yaml') return 'text';
  return null;
}

export function maxBytesForAttachmentMime(mime: string): number | null {
  const kind = classifyAttachmentMime(mime);
  if (kind === 'image') return MAX_IMAGE_BYTES;
  if (kind === 'document') return MAX_PDF_BYTES;
  if (kind === 'text') return MAX_TEXT_BYTES;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
