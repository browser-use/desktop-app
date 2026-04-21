import React, { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { useHydrateSession } from './useSessionsQuery';
import { STATUS_LABEL } from './constants';
import { ContentRenderer, getPreview } from './ContentRenderer';
import { adaptSession } from './types';
import type { AgentSession, OutputEntry } from './types';

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('credit balance is too low') || lower.includes('insufficient_quota')) return 'API credits exhausted. Please add credits to your Anthropic account.';
  if (lower.includes('invalid_api_key') || lower.includes('no api key')) return 'No API key configured. Add your key in Settings.';
  if (lower.includes('rate_limit') || lower.includes('rate limit')) return 'Rate limited. Too many requests — try again in a moment.';
  if (lower.includes('overloaded') || lower.includes('529')) return 'API is overloaded. Try again shortly.';
  if (lower.includes('cancelled')) return 'Task was cancelled.';
  if (lower.includes('app exited unexpectedly')) return 'App exited unexpectedly during this task.';
  if (lower.includes('cdp') || lower.includes('browser session expired')) return 'Browser session expired. Start a new task.';
  return raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function BrowseIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 5.5h11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CodeIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M5 4L2 7l3 3M9 4l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CameraIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="3.5" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function NetworkIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 7h11M7 1.5c-2 2-2 5 0 5s2 3 0 5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M8 1.5H4a1.5 1.5 0 00-1.5 1.5v8A1.5 1.5 0 004 12.5h6a1.5 1.5 0 001.5-1.5V5L8 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 1.5V5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ToolGenericIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ErrorIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4.5v3M7 9.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const BROWSER_KEYWORDS = /goto|nav|tab|click|scroll|hover|select|wait|back|forward|refresh|browse|page/i;
const CODE_KEYWORDS = /^js$|javascript|eval|exec|script|shell|bash|code|run_code/i;
const SCREENSHOT_KEYWORDS = /screen|capture|snap|photo/i;
const NETWORK_KEYWORDS = /http|fetch|request|api|curl|download|upload/i;
const FILE_KEYWORDS = /file|read|write|search|find|glob|grep|dir|folder|path/i;

function toolIcon(name?: string): React.ReactElement {
  if (!name) return <ToolGenericIcon />;
  if (CODE_KEYWORDS.test(name)) return <CodeIcon />;
  if (SCREENSHOT_KEYWORDS.test(name)) return <CameraIcon />;
  if (NETWORK_KEYWORDS.test(name)) return <NetworkIcon />;
  if (BROWSER_KEYWORDS.test(name)) return <BrowseIcon />;
  if (FILE_KEYWORDS.test(name)) return <FileIcon />;
  return <ToolGenericIcon />;
}

