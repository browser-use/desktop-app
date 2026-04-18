import React, { useState, useEffect, useCallback, useRef } from 'react';

// ---- Types ----------------------------------------------------------------

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

interface MetricEntry {
  name: string;
  value: number;
}

interface WebVital {
  name: string;
  value: string;
  rating: 'good' | 'needs-improvement' | 'poor' | 'unknown';
}

interface TraceEvent {
  id: number;
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

interface MetricSnapshot {
  ts: number;
  metrics: MetricEntry[];
}

// ---- Constants ------------------------------------------------------------

const PANEL_TAG = '[PerformancePanel]';

const DISPLAY_METRICS: string[] = [
  'JSHeapUsedSize',
  'JSHeapTotalSize',
  'Documents',
  'Frames',
  'JSEventListeners',
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
];

const METRIC_UNITS: Record<string, string> = {
  JSHeapUsedSize: 'bytes',
  JSHeapTotalSize: 'bytes',
  TaskDuration: 's',
  ScriptDuration: 's',
  LayoutDuration: 's',
  RecalcStyleDuration: 's',
};

// ---- Helpers ---------------------------------------------------------------

function formatMetricValue(name: string, value: number): string {
  const unit = METRIC_UNITS[name];
  if (unit === 'bytes') {
    if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }
  if (unit === 's') {
    return `${(value * 1000).toFixed(1)} ms`;
  }
  return String(value);
}

function vitalRating(name: string, value: number): 'good' | 'needs-improvement' | 'poor' | 'unknown' {
  // Thresholds from web.dev/vitals
  if (name === 'FCP') {
    if (value <= 1800) return 'good';
    if (value <= 3000) return 'needs-improvement';
    return 'poor';
  }
  if (name === 'LCP') {
    if (value <= 2500) return 'good';
    if (value <= 4000) return 'needs-improvement';
    return 'poor';
  }
  if (name === 'CLS') {
    if (value <= 0.1) return 'good';
    if (value <= 0.25) return 'needs-improvement';
    return 'poor';
  }
  if (name === 'FID' || name === 'INP') {
    if (value <= 100) return 'good';
    if (value <= 300) return 'needs-improvement';
    return 'poor';
  }
  return 'unknown';
}

const RATING_COLORS: Record<string, string> = {
  good: 'var(--color-status-success)',
  'needs-improvement': 'var(--color-status-warning)',
  poor: 'var(--color-status-error)',
  unknown: 'var(--color-fg-tertiary)',
};

let traceEventIdCounter = 0;

// ---- Component -------------------------------------------------------------

export function PerformancePanel({ cdpSend, onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [webVitals, setWebVitals] = useState<WebVital[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [snapshot, setSnapshot] = useState<MetricSnapshot | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [loadingVitals, setLoadingVitals] = useState(false);
  const metricsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Enable Performance domain on mount
  useEffect(() => {
    if (!isAttached) return;
    console.log(PANEL_TAG, 'enabling Performance domain');
    void cdpSend('Performance.enable', { timeDomain: 'timeTicks' }).then((r) => {
      console.log(PANEL_TAG, 'Performance.enable result:', r);
      void fetchMetrics();
    });

    return () => {
      console.log(PANEL_TAG, 'disabling Performance domain');
      void cdpSend('Performance.disable');
      if (metricsIntervalRef.current !== null) {
        clearInterval(metricsIntervalRef.current);
        metricsIntervalRef.current = null;
      }
    };
  }, [isAttached]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll metrics every 3 seconds when connected
  useEffect(() => {
    if (!isAttached) return;
    metricsIntervalRef.current = setInterval(() => {
      void fetchMetrics();
    }, 3000);
    return () => {
      if (metricsIntervalRef.current !== null) {
        clearInterval(metricsIntervalRef.current);
        metricsIntervalRef.current = null;
      }
    };
  }, [isAttached]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to Tracing events
  useEffect(() => {
    if (!isAttached) return;
    const unsubscribe = onCdpEvent((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Tracing.dataCollected') {
        const value = p.value as Array<Record<string, unknown>> | undefined;
        if (!value) return;
        console.log(PANEL_TAG, 'Tracing.dataCollected, events:', value.length);
        setTraceEvents((prev) => [
          ...prev,
          ...value.map((ev) => ({
            id: traceEventIdCounter++,
            name: (ev.name as string) ?? '',
            cat: (ev.cat as string) ?? '',
            ph: (ev.ph as string) ?? '',
            ts: (ev.ts as number) ?? 0,
            dur: ev.dur as number | undefined,
            pid: (ev.pid as number) ?? 0,
            tid: (ev.tid as number) ?? 0,
            args: ev.args as Record<string, unknown> | undefined,
          })),
        ]);
      }

      if (method === 'Tracing.tracingComplete') {
        console.log(PANEL_TAG, 'Tracing.tracingComplete');
        setIsRecording(false);
      }
    });

    return unsubscribe;
  }, [isAttached, onCdpEvent]);

  const fetchMetrics = useCallback(async () => {
    console.log(PANEL_TAG, 'fetching performance metrics');
    try {
      const r = await cdpSend('Performance.getMetrics');
      const result = r.result as { metrics?: MetricEntry[] };
      if (result?.metrics) {
        const filtered = result.metrics.filter((m) => DISPLAY_METRICS.includes(m.name));
        console.log(PANEL_TAG, 'got', filtered.length, 'metrics');
        setMetrics(filtered);
      }
    } catch (err) {
      console.error(PANEL_TAG, 'getMetrics failed:', err);
    }
  }, [cdpSend]);

  const fetchWebVitals = useCallback(async () => {
    setLoadingVitals(true);
    console.log(PANEL_TAG, 'fetching Web Vitals via Runtime.evaluate');
    try {
      const expression = `(function() {
        return new Promise(function(resolve) {
          var result = {};
          var entries = performance.getEntriesByType('paint');
          entries.forEach(function(e) {
            if (e.name === 'first-contentful-paint') result.FCP = e.startTime;
            if (e.name === 'first-paint') result.FP = e.startTime;
          });
          try {
            new PerformanceObserver(function(list) {
              var lcpEntries = list.getEntries();
              if (lcpEntries.length > 0) result.LCP = lcpEntries[lcpEntries.length - 1].startTime;
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch(e) {}
          try {
            var clsValue = 0;
            new PerformanceObserver(function(list) {
              list.getEntries().forEach(function(e) { if (!e.hadRecentInput) clsValue += e.value; });
              result.CLS = clsValue;
            }).observe({ type: 'layout-shift', buffered: true });
          } catch(e) {}
          try {
            new PerformanceObserver(function(list) {
              var fidEntries = list.getEntries();
              if (fidEntries.length > 0) result.FID = fidEntries[0].processingStart - fidEntries[0].startTime;
            }).observe({ type: 'first-input', buffered: true });
          } catch(e) {}
          setTimeout(function() { resolve(result); }, 100);
        });
      })()`;

      const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const res = r.result as { result?: { value?: Record<string, number> }; exceptionDetails?: unknown };
      if (res.result?.value) {
        const vals = res.result.value;
        console.log(PANEL_TAG, 'web vitals raw:', vals);
        const vitals: WebVital[] = Object.entries(vals).map(([name, value]) => ({
          name,
          value: name === 'CLS' ? value.toFixed(4) : `${value.toFixed(1)} ms`,
          rating: vitalRating(name, value),
        }));
        setWebVitals(vitals);
      }
    } catch (err) {
      console.error(PANEL_TAG, 'fetchWebVitals failed:', err);
    } finally {
      setLoadingVitals(false);
    }
  }, [cdpSend]);

  const handleTakeSnapshot = useCallback(async () => {
    setLoadingMetrics(true);
    console.log(PANEL_TAG, 'taking metrics snapshot');
    try {
      const r = await cdpSend('Performance.getMetrics');
      const result = r.result as { metrics?: MetricEntry[] };
      if (result?.metrics) {
        const filtered = result.metrics.filter((m) => DISPLAY_METRICS.includes(m.name));
        setSnapshot({ ts: Date.now(), metrics: filtered });
        console.log(PANEL_TAG, 'snapshot taken with', filtered.length, 'metrics');
      }
    } catch (err) {
      console.error(PANEL_TAG, 'snapshot failed:', err);
    } finally {
      setLoadingMetrics(false);
    }
  }, [cdpSend]);

  const handleStartRecording = useCallback(async () => {
    console.log(PANEL_TAG, 'starting Tracing session');
    setTraceEvents([]);
    setIsRecording(true);
    try {
      await cdpSend('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: {
          recordMode: 'recordUntilFull',
          includedCategories: ['devtools.timeline', 'v8', 'blink', 'cc'],
        },
      });
      console.log(PANEL_TAG, 'Tracing.start OK');
    } catch (err) {
      console.error(PANEL_TAG, 'Tracing.start failed:', err);
      setIsRecording(false);
    }
  }, [cdpSend]);

  const handleStopRecording = useCallback(async () => {
    console.log(PANEL_TAG, 'stopping Tracing session');
    try {
      await cdpSend('Tracing.end');
      console.log(PANEL_TAG, 'Tracing.end OK, waiting for dataCollected events');
    } catch (err) {
      console.error(PANEL_TAG, 'Tracing.end failed:', err);
      setIsRecording(false);
    }
  }, [cdpSend]);

  if (!isAttached) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Not connected</div>
        <div className="panel-placeholder-desc">Attach to a tab to use the Performance panel.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontSize: 'var(--font-size-xs)' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
          flexShrink: 0,
        }}
      >
        {!isRecording ? (
          <button onClick={() => void handleStartRecording()} style={actionBtnStyle}>
            ● Record
          </button>
        ) : (
          <button
            onClick={() => void handleStopRecording()}
            style={{ ...actionBtnStyle, background: 'var(--color-status-error)', color: '#fff' }}
          >
            ■ Stop
          </button>
        )}
        <button onClick={() => void handleTakeSnapshot()} disabled={loadingMetrics} style={actionBtnStyle}>
          {loadingMetrics ? 'Snapping...' : 'Take Snapshot'}
        </button>
        <button onClick={() => void fetchWebVitals()} disabled={loadingVitals} style={actionBtnStyle}>
          {loadingVitals ? 'Loading...' : 'Load Web Vitals'}
        </button>
        <button onClick={() => void fetchMetrics()} style={secondaryBtnStyle}>
          Refresh Metrics
        </button>
      </div>

