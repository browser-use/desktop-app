import React, { useState, useEffect, useCallback, useRef } from 'react';

// ---- Types ----------------------------------------------------------------

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
}

interface Breakpoint {
  scriptId: string;
  lineNumber: number;
  breakpointId: string;
  url: string;
}

interface CallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  scopeChain: ScopeEntry[];
}

interface ScopeEntry {
  type: string;
  name?: string;
  object: { objectId?: string; description?: string; value?: unknown };
}

interface ScopeVariable {
  name: string;
  value: string;
}

interface WatchExpression {
  id: number;
  expression: string;
  result: string;
}

interface PausedState {
  callFrames: CallFrame[];
  reason: string;
}

// ---- Constants ------------------------------------------------------------

const PANEL_TAG = '[SourcesPanel]';
let watchIdCounter = 0;

// ---- Helpers ---------------------------------------------------------------

function displayUrl(url: string): string {
  if (!url) return '(anonymous)';
  try {
    const u = new URL(url);
    return u.pathname.split('/').pop() || u.pathname || url;
  } catch {
    return url.split('/').pop() || url;
  }
}

// ---- Component -------------------------------------------------------------

export function SourcesPanel({ cdpSend, onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [selectedScript, setSelectedScript] = useState<ScriptInfo | null>(null);
  const [sourceLines, setSourceLines] = useState<string[]>([]);
  const [loadingSource, setLoadingSource] = useState(false);
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([]);
  const [paused, setPaused] = useState<PausedState | null>(null);
  const [watchExpressions, setWatchExpressions] = useState<WatchExpression[]>([]);
  const [newWatchExpr, setNewWatchExpr] = useState('');
  const [scopeVars, setScopeVars] = useState<ScopeVariable[]>([]);
  const sourceViewRef = useRef<HTMLDivElement>(null);

  // Enable Debugger domain on mount
  useEffect(() => {
    if (!isAttached) return;
    console.log(PANEL_TAG, 'enabling Debugger domain');
    void cdpSend('Debugger.enable').then((r) => {
      console.log(PANEL_TAG, 'Debugger.enable result:', r);
    });
    void cdpSend('Runtime.enable').then((r) => {
      console.log(PANEL_TAG, 'Runtime.enable result:', r);
    });

    return () => {
      console.log(PANEL_TAG, 'disabling Debugger domain');
      void cdpSend('Debugger.disable');
    };
  }, [isAttached, cdpSend]);

  // Subscribe to CDP events
  useEffect(() => {
    if (!isAttached) return;
    console.log(PANEL_TAG, 'subscribing to CDP events');

    const unsubscribe = onCdpEvent((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Debugger.scriptParsed') {
        const url = (p.url as string) ?? '';
        const scriptId = p.scriptId as string;
        // Skip internal / extension scripts and empty URLs
        if (!url || url.startsWith('extensions::') || url.includes('chrome-extension://')) return;
        console.log(PANEL_TAG, 'scriptParsed:', scriptId, url);
        setScripts((prev) => {
          if (prev.some((s) => s.scriptId === scriptId)) return prev;
          return [...prev, { scriptId, url, sourceMapURL: p.sourceMapURL as string | undefined }];
        });
      }

      if (method === 'Debugger.paused') {
        const frames = (p.callFrames as CallFrame[]) ?? [];
        const reason = (p.reason as string) ?? 'breakpoint';
        console.log(PANEL_TAG, 'paused, reason:', reason, 'frames:', frames.length);
        setPaused({ callFrames: frames, reason });

        // Load scope variables from top frame
        const topFrame = frames[0];
        if (topFrame) {
          loadScopeVars(topFrame.scopeChain);
        }
      }

      if (method === 'Debugger.resumed') {
        console.log(PANEL_TAG, 'resumed');
        setPaused(null);
        setScopeVars([]);
      }
    });

    return unsubscribe;
  }, [isAttached, onCdpEvent]);

  const loadScopeVars = useCallback(
    async (scopeChain: ScopeEntry[]) => {
      const vars: ScopeVariable[] = [];
      for (const scope of scopeChain.slice(0, 3)) {
        if (!scope.object.objectId) continue;
        try {
          const r = await cdpSend('Runtime.getProperties', {
            objectId: scope.object.objectId,
            ownProperties: true,
          });
          const props = (r.result as { result?: Array<{ name: string; value?: { type: string; value?: unknown; description?: string } }> })?.result ?? [];
          for (const prop of props.slice(0, 20)) {
            const val = prop.value;
            if (!val) continue;
            const display = val.value !== undefined ? JSON.stringify(val.value) : val.description ?? `[${val.type}]`;
            vars.push({ name: prop.name, value: display });
          }
        } catch (err) {
          console.warn(PANEL_TAG, 'getProperties failed:', err);
        }
      }
      console.log(PANEL_TAG, 'loaded', vars.length, 'scope vars');
      setScopeVars(vars);
    },
    [cdpSend],
  );

  const handleSelectScript = useCallback(
    async (script: ScriptInfo) => {
      console.log(PANEL_TAG, 'selecting script:', script.scriptId, script.url);
      setSelectedScript(script);
      setLoadingSource(true);
      setSourceLines([]);
      try {
        const r = await cdpSend('Debugger.getScriptSource', { scriptId: script.scriptId });
        const src = (r.result as { scriptSource?: string })?.scriptSource ?? '';
        console.log(PANEL_TAG, 'loaded source, length:', src.length);
        setSourceLines(src.split('\n'));
      } catch (err) {
        console.error(PANEL_TAG, 'getScriptSource failed:', err);
        setSourceLines(['// Failed to load source']);
      } finally {
        setLoadingSource(false);
      }
    },
    [cdpSend],
  );

  const handleLineClick = useCallback(
    async (lineNumber: number) => {
      if (!selectedScript) return;
      const existing = breakpoints.find(
        (bp) => bp.scriptId === selectedScript.scriptId && bp.lineNumber === lineNumber,
      );
      if (existing) {
        console.log(PANEL_TAG, 'removing breakpoint:', existing.breakpointId);
        try {
          await cdpSend('Debugger.removeBreakpoint', { breakpointId: existing.breakpointId });
          setBreakpoints((prev) => prev.filter((bp) => bp.breakpointId !== existing.breakpointId));
        } catch (err) {
          console.error(PANEL_TAG, 'removeBreakpoint failed:', err);
        }
      } else {
        console.log(PANEL_TAG, 'setting breakpoint at line:', lineNumber, 'url:', selectedScript.url);
        try {
          const r = await cdpSend('Debugger.setBreakpointByUrl', {
            lineNumber,
            url: selectedScript.url,
            columnNumber: 0,
          });
          const bpId = (r.result as { breakpointId?: string })?.breakpointId;
          if (bpId) {
            setBreakpoints((prev) => [
              ...prev,
              { scriptId: selectedScript.scriptId, lineNumber, breakpointId: bpId, url: selectedScript.url },
            ]);
          }
        } catch (err) {
          console.error(PANEL_TAG, 'setBreakpointByUrl failed:', err);
        }
      }
    },
    [selectedScript, breakpoints, cdpSend],
  );

  const handleAddWatch = useCallback(async () => {
    const expr = newWatchExpr.trim();
    if (!expr) return;
    console.log(PANEL_TAG, 'evaluating watch expression:', expr);
    let result = '—';
    try {
      const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
      const res = (r.result as { result?: { value?: unknown; description?: string; type?: string }; exceptionDetails?: { text?: string } });
      if (res.exceptionDetails) {
        result = `Error: ${res.exceptionDetails.text ?? 'unknown'}`;
      } else if (res.result) {
        result = res.result.value !== undefined ? JSON.stringify(res.result.value) : res.result.description ?? `[${res.result.type}]`;
      }
    } catch (err) {
      result = String(err);
    }
    setWatchExpressions((prev) => [...prev, { id: watchIdCounter++, expression: expr, result }]);
    setNewWatchExpr('');
  }, [newWatchExpr, cdpSend]);

  const handleRemoveWatch = (id: number): void => {
    setWatchExpressions((prev) => prev.filter((w) => w.id !== id));
  };

  const handleResume = useCallback(async () => {
    console.log(PANEL_TAG, 'resuming execution');
    await cdpSend('Debugger.resume');
  }, [cdpSend]);

  const handleStepOver = useCallback(async () => {
    console.log(PANEL_TAG, 'step over');
    await cdpSend('Debugger.stepOver');
  }, [cdpSend]);

  const handleStepInto = useCallback(async () => {
    console.log(PANEL_TAG, 'step into');
    await cdpSend('Debugger.stepInto');
  }, [cdpSend]);

  const isBreakpointLine = (lineNumber: number): boolean => {
    if (!selectedScript) return false;
    return breakpoints.some((bp) => bp.scriptId === selectedScript.scriptId && bp.lineNumber === lineNumber);
  };

  if (!isAttached) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Not connected</div>
        <div className="panel-placeholder-desc">Attach to a tab to use the Sources panel.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
      {/* Left pane: file tree + sidebar controls */}
      <div
        style={{
          width: '220px',
          flexShrink: 0,
          borderRight: '1px solid var(--color-border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Script list */}
        <div
          style={{
            padding: 'var(--space-2) var(--space-3)',
            borderBottom: '1px solid var(--color-border-subtle)',
            fontSize: 'var(--font-size-2xs)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-fg-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Scripts ({scripts.length})
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {scripts.length === 0 ? (
            <div style={{ padding: 'var(--space-4)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
              Waiting for scripts...
            </div>
          ) : (
            scripts.map((s) => (
              <div
                key={s.scriptId}
                onClick={() => void handleSelectScript(s)}
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  cursor: 'pointer',
                  color: selectedScript?.scriptId === s.scriptId ? 'var(--color-accent-default)' : 'var(--color-fg-primary)',
                  backgroundColor: selectedScript?.scriptId === s.scriptId ? 'var(--color-accent-muted)' : 'transparent',
                  borderRadius: 'var(--radius-xs)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 'var(--font-size-2xs)',
                }}
                title={s.url}
              >
                {displayUrl(s.url)}
              </div>
            ))
          )}
        </div>

        {/* Breakpoints list */}
        <div style={{ borderTop: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
          <div
            style={{
              padding: 'var(--space-2) var(--space-3)',
              fontSize: 'var(--font-size-2xs)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-fg-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Breakpoints
          </div>
          <div style={{ maxHeight: '120px', overflowY: 'auto' }}>
            {breakpoints.length === 0 ? (
              <div style={{ padding: 'var(--space-2) var(--space-3)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
                None set
              </div>
            ) : (
              breakpoints.map((bp) => (
                <div
                  key={bp.breakpointId}
                  style={{
                    padding: 'var(--space-1) var(--space-3)',
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-fg-primary)',
                    display: 'flex',
                    gap: 'var(--space-2)',
                  }}
                >
                  <span style={{ color: '#f87171' }}>◉</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayUrl(bp.url)}:{bp.lineNumber + 1}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Watch expressions */}
        <div style={{ borderTop: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
          <div
            style={{
              padding: 'var(--space-2) var(--space-3)',
              fontSize: 'var(--font-size-2xs)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-fg-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Watch
          </div>
          <div style={{ maxHeight: '100px', overflowY: 'auto' }}>
            {watchExpressions.map((w) => (
              <div
                key={w.id}
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  fontSize: 'var(--font-size-2xs)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--space-2)',
                }}
              >
                <span style={{ color: '#c792ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.expression}</span>
                <span style={{ color: 'var(--color-fg-secondary)', flexShrink: 0 }}>{w.result}</span>
                <span
                  style={{ color: 'var(--color-fg-tertiary)', cursor: 'pointer', flexShrink: 0 }}
                  onClick={() => handleRemoveWatch(w.id)}
                >
                  ✕
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', padding: 'var(--space-1) var(--space-3)', gap: 'var(--space-2)' }}>
            <input
              value={newWatchExpr}
              onChange={(e) => setNewWatchExpr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddWatch(); }}
              placeholder="Add expression..."
              style={{
                flex: 1,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-1) var(--space-2)',
                fontSize: 'var(--font-size-2xs)',
                color: 'var(--color-fg-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            />
            <button
              onClick={() => void handleAddWatch()}
              style={{
                padding: '0 var(--space-2)',
                background: 'var(--color-accent-default)',
                color: 'var(--color-fg-inverse)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-2xs)',
                cursor: 'pointer',
              }}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Center pane: source viewer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Debugger controls when paused */}
        {paused && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              padding: 'var(--space-2) var(--space-4)',
              background: 'rgba(245,158,11,0.08)',
              borderBottom: '1px solid var(--color-status-warning)',
              flexShrink: 0,
            }}
          >
            <span style={{ color: 'var(--color-status-warning)', fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)' }}>
              Paused: {paused.reason}
            </span>
            <button onClick={() => void handleResume()} style={debugBtnStyle}>Resume</button>
            <button onClick={() => void handleStepOver()} style={debugBtnStyle}>Step Over</button>
            <button onClick={() => void handleStepInto()} style={debugBtnStyle}>Step Into</button>
          </div>
        )}

        {/* Source code viewer */}
        <div ref={sourceViewRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', position: 'relative' }}>
          {!selectedScript ? (
            <div className="panel-placeholder">
              <div className="panel-placeholder-title" style={{ fontSize: 'var(--font-size-sm)' }}>
                Select a script to view its source
              </div>
            </div>
          ) : loadingSource ? (
            <div className="panel-placeholder">
              <div className="panel-placeholder-title" style={{ fontSize: 'var(--font-size-sm)' }}>Loading...</div>
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <tbody>
                {sourceLines.map((line, idx) => {
                  const lineNum = idx; // 0-based to match CDP
                  const hasBp = isBreakpointLine(lineNum);
                  return (
                    <tr
                      key={idx}
                      style={{
                        background: hasBp ? 'rgba(248,113,113,0.12)' : 'transparent',
                      }}
                    >
                      <td
                        onClick={() => void handleLineClick(lineNum)}
                        style={{
                          width: '48px',
                          minWidth: '48px',
                          textAlign: 'right',
                          paddingRight: 'var(--space-3)',
                          paddingLeft: 'var(--space-2)',
                          color: hasBp ? '#f87171' : 'var(--color-fg-tertiary)',
                          fontSize: 'var(--font-size-2xs)',
                          cursor: 'pointer',
                          userSelect: 'none',
                          borderRight: '1px solid var(--color-border-subtle)',
                          verticalAlign: 'top',
                        }}
                      >
                        {hasBp ? '◉' : idx + 1}
                      </td>
                      <td
                        style={{
                          paddingLeft: 'var(--space-4)',
                          paddingRight: 'var(--space-4)',
                          color: 'var(--color-fg-primary)',
                          whiteSpace: 'pre',
                          verticalAlign: 'top',
                          fontSize: 'var(--font-size-xs)',
                        }}
                      >
                        {line}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Right pane: call stack + scope when paused */}
      {paused && (
        <div
          style={{
            width: '220px',
            flexShrink: 0,
            borderLeft: '1px solid var(--color-border-default)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            fontSize: 'var(--font-size-2xs)',
          }}
        >
          <div
            style={{
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-border-subtle)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-fg-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Call Stack
          </div>
          <div style={{ maxHeight: '160px', overflowY: 'auto' }}>
            {paused.callFrames.map((frame, i) => (
              <div
                key={frame.callFrameId}
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  color: i === 0 ? 'var(--color-accent-default)' : 'var(--color-fg-primary)',
                  borderBottom: '1px solid var(--color-border-subtle)',
                }}
              >
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {frame.functionName || '(anonymous)'}
                </div>
                <div style={{ color: 'var(--color-fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayUrl(frame.url)}:{frame.lineNumber + 1}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-border-subtle)',
              borderTop: '1px solid var(--color-border-subtle)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-fg-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Scope
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {scopeVars.length === 0 ? (
              <div style={{ padding: 'var(--space-2) var(--space-3)', color: 'var(--color-fg-tertiary)' }}>
                No variables
              </div>
            ) : (
              scopeVars.map((v, i) => (
                <div key={i} style={{ padding: 'var(--space-1) var(--space-3)', display: 'flex', gap: 'var(--space-2)', justifyContent: 'space-between' }}>
                  <span style={{ color: '#c792ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                  <span style={{ color: '#c3e88d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px' }}>{v.value}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Shared style for debugger control buttons
const debugBtnStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-3)',
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--color-fg-primary)',
  fontSize: 'var(--font-size-2xs)',
  cursor: 'pointer',
};
