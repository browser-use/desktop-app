import React, { useState, useEffect, useCallback, useRef } from 'react';

// ---- Types ----------------------------------------------------------------

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

interface SnapshotSummary {
  id: number;
  takenAt: number;
  totalBytes: number;
  nodeCountsByType: Record<string, number>;
  rawChunkCount: number;
}

interface AllocationSample {
  id: number;
  size: number;
  count: number;
  ts: number;
}

interface GcStat {
  lastSeenObjectId: number;
  timestamp: number;
}

// ---- Constants ------------------------------------------------------------

const PANEL_TAG = '[MemoryPanel]';
let snapshotIdCounter = 0;
let allocationSampleIdCounter = 0;

// ---- Helpers ---------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function parseSnapshotNodes(raw: string): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const data = JSON.parse(raw) as {
      snapshot?: { meta?: { node_types?: unknown[] } };
      nodes?: number[];
      strings?: string[];
    };
    const meta = data.snapshot?.meta;
    const nodeTypes = meta?.node_types as string[][] | undefined;
    const nodeTypeList = nodeTypes?.[0] ?? [];
    const nodes = data.nodes ?? [];
    const strings = data.strings ?? [];
    // node fields: type, name, id, self_size, edge_count, trace_node_id, detachedness (7 fields per node)
    const NODE_FIELDS = 7;
    for (let i = 0; i < nodes.length; i += NODE_FIELDS) {
      const typeIndex = nodes[i];
      const typeName = nodeTypeList[typeIndex] ?? String(typeIndex);
      counts[typeName] = (counts[typeName] ?? 0) + 1;
    }
  } catch {
    // snapshot format not parseable — return empty
  }
  return counts;
}

// ---- Component -------------------------------------------------------------