      {/* Main scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>

        {/* Metrics Dashboard */}
        <section>
          <div style={sectionHeaderStyle}>Runtime Metrics</div>
          {metrics.length === 0 ? (
            <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>Loading metrics...</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
              {metrics.map((m) => (
                <div key={m.name} style={metricCardStyle}>
                  <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)', marginBottom: 'var(--space-1)' }}>{m.name}</div>
                  <div style={{ color: 'var(--color-fg-primary)', fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-weight-semibold)' }}>
                    {formatMetricValue(m.name, m.value)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Web Vitals */}
        {webVitals.length > 0 && (
          <section>
            <div style={sectionHeaderStyle}>Web Vitals</div>
            <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
              {webVitals.map((v) => (
                <div key={v.name} style={{ ...metricCardStyle, minWidth: '120px' }}>
                  <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)', marginBottom: 'var(--space-1)' }}>{v.name}</div>
                  <div style={{ color: RATING_COLORS[v.rating], fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--font-size-sm)' }}>
                    {v.value}
                  </div>
                  <div style={{ color: RATING_COLORS[v.rating], fontSize: 'var(--font-size-2xs)', marginTop: 'var(--space-1)' }}>
                    {v.rating}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Snapshot */}
        {snapshot && (
          <section>
            <div style={sectionHeaderStyle}>
              Snapshot — {new Date(snapshot.ts).toLocaleTimeString()}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
              {snapshot.metrics.map((m) => (
                <div key={m.name} style={{ ...metricCardStyle, background: 'var(--color-bg-elevated)' }}>
                  <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)', marginBottom: 'var(--space-1)' }}>{m.name}</div>
                  <div style={{ color: 'var(--color-fg-primary)', fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-weight-semibold)' }}>
                    {formatMetricValue(m.name, m.value)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Trace Events */}
        {traceEvents.length > 0 && (
          <section>
            <div style={sectionHeaderStyle}>
              Trace Events ({traceEvents.length})
            </div>
            <div style={{ overflowY: 'auto', maxHeight: '300px', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-mono)' }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-elevated)', position: 'sticky', top: 0 }}>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Cat</th>
                    <th style={thStyle}>Ph</th>
                    <th style={thStyle}>ts (μs)</th>
                    <th style={thStyle}>dur (μs)</th>
                  </tr>
                </thead>
                <tbody>
                  {traceEvents.slice(0, 500).map((ev) => (
                    <tr key={ev.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                      <td style={tdStyle}>{ev.name}</td>
                      <td style={{ ...tdStyle, color: 'var(--color-fg-tertiary)' }}>{ev.cat}</td>
                      <td style={{ ...tdStyle, color: 'var(--color-accent-default)' }}>{ev.ph}</td>
                      <td style={tdStyle}>{ev.ts}</td>
                      <td style={tdStyle}>{ev.dur ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {traceEvents.length > 500 && (
                <div style={{ padding: 'var(--space-2) var(--space-4)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
                  Showing first 500 of {traceEvents.length} events
                </div>
              )}
            </div>
          </section>
        )}

        {isRecording && traceEvents.length === 0 && (
          <section>
            <div style={{ color: 'var(--color-status-warning)', fontSize: 'var(--font-size-2xs)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span>●</span> Recording... interact with the page, then click Stop.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ---- Shared styles ---------------------------------------------------------

const actionBtnStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-4)',
  background: 'var(--color-accent-default)',
  color: 'var(--color-fg-inverse)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--font-size-xs)',
  fontWeight: 'var(--font-weight-medium)',
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-3)',
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--color-fg-primary)',
  fontSize: 'var(--font-size-xs)',
  cursor: 'pointer',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-2xs)',
  fontWeight: 'var(--font-weight-semibold)',
  color: 'var(--color-fg-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 'var(--space-3)',
};

const metricCardStyle: React.CSSProperties = {
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-3)',
};

const thStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  textAlign: 'left',
  fontWeight: 'var(--font-weight-medium)',
  color: 'var(--color-fg-secondary)',
  borderBottom: '1px solid var(--color-border-default)',
};

const tdStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-3)',
  color: 'var(--color-fg-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '200px',
};
