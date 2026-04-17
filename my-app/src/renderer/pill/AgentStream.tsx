/**
 * AgentStream — streaming log shown while an hl agent task runs.
 *
 * Entries are reduced from the hl event stream (thinking / tool_call /
 * tool_result / done / error). Latest-first rendering would be natural but
 * user expectation in a dynamic-island-style log is top-down-append, so we
 * show oldest → newest and the container scroll-snaps to the bottom.
 */

import React, { useEffect, useRef } from 'react';

export type StreamEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; argsPreview: string; ok?: boolean; resultPreview?: string; ms?: number };

export interface HlEventLike {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'task_started';
  text?: string;
  name?: string;
  args?: unknown;
  preview?: string;
  ok?: boolean;
  ms?: number;
  summary?: string;
  message?: string;
  iteration?: number;
}

const MAX_ENTRIES = 60;

function safePreview(x: unknown, max = 80): string {
  try {
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch { return String(x).slice(0, max); }
}

/** Reducer: push one hl event into the running entry list. */
export function applyHlEvent(entries: StreamEntry[], e: HlEventLike): StreamEntry[] {
  if (e.type === 'thinking' && e.text) {
    const entry: StreamEntry = { kind: 'thinking', text: e.text };
    return [...entries, entry].slice(-MAX_ENTRIES);
  }
  if (e.type === 'tool_call' && e.name) {
    const entry: StreamEntry = { kind: 'tool', name: e.name, argsPreview: safePreview(e.args) };
    return [...entries, entry].slice(-MAX_ENTRIES);
  }
  if (e.type === 'tool_result' && e.name) {
    // Patch the last matching tool entry without a result.
    const out = entries.slice();
    for (let i = out.length - 1; i >= 0; i--) {
      const en = out[i];
      if (en.kind === 'tool' && en.name === e.name && en.ok === undefined) {
        out[i] = { ...en, ok: e.ok ?? false, resultPreview: e.preview ?? '', ms: e.ms };
        return out;
      }
    }
    return entries;
  }
  return entries;
}

interface AgentStreamProps {
  entries: StreamEntry[];
  iteration: number;
  maxIterations: number;
  onStop: () => void;
}

export function AgentStream({ entries, iteration, maxIterations, onStop }: AgentStreamProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div className="pill-stream" data-testid="agent-stream">
      <div className="pill-stream-header">
        <span className="pill-spinner" aria-hidden="true">◐</span>
        <span>Agent running</span>
        <span className="pill-stream-step">{iteration}/{maxIterations}</span>
        <button type="button" className="pill-stream-stop" onClick={onStop} aria-label="Stop agent">Stop</button>
      </div>
      <div className="pill-stream-log" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="pill-stream-entry pill-stream-entry--thinking">Starting…</div>
        )}
        {entries.map((en, i) => {
          if (en.kind === 'thinking') {
            return <div key={i} className="pill-stream-entry pill-stream-entry--thinking">{en.text}</div>;
          }
          const status = en.ok === undefined ? '⋯' : en.ok ? '✓' : '✗';
          return (
            <div key={i} className={`pill-stream-entry pill-stream-entry--tool ${en.ok === false ? 'is-error' : ''}`}>
              <span className="pill-stream-tool-name">▶ {en.name}</span>
              <span className="pill-stream-tool-args">({en.argsPreview})</span>
              <div className="pill-stream-tool-result">
                <span className="pill-stream-tool-status">{status}</span>
                {en.resultPreview && <span className="pill-stream-tool-preview">{en.resultPreview}</span>}
                {typeof en.ms === 'number' && <span className="pill-stream-tool-ms">{en.ms}ms</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