export function MemoryPanel({ cdpSend, onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapshotProgress, setSnapshotProgress] = useState<number | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [allocationSamples, setAllocationSamples] = useState<AllocationSample[]>([]);
  const [gcStats, setGcStats] = useState<GcStat[]>([]);
  const chunkBufferRef = useRef<string>('');
  const chunkCountRef = useRef<number>(0);
  const currentSnapshotStartRef = useRef<number>(0);

  // Enable HeapProfiler on mount
  useEffect(() => {
    if (!isAttached) return;
    console.log(PANEL_TAG, 'enabling HeapProfiler domain');
    void cdpSend('HeapProfiler.enable').then((r) => {
      console.log(PANEL_TAG, 'HeapProfiler.enable result:', r);
    });

    return () => {
      console.log(PANEL_TAG, 'disabling HeapProfiler domain');
      void cdpSend('HeapProfiler.disable');
    };
  }, [isAttached, cdpSend]);

  // Subscribe to HeapProfiler events
  useEffect(() => {
    if (!isAttached) return;
    console.log(PANEL_TAG, 'subscribing to HeapProfiler events');

    const unsubscribe = onCdpEvent((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'HeapProfiler.addHeapSnapshotChunk') {
        const chunk = p.chunk as string;
        chunkBufferRef.current += chunk;
        chunkCountRef.current += 1;
        // Estimate progress by chunk size growth (rough heuristic)
        const approxProgress = Math.min(99, Math.floor((chunkBufferRef.current.length / 5000000) * 100));
        setSnapshotProgress(approxProgress);
        console.log(PANEL_TAG, 'snapshot chunk received, total chars:', chunkBufferRef.current.length);
      }

      if (method === 'HeapProfiler.reportHeapSnapshotProgress') {
        const done = p.done as number;
        const total = p.total as number;
        const finished = p.finished as boolean | undefined;
        if (total > 0) {
          const pct = Math.floor((done / total) * 100);
          setSnapshotProgress(pct);
          console.log(PANEL_TAG, 'snapshot progress:', pct, '%');
        }
        if (finished) {
          console.log(PANEL_TAG, 'snapshot complete, processing', chunkBufferRef.current.length, 'chars');
          finalizeSnapshot();
        }
      }

      if (method === 'HeapProfiler.heapStatsUpdate') {
        const statsUpdate = p.statsUpdate as number[] | undefined;
        if (!statsUpdate) return;
        // statsUpdate is an array: [startPosition, count, size, startPosition2, count2, size2, ...]
        let totalSize = 0;
        let totalCount = 0;
        for (let i = 0; i < statsUpdate.length; i += 3) {
          totalCount += statsUpdate[i + 1] ?? 0;
          totalSize += statsUpdate[i + 2] ?? 0;
        }
        console.log(PANEL_TAG, 'heapStatsUpdate, size:', totalSize, 'count:', totalCount);
        const MAX_ALLOCATION_SAMPLES = 5000;
        setAllocationSamples((prev) => {
          const next = [...prev, { id: allocationSampleIdCounter++, size: totalSize, count: totalCount, ts: Date.now() }];
          return next.length > MAX_ALLOCATION_SAMPLES ? next.slice(-MAX_ALLOCATION_SAMPLES) : next;
        });
      }

      if (method === 'HeapProfiler.lastSeenObjectId') {
        const lastSeenObjectId = p.lastSeenObjectId as number;
        const timestamp = p.timestamp as number;
        console.log(PANEL_TAG, 'lastSeenObjectId:', lastSeenObjectId, 'ts:', timestamp);
        setGcStats((prev) => [...prev.slice(-99), { lastSeenObjectId, timestamp }]);
      }
    });

    return unsubscribe;
  }, [isAttached, onCdpEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  const finalizeSnapshot = useCallback(() => {
    const raw = chunkBufferRef.current;
    const chunkCount = chunkCountRef.current;
    const totalBytes = raw.length * 2; // rough UTF-16 estimate

    console.log(PANEL_TAG, 'finalizing snapshot, raw length:', raw.length, 'chunk count:', chunkCount);

    const nodeCountsByType = parseSnapshotNodes(raw);
    const summary: SnapshotSummary = {
      id: snapshotIdCounter++,
      takenAt: currentSnapshotStartRef.current,
      totalBytes,
      nodeCountsByType,
      rawChunkCount: chunkCount,
    };

    setSnapshots((prev) => [...prev, summary]);
    setSnapshotProgress(null);

    // Reset buffer for next snapshot
    chunkBufferRef.current = '';
    chunkCountRef.current = 0;
  }, []);

  const handleTakeSnapshot = useCallback(async () => {
    console.log(PANEL_TAG, 'taking heap snapshot');
    chunkBufferRef.current = '';
    chunkCountRef.current = 0;
    currentSnapshotStartRef.current = Date.now();
    setSnapshotProgress(0);

    try {
      await cdpSend('HeapProfiler.takeHeapSnapshot', { reportProgress: true, treatGlobalObjectsAsRoots: true });
      console.log(PANEL_TAG, 'takeHeapSnapshot command sent');
      // Finalization happens in the reportHeapSnapshotProgress finished=true handler,
      // but some implementations never send finished=true, so also finalize after command resolves.
      if (chunkBufferRef.current.length > 0) {
        finalizeSnapshot();
      }
    } catch (err) {
      console.error(PANEL_TAG, 'takeHeapSnapshot failed:', err);
      setSnapshotProgress(null);
    }
  }, [cdpSend, finalizeSnapshot]);

  const handleStartTracking = useCallback(async () => {
    console.log(PANEL_TAG, 'starting heap allocation tracking');
    setAllocationSamples([]);
    setIsTracking(true);
    try {
      await cdpSend('HeapProfiler.startTrackingHeapObjects', { trackAllocations: true });
      console.log(PANEL_TAG, 'startTrackingHeapObjects OK');
    } catch (err) {
      console.error(PANEL_TAG, 'startTrackingHeapObjects failed:', err);
      setIsTracking(false);
    }
  }, [cdpSend]);

  const handleStopTracking = useCallback(async () => {
    console.log(PANEL_TAG, 'stopping heap allocation tracking');
    try {
      await cdpSend('HeapProfiler.stopTrackingHeapObjects', { reportProgress: false });
      console.log(PANEL_TAG, 'stopTrackingHeapObjects OK');
    } catch (err) {
      console.error(PANEL_TAG, 'stopTrackingHeapObjects failed:', err);
    } finally {
      setIsTracking(false);
    }
  }, [cdpSend]);

  const handleCollectGarbage = useCallback(async () => {
    console.log(PANEL_TAG, 'requesting garbage collection');
    try {
      await cdpSend('HeapProfiler.collectGarbage');
      console.log(PANEL_TAG, 'collectGarbage OK');
    } catch (err) {
      console.error(PANEL_TAG, 'collectGarbage failed:', err);
    }
  }, [cdpSend]);

  if (!isAttached) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Not connected</div>
        <div className="panel-placeholder-desc">Attach to a tab to use the Memory panel.</div>
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
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() => void handleTakeSnapshot()}
          disabled={snapshotProgress !== null}
          style={actionBtnStyle}
        >
          {snapshotProgress !== null ? `Snapshotting... ${snapshotProgress}%` : 'Take Heap Snapshot'}
        </button>
        {!isTracking ? (
          <button onClick={() => void handleStartTracking()} style={actionBtnStyle}>
            Start Allocation Tracking
          </button>
        ) : (
          <button
            onClick={() => void handleStopTracking()}
            style={{ ...actionBtnStyle, background: 'var(--color-status-error)', color: '#fff' }}
          >
            Stop Allocation Tracking
          </button>
        )}
        <button onClick={() => void handleCollectGarbage()} style={secondaryBtnStyle}>
          Collect Garbage
        </button>
      </div>

      {/* Snapshot progress bar */}
      {snapshotProgress !== null && (
        <div style={{ flexShrink: 0, padding: '0 var(--space-4)', paddingTop: 'var(--space-2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)', fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-secondary)' }}>
            <span>Taking snapshot...</span>
            <span>{snapshotProgress}%</span>
          </div>
          <div style={{ height: '4px', background: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${snapshotProgress}%`,
                background: 'var(--color-accent-default)',
                borderRadius: 'var(--radius-full)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      )}

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>

        {/* Heap Snapshots */}
        <section>
          <div style={sectionHeaderStyle}>Heap Snapshots ({snapshots.length})</div>
          {snapshots.length === 0 ? (
            <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
              No snapshots yet. Click "Take Heap Snapshot" to capture one.
            </div>
          ) : (
            snapshots.map((snap) => (
              <div
                key={snap.id}
                style={{
                  background: 'var(--color-bg-sunken)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-3)',
                  marginBottom: 'var(--space-3)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
                  <span style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-primary)' }}>
                    Snapshot #{snap.id + 1}
                  </span>
                  <span style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
                    {new Date(snap.takenAt).toLocaleTimeString()}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-6)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>Total Size</div>
                    <div style={{ color: 'var(--color-fg-primary)', fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-weight-semibold)' }}>
                      {formatBytes(snap.totalBytes)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>Chunks Received</div>
                    <div style={{ color: 'var(--color-fg-primary)', fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-weight-semibold)' }}>
                      {snap.rawChunkCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>Node Types</div>
                    <div style={{ color: 'var(--color-fg-primary)', fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-weight-semibold)' }}>
                      {Object.keys(snap.nodeCountsByType).length}
                    </div>
                  </div>
                </div>
                {Object.keys(snap.nodeCountsByType).length > 0 && (
                  <div>
                    <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)', marginBottom: 'var(--space-2)' }}>
                      Node Counts by Type
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-mono)' }}>
                      <thead>
                        <tr>
                          <th style={thStyle}>Type</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(snap.nodeCountsByType)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 15)
                          .map(([type, count]) => (
                            <tr key={type} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                              <td style={tdStyle}>{type}</td>
                              <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--color-fg-secondary)' }}>{count.toLocaleString()}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))
          )}
        </section>

        {/* Allocation Timeline */}
        {(isTracking || allocationSamples.length > 0) && (
          <section>
            <div style={sectionHeaderStyle}>
              Allocation Timeline {isTracking && <span style={{ color: 'var(--color-status-error)' }}>● recording</span>}
            </div>
            {allocationSamples.length === 0 ? (
              <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
                Waiting for allocation data...
              </div>
            ) : (
              <div style={{ border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', maxHeight: '240px', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-mono)' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-bg-elevated)', position: 'sticky', top: 0 }}>
                      <th style={thStyle}>Time</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Total Size</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Object Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocationSamples.slice(-100).map((sample) => (
                      <tr key={sample.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                        <td style={tdStyle}>{new Date(sample.ts).toLocaleTimeString()}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--color-fg-secondary)' }}>
                          {formatBytes(sample.size)}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--color-fg-secondary)' }}>
                          {sample.count.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* GC Stats */}
        {gcStats.length > 0 && (
          <section>
            <div style={sectionHeaderStyle}>Garbage Collection ({gcStats.length} events)</div>
            <div style={{ border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', maxHeight: '200px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-mono)' }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-elevated)', position: 'sticky', top: 0 }}>
                    <th style={thStyle}>Last Object ID</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Timestamp (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {gcStats.slice(-50).map((stat, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                      <td style={tdStyle}>{stat.lastSeenObjectId.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--color-fg-secondary)' }}>
                        {stat.timestamp.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
};
