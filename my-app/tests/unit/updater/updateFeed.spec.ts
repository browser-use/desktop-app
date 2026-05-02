import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('generate-mac-update-feed', () => {
  it('writes electron-updater macOS metadata with the ZIP as the primary path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-use-update-feed-'));
    try {
      const zip = path.join(dir, 'Browser-Use-arm64-mac.zip');
      const dmg = path.join(dir, 'Browser-Use-arm64.dmg');
      const output = path.join(dir, 'latest-mac.yml');
      writeFileSync(zip, 'zip-data');
      writeFileSync(dmg, 'dmg-data');

      execFileSync(
        process.execPath,
        [
          path.resolve(__dirname, '../../../scripts/generate-mac-update-feed.mjs'),
          '--version',
          '1.2.3',
          '--release-date',
          '2026-05-01T12:00:00.000Z',
          '--output',
          output,
          zip,
          dmg,
        ],
        { stdio: 'pipe' },
      );

      const manifest = readFileSync(output, 'utf8');
      const firstFileSha = manifest.match(/sha512: "([^"]+)"/)?.[1];

      expect(manifest).toContain('version: "1.2.3"');
      expect(manifest).toContain('releaseDate: "2026-05-01T12:00:00.000Z"');
      expect(manifest).toContain('path: "Browser-Use-arm64-mac.zip"');
      expect(manifest).toContain('  - url: "Browser-Use-arm64-mac.zip"');
      expect(manifest).toContain('  - url: "Browser-Use-arm64.dmg"');
      expect(manifest).toContain(`sha512: "${firstFileSha}"`);
      expect(manifest).toMatch(/size: [1-9][0-9]*/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generate-linux-update-feed', () => {
  it('writes electron-updater Linux metadata with the AppImage as the primary path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-use-linux-update-feed-'));
    try {
      const appImage = path.join(dir, 'Browser-Use-1.2.3-x64.AppImage');
      const output = path.join(dir, 'latest-linux.yml');
      writeFileSync(appImage, 'appimage-data');

      execFileSync(
        process.execPath,
        [
          path.resolve(__dirname, '../../../scripts/generate-linux-update-feed.mjs'),
          '--version',
          '1.2.3',
          '--release-date',
          '2026-05-01T12:00:00.000Z',
          '--output',
          output,
          appImage,
        ],
        { stdio: 'pipe' },
      );

      const manifest = readFileSync(output, 'utf8');
      const firstFileSha = manifest.match(/sha512: "([^"]+)"/)?.[1];

      expect(manifest).toContain('version: "1.2.3"');
      expect(manifest).toContain('releaseDate: "2026-05-01T12:00:00.000Z"');
      expect(manifest).toContain('path: "Browser-Use-1.2.3-x64.AppImage"');
      expect(manifest).toContain('  - url: "Browser-Use-1.2.3-x64.AppImage"');
      expect(manifest).toContain(`sha512: "${firstFileSha}"`);
      expect(manifest).toMatch(/size: [1-9][0-9]*/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
