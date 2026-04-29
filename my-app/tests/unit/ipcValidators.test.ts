import { describe, expect, test } from 'vitest';
import { assertAttachments } from '../../src/main/ipc-validators';

describe('assertAttachments', () => {
  test('accepts unknown MIME attachments within the other-file limit', () => {
    const bytes = new Uint8Array([1, 2, 3]);

    const attachments = assertAttachments([
      { name: 'archive.bin', mime: 'application/octet-stream', bytes },
    ]);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: 'archive.bin',
      mime: 'application/octet-stream',
    });
    expect(attachments[0].bytes).toEqual(Buffer.from(bytes));
  });

  test('enforces the other-file size limit for unknown MIME attachments', () => {
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);

    expect(() => assertAttachments([
      { name: 'archive.bin', mime: 'application/octet-stream', bytes },
    ])).toThrow(/exceeds 10MB limit for other/);
  });
});
