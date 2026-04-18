import React, { useState, useEffect, useCallback, useRef } from 'react';

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

type StepType = 'navigate' | 'click' | 'type' | 'wait' | 'scroll' | 'keypress';

interface RecordedStep {
  id: string;
  type: StepType;
  target?: string;
  value?: string;
  timestamp: number;
  elapsedMs: number;
}

const STEP_ICONS: Record<StepType, string> = {
  navigate: '⇢',
  click: '◎',
  type: '⌨',
  wait: '◔',
  scroll: '↕',
  keypress: '⌥',
};

const STEP_COLOR: Record<StepType, string> = {
  navigate: '#7cacf8',
  click: '#4ade80',
  type: '#f7c948',
  wait: 'var(--color-fg-tertiary)',
  scroll: '#c792ea',
  keypress: '#f87171',
};

let stepIdCounter = 0;

function generateStepId(): string {
  return `step-${Date.now()}-${stepIdCounter++}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export function RecorderPanel({ cdpSend, onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [isRecording, setIsRecording] = useState(false);
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const recordingStartRef = useRef<number>(0);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const listenerActiveRef = useRef(false);

  // ── elapsed timer ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (isRecording) {
      elapsedIntervalRef.current = setInterval(() => {
        setElapsed(Date.now() - recordingStartRef.current);
      }, 100);
    } else {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
    }
    return () => {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
      }
    };
  }, [isRecording]);

  // ── CDP event listener for recording ─────────────────────────────────────

  const startListening = useCallback(() => {
    if (listenerActiveRef.current) return;
    listenerActiveRef.current = true;

    console.log('[RecorderPanel] subscribing to CDP events for recording');
    const unsubscribe = onCdpEvent((method, params) => {
      if (!listenerActiveRef.current) return;
      const p = params as Record<string, unknown>;
      const now = Date.now();
      const elapsed = now - recordingStartRef.current;

      if (method === 'Page.frameNavigated') {
        const frame = p.frame as Record<string, unknown> | undefined;
        const url = (frame?.url as string) ?? '';
        console.log('[RecorderPanel] Page.frameNavigated:', url);

        setSteps((prev) => [
          ...prev,
          {
            id: generateStepId(),
            type: 'navigate',
            value: url,
            timestamp: now,
            elapsedMs: elapsed,
          },
        ]);
      }
    });

    unsubscribeRef.current = unsubscribe;
  }, [onCdpEvent]);

  const stopListening = useCallback(() => {
    listenerActiveRef.current = false;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    console.log('[RecorderPanel] unsubscribed from CDP events');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  // ── inject DOM listeners into the page via Runtime.evaluate ───────────────

  const injectPageListeners = useCallback(async () => {
    console.log('[RecorderPanel] injecting page-side event listeners');

    const injectionScript = `
      (function() {
        if (window.__recorderInjected__) return;
        window.__recorderInjected__ = true;

        function getSelector(el) {
          if (!el || el === document.body) return 'body';
          if (el.id) return '#' + el.id;
          const tag = el.tagName.toLowerCase();
          const cls = Array.from(el.classList).slice(0, 2).join('.');
          return cls ? tag + '.' + cls : tag;
        }

        document.addEventListener('click', function(e) {
          const sel = getSelector(e.target);
          window.__recorder_last_click__ = { selector: sel, ts: Date.now() };
          console.debug('[Recorder:click]', sel);
        }, true);

        document.addEventListener('input', function(e) {
          const sel = getSelector(e.target);
          const val = e.target.value;
          window.__recorder_last_input__ = { selector: sel, value: val, ts: Date.now() };
          console.debug('[Recorder:input]', sel, val);
        }, true);

        document.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
            window.__recorder_last_key__ = { key: e.key, ts: Date.now() };
            console.debug('[Recorder:keydown]', e.key);
          }
        }, true);

        document.addEventListener('scroll', function(e) {
          window.__recorder_last_scroll__ = { x: window.scrollX, y: window.scrollY, ts: Date.now() };
        }, { passive: true, capture: true });
      })();
    `;

    try {
      await cdpSend('Runtime.evaluate', { expression: injectionScript });
      console.log('[RecorderPanel] page listeners injected');
    } catch (err) {
      console.warn('[RecorderPanel] injectPageListeners failed:', err);
    }
  }, [cdpSend]);

  // Poll for click/input events from the page
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingInProgressRef = useRef(false);
  const lastClickTsRef = useRef<number>(0);
  const lastInputTsRef = useRef<number>(0);
  const lastKeyTsRef = useRef<number>(0);
  const lastScrollTsRef = useRef<number>(0);

  const pollPageEvents = useCallback(async () => {
    if (pollingInProgressRef.current) return;
    pollingInProgressRef.current = true;
    try {
      const clickResp = await cdpSend('Runtime.evaluate', {
        expression: 'window.__recorder_last_click__ ? JSON.stringify(window.__recorder_last_click__) : null',
        returnByValue: true,
      });
      const clickJson = (clickResp.result as any)?.result?.value as string | null;
      if (clickJson) {
        const click = JSON.parse(clickJson) as { selector: string; ts: number };
        if (click.ts > lastClickTsRef.current) {
          lastClickTsRef.current = click.ts;
          const elapsed = click.ts - recordingStartRef.current;
          console.log('[RecorderPanel] captured click:', click.selector);
          setSteps((prev) => [
            ...prev,
            { id: generateStepId(), type: 'click', target: click.selector, timestamp: click.ts, elapsedMs: elapsed },
          ]);
        }
      }

      const inputResp = await cdpSend('Runtime.evaluate', {
        expression: 'window.__recorder_last_input__ ? JSON.stringify(window.__recorder_last_input__) : null',
        returnByValue: true,
      });
      const inputJson = (inputResp.result as any)?.result?.value as string | null;
      if (inputJson) {
        const input = JSON.parse(inputJson) as { selector: string; value: string; ts: number };
        if (input.ts > lastInputTsRef.current) {
          lastInputTsRef.current = input.ts;
          const elapsed = input.ts - recordingStartRef.current;
          console.log('[RecorderPanel] captured input:', input.selector, 'value:', input.value);
          setSteps((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === 'type' && last.target === input.selector) {
              return [
                ...prev.slice(0, -1),
                { ...last, value: input.value, timestamp: input.ts, elapsedMs: elapsed },
              ];
            }
            return [
              ...prev,
              { id: generateStepId(), type: 'type', target: input.selector, value: input.value, timestamp: input.ts, elapsedMs: elapsed },
            ];
          });
        }
      }

      const keyResp = await cdpSend('Runtime.evaluate', {
        expression: 'window.__recorder_last_key__ ? JSON.stringify(window.__recorder_last_key__) : null',
        returnByValue: true,
      });
      const keyJson = (keyResp.result as any)?.result?.value as string | null;
      if (keyJson) {
        const key = JSON.parse(keyJson) as { key: string; ts: number };
        if (key.ts > lastKeyTsRef.current) {
          lastKeyTsRef.current = key.ts;
          const elapsed = key.ts - recordingStartRef.current;
          console.log('[RecorderPanel] captured keypress:', key.key);
          setSteps((prev) => [
            ...prev,
            { id: generateStepId(), type: 'keypress', value: key.key, timestamp: key.ts, elapsedMs: elapsed },
          ]);
        }
      }

      const scrollResp = await cdpSend('Runtime.evaluate', {
        expression: 'window.__recorder_last_scroll__ ? JSON.stringify(window.__recorder_last_scroll__) : null',
        returnByValue: true,
      });
      const scrollJson = (scrollResp.result as any)?.result?.value as string | null;
      if (scrollJson) {
        const scroll = JSON.parse(scrollJson) as { x: number; y: number; ts: number };
        if (scroll.ts > lastScrollTsRef.current) {
          lastScrollTsRef.current = scroll.ts;
          const elapsed = scroll.ts - recordingStartRef.current;
          setSteps((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === 'scroll') {
              return [
                ...prev.slice(0, -1),
                { ...last, value: `${scroll.x},${scroll.y}`, timestamp: scroll.ts, elapsedMs: elapsed },
              ];
            }
            return [
              ...prev,
              { id: generateStepId(), type: 'scroll', value: `${scroll.x},${scroll.y}`, timestamp: scroll.ts, elapsedMs: elapsed },
            ];
          });
        }
      }
    } catch {
      // Page may have navigated — silently ignore
    } finally {
      pollingInProgressRef.current = false;
    }
  }, [cdpSend]);

  // ── start / stop recording ────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (!isAttached) return;
    console.log('[RecorderPanel] starting recording');
    setError(null);

    try {
      await cdpSend('DOM.enable');
      await cdpSend('Page.enable');
      console.log('[RecorderPanel] DOM + Page domains enabled');

      recordingStartRef.current = Date.now();
      lastClickTsRef.current = recordingStartRef.current;
      lastInputTsRef.current = recordingStartRef.current;
      lastKeyTsRef.current = recordingStartRef.current;
      lastScrollTsRef.current = recordingStartRef.current;

      setIsRecording(true);
      startListening();
      await injectPageListeners();

      pollingIntervalRef.current = setInterval(() => {
        void pollPageEvents();
      }, 500);
    } catch (err) {
      console.error('[RecorderPanel] startRecording failed:', err);
      setError(String(err));
    }
  }, [isAttached, cdpSend, startListening, injectPageListeners, pollPageEvents]);

  const stopRecording = useCallback(() => {
    console.log('[RecorderPanel] stopping recording');
    setIsRecording(false);
    stopListening();

    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    void cdpSend('DOM.disable').catch(() => {});
    void cdpSend('Page.disable').catch(() => {});
  }, [cdpSend, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // ── replay ─────────────────────────────────────────────────────────────────

  const replaySteps = useCallback(async () => {
    if (steps.length === 0 || replaying) return;
    console.log('[RecorderPanel] starting replay of', steps.length, 'steps');
    setReplaying(true);
    setError(null);

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        setReplayIndex(i);
        console.log('[RecorderPanel] replaying step', i, step.type, step.target ?? step.value ?? '');

        switch (step.type) {
          case 'navigate': {
            const url = step.value ?? '';
            if (url) {
              const resp = await cdpSend('Page.navigate', { url });
              if (!resp.success) console.warn('[RecorderPanel] Page.navigate failed:', resp.error);
              // Wait for load
              await new Promise((res) => setTimeout(res, 1500));
              // Re-inject listeners after navigation
              await injectPageListeners();
            }
            break;
          }

          case 'click': {
            const selector = step.target ?? '';
            if (selector) {
              // Use Runtime.evaluate to click the element
              const resp = await cdpSend('Runtime.evaluate', {
                expression: `
                  (function() {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (el) {
                      el.click();
                      return true;
                    }
                    return false;
                  })()
                `,
                returnByValue: true,
              });
              const clicked = (resp.result as any)?.result?.value as boolean;
              console.log('[RecorderPanel] click replay result:', clicked, 'for selector:', selector);
            }
            break;
          }

          case 'type': {
            const selector = step.target ?? '';
            const value = step.value ?? '';
            if (selector && value) {
              await cdpSend('Runtime.evaluate', {
                expression: `
                  (function() {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (el) {
                      el.focus();
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                      if (nativeInputValueSetter) {
                        nativeInputValueSetter.call(el, ${JSON.stringify(value)});
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                      } else {
                        el.value = ${JSON.stringify(value)};
                      }
                      return true;
                    }
                    return false;
                  })()
                `,
                returnByValue: true,
              });
              console.log('[RecorderPanel] type replay done for selector:', selector);
            }
            break;
          }

          case 'keypress': {
            const key = step.value ?? '';
            if (key) {
              await cdpSend('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key,
                code: key === 'Enter' ? 'Enter' : key === 'Tab' ? 'Tab' : key === 'Escape' ? 'Escape' : key,
                windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0,
              });
              await cdpSend('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key,
                code: key === 'Enter' ? 'Enter' : key === 'Tab' ? 'Tab' : key === 'Escape' ? 'Escape' : key,
                windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0,
              });
              console.log('[RecorderPanel] keypress replay done:', key);
            }
            break;
          }

          case 'scroll': {
            const parts = (step.value ?? '0,0').split(',');
            const x = parseInt(parts[0] ?? '0', 10);
            const y = parseInt(parts[1] ?? '0', 10);
            await cdpSend('Runtime.evaluate', { expression: `window.scrollTo(${x}, ${y})` });
            console.log('[RecorderPanel] scroll replay done:', x, y);
            break;
          }

          case 'wait':
            await new Promise((res) => setTimeout(res, parseInt(step.value ?? '500', 10)));
            break;
        }

        // Small delay between steps
        await new Promise((res) => setTimeout(res, 200));
      }

      console.log('[RecorderPanel] replay complete');
    } catch (err) {
      console.error('[RecorderPanel] replay failed:', err);
      setError(String(err));
    } finally {
      setReplaying(false);
      setReplayIndex(null);
    }
  }, [steps, replaying, cdpSend, injectPageListeners]);

  // ── export ────────────────────────────────────────────────────────────────

  const exportRecording = useCallback(() => {
    console.log('[RecorderPanel] exporting recording as JSON');
    const data = JSON.stringify({ version: 1, steps, exportedAt: new Date().toISOString() }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [steps]);

  // ── step management ────────────────────────────────────────────────────────

  const deleteStep = useCallback((id: string) => {
    console.log('[RecorderPanel] deleting step:', id);
    setSteps((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const moveStep = useCallback((id: string, direction: 'up' | 'down') => {
    console.log('[RecorderPanel] moving step', id, direction);
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= next.length) return prev;
      [next[idx], next[swapIdx]] = [next[swapIdx]!, next[idx]!];
      return next;
    });
  }, []);

  const clearSteps = useCallback(() => {
    console.log('[RecorderPanel] clearing all steps');
    setSteps([]);
    setError(null);
  }, []);

  // ── render ────────────────────────────────────────────────────────────────

  if (!isAttached) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Not attached</div>
        <div className="panel-placeholder-desc">Attach to a tab to start recording user flows.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
          flexShrink: 0,
          backgroundColor: 'var(--color-bg-elevated)',
        }}
      >
        {!isRecording ? (
          <button
            className="devtools-connect-btn"
            onClick={() => void startRecording()}
            disabled={replaying}
            style={{
              padding: 'var(--space-2) var(--space-5)',
              fontSize: 'var(--font-size-xs)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
            }}
          >
            <span style={{ color: 'var(--color-status-error)', fontSize: '10px' }}>●</span>
            Start Recording
          </button>
        ) : (
          <button
            onClick={stopRecording}
            style={{
              padding: 'var(--space-2) var(--space-5)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-status-error)',
              border: '1px solid var(--color-status-error)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: '10px' }}>■</span>
            Stop Recording
          </button>
        )}

        {steps.length > 0 && (
          <>
            <button
              className="devtools-connect-btn"
              onClick={() => void replaySteps()}
              disabled={replaying || isRecording}
              style={{ padding: 'var(--space-2) var(--space-5)', fontSize: 'var(--font-size-xs)' }}
            >
              {replaying ? 'Replaying...' : 'Replay'}
            </button>
            <button className="console-clear-btn" onClick={exportRecording} disabled={isRecording || replaying}>
              Export
            </button>
            <button className="console-clear-btn" onClick={clearSteps} disabled={isRecording || replaying}>
              Clear
            </button>
          </>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-4)', fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {isRecording && (
            <span style={{ color: 'var(--color-status-error)' }}>
              ● {formatElapsed(elapsed)}
            </span>
          )}
          <span>{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-status-error)', fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)', borderBottom: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* Recording indicator */}
      {isRecording && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-4)',
            backgroundColor: 'rgba(248, 113, 113, 0.08)',
            borderBottom: '1px solid rgba(248, 113, 113, 0.2)',
            flexShrink: 0,
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-status-error)',
          }}
        >
          <span style={{ animation: 'none' }}>●</span>
          Recording in progress — interact with the page to capture steps
        </div>
      )}

      {/* Steps list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {steps.length === 0 ? (
          <div className="panel-placeholder" style={{ height: '300px' }}>
            <div className="panel-placeholder-icon">●</div>
            <div className="panel-placeholder-title">No steps recorded</div>
            <div className="panel-placeholder-desc">
              Click "Start Recording" then interact with the page. Navigation, clicks, and typing will be captured.
            </div>
          </div>
        ) : (
          steps.map((step, i) => (
            <div
              key={step.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-3)',
                padding: 'var(--space-2) var(--space-4)',
                borderBottom: '1px solid var(--color-border-subtle)',
                backgroundColor: replayIndex === i ? 'var(--color-accent-muted)' : 'transparent',
              }}
            >
              {/* Step number */}
              <span
                style={{
                  flexShrink: 0,
                  width: '24px',
                  textAlign: 'right',
                  fontSize: 'var(--font-size-2xs)',
                  color: 'var(--color-fg-tertiary)',
                  fontFamily: 'var(--font-mono)',
                  paddingTop: '1px',
                }}
              >
                {i + 1}
              </span>

              {/* Step icon */}
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 'var(--font-size-sm)',
                  color: STEP_COLOR[step.type],
                  width: '20px',
                  textAlign: 'center',
                }}
              >
                {STEP_ICONS[step.type]}
              </span>

              {/* Step content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span
                    style={{
                      fontSize: 'var(--font-size-2xs)',
                      fontWeight: 'var(--font-weight-semibold)',
                      color: STEP_COLOR[step.type],
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {step.type}
                  </span>
                  {step.target && (
                    <span
                      style={{
                        fontSize: 'var(--font-size-xs)',
                        fontFamily: 'var(--font-mono)',
                        color: '#c792ea',
                      }}
                    >
                      {truncate(step.target, 60)}
                    </span>
                  )}
                </div>
                {step.value && (
                  <div
                    style={{
                      marginTop: 'var(--space-1)',
                      fontSize: 'var(--font-size-xs)',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-fg-secondary)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {truncate(step.value, 120)}
                  </div>
                )}
                <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  +{formatElapsed(step.elapsedMs)}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
                <button
                  className="console-clear-btn"
                  onClick={() => moveStep(step.id, 'up')}
                  disabled={i === 0 || replaying}
                  style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--font-size-2xs)' }}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="console-clear-btn"
                  onClick={() => moveStep(step.id, 'down')}
                  disabled={i === steps.length - 1 || replaying}
                  style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--font-size-2xs)' }}
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  className="console-clear-btn"
                  onClick={() => deleteStep(step.id)}
                  disabled={replaying || isRecording}
                  style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--font-size-2xs)', color: 'var(--color-status-error)' }}
                  title="Delete step"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
