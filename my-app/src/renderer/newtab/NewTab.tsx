import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BookmarkNode, PersistedBookmarks } from '../../main/bookmarks/BookmarkStore';
import type { NtpCustomization, NtpShortcut } from '../../main/ntp/NtpCustomizationStore';

const MAX_TILES = 8;

declare const electronAPI: {
  tabs: {
    navigateActive: (input: string) => Promise<void>;
  };
  bookmarks: {
    list: () => Promise<PersistedBookmarks>;
  };
  ntp: {
    get: () => Promise<NtpCustomization>;
    set: (patch: Partial<NtpCustomization>) => Promise<NtpCustomization>;
  };
  on: {
    ntpCustomizationUpdated: (cb: (data: NtpCustomization) => void) => () => void;
  };
};

interface Tile {
  name: string;
  url: string;
  favicon?: string;
}

function extractTiles(tree: PersistedBookmarks): Tile[] {
  const barRoot = tree.roots[0];
  if (!barRoot?.children) return [];
  return barRoot.children
    .filter((c: BookmarkNode) => c.type === 'bookmark' && c.url)
    .slice(0, MAX_TILES)
    .map((c: BookmarkNode) => ({
      name: c.name,
      url: c.url!,
    }));
}

function shortcutsToTiles(shortcuts: NtpShortcut[]): Tile[] {
  return shortcuts.slice(0, MAX_TILES).map((s) => ({
    name: s.name,
    url: s.url,
  }));
}

function faviconUrl(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch {
    return '';
  }
}

function domainLabel(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return pageUrl;
  }
}

function getBackgroundStyle(config: NtpCustomization): React.CSSProperties {
  if (config.backgroundType === 'uploaded-image' && config.backgroundImageDataUrl) {
    return {
      backgroundImage: `url(${config.backgroundImageDataUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    };
  }
  if (config.backgroundType === 'solid-color' && config.backgroundColor) {
    return { background: config.backgroundColor };
  }
  return {};
}

export function NewTab(): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [config, setConfig] = useState<NtpCustomization | null>(null);

  useEffect(() => {
    console.log('[NewTab] Loading NTP customization and bookmarks');

    electronAPI.ntp.get().then((ntpConfig) => {
      console.log('[NewTab] NTP config loaded:', ntpConfig.backgroundType, ntpConfig.shortcutMode);
      setConfig(ntpConfig);

      if (ntpConfig.shortcutMode === 'custom') {
        setTiles(shortcutsToTiles(ntpConfig.customShortcuts));
      } else {
        electronAPI.bookmarks.list().then((tree) => {
          setTiles(extractTiles(tree));
        });
      }
    }).catch(() => {
      console.warn('[NewTab] NTP customization not available, falling back to bookmarks');
      electronAPI.bookmarks.list().then((tree) => {
        setTiles(extractTiles(tree));
      });
    });

    const unsub = electronAPI.on.ntpCustomizationUpdated((data) => {
      console.log('[NewTab] NTP customization updated:', data.backgroundType);
      setConfig(data);
      if (data.shortcutMode === 'custom') {
        setTiles(shortcutsToTiles(data.customShortcuts));
      } else {
        electronAPI.bookmarks.list().then((tree) => {
          setTiles(extractTiles(tree));
        });
      }
    });

    return unsub;
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed) {
        electronAPI.tabs.navigateActive(trimmed);
      }
    },
    [query],
  );

  const handleTileClick = useCallback((url: string) => {
    electronAPI.tabs.navigateActive(url);
  }, []);

  const bgStyle = config ? getBackgroundStyle(config) : {};
  const showShortcuts = config ? config.shortcutsVisible : true;

  return (
    <div className="newtab" style={bgStyle}>
      <form className="newtab__search" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className="newtab__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or enter address"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Search or enter address"
        />
      </form>

      {showShortcuts && tiles.length > 0 && (
        <div className="newtab__tiles">
          {tiles.map((tile) => (
            <button
              key={tile.url}
              type="button"
              className="newtab__tile"
              onClick={() => handleTileClick(tile.url)}
              title={tile.url}
            >
              <span className="newtab__tile-icon">
                <img
                  src={faviconUrl(tile.url)}
                  alt=""
                  width={24}
                  height={24}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </span>
              <span className="newtab__tile-label">
                {tile.name || domainLabel(tile.url)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