function ToolStep({ entry }: { entry: OutputEntry }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);

  const hasResult = !!entry.result;
  const dur = entry.result?.duration;

  return (
    <div className={`step step--tool${hasResult ? '' : ' step--tool-active'}`}>
      <div className="step__row" onClick={toggle} role="button" tabIndex={0} aria-expanded={open}>
        <span className="step__icon">{toolIcon(entry.tool)}</span>
        <span className="step__name">{entry.tool}</span>
        {!hasResult && <span className="step__spinner" />}
        <span className="step__fill" />
        {dur != null && <span className="step__dur">{formatDuration(dur)}</span>}
      </div>
      {open && (
        <div className="step__detail">
          <ContentRenderer content={entry.content} type="tool_call" />
          {hasResult && (
            <>
              <div className="step__divider" />
              <ContentRenderer content={entry.result!.content} type="tool_result" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ entry }: { entry: OutputEntry }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);
  const count = entry.groupCount ?? 0;
  const children = entry.groupEntries ?? [];

  return (
    <div className="step step--tool-group">
      <div className="step__row" onClick={toggle} role="button" tabIndex={0} aria-expanded={open}>
        <span className="step__icon">{toolIcon(entry.tool)}</span>
        <span className="step__name">{entry.tool}</span>
        <span className="step__badge">{count}</span>
        <span className="step__fill" />
      </div>
      {open && (
        <div className="step__group-children">
          {children.map((child) => (
            <ToolStep key={child.id} entry={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function OutputRow({ entry }: { entry: OutputEntry }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);

  if (entry.type === 'thinking') {
    return (
      <div className="step step--thinking">
        <span className="step__text">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === 'tool_call') {
    if (entry.groupCount && entry.groupCount > 1) {
      return <ToolGroup entry={entry} />;
    }
    return <ToolStep entry={entry} />;
  }

  if (entry.type === 'tool_result') {
    const dur = entry.duration;
    return (
      <div className="step step--tool">
        <div className="step__row" onClick={toggle} role="button" tabIndex={0} aria-expanded={open}>
          <span className="step__icon">{toolIcon(entry.tool)}</span>
          <span className="step__name">{entry.tool}</span>
          <span className="step__fill" />
          {dur != null && <span className="step__dur">{formatDuration(dur)}</span>}
        </div>
        {open && (
          <div className="step__detail">
            <ContentRenderer content={entry.content} type="tool_result" />
          </div>
        )}
      </div>
    );
  }

  if (entry.type === 'skill_written') {
    return (
      <div className="step step--skill">
        <span className="step__icon">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 11.5V3a1.5 1.5 0 011.5-1.5h7A1.5 1.5 0 0112 3v7a1.5 1.5 0 01-1.5 1.5h-7L2 11.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M5 5h4M5 7.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>
        <span className="step__skill-label">Learned</span>
        <span className="step__skill-topic">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === 'notify') {
    const isBlocking = entry.level === 'blocking';
    return (
      <div className={`step step--notify${isBlocking ? ' step--notify-blocking' : ' step--notify-info'}`}>
        <span className="step__text">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === 'user_input') {
    return (
      <div className="step step--user-input">
        <span className="step__user-chevron">&rsaquo;</span>
        <span className="step__user-text">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === 'done') {
    return (
      <div className="step step--done">
        <div className="step__done-divider" />
        <pre className="step__done-text">{entry.content}</pre>
      </div>
    );
  }

  if (entry.type === 'error') {
    return (
      <div className="step step--error">
        <span className="step__text">{entry.content}</span>
      </div>
    );
  }

  return (
    <div className="step step--output">
      <span className="step__text">{entry.content}</span>
    </div>
  );
}

function BrowserIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 5.5h11" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.5" cy="4" r="0.5" fill="currentColor" />
      <circle cx="5.5" cy="4" r="0.5" fill="currentColor" />
    </svg>
  );
}

function OutputIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M3 4h8M3 7h6M3 10h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function SplitIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="7.5" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CopyIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.5 4.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v5A1.5 1.5 0 003 9.5h1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function RerunIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M2 7a5 5 0 019.33-2.5M12 7a5 5 0 01-9.33 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M11 2v3h-3M3 12V9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FollowUpInput({ sessionId, onUserInput, autoFocus }: { sessionId: string; onUserInput: (text: string) => void; autoFocus?: boolean }): React.ReactElement {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    console.log('[FollowUpInput] sending follow-up', { id: sessionId, prompt: trimmed });
    onUserInput(trimmed);
    setValue('');
  }, [value, sessionId, onUserInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      textareaRef.current?.blur();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [value]);

  return (
    <div className="followup">
      <span className="followup__chevron">&rsaquo;</span>
      <textarea
        ref={textareaRef}
        className="followup__input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Follow up..."
        rows={1}
      />
    </div>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

interface AgentPaneProps {
  session: AgentSession;
  focused?: boolean;
  onRerun?: (sessionId: string) => void;
  onFollowUp?: (sessionId: string, prompt: string) => void;
  onDismiss?: (sessionId: string) => void;
  onCancel?: (sessionId: string) => void;
  onSelect?: (sessionId: string) => void;
  onOpenFollowUp?: () => void;
  followUpShortcut?: string;
  cycleShortcut?: string;
}

export function AgentPane({ session, focused, onRerun, onFollowUp, onDismiss, onCancel, onSelect, onOpenFollowUp, followUpShortcut, cycleShortcut }: AgentPaneProps): React.ReactElement {
  useHydrateSession(session.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  type PaneViewMode = 'output' | 'split' | 'browser';
  const [viewMode, setViewMode] = useState<PaneViewMode>('split');
  const [browserDead, setBrowserDead] = useState(false);
  const [splitPaddingLeft, setSplitPaddingLeft] = useState(0);
  const [frameRect, setFrameRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const { entries: rawEntries } = useMemo(() => adaptSession(session), [session]);
  const entries = useMemo<OutputEntry[]>(() => {
    if (!session.prompt) return rawEntries;
    const promptEntry: OutputEntry = {
      id: `prompt-${session.id}`,
      type: 'user_input',
      timestamp: session.createdAt,
      content: session.prompt,
    };
    return [promptEntry, ...rawEntries];
  }, [rawEntries, session.prompt, session.id, session.createdAt]);

  const SPLIT_RATIO = 0.6;

  const computeBounds = useCallback((mode: PaneViewMode): { x: number; y: number; width: number; height: number; slotWidth: number } | null => {
    const el = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const fullWidth = Math.round(rect.width);
    const slotWidth = mode === 'split' ? Math.round(fullWidth * SPLIT_RATIO) : fullWidth;
    const border = 1;
    return {
      x: Math.round(rect.x) + border,
      y: Math.round(rect.y) + border,
      width: slotWidth - border * 2,
      height: Math.round(rect.height) - border * 2,
      slotWidth,
    };
  }, []);

  useEffect(() => {
    if (session.status === 'running') {
      setBrowserDead(false);
    }
  }, [session.id, session.status]);

  const browserNotReady = session.status === 'draft' || (session.status === 'running' && rawEntries.length === 0);

  const updateFrameRect = useCallback((slotWidth: number) => {
    const paneEl = paneRef.current;
    const outEl = paneEl?.querySelector('.pane__output') as HTMLElement | null;
    if (!paneEl || !outEl) return;
    const p = paneEl.getBoundingClientRect();
    const o = outEl.getBoundingClientRect();
    setFrameRect({
      left: Math.round(o.left - p.left),
      top: Math.round(o.top - p.top),
      width: slotWidth,
      height: Math.round(o.height),
    });
  }, []);

  const applyViewMode = useCallback(async (mode: PaneViewMode): Promise<void> => {
    const api = window.electronAPI;
    if (!api) return;

    if (mode === 'output' || browserDead) {
      console.log('[AgentPane] detaching browser view', { id: session.id, mode });
      await api.sessions.viewDetach(session.id).catch(() => {});
      setSplitPaddingLeft(0);
      setFrameRect(null);
      return;
    }

    if (browserNotReady) {
      console.log('[AgentPane] browser not ready, deferring attach', { id: session.id, mode });
      await api.sessions.viewDetach(session.id).catch(() => {});
      const computed = computeBounds(mode);
      if (computed) {
        setSplitPaddingLeft(mode === 'split' ? computed.slotWidth : 0);
        updateFrameRect(computed.slotWidth);
      }
      return;
    }

    const computed = computeBounds(mode);
    if (!computed) return;
    const { slotWidth, ...bounds } = computed;
    console.log('[AgentPane] attaching browser view', { id: session.id, mode, bounds });
    const ok = await api.sessions.viewAttach(session.id, bounds);
    if (!ok) {
      setBrowserDead(true);
      setSplitPaddingLeft(0);
      setFrameRect(null);
      return;
    }
    setSplitPaddingLeft(mode === 'split' ? slotWidth : 0);
    updateFrameRect(slotWidth);
  }, [session.id, browserDead, computeBounds, browserNotReady, updateFrameRect]);

  const handleSetMode = useCallback((mode: PaneViewMode) => {
    if (browserDead && mode !== 'output') {
      setBrowserDead(false);
    }
    setViewMode(mode);
  }, [browserDead]);

  useEffect(() => {
    const onCycle = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail || detail.sessionId !== session.id) return;
      const order: PaneViewMode[] = ['output', 'split', 'browser'];
      setViewMode((curr) => {
        const next = order[(order.indexOf(curr) + 1) % order.length];
        console.log('[AgentPane] cycle view', { id: session.id, from: curr, to: next });
        if (browserDead && next !== 'output') setBrowserDead(false);
        return next;
      });
    };
    window.addEventListener('pane:cycle-view', onCycle);
    return () => window.removeEventListener('pane:cycle-view', onCycle);
  }, [session.id, browserDead]);

  useEffect(() => {
    void applyViewMode(viewMode);
  }, [viewMode, applyViewMode]);

  useEffect(() => {
    if (viewMode === 'output') return;
    const paneEl = paneRef.current;
    if (!paneEl) return;
    const api = window.electronAPI;
    if (!api) return;

    let lastKey = '';
    const updateBounds = () => {
      const outEl = paneEl.querySelector('.pane__output') as HTMLElement | null;
      if (!outEl) return;
      const computed = computeBounds(viewMode);
      if (!computed) return;
      const { slotWidth, ...bounds } = computed;
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      api.sessions.viewAttach(session.id, bounds).catch(() => {});
      setSplitPaddingLeft(viewMode === 'split' ? slotWidth : 0);
      const p = paneEl.getBoundingClientRect();
      const o = outEl.getBoundingClientRect();
      setFrameRect({
        left: Math.round(o.left - p.left),
        top: Math.round(o.top - p.top),
        width: slotWidth,
        height: Math.round(o.height),
      });
    };

    const observer = new ResizeObserver(updateBounds);
    observer.observe(paneEl, { box: 'border-box' });
    return () => observer.disconnect();
  }, [viewMode, session.id, computeBounds]);

  useEffect(() => {
    return () => {
      const api = window.electronAPI;
      if (!api) return;
      console.log('[AgentPane] unmount -> detach', { id: session.id });
      api.sessions.viewDetach(session.id).catch(() => {});
    };
  }, [session.id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  const elapsed = formatElapsed(session.createdAt);
  const statusText = STATUS_LABEL[session.status] ?? session.status;

  return (
    <div ref={paneRef} className={`pane pane--${session.status}${focused ? ' pane--focused' : ''}`} onClick={() => onSelect?.(session.id)}>
      <div className="pane__header">
        <span className={`pane__dot pane__dot--${session.status}`} />
        <span className="pane__prompt">{session.prompt}</span>
        <div className="pane__actions">
          {browserDead ? (
            <span className="pane__action-btn pane__action-btn--disabled">
              <BrowserIcon />
              <span>Browser ended</span>
            </span>
          ) : (
            <div
              className="pane__view-toggle"
              role="radiogroup"
              aria-label="Pane view mode"
              data-tip={`Press ${cycleShortcut || 'v'} to cycle`}
            >
              <button
                className={`pane__action-btn${viewMode === 'output' ? ' pane__action-btn--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleSetMode('output'); }}
                aria-label="Output only"
              >
                <OutputIcon />
                <span>Output</span>
              </button>
              <button
                className={`pane__action-btn${viewMode === 'split' ? ' pane__action-btn--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleSetMode('split'); }}
                aria-label="Split view"
              >
                <SplitIcon />
                <span>Split</span>
              </button>
              <button
                className={`pane__action-btn${viewMode === 'browser' ? ' pane__action-btn--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleSetMode('browser'); }}
                aria-label="Browser only"
              >
                <BrowserIcon />
                <span>Browser</span>
              </button>
            </div>
          )}
          {onRerun && (
            <button
              className="pane__action-btn pane__action-btn--icon"
              onClick={(e) => { e.stopPropagation(); onRerun(session.id); }}
              aria-label="Rerun"
              data-tip="Rerun"
            >
              <RerunIcon />
            </button>
          )}
          {(session.status === 'running' || session.status === 'stuck') && onCancel && (
            <button
              className="pane__action-btn pane__action-btn--icon pane__action-btn--danger"
              onClick={(e) => { e.stopPropagation(); onCancel(session.id); }}
              aria-label="Stop"
              data-tip="Stop"
            >
              <CloseIcon />
            </button>
          )}
          {session.status !== 'running' && session.status !== 'stuck' && onDismiss && (
            <button
              className="pane__action-btn pane__action-btn--icon pane__action-btn--danger"
              onClick={(e) => { e.stopPropagation(); onDismiss(session.id); }}
              aria-label="Close"
              data-tip="Close"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>
      <div className="pane__meta">
        <span className="pane__status">{statusText}</span>
        <span className="pane__sep" />
        <span className="pane__elapsed">{elapsed}</span>
        {session.group && (
          <>
            <span className="pane__sep" />
            <span className="pane__group">{session.group}</span>
          </>
        )}
      </div>

      {session.status === 'running' && (
        <div className="pane__progress">
          <div className="pane__progress-bar" />
        </div>
      )}

      {frameRect && viewMode !== 'output' && (
        <div
          className="pane__browser-frame"
          style={{
            left: frameRect.left,
            top: frameRect.top,
            width: frameRect.width,
            height: frameRect.height,
          }}
          aria-hidden="true"
        >
          <div className="pane__browser-starting">
            <span className="pane__spinner" />
            <span>Browser starting…</span>
          </div>
        </div>
      )}
      <div
        className={`pane__output${viewMode === 'split' ? ' pane__output--split' : ''}`}
        ref={scrollRef}
        style={viewMode === 'split' && splitPaddingLeft > 0 ? { paddingLeft: splitPaddingLeft } : undefined}
      >
        {entries.map((entry) => (
          <OutputRow key={entry.id} entry={entry} />
        ))}
        {session.status === 'running' && rawEntries.length === 0 && (
          <div className="pane__output-starting">
            <span className="pane__spinner" />
            <span className="pane__output-empty-text">Agent starting…</span>
          </div>
        )}
        {session.status === 'running' && rawEntries.length > 0 && (
          <div className="pane__cursor-row">
            <span className="pane__cursor" />
          </div>
        )}
        {session.status === 'idle' && !session.error && onOpenFollowUp && (
          <button
            type="button"
            className="pane__followup-hint"
            onClick={(e) => { e.stopPropagation(); onOpenFollowUp(); }}
          >
            Press <kbd className="pane__followup-kbd">{followUpShortcut || 'f'}</kbd> to follow up
          </button>
        )}
        {session.error && entries.length <= 2 && (
          <div className="pane__error-center">
            <div className="pane__error-icon">
              <ErrorIcon />
            </div>
            <p className="pane__error-msg">{friendlyError(session.error)}</p>
            {onRerun && (
              <button className="pane__rerun-btn" onClick={() => onRerun(session.id)}>
                <RerunIcon />
                <span>Rerun task</span>
              </button>
            )}
          </div>
        )}
        {session.error && entries.length > 2 && onRerun && (
          <div className="pane__rerun">
            <span className="pane__rerun-error">{friendlyError(session.error)}</span>
            <button className="pane__rerun-btn" onClick={() => onRerun(session.id)}>
              <RerunIcon />
              <span>Rerun task</span>
            </button>
          </div>
        )}
        {!session.error && session.status === 'stopped' && onRerun && (
          <div className="pane__rerun">
            <button className="pane__rerun-btn" onClick={() => onRerun(session.id)}>
              <RerunIcon />
              <span>Rerun task</span>
            </button>
          </div>
        )}
      </div>

    </div>
  );
}

export default AgentPane;
