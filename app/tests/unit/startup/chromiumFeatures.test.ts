import { describe, expect, it } from 'vitest';
import { mergeChromiumFeature } from '../../../src/main/startup/chromiumFeatures';

describe('mergeChromiumFeature', () => {
  it('adds a feature when no features are enabled yet', () => {
    expect(mergeChromiumFeature('', 'GlobalShortcutsPortal')).toBe('GlobalShortcutsPortal');
  });

  it('preserves existing Chromium feature flags when adding a feature', () => {
    expect(mergeChromiumFeature('WaylandWindowDecorations,UseOzonePlatform', 'GlobalShortcutsPortal')).toBe(
      'WaylandWindowDecorations,UseOzonePlatform,GlobalShortcutsPortal',
    );
  });

  it('does not duplicate an already-enabled feature', () => {
    expect(mergeChromiumFeature('WaylandWindowDecorations,GlobalShortcutsPortal', 'GlobalShortcutsPortal')).toBe(
      'WaylandWindowDecorations,GlobalShortcutsPortal',
    );
  });

  it('normalizes spacing and empty feature-list entries', () => {
    expect(mergeChromiumFeature(' WaylandWindowDecorations, ,UseOzonePlatform ', 'GlobalShortcutsPortal')).toBe(
      'WaylandWindowDecorations,UseOzonePlatform,GlobalShortcutsPortal',
    );
  });
});
