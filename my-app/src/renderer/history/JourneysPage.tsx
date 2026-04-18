import React, { useCallback, useEffect, useRef, useState } from 'react';

interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  favicon: string | null;
}

interface JourneyCluster {
  id: string;
  label: string;
  domain: string;
  entries: HistoryEntry[];
  startTime: number;
  endTime: number;
}

interface JourneyQueryResult {
  clusters: JourneyCluster[];
  totalCount: number;
}

declare const historyAPI: {
  journeys: (opts?: { query?: string; limit?: number; offset?: number }) => Promise<JourneyQueryResult>;
  remove: (id: string) => Promise<boolean>;
  removeCluster: (clusterId: string) => Promise<number>;
  navigateTo: (url: string) => Promise<void>;
};

const PAGE_SIZE = 30;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDateRange(start: number, end: number): string {
  const s = new Date(start);
  const e = new Date(end);
  const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const sameDay =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate();

  if (sameDay) {
    return `${s.toLocaleDateString(undefined, dateOpts)} · ${formatTime(start)} – ${formatTime(end)}`;
  }
  return `${s.toLocaleDateString(undefined, dateOpts)} – ${e.toLocaleDateString(undefined, dateOpts)}`;
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

export function JourneysPage(): React.ReactElement {
  const [clusters, setClusters] = useState<JourneyCluster[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // React 19's useRef signature requires an explicit initial value.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchJourneys = useCallback(async (searchQuery: string, pageOffset: number) => {
    setLoading(true);
    try {
      const result = await historyAPI.journeys({
        query: searchQuery || undefined,
        limit: PAGE_SIZE,
        offset: pageOffset,
      });
      if (pageOffset === 0) {
        setClusters(result.clusters);
      } else {
        setClusters((prev) => [...prev, ...result.clusters]);
      }
      setTotalCount(result.totalCount);
    } catch (err) {
      console.error('JourneysPage.fetchJourneys.failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJourneys(debouncedQuery, 0);
    setOffset(0);
    setExpanded(new Set());
  }, [debouncedQuery, fetchJourneys]);

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
    fetchJourneys(debouncedQuery, nextOffset);
  }, [offset, debouncedQuery, fetchJourneys]);

  const toggleExpand = useCallback((clusterId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  }, []);

  const handleRemoveEntry = useCallback(async (entryId: string, clusterId: string) => {
    await historyAPI.remove(entryId);
    setClusters((prev) =>
      prev
        .map((c) => {
          if (c.id !== clusterId) return c;
          const filtered = c.entries.filter((e) => e.id !== entryId);
          if (filtered.length < 2) return null;
          return { ...c, entries: filtered };
        })
        .filter(Boolean) as JourneyCluster[],
    );
    setTotalCount((prev) => prev);
  }, []);

  const handleRemoveCluster = useCallback(async (clusterId: string) => {
    const removed = await historyAPI.removeCluster(clusterId);
    if (removed > 0) {
      setClusters((prev) => prev.filter((c) => c.id !== clusterId));
      setTotalCount((prev) => prev - 1);
    }
  }, []);

  const handleNavigate = useCallback((url: string) => {
    historyAPI.navigateTo(url);
  }, []);

  const hasMore = clusters.length < totalCount;

  return (
    <div className="journeys">
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
          placeholder="Search journeys"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Search journeys"
        />
      </div>

      <div className="journeys__content">
        {loading && clusters.length === 0 ? (
          <div className="history__empty">Loading...</div>
        ) : clusters.length === 0 ? (
          <div className="history__empty">
            {debouncedQuery ? 'No matching journeys' : 'No journeys yet — browse more to build topic clusters'}
          </div>
        ) : (
          <>
            {clusters.map((cluster) => {
              const isExpanded = expanded.has(cluster.id);
              return (
                <div key={cluster.id} className="journey-cluster">
                  <div className="journey-cluster__header">
                    <button
                      type="button"
                      className="journey-cluster__toggle"
                      onClick={() => toggleExpand(cluster.id)}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? 'Collapse cluster' : 'Expand cluster'}
                    >
                      <svg
                        className={`journey-cluster__chevron ${isExpanded ? 'journey-cluster__chevron--open' : ''}`}
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path d="M4 3L8 6L4 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <img
                      className="history__favicon"
                      src={faviconUrl(cluster.entries[0]?.url ?? '')}
                      alt=""
                      width={16}
                      height={16}
                      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                    <div className="journey-cluster__info">
                      <span className="journey-cluster__label">{cluster.label}</span>
                      <span className="journey-cluster__meta">
                        {formatDateRange(cluster.startTime, cluster.endTime)} · {cluster.entries.length} pages
                      </span>
                    </div>
                    <button
                      type="button"
                      className="journey-cluster__delete"
                      onClick={() => handleRemoveCluster(cluster.id)}
                      title="Delete entire cluster"
                      aria-label="Delete cluster"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="journey-cluster__entries">
                      {cluster.entries.map((entry) => (
                        <div key={entry.id} className="history__entry">
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
                            onClick={() => handleRemoveEntry(entry.id, cluster.id)}
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
                  )}
                </div>
              );
            })}
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
    </div>
  );
}
