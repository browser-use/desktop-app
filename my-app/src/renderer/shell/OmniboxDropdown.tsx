/**
 * OmniboxDropdown — renders ranked autocomplete suggestions below the URL bar.
 *
 * Suggestion types:
 *   history      — clock icon, title + URL
 *   bookmark     — star icon, title + URL
 *   search       — magnifier icon, query text
 *   shortcut     — bolt icon, learned selection
 *   featured     — @ icon, @tabs / @bookmarks / @history
 *   keyword      — engine icon, search engine keyword mode
 *   zero-suggest — clock/clipboard icon, focus-empty suggestions
 *   url          — globe icon, direct URL navigation
 *
 * Per-suggestion × button removes history entries inline.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import type { OmniboxSuggestion } from '../../main/omnibox/providers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ICON_SIZE = 14;

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------
function HistoryIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function BookmarkIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.5l1.4 2.84 3.13.46-2.27 2.21.54 3.12L7 8.5l-2.8 1.63.54-3.12L2.47 4.8l3.13-.46L7 1.5z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.5 9.5l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function GlobeIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 7h11M7 1.5a8.5 5.5 0 0 1 0 11M7 1.5a8.5 5.5 0 0 0 0 11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ShortcutIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5 2.5L9 7l-4 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AtIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.5 7a2.5 2.5 0 1 0-2.5 2.5V11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ClipboardIcon(): React.ReactElement {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 3V2.5A1.5 1.5 0 0 1 9 2.5V3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SuggestionIcon({ s }: { s: OmniboxSuggestion }): React.ReactElement {
  if (s.favicon) {
    return (
      <img
        src={s.favicon}
        alt=""
        className="omnibox-suggestion__favicon"
        width={ICON_SIZE}
        height={ICON_SIZE}
        aria-hidden="true"
      />
    );
  }
  switch (s.type) {
    case 'history': return <HistoryIcon />;
    case 'bookmark': return <BookmarkIcon />;
    case 'search': return <SearchIcon />;
    case 'shortcut': return <ShortcutIcon />;
    case 'featured': return <AtIcon />;
    case 'keyword': return <SearchIcon />;
    case 'zero-suggest': return s.description === 'Clipboard' ? <ClipboardIcon /> : <HistoryIcon />;
    default: return <GlobeIcon />;
  }
}

function CloseIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface OmniboxDropdownProps {
  suggestions: OmniboxSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: OmniboxSuggestion) => void;
  onRemove: (suggestion: OmniboxSuggestion) => void;
  onHoverIndex: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function OmniboxDropdown({
  suggestions,
  selectedIndex,
  onSelect,
  onRemove,
  onHoverIndex,
}: OmniboxDropdownProps): React.ReactElement | null {
  const listRef = useRef<HTMLUListElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, suggestion: OmniboxSuggestion) => {
      // Prevent blur on the input before click registers
      e.preventDefault();
      onSelect(suggestion);
    },
    [onSelect],
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent, suggestion: OmniboxSuggestion) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove(suggestion);
    },
    [onRemove],
  );

  if (suggestions.length === 0) return null;

  return (
    <div className="omnibox-dropdown" role="listbox" aria-label="Address bar suggestions">
      <ul ref={listRef} className="omnibox-dropdown__list">
        {suggestions.map((s, i) => (
          <li
            key={s.id}
            className={[
              'omnibox-suggestion',
              i === selectedIndex ? 'omnibox-suggestion--selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="option"
            aria-selected={i === selectedIndex}
            onMouseDown={(e) => handleMouseDown(e, s)}
            onMouseEnter={() => onHoverIndex(i)}
          >
            <span className="omnibox-suggestion__icon">
              <SuggestionIcon s={s} />
            </span>

            <span className="omnibox-suggestion__body">
              <span className="omnibox-suggestion__title">{s.title}</span>
              {s.description && s.description !== s.title && (
                <span className="omnibox-suggestion__desc">{s.description}</span>
              )}
            </span>

            {/* × to remove history / shortcut entries */}
            {(s.type === 'history' || s.type === 'shortcut' || s.type === 'zero-suggest') && (
              <button
                type="button"
                className="omnibox-suggestion__remove"
                onMouseDown={(e) => handleRemove(e, s)}
                aria-label={`Remove ${s.title}`}
                title="Remove from suggestions"
                tabIndex={-1}
              >
                <CloseIcon />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
