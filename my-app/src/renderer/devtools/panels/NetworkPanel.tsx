import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[NetworkPanel]';

type TypeFilter = 'All' | 'XHR' | 'JS' | 'CSS' | 'Img' | 'Media' | 'Font' | 'Doc' | 'WS' | 'Other';

const TYPE_FILTERS: TypeFilter[] = [
  'All', 'XHR', 'JS', 'CSS', 'Img', 'Media', 'Font', 'Doc', 'WS', 'Other',
];

/** Maps CDP Network.ResourceType to our filter categories */
const RESOURCE_TYPE_TO_FILTER: Record<string, TypeFilter> = {
  Document: 'Doc',
  Stylesheet: 'CSS',
  Image: 'Img',
  Media: 'Media',
  Font: 'Font',
  Script: 'JS',
  TextTrack: 'Other',
  XHR: 'XHR',
  Fetch: 'XHR',
  EventSource: 'XHR',
  WebSocket: 'WS',
  Manifest: 'Other',
  SignedExchange: 'Other',
  Ping: 'Other',
  CSPViolationReport: 'Other',
  Preflight: 'Other',
  Other: 'Other',
};

/** Maps CDP resourceType to waterfall bar data-type attribute */
const RESOURCE_TYPE_TO_BAR_TYPE: Record<string, string> = {
  Document: 'document',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Media: 'other',
  Font: 'font',
  Script: 'script',
  TextTrack: 'other',
  XHR: 'xhr',
  Fetch: 'fetch',
  EventSource: 'fetch',
  WebSocket: 'other',
  Manifest: 'other',
  SignedExchange: 'other',
  Ping: 'other',
  CSPViolationReport: 'other',
  Preflight: 'other',
  Other: 'other',
};

const DETAIL_TABS = ['Headers', 'Preview', 'Response'] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface CdpPanelProps {
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  subscribeCdp: (listener: (method: string, params: unknown) => void) => () => void;
}

interface FlatHeaders {
  [name: string]: string;
}

interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  filterCategory: TypeFilter;
  barType: string;
  status: number | null;
  statusText: string;
  mimeType: string;
  encodedDataLength: number | null;
  startTime: number;   // CDP monotonic timestamp (seconds)
  endTime: number | null;
  failed: boolean;
  failureText: string;
  requestHeaders: FlatHeaders;
  responseHeaders: FlatHeaders;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function formatTime(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function extractFilename(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last || u.hostname || url;
  } catch {
    const parts = url.split('/').filter(Boolean);
    return parts[parts.length - 1] || url;
  }
}

function flattenHeaders(
  raw: Array<{ name: string; value: string }> | Record<string, string> | undefined,
): FlatHeaders {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: FlatHeaders = {};
    for (const h of raw) out[h.name] = h.value;
    return out;
  }
  return { ...raw };
}

// ─── Body preview (defined outside component to avoid re-creation on render) ──

