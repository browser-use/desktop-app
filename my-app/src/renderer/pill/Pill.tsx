/**
 * Pill — root component, dynamic-island style.
 *
 * Phases:
 *   idle        — input-only when empty; shows CommandPalette when the user types
 *   submitting  — dot pulses, stream placeholder
 *   running     — AgentStream renders tool_call / thinking / tool_result entries
 *   done/error  — ResultDisplay (unchanged from before)
 *
 * Two event streams feed this component:
 *   window.pillAPI.onEvent      — legacy AgentEvent from python-daemon engine
 *   window.pillAPI.hl.onEvent   — HlEvent stream from the in-process hl engine
 *
 * Both converge to the same state machine. Engine flag decides which stream
 * is authoritative for a given task_id (we accept either).
 *
 * Keyboard:
 *   typing          — filters palette rows
 *   ArrowDown / Up  — move palette active index
 *   Enter           — select active palette row (tab / agent); empty input still hides
 *   Escape          — hide pill
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PillInput } from './PillInput';
import { CommandPalette, buildRows, type PaletteRow } from './CommandPalette';
import { AgentStream, applyHlEvent, type StreamEntry, type HlEventLike } from './AgentStream';
import { ResultDisplay, type ResultState } from './ResultDisplay';
import type { AgentEvent } from '../../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 4000 as const;
const MAX_ITERATIONS = 25 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PillPhase = 'idle' | 'submitting' | 'running' | 'done' | 'error';
type PillDataState = 'idle' | 'focused' | 'streaming' | 'done' | 'error';

interface TabLite { id: string; url: string; title: string }

interface PillState {
  phase: PillPhase;
  inputValue: string;
  activeTaskId: string | null;
  streamEntries: StreamEntry[];
  streamIteration: number;
  result: ResultState | null;
  paletteTabs: TabLite[];
  activeTabId: string | null;
  paletteIndex: number;
}

const INITIAL_STATE: PillState = {
  phase: 'idle',
  inputValue: '',
  activeTaskId: null,
  streamEntries: [],
  streamIteration: 0,
  result: null,
  paletteTabs: [],
  activeTabId: null,
  paletteIndex: 0,
};

// ---------------------------------------------------------------------------
// Preload API surface
// ---------------------------------------------------------------------------

interface PillAPI {
  submit: (prompt: string) => Promise<{ task_id: string }>;
  cancel: (task_id: string) => Promise<{ ok: boolean }>;
  hide: () => void;
  // `boolean` collapses/expands to the default height; a `number` expands to
  // that exact pixel height (used for the palette's visible-rows layout).
  setExpanded: (expanded: boolean | number) => void;
  onEvent: (cb: (event: AgentEvent) => void) => () => void;
  onHideRequest: (cb: () => void) => () => void;
  onQueuedTask: (cb: (data: { prompt: string; task_id: string }) => void) => () => void;
  hl: {
    onEvent: (cb: (payload: { task_id: string; event: HlEventLike }) => void) => () => void;
    getEngine: () => Promise<'python-daemon' | 'hl-inprocess'>;
    setEngine: (e: 'python-daemon' | 'hl-inprocess') => Promise<'python-daemon' | 'hl-inprocess'>;
  };
  tabs: {
    getState: () => Promise<{ tabs: TabLite[]; activeTabId: string | null }>;
    activate: (tab_id: string) => Promise<void>;
  };
}

declare global { interface Window { pillAPI: PillAPI } }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeDataState(phase: PillPhase, isFocused: boolean): PillDataState {
  switch (phase) {
    case 'idle': return isFocused ? 'focused' : 'idle';
    case 'submitting':
    case 'running': return 'streaming';
    case 'done': return 'done';
    case 'error': return 'error';
  }
}

function LeadingDot({ state }: { state: PillDataState }): React.ReactElement {
  if (state === 'done') {
    return (
      <span className="pill-result-lead-icon pill-result-lead-icon--done" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.5 7.5L6.5 9.5L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="pill-result-lead-icon pill-result-lead-icon--error" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 4.5V7.5M7 9V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span className="pill-dot" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Map legacy AgentEvent → HlEventLike so a single reducer drives the stream.
// ---------------------------------------------------------------------------
function agentEventToHl(ev: AgentEvent): HlEventLike | null {
  switch (ev.event) {
    case 'task_started': return { type: 'task_started' };
    case 'step_start':   return { type: 'tool_call', name: `step-${ev.step}`, args: ev.plan };
    case 'step_result':  return { type: 'tool_result', name: `step-${ev.step}`, ok: true, preview: String(ev.result ?? '') };
    case 'step_error':   return { type: 'tool_result', name: `step-${ev.step}`, ok: false, preview: ev.error.message };
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Pill(): React.ReactElement {
  const [state, setState] = useState<PillState>(INITIAL_STATE);
  const [isFocused, setIsFocused] = useState(false);
  const stateRef = useRef<PillState>(state);
  stateRef.current = state;

  const dataState = computeDataState(state.phase, isFocused);
  const paletteRows = buildRows(state.inputValue, state.paletteTabs);

  // -------------------------------------------------------------------------
  // Expanded-window sync: grow the frame when we're showing palette / stream /
  // result, collapse back to the input-only height when idle+empty.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const shouldExpand =
      state.phase !== 'idle' ||
      paletteRows.length > 0;
    if (!shouldExpand) {
      window.pillAPI.setExpanded(false);
    } else if (state.phase === 'idle' && paletteRows.length > 0) {
      const rowHeight = 40;
      const visibleRows = Math.min(paletteRows.length, 6);
      const height = 62 + 1 + 12 + (visibleRows * rowHeight) + 4;
      window.pillAPI.setExpanded(height);
    } else {
      window.pillAPI.setExpanded(true);
    }
  }, [state.phase, paletteRows.length]);

  // -------------------------------------------------------------------------
  // Palette tab list — refresh on mount + whenever the input gains focus.
  // -------------------------------------------------------------------------
  const refreshTabs = useCallback(async () => {
    try {
      const { tabs, activeTabId } = await window.pillAPI.tabs.getState();
      setState((prev) => ({ ...prev, paletteTabs: tabs, activeTabId }));
    } catch { /* pill might load before tabs are ready — ignore */ }
  }, []);

  useEffect(() => { void refreshTabs(); }, [refreshTabs]);

  // -------------------------------------------------------------------------
  // Event streams
  // -------------------------------------------------------------------------
  useEffect(() => {
    const unsubHl = window.pillAPI.hl.onEvent(({ task_id, event }) => {
      setState((prev) => applyIncoming(prev, task_id, event));
    });

    const unsubLegacy = window.pillAPI.onEvent((event) => {
      const hl = agentEventToHl(event);
      if (hl) setState((prev) => applyIncoming(prev, event.task_id, hl));
      // Legacy terminal events drive done/error directly.
      if (event.event === 'task_done') {
        setState((prev) => ({ ...prev, phase: 'done', result: { kind: 'done', result: event.result, stepsUsed: event.steps_used, tokensUsed: event.tokens_used } }));
      } else if (event.event === 'task_failed') {
        setState((prev) => ({ ...prev, phase: 'error', result: { kind: 'failed', reason: event.reason } }));
      } else if (event.event === 'target_lost') {
        setState((prev) => ({ ...prev, phase: 'error', result: { kind: 'target_lost' } }));
      } else if (event.event === 'task_cancelled') {
        setState((prev) => ({ ...prev, phase: 'error', result: { kind: 'cancelled' } }));
      }
    });

    const unsubHide = window.pillAPI.onHideRequest(() => setState(INITIAL_STATE));

    return () => { unsubHl(); unsubLegacy(); unsubHide(); };
  }, []);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const runAgent = useCallback(async (prompt: string) => {
    setState((prev) => ({
      ...prev,
      phase: 'submitting',
      inputValue: prompt,
      streamEntries: [],
      streamIteration: 0,
      result: null,
      paletteIndex: 0,
    }));
    setIsFocused(false);
    try {
      const { task_id } = await window.pillAPI.submit(prompt);
      setState((prev) => ({ ...prev, activeTaskId: task_id }));
    } catch (err) {
      setState((prev) => ({ ...prev, phase: 'error', result: { kind: 'failed', reason: 'submit_error' } }));
    }
  }, []);

  const activateTab = useCallback(async (tab_id: string) => {
    await window.pillAPI.tabs.activate(tab_id);
    window.pillAPI.hide();
    setState(INITIAL_STATE);
    setIsFocused(false);
  }, []);

  const selectPaletteRow = useCallback((row: PaletteRow) => {
    if (row.kind === 'tab') void activateTab(row.tabId);
    else void runAgent(row.prompt);
  }, [activateTab, runAgent]);

  const handleSubmit = useCallback((prompt: string) => {
    const row = paletteRows[state.paletteIndex];
    if (row) selectPaletteRow(row);
    else void runAgent(prompt);
  }, [paletteRows, state.paletteIndex, selectPaletteRow, runAgent]);

  const handleEscape = useCallback(() => {
    setState(INITIAL_STATE);
    setIsFocused(false);
    window.pillAPI.hide();
  }, []);

  const handleDismiss = useCallback(() => {
    setState(INITIAL_STATE);
    setIsFocused(false);
    window.pillAPI.hide();
  }, []);

  const handleStop = useCallback(async () => {
    const t = stateRef.current.activeTaskId;
    if (t) await window.pillAPI.cancel(t);
    setState((prev) => ({ ...prev, phase: 'error', result: { kind: 'cancelled' } }));
  }, []);

  // Arrow-key nav over palette rows — container-level so it works while the
  // <input> has focus.
  const onKeyDownContainer = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (state.phase !== 'idle') return;
    if (paletteRows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setState((prev) => ({ ...prev, paletteIndex: (prev.paletteIndex + 1) % Math.max(1, paletteRows.length) }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setState((prev) => ({ ...prev, paletteIndex: (prev.paletteIndex - 1 + paletteRows.length) % Math.max(1, paletteRows.length) }));
    }
  }, [state.phase, paletteRows.length]);

  // -------------------------------------------------------------------------
  // Derived booleans
  // -------------------------------------------------------------------------
  const isInputDisabled = state.phase === 'submitting' || state.phase === 'running';
  const showPalette = state.phase === 'idle' && paletteRows.length > 0;
  const showStream  = state.phase === 'submitting' || state.phase === 'running';
  const showResult  = (state.phase === 'done' || state.phase === 'error') && state.result !== null;
  const showSubmitChip = state.phase === 'idle' && state.inputValue.trim().length > 0;
  const showCopyChip = state.phase === 'done';

  return (
    <div
      className="pill-container"
      data-state={dataState}
      data-phase={state.phase}
      data-testid="pill-container"
      onKeyDown={onKeyDownContainer}
      onFocus={() => { if (state.phase === 'idle') setIsFocused(true); }}
      onBlur={() => setIsFocused(false)}
    >
      <PillInput
        value={state.inputValue}
        onChange={(v) => setState((prev) => ({ ...prev, inputValue: v, paletteIndex: 0 }))}
        onSubmit={handleSubmit}
        onEscape={handleEscape}
        disabled={isInputDisabled}
        leadingSlot={<LeadingDot state={dataState} />}
        showSubmitChip={showSubmitChip}
        showCopyChip={showCopyChip}
      />

      {(showPalette || showStream || showResult) && <div className="pill-divider" aria-hidden="true" />}

      {showPalette && (
        <CommandPalette
          rows={paletteRows}
          activeIndex={state.paletteIndex}
          onSelect={selectPaletteRow}
          onHover={(i) => setState((prev) => ({ ...prev, paletteIndex: i }))}
        />
      )}

      {showStream && (
        <AgentStream
          entries={state.streamEntries}
          iteration={state.streamIteration}
          maxIterations={MAX_ITERATIONS}
          onStop={handleStop}
        />
      )}

      {showResult && state.result !== null && (
        <ResultDisplay state={state.result} onDismiss={handleDismiss} autoDismissMs={AUTO_DISMISS_MS} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure reducer: incoming hl event → updated pill state
// ---------------------------------------------------------------------------
function applyIncoming(prev: PillState, task_id: string, event: HlEventLike): PillState {
  if (prev.activeTaskId && task_id !== prev.activeTaskId) return prev;

  if (event.type === 'task_started') {
    return { ...prev, phase: 'running', activeTaskId: task_id, streamEntries: [], streamIteration: 0 };
  }
  if (event.type === 'done') {
    return { ...prev, phase: 'done', result: { kind: 'done', result: event.summary ?? '', stepsUsed: prev.streamIteration, tokensUsed: 0 } };
  }
  if (event.type === 'error') {
    const msg = event.message ?? 'error';
    if (msg === 'cancelled') return { ...prev, phase: 'error', result: { kind: 'cancelled' } };
    return { ...prev, phase: 'error', result: { kind: 'failed', reason: msg } };
  }
  // Non-terminal: update stream + iteration counter.
  const iteration = event.iteration ?? prev.streamIteration;
  return {
    ...prev,
    phase: 'running',
    streamEntries: applyHlEvent(prev.streamEntries, event),
    streamIteration: Math.max(prev.streamIteration, iteration),
  };
}
