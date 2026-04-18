/**
 * useRegionCycling — F6 region cycling across chrome UI areas.
 * Regions: tab-strip → toolbar → bookmarks-bar (if visible) → content → side-panel (if open).
 * Shift+F6 reverses direction.
 */

import { useCallback, useRef } from 'react';

export type RegionId = 'tab-strip' | 'toolbar' | 'bookmarks-bar' | 'content' | 'side-panel';

interface RegionCyclingOptions {
  barVisible: boolean;
  sidePanelOpen: boolean;
}

interface RegionRefs {
  tabStrip: React.RefObject<HTMLElement | null>;
  toolbar: React.RefObject<HTMLElement | null>;
  bookmarksBar: React.RefObject<HTMLElement | null>;
  sidePanel: React.RefObject<HTMLElement | null>;
}

const ALL_REGIONS: RegionId[] = [
  'tab-strip',
  'toolbar',
  'bookmarks-bar',
  'content',
  'side-panel',
];

function getVisibleRegions(opts: RegionCyclingOptions): RegionId[] {
  return ALL_REGIONS.filter((r) => {
    if (r === 'bookmarks-bar') return opts.barVisible;
    if (r === 'side-panel') return opts.sidePanelOpen;
    return true;
  });
}

function focusFirstInteractive(container: HTMLElement | null): boolean {
  if (!container) return false;
  const focusable = container.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable) {
    focusable.focus();
    console.log('[RegionCycling] focused element:', focusable.tagName, focusable.className);
    return true;
  }
  if (container.tabIndex >= 0) {
    container.focus();
    return true;
  }
  return false;
}

export function useRegionCycling(
  refs: RegionRefs,
  opts: RegionCyclingOptions,
): {
  currentRegionRef: React.MutableRefObject<RegionId>;
  cycleRegion: (forward: boolean) => RegionId;
  setCurrentRegion: (region: RegionId) => void;
} {
  const currentRegionRef = useRef<RegionId>('content');

  const setCurrentRegion = useCallback((region: RegionId) => {
    currentRegionRef.current = region;
  }, []);

  const cycleRegion = useCallback(
    (forward: boolean): RegionId => {
      const regions = getVisibleRegions(opts);
      const current = currentRegionRef.current;
      let idx = regions.indexOf(current);
      if (idx === -1) idx = regions.indexOf('content');
      if (idx === -1) idx = 0;

      if (forward) {
        idx = (idx + 1) % regions.length;
      } else {
        idx = (idx - 1 + regions.length) % regions.length;
      }

      const next = regions[idx];
      currentRegionRef.current = next;

      console.log('[RegionCycling] cycling from', current, 'to', next, forward ? '(forward)' : '(backward)');

      switch (next) {
        case 'tab-strip':
          focusFirstInteractive(refs.tabStrip.current);
          break;
        case 'toolbar':
          focusFirstInteractive(refs.toolbar.current);
          break;
        case 'bookmarks-bar':
          focusFirstInteractive(refs.bookmarksBar.current);
          break;
        case 'side-panel':
          focusFirstInteractive(refs.sidePanel.current);
          break;
        case 'content':
          break;
      }

      return next;
    },
    [opts, refs],
  );

  return { currentRegionRef, cycleRegion, setCurrentRegion };
}