function renderBodyPreview(mimeType: string, body: string): React.ReactElement {
  const lower = mimeType.toLowerCase();

  if (lower.includes('json')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--color-fg-primary)' }}>
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      // fall through to raw
    }
  }

  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--color-fg-primary)', fontSize: 'var(--font-size-2xs)' }}>
      {body}
    </pre>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NetworkPanel({ sendCdp, subscribeCdp }: CdpPanelProps): React.ReactElement {
  const [requests, setRequests] = useState<NetworkRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<TypeFilter>('All');
  const [textFilter, setTextFilter] = useState('');
  const [isRecording, setIsRecording] = useState(true);
  const [detailTab, setDetailTab] = useState<DetailTab>('Headers');
  const [responseBody, setResponseBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  // CDP monotonic timestamp of the first request — used to anchor waterfall
  const pageStartTimeRef = useRef<number | null>(null);
  // Mutable map for patching in-flight entries without triggering extra renders
  const requestMapRef = useRef<Map<string, NetworkRequest>>(new Map());
  // Track recording state in a ref so the event handler closure stays current
  const isRecordingRef = useRef(true);

  // ── Sync recording ref with state ─────────────────────────────────────────

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // ── CDP domain lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    console.log(LOG_PREFIX, 'enabling Network + Page domains');
    void sendCdp('Network.enable', { maxTotalBufferSize: 10485760, maxResourceBufferSize: 5242880 });
    void sendCdp('Page.enable');

    const unsubscribe = subscribeCdp((method, params) => {
      if (!isRecordingRef.current) return;

      const p = params as Record<string, unknown>;

      // ── requestWillBeSent ──────────────────────────────────────────────────
      if (method === 'Network.requestWillBeSent') {
        const reqId = p.requestId as string;
        const req = p.request as Record<string, unknown>;
        const timestamp = p.timestamp as number;
        const rawType = (p.type as string | undefined) ?? 'Other';
        const filterCategory = RESOURCE_TYPE_TO_FILTER[rawType] ?? 'Other';
        const barType = RESOURCE_TYPE_TO_BAR_TYPE[rawType] ?? 'other';

        if (pageStartTimeRef.current === null) {
          pageStartTimeRef.current = timestamp;
          console.log(LOG_PREFIX, 'page start time anchored at', timestamp);
        }

        const entry: NetworkRequest = {
          requestId: reqId,
          url: req.url as string,
          method: req.method as string,
          resourceType: rawType,
          filterCategory,
          barType,
          status: null,
          statusText: '',
          mimeType: '',
          encodedDataLength: null,
          startTime: timestamp,
          endTime: null,
          failed: false,
          failureText: '',
          requestHeaders: flattenHeaders(req.headers as Array<{ name: string; value: string }> | Record<string, string>),
          responseHeaders: {},
        };

        console.log(LOG_PREFIX, 'requestWillBeSent', reqId, entry.method, entry.url, 'type:', rawType);

        requestMapRef.current.set(reqId, entry);
        setRequests((prev) => {
          const idx = prev.findIndex((r) => r.requestId === reqId);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = entry;
            return next;
          }
          return [...prev, entry];
        });
      }

      // ── responseReceived ───────────────────────────────────────────────────
      if (method === 'Network.responseReceived') {
        const reqId = p.requestId as string;
        const response = p.response as Record<string, unknown>;
        const status = response.status as number;
        const statusText = (response.statusText as string) || '';
        const mimeType = (response.mimeType as string) || '';
        const responseHeaders = flattenHeaders(
          response.headers as Array<{ name: string; value: string }> | Record<string, string>,
        );

        console.log(LOG_PREFIX, 'responseReceived', reqId, status, mimeType);

        const existing = requestMapRef.current.get(reqId);
        if (existing) {
          const updated = { ...existing, status, statusText, mimeType, responseHeaders };
          requestMapRef.current.set(reqId, updated);
          setRequests((prev) =>
            prev.map((r) => (r.requestId === reqId ? updated : r)),
          );
        }
      }

      // ── loadingFinished ────────────────────────────────────────────────────
      if (method === 'Network.loadingFinished') {
        const reqId = p.requestId as string;
        const timestamp = p.timestamp as number;
        const encodedDataLength = (p.encodedDataLength as number | undefined) ?? 0;

        console.log(LOG_PREFIX, 'loadingFinished', reqId, 'size:', encodedDataLength, 'bytes');

        const existing = requestMapRef.current.get(reqId);
        if (existing) {
          const updated = { ...existing, endTime: timestamp, encodedDataLength };
          requestMapRef.current.set(reqId, updated);
          setRequests((prev) =>
            prev.map((r) => (r.requestId === reqId ? updated : r)),
          );
        }
      }

      // ── loadingFailed ──────────────────────────────────────────────────────
      if (method === 'Network.loadingFailed') {
        const reqId = p.requestId as string;
        const timestamp = p.timestamp as number;
        const errorText = (p.errorText as string | undefined) ?? 'Failed';
        const canceled = (p.canceled as boolean | undefined) ?? false;
        const failureText = canceled ? 'Canceled' : errorText;

        console.log(LOG_PREFIX, 'loadingFailed', reqId, failureText);

        const existing = requestMapRef.current.get(reqId);
        if (existing) {
          const updated = { ...existing, endTime: timestamp, failed: true, failureText };
          requestMapRef.current.set(reqId, updated);
          setRequests((prev) =>
            prev.map((r) => (r.requestId === reqId ? updated : r)),
          );
        }
      }

      // ── Page navigation resets waterfall reference ─────────────────────────
      if (method === 'Page.frameNavigated') {
        console.log(LOG_PREFIX, 'Page.frameNavigated — resetting waterfall anchor');
        pageStartTimeRef.current = null;
      }
    });

    return () => {
      console.log(LOG_PREFIX, 'disabling Network domain');
      unsubscribe();
      void sendCdp('Network.disable').catch(() => {});
      void sendCdp('Page.disable').catch(() => {});
    };
  }, [sendCdp, subscribeCdp]);

  // ── Filtered list ──────────────────────────────────────────────────────────

  const filteredRequests = useMemo(() => {
    const lower = textFilter.toLowerCase();
    return requests.filter((r) => {
      if (activeFilter !== 'All' && r.filterCategory !== activeFilter) return false;
      if (lower && !r.url.toLowerCase().includes(lower)) return false;
      return true;
    });
  }, [requests, activeFilter, textFilter]);

  // ── Summary stats ──────────────────────────────────────────────────────────

  const { totalSize } = useMemo(() => {
    const totalSize = filteredRequests.reduce((acc, r) => acc + (r.encodedDataLength ?? 0), 0);
    return { totalSize };
  }, [filteredRequests]);

  // ── Waterfall scale ────────────────────────────────────────────────────────

  const waterfallDurationMs = useMemo(() => {
    if (requests.length === 0) return 1000;
    const pageStart = pageStartTimeRef.current ?? requests[0].startTime;
    let maxEnd = pageStart;
    for (const r of requests) {
      const end = r.endTime ?? r.startTime;
      if (end > maxEnd) maxEnd = end;
    }
    return Math.max((maxEnd - pageStart) * 1000, 100);
  }, [requests]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleClear = useCallback(() => {
    console.log(LOG_PREFIX, 'clearing all requests');
    requestMapRef.current.clear();
    pageStartTimeRef.current = null;
    setRequests([]);
    setSelectedId(null);
    setResponseBody(null);
  }, []);

  const handleToggleRecord = useCallback(() => {
    setIsRecording((prev) => {
      console.log(LOG_PREFIX, 'recording toggled to:', !prev);
      return !prev;
    });
  }, []);

  const handleSelectRequest = useCallback((requestId: string) => {
    console.log(LOG_PREFIX, 'selected request:', requestId);
    setSelectedId(requestId);
    setDetailTab('Headers');
    setResponseBody(null);
  }, []);

  // ── Response body fetch ────────────────────────────────────────────────────

  const fetchResponseBody = useCallback(
    async (requestId: string) => {
      console.log(LOG_PREFIX, 'fetching response body for', requestId);
      setLoadingBody(true);
      setResponseBody(null);
      try {
        const result = (await sendCdp('Network.getResponseBody', { requestId })) as
          | { body?: string; base64Encoded?: boolean }
          | undefined;
        if (requestId !== selectedId) return;
        const body = result?.body ?? '';
        const display = result?.base64Encoded ? `(base64)\n${body}` : body || '(empty)';
        console.log(LOG_PREFIX, 'response body fetched, length:', body.length);
        setResponseBody(display);
      } catch (err) {
        if (requestId !== selectedId) return;
        console.warn(LOG_PREFIX, 'getResponseBody failed:', err);
        setResponseBody('(body not available)');
      } finally {
        setLoadingBody(false);
      }
    },
    [sendCdp, selectedId],
  );

  const handleDetailTabChange = useCallback(
    (tab: DetailTab) => {
      setDetailTab(tab);
      if ((tab === 'Response' || tab === 'Preview') && selectedId && responseBody === null) {
        void fetchResponseBody(selectedId);
      }
    },
    [selectedId, responseBody, fetchResponseBody],
  );

  // ── Derived: selected request ──────────────────────────────────────────────

  const selectedRequest = useMemo(
    () => (selectedId ? (requests.find((r) => r.requestId === selectedId) ?? null) : null),
    [requests, selectedId],
  );

  // ── Waterfall bar positioning ──────────────────────────────────────────────

  const computeWaterfallBar = useCallback(
    (req: NetworkRequest): { left: string; width: string } => {
      const pageStart = pageStartTimeRef.current ?? req.startTime;
      const startOffsetMs = (req.startTime - pageStart) * 1000;
      const endMs = req.endTime != null ? (req.endTime - pageStart) * 1000 : startOffsetMs + 10;
      const durationMs = Math.max(endMs - startOffsetMs, 2);

      const leftPct = Math.max(0, (startOffsetMs / waterfallDurationMs) * 100);
      const widthPct = Math.min((durationMs / waterfallDurationMs) * 100, 100 - leftPct);

      return {
        left: `${leftPct.toFixed(2)}%`,
        width: `${Math.max(widthPct, 0.5).toFixed(2)}%`,
      };
    },
    [waterfallDurationMs],
  );

  // ── Render: status cell ────────────────────────────────────────────────────

  const renderStatusCell = (req: NetworkRequest): React.ReactElement => {
    if (req.failed) {
      return (
        <td>
          <span className="network-status" data-ok="false">{req.failureText || 'Failed'}</span>
        </td>
      );
    }
    if (req.status === null) {
      return (
        <td>
          <span className="network-status" style={{ color: 'var(--color-fg-tertiary)' }}>pending</span>
        </td>
      );
    }
    const isOk = req.status >= 200 && req.status < 400;
    return (
      <td>
        <span className="network-status" data-ok={isOk ? 'true' : 'false'}>{req.status}</span>
      </td>
    );
  };

  // ── Render: detail pane ────────────────────────────────────────────────────

  const renderDetailPane = (): React.ReactElement | null => {
    if (!selectedRequest) return null;

    return (
      <div
        style={{
          borderTop: '1px solid var(--color-border-default)',
          height: '240px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Tab strip */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'var(--color-bg-elevated)',
            flexShrink: 0,
          }}
        >
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab}
              style={{
                padding: 'var(--space-2) var(--space-5)',
                fontSize: 'var(--font-size-xs)',
                color: detailTab === tab ? 'var(--color-accent-default)' : 'var(--color-fg-secondary)',
                borderBottom: detailTab === tab ? '2px solid var(--color-accent-default)' : '2px solid transparent',
                background: 'transparent',
              }}
              onClick={() => handleDetailTabChange(tab)}
            >
              {tab}
            </button>
          ))}
          <button
            style={{ marginLeft: 'auto', padding: 'var(--space-1) var(--space-4)', fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-tertiary)' }}
            onClick={() => { setSelectedId(null); setResponseBody(null); }}
          >
            ✕
          </button>
        </div>

        {/* Tab content */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 'var(--space-3) var(--space-4)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-xs)',
          }}
        >
          {detailTab === 'Headers' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {/* General */}
              <section>
                <div style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-secondary)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', fontSize: 'var(--font-size-2xs)', letterSpacing: '0.05em' }}>
                  General
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-1) var(--space-4)' }}>
                  <span style={{ color: 'var(--color-fg-tertiary)' }}>Request URL</span>
                  <span style={{ color: 'var(--color-fg-primary)', wordBreak: 'break-all' }}>{selectedRequest.url}</span>
                  <span style={{ color: 'var(--color-fg-tertiary)' }}>Request Method</span>
                  <span>{selectedRequest.method}</span>
                  {selectedRequest.status !== null && (
                    <>
                      <span style={{ color: 'var(--color-fg-tertiary)' }}>Status Code</span>
                      <span>{selectedRequest.status} {selectedRequest.statusText}</span>
                    </>
                  )}
                  <span style={{ color: 'var(--color-fg-tertiary)' }}>Resource Type</span>
                  <span>{selectedRequest.resourceType}</span>
                </div>
              </section>

              {/* Response Headers */}
              {Object.keys(selectedRequest.responseHeaders).length > 0 && (
                <section>
                  <div style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-secondary)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', fontSize: 'var(--font-size-2xs)', letterSpacing: '0.05em' }}>
                    Response Headers
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-1) var(--space-4)' }}>
                    {Object.entries(selectedRequest.responseHeaders).map(([name, value]) => (
                      <React.Fragment key={name}>
                        <span style={{ color: 'var(--color-fg-tertiary)', whiteSpace: 'nowrap' }}>{name}</span>
                        <span style={{ color: 'var(--color-fg-primary)', wordBreak: 'break-all' }}>{value}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </section>
              )}

              {/* Request Headers */}
              {Object.keys(selectedRequest.requestHeaders).length > 0 && (
                <section>
                  <div style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-secondary)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', fontSize: 'var(--font-size-2xs)', letterSpacing: '0.05em' }}>
                    Request Headers
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-1) var(--space-4)' }}>
                    {Object.entries(selectedRequest.requestHeaders).map(([name, value]) => (
                      <React.Fragment key={name}>
                        <span style={{ color: 'var(--color-fg-tertiary)', whiteSpace: 'nowrap' }}>{name}</span>
                        <span style={{ color: 'var(--color-fg-primary)', wordBreak: 'break-all' }}>{value}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {(detailTab === 'Response' || detailTab === 'Preview') && (
            <>
              {loadingBody && (
                <span style={{ color: 'var(--color-fg-tertiary)' }}>Loading...</span>
              )}
              {!loadingBody && responseBody === null && (
                <span style={{ color: 'var(--color-fg-tertiary)' }}>No body available</span>
              )}
              {!loadingBody && responseBody !== null && (
                detailTab === 'Preview'
                  ? renderBodyPreview(selectedRequest.mimeType, responseBody)
                  : (
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--color-fg-primary)' }}>
                      {responseBody}
                    </pre>
                  )
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="network-panel">

      {/* Toolbar */}
      <div className="network-toolbar">
        <button
          style={{
            padding: 'var(--space-1) var(--space-3)',
            fontSize: 'var(--font-size-2xs)',
            borderRadius: 'var(--radius-sm)',
            color: isRecording ? 'var(--color-status-error)' : 'var(--color-fg-secondary)',
            fontWeight: 'var(--font-weight-medium)',
          }}
          title={isRecording ? 'Pause recording' : 'Resume recording'}
          onClick={handleToggleRecord}
        >
          {isRecording ? '● Record' : '○ Paused'}
        </button>

        <button
          style={{
            padding: 'var(--space-1) var(--space-3)',
            fontSize: 'var(--font-size-2xs)',
            color: 'var(--color-fg-tertiary)',
            borderRadius: 'var(--radius-sm)',
          }}
          onClick={handleClear}
        >
          Clear
        </button>

        <input
          className="network-filter-input"
          type="text"
          placeholder="Filter by URL..."
          value={textFilter}
          onChange={(e) => {
            console.log(LOG_PREFIX, 'text filter:', e.target.value);
            setTextFilter(e.target.value);
          }}
        />

        <div className="network-type-filters">
          {TYPE_FILTERS.map((type) => (
            <button
              key={type}
              className="network-type-btn"
              data-active={activeFilter === type ? 'true' : 'false'}
              onClick={() => {
                console.log(LOG_PREFIX, 'type filter:', type);
                setActiveFilter(type);
              }}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {/* Request table */}
      <div className="network-table-wrapper">
        <table className="network-table">
          <thead>
            <tr>
              <th style={{ width: '200px' }}>Name</th>
              <th style={{ width: '60px' }}>Method</th>
              <th style={{ width: '70px' }}>Status</th>
              <th style={{ width: '70px' }}>Type</th>
              <th style={{ width: '80px' }}>Size</th>
              <th style={{ width: '80px' }}>Time</th>
              <th>Waterfall</th>
            </tr>
          </thead>
          <tbody>
            {filteredRequests.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{ textAlign: 'center', color: 'var(--color-fg-tertiary)', padding: 'var(--space-8)' }}
                >
                  {requests.length === 0
                    ? 'No requests captured. Navigate to a page to begin.'
                    : 'No requests match current filters.'}
                </td>
              </tr>
            ) : (
              filteredRequests.map((req) => {
                const durationMs = req.endTime !== null ? (req.endTime - req.startTime) * 1000 : null;
                const bar = computeWaterfallBar(req);

                return (
                  <tr
                    key={req.requestId}
                    data-selected={selectedId === req.requestId ? 'true' : 'false'}
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleSelectRequest(req.requestId)}
                  >
                    <td title={req.url}>
                      <span className="network-url">{extractFilename(req.url)}</span>
                    </td>
                    <td>
                      <span className="network-method">{req.method}</span>
                    </td>
                    {renderStatusCell(req)}
                    <td style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
                      {req.filterCategory}
                    </td>
                    <td>
                      <span className="network-size">{formatSize(req.encodedDataLength)}</span>
                    </td>
                    <td>
                      <span className="network-time">{formatTime(durationMs)}</span>
                    </td>
                    <td>
                      <div className="network-waterfall">
                        <div
                          className="network-waterfall-bar"
                          data-type={req.barType}
                          style={{ left: bar.left, width: bar.width }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Detail pane (shown when a row is selected) */}
      {renderDetailPane()}

      {/* Summary bar */}
      <div className="network-summary">
        <span>
          {filteredRequests.length} request{filteredRequests.length !== 1 ? 's' : ''}
        </span>
        <span>{formatSize(totalSize)} transferred</span>
        {!isRecording && (
          <span style={{ color: 'var(--color-status-warning)' }}>Recording paused</span>
        )}
      </div>
    </div>
  );
}
