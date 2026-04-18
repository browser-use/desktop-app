/**
 * TabHoverCard — tooltip-style card shown when hovering a tab chip.
 *
 * Shows the tab's title, URL, and a thumbnail screenshot.
 * Positioned absolutely below the hovered tab.
 */

import React, { useEffect, useState } from 'react';

declare const electronAPI: {
  tabs: {
    captureThumbnail: (tabId: string) => Promise<string | null>;
  };
};

interface TabHoverCardProps {
  tabId: string;
  title: string;
  url: string;
  anchorRect: DOMRect;
}

export function TabHoverCard({
  tabId,
  title,
  url,
  anchorRect,
}: TabHoverCardProps): React.ReactElement {
  const [thumbnail, setThumbnail] = useState<string | null>(null);

  useEffect(() => {
    setThumbnail(null);
    let cancelled = false;
    void electronAPI.tabs.captureThumbnail(tabId).then((dataUrl) => {
      if (!cancelled) setThumbnail(dataUrl);
    });
    return () => { cancelled = true; };
  }, [tabId]);

  const CARD_WIDTH = 280;
  const CARD_HEIGHT = 175 + 56; // thumbnail + body estimate
  const left = Math.max(4, Math.min(
    anchorRect.left + anchorRect.width / 2 - CARD_WIDTH / 2,
    window.innerWidth - CARD_WIDTH - 4,
  ));
  const topBelow = anchorRect.bottom + 6;
  const top = topBelow + CARD_HEIGHT > window.innerHeight
    ? Math.max(4, anchorRect.top - CARD_HEIGHT - 6)
    : topBelow;

  const displayUrl = (() => {
    try { return new URL(url).hostname || url; } catch { return url; }
  })();

  return (
    <div
      className="tab-hover-card"
      style={{ left, top, width: CARD_WIDTH }}
      role="tooltip"
    >
      {thumbnail ? (
        <img
          className="tab-hover-card__thumbnail"
          src={thumbnail}
          alt=""
          width={CARD_WIDTH}
          height={175}
        />
      ) : (
        <div className="tab-hover-card__thumbnail-placeholder" />
      )}
      <div className="tab-hover-card__body">
        <p className="tab-hover-card__title">{title || 'New Tab'}</p>
        {displayUrl && <p className="tab-hover-card__url">{displayUrl}</p>}
      </div>
    </div>
  );
}
