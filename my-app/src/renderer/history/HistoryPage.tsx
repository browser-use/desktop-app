import React, { useCallback, useEffect, useRef, useState } from 'react';
import { JourneysPage } from './JourneysPage';

interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  favicon: string | null;
}

interface HistoryQueryResult {
  entries: HistoryEntry[];
  totalCount: number;
}

declare const historyAPI: {
  query: (opts?: { query?: string; limit?: number; offset?: number }) => Promise<HistoryQueryResult>;
  remove: (id: string) => Promise<boolean>;
  removeBulk: (ids: string[]) => Promise<number>;
  clearAll: () => Promise<boolean>;
  navigateTo: (url: string) => Promise<void>;
};

type HistoryTab = 'list' | 'journeys' | 'other-devices';

const PAGE_SIZE = 100;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function getDateLabel(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const entryDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (entryDate.getTime() === today.getTime()) return 'Today';
  if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function groupByDate(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const label = getDateLabel(entry.visitTime);
    const group = groups.get(label);
    if (group) {
      group.push(entry);
    } else {
      groups.set(label, [entry]);
    }
  }
  return groups;
}

function faviconUrl(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=16`;
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

function HistoryList(): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  // React 19's useRef signature requires an explicit initial value; undefined
  // is the effective default for a ref that hasn't been populated yet.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchHistory = useCallback(async (searchQuery: string, pageOffset: number) => {
    setLoading(true);
    try {
      const result = await historyAPI.query({
        query: searchQuery || undefined,
        limit: PAGE_SIZE,
        offset: pageOffset,
      });
      if (pageOffset === 0) {
        setEntries(result.entries);
      } else {
        setEntries((prev) => [...prev, ...result.entries]);
      }
      setTotalCount(result.totalCount);
    } catch (err) {
      console.error('HistoryPage.fetchHistory.failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory(debouncedQuery, 0);
    setOffset(0);
    setSelected(new Set());
  }, [debouncedQuery, fetchHistory]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(val);
    }, 250);
  }, []);

  const handleLoadMore = useCallback(() => {
    const nextOffset = offset + PAGE_SIZE;
    setOffset(nextOffset);
    fetchHistory(debouncedQuery, nextOffset);
  }, [offset, debouncedQuery, fetchHistory]);

  const handleRemove = useCallback(async (id: string) => {
    await historyAPI.remove(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setTotalCount((prev) => prev - 1);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    await historyAPI.removeBulk(ids);
    setEntries((prev) => prev.filter((e) => !selected.has(e.id)));
    setTotalCount((prev) => prev - selected.size);
    setSelected(new Set());
  }, [selected]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNavigate = useCallback((url: string) => {
    historyAPI.navigateTo(url);
  }, []);

  const groups = groupByDate(entries);
  const hasMore = entries.length < totalCount;

  return (
    <>
      {selected.size > 0 && (
        <div className="history__bulk-bar">
          <span className="history__bulk-count">{selected.size} selected</span>
          <button
            type="button"
            className="history__bulk-delete"
            onClick={handleBulkDelete}
          >
            Delete
          </button>
        </div>
      )}

      <div className="history__search-container">
        <svg className="history__search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          className="history__search"
          type="text"
          value={query}
          onChange={handleQueryChange}
          placeholder="Search history"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Search history"
        />
      </div>

      <div className="history__content">
        {loading && entries.length === 0 ? (
          <div className="history__empty">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="history__empty">
            {debouncedQuery ? 'No results found' : 'No browsing history'}
          </div>
        ) : (
          <>
            {Array.from(groups.entries()).map(([dateLabel, groupEntries]) => (
              <div key={dateLabel} className="history__group">
                <h2 className="history__date-label">{dateLabel}</h2>
                <div className="history__entries">
                  {groupEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className={`history__entry ${selected.has(entry.id) ? 'history__entry--selected' : ''}`}
                    >
                      <label className="history__checkbox-label">
                        <input
                          type="checkbox"
                          className="history__checkbox"
                          checked={selected.has(entry.id)}
                          onChange={() => toggleSelect(entry.id)}
                        />
                      </label>
                      <span className="history__time">{formatTime(entry.visitTime)}</span>
                      <img
                        className="history__favicon"
                        src={entry.favicon || faviconUrl(entry.url)}
                        alt=""
                        width={16}
                        height={16}
                        onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                      />
                      <button
                        type="button"
                        className="history__entry-link"
                        onClick={() => handleNavigate(entry.url)}
                        title={entry.url}
                      >
                        <span className="history__entry-title">{entry.title || entry.url}</span>
                        <span className="history__entry-domain">{domainLabel(entry.url)}</span>
                      </button>
                      <button
                        type="button"
                        className="history__entry-menu"
                        onClick={() => handleRemove(entry.id)}
                        title="Remove from history"
                        aria-label="Remove from history"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {hasMore && (
              <button
                type="button"
                className="history__load-more"
                onClick={handleLoadMore}
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function OtherDevicesPage(): React.ReactElement {
  return (
    <div className="history-other-devices">
      <div className="history-other-devices__empty">
        <div className="history-other-devices__icon" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <h2 className="history-other-devices__title">Tabs from other devices</h2>
        <p className="history-other-devices__desc">
          Sign in and enable sync to see open tabs from your other devices.
        </p>
        <p className="history-other-devices__hint">
          To enable: <strong>Settings → Sync</strong> → turn on sync and enable &ldquo;History and tabs&rdquo;.
        </p>
      </div>
    </div>
  );
}

export function HistoryPage(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<HistoryTab>('list');

  return (
    <div className="history">
      <header className="history__header">
        <h1 className="history__title">History</h1>
      </header>

      <nav className="history__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`history__tab ${activeTab === 'list' ? 'history__tab--active' : ''}`}
          aria-selected={activeTab === 'list'}
          onClick={() => setActiveTab('list')}
        >
          List
        </button>
        <button
          type="button"
          role="tab"
          className={`history__tab ${activeTab === 'journeys' ? 'history__tab--active' : ''}`}
          aria-selected={activeTab === 'journeys'}
          onClick={() => setActiveTab('journeys')}
        >
          Journeys
        </button>
        <button
          type="button"
          role="tab"
          className={`history__tab ${activeTab === 'other-devices' ? 'history__tab--active' : ''}`}
          aria-selected={activeTab === 'other-devices'}
          onClick={() => setActiveTab('other-devices')}
        >
          Other devices
        </button>
      </nav>

      {activeTab === 'list' && <HistoryList />}
      {activeTab === 'journeys' && <JourneysPage />}
      {activeTab === 'other-devices' && <OtherDevicesPage />}
    </div>
  );
}
