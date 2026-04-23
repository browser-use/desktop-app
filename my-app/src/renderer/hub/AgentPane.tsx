import React, { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { useHydrateSession } from './useSessionsQuery';
import { STATUS_LABEL } from './constants';
import { ContentRenderer, getPreview } from './ContentRenderer';
import { Markdown, linkifyOutputPaths } from './Markdown';
import { TerminalPane } from './TerminalPane';
// Inline the SVG source so `fill="currentColor"` in the logos picks up the
// menu's CSS color. `<img src=...>` renders in its own graphics context and
// can't inherit text color.
// @ts-expect-error — Vite raw-import modifier
import cursorLogoSrc from './cursor-logo.svg?raw';
import vscodeLogo from './vscode-logo.svg';
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

function isApiKeyError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    lower.includes('no api key') ||
    lower.includes('authentication_error') ||
    lower.includes('x-api-key') ||
    lower.includes('401')
  );
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('credit balance is too low') || lower.includes('insufficient_quota')) return 'API credits exhausted. Please add credits to your Anthropic account.';
  if (isApiKeyError(raw)) return 'Anthropic API key is missing or invalid. Update it in Settings.';
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

// Cached editor list — fetched once per renderer load.
// Filter out editors we don't want to expose (Xcode etc.) defensively here so
// the UI updates without waiting for a main-process restart to flush its cache.
const EDITOR_BLOCKLIST = new Set(['xcode']);
let editorsPromise: Promise<Array<{ id: string; name: string }>> | null = null;
function getEditors(): Promise<Array<{ id: string; name: string }>> {
  if (!editorsPromise) {
    const base = window.electronAPI?.sessions?.listEditors?.() ?? Promise.resolve([]);
    editorsPromise = base.then((list) => list.filter((e) => !EDITOR_BLOCKLIST.has(e.id)));
  }
  return editorsPromise;
}

function formatFileSize(n: number | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function EditorIcon({ id }: { id: string }): React.ReactElement {
  if (id === 'cursor') {
    return (
      <span
        className="editor-logo editor-logo--cursor"
        dangerouslySetInnerHTML={{ __html: cursorLogoSrc as string }}
      />
    );
  }
  if (id === 'vscode' || id === 'vscode-insiders') {
    return <img src={vscodeLogo} alt="" width={14} height={14} />;
  }
  if (id === 'zed' || id === 'zed-preview') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="#9a62ff" />
        <path d="M8 8h8L8 16h8" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      </svg>
    );
  }
  if (id === 'windsurf') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 16c4-3 6-3 8 0s6 3 8 0" stroke="#39c4b5" strokeWidth="2" strokeLinecap="round" fill="none" />
        <path d="M4 10c4-3 6-3 8 0s6 3 8 0" stroke="#39c4b5" strokeWidth="2" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  if (id === 'sublime') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 5v14l14-4V1L5 5Z" fill="#FF9800" />
      </svg>
    );
  }
  // JetBrains family — generic ring
  if (['webstorm', 'intellij', 'intellij-ce', 'pycharm', 'pycharm-ce', 'rider', 'goland'].includes(id)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="3" fill="#000" />
        <path d="M7 17h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  // Fallback: generic monitor icon.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 11.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function FileOutputRow({ entry }: { entry: OutputEntry }): React.ReactElement {
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { getEditors().then(setEditors).catch(() => setEditors([])); }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const onOpenInEditor = useCallback(async (editorId: string) => {
    if (!entry.tool) return;
    setMenuOpen(false);
    try { await window.electronAPI?.sessions?.openInEditor?.(editorId, entry.tool); }
    catch (err) { console.error('[file_output] openInEditor failed', err); }
  }, [entry.tool]);

  const onOpenWithDefault = useCallback(async () => {
    if (!entry.tool) return;
    setMenuOpen(false);
    try { await window.electronAPI?.sessions?.downloadOutput?.(entry.tool); }
    catch (err) { console.error('[file_output] openWithDefault failed', err); }
  }, [entry.tool]);

  const onRevealInFinder = useCallback(async () => {
    if (!entry.tool) return;
    setMenuOpen(false);
    try { await window.electronAPI?.sessions?.revealOutput?.(entry.tool); }
    catch (err) { console.error('[file_output] reveal failed', err); }
  }, [entry.tool]);

  return (
    <div className="step step--file-output">
      <span className="step__icon">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M8 1.5H4a1.5 1.5 0 00-1.5 1.5v8A1.5 1.5 0 004 12.5h6a1.5 1.5 0 001.5-1.5V5L8 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M8 1.5V5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="step__skill-label">Produced file</span>
      <span className="step__skill-topic" title={entry.tool}>{entry.content}</span>
      <span className="step__file-size">{formatFileSize(entry.fileSize)}</span>
      <div className="step__file-ide" ref={menuRef}>
        <button
          className="step__file-download step__file-ide-toggle"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          Open in {'\u25BE'}
        </button>
        {menuOpen && (
          <div className="step__file-ide-menu" role="menu">
            {editors.map((ed) => (
              <button
                key={ed.id}
                role="menuitem"
                className="step__file-ide-menu-item"
                onClick={() => onOpenInEditor(ed.id)}
              >
                <span className="step__file-ide-menu-icon"><EditorIcon id={ed.id} /></span>
                <span>{ed.name}</span>
              </button>
            ))}
            {editors.length > 0 && <div className="step__file-ide-menu-sep" />}
            <button
              role="menuitem"
              className="step__file-ide-menu-item"
              onClick={onRevealInFinder}
              title="Show the file in Finder without opening it"
            >
              <span className="step__file-ide-menu-icon">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 4.5v6A1.5 1.5 0 003.5 12h7A1.5 1.5 0 0012 10.5V5.5A1.5 1.5 0 0010.5 4H7L5.5 2.5h-2A1.5 1.5 0 002 4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
              </span>
              <span>Reveal in Finder</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function OutputRow({ entry }: { entry: OutputEntry }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);

  if (entry.type === 'thinking') {
    return (
      <div className="step step--thinking">
        <div className="step__text">
          <Markdown source={linkifyOutputPaths(entry.content)} />
        </div>
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

  if (entry.type === 'skill_used') {
    return (
      <div className="step step--skill-used">
        <span className="step__icon">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 3h10v8H2z" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 6h4M5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>
        <span className="step__skill-label">Read skill</span>
        <span className="step__skill-topic">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === 'harness_edited') {
    const isHelpers = entry.harnessTarget === 'helpers';
    const verb = entry.harnessAction === 'patch' ? 'Patched' : 'Updated';
    const addedCount = entry.added?.length ?? 0;
    const removedCount = entry.removed?.length ?? 0;
    const changedCount = entry.changed?.length ?? 0;
    const diffParts: string[] = [];
    if (addedCount) diffParts.push(`+${addedCount}`);
    if (removedCount) diffParts.push(`-${removedCount}`);
    if (changedCount) diffParts.push(`~${changedCount}`);
    const diffSummary = diffParts.length ? ` (${diffParts.join(' ')})` : '';
    const title = (entry.added ?? []).concat(entry.changed ?? []).concat((entry.removed ?? []).map((n) => `-${n}`)).join(', ');
    return (
      <div className="step step--harness" title={title || undefined}>
        <span className="step__icon">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 2v10M11 2v10M3 4h8M3 10h8M5 7h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </span>
        <span className="step__skill-label">{verb} harness</span>
        <span className="step__skill-topic">{isHelpers ? 'helpers.js' : `TOOLS.json${diffSummary}`}</span>
      </div>
    );
  }

  if (entry.type === 'file_output') {
    return <FileOutputRow entry={entry} />;
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
    return null as unknown as React.ReactElement;
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
      <div className="step__text">
        <Markdown source={entry.content} />
      </div>
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

interface FollowUpAttachment { idx: number; name: string; mime: string; bytes: Uint8Array }

async function fileToAttachment(file: File, idx: number): Promise<FollowUpAttachment> {
  const buf = await file.arrayBuffer();
  return {
    idx,
    name: file.name || `image-${idx}`,
    mime: file.type || 'application/octet-stream',
    bytes: new Uint8Array(buf),
  };
}

function insertAtCaret(el: HTMLTextAreaElement, text: string): string {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const next = before + text + after;
  // Defer caret move to next tick once React re-renders with the new value.
  queueMicrotask(() => {
    el.selectionStart = el.selectionEnd = start + text.length;
  });
  return next;
}

function FollowUpInput({ sessionId, onUserInput, autoFocus }: { sessionId: string; onUserInput: (text: string, attachments?: FollowUpAttachment[]) => void; autoFocus?: boolean }): React.ReactElement {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<FollowUpAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const idxCounter = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    // Only include attachments whose `[Image #N]` token still appears in the
    // text — deleting the token from the input removes the attachment.
    const presentIdx = new Set<number>();
    const tokenRe = /\[Image #(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(trimmed)) !== null) presentIdx.add(Number(m[1]));
    const filtered = attachments.filter((a) => presentIdx.has(a.idx));
    if (!trimmed && filtered.length === 0) return;
    console.log('[FollowUpInput] sending follow-up', { id: sessionId, prompt: trimmed, attachmentCount: filtered.length });
    onUserInput(trimmed, filtered.length > 0 ? filtered : undefined);
    setValue('');
    setAttachments([]);
    idxCounter.current = 0;
  }, [value, sessionId, onUserInput, attachments]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      textareaRef.current?.blur();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const addFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const el = textareaRef.current;
    const startIdx = idxCounter.current + 1;
    idxCounter.current += list.length;
    try {
      const next = await Promise.all(list.map((f, i) => fileToAttachment(f, startIdx + i)));
      setAttachments((prev) => [...prev, ...next]);
      const tokens = next.map((a) => `[Image #${a.idx}]`).join(' ');
      if (el) {
        setValue((prev) => {
          const pos = el.selectionStart ?? prev.length;
          const before = prev.slice(0, pos);
          const after = prev.slice(el.selectionEnd ?? prev.length);
          const sep = before && !before.endsWith(' ') ? ' ' : '';
          const inserted = sep + tokens + (after && !after.startsWith(' ') ? ' ' : '');
          queueMicrotask(() => {
            const newPos = before.length + inserted.length;
            el.selectionStart = el.selectionEnd = newPos;
            el.focus();
          });
          return before + inserted + after;
        });
      } else {
        setValue((prev) => (prev ? prev + ' ' : '') + tokens);
      }
    } catch (err) {
      console.error('[FollowUpInput] attach failed', err);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }, [addFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer?.files ?? null);
  }, [addFiles]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [value]);

  // Suppress unused warning for insertAtCaret if lint is strict; referenced for future direct-caret paths.
  void insertAtCaret;

  return (
    <div
      className={`followup${dragOver ? ' followup--dragover' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="followup__row">
        <span className="followup__chevron">&rsaquo;</span>
        <textarea
          ref={textareaRef}
          className="followup__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Follow up..."
          rows={1}
        />
        <button
          type="button"
          className="followup__attach-btn"
          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
          aria-label="Attach files"
          title="Attach files"
        >+</button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
        />
      </div>
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
  onFollowUp?: (sessionId: string, prompt: string, attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>) => void;
  onDismiss?: (sessionId: string) => void;
  onCancel?: (sessionId: string) => void;
  onSelect?: (sessionId: string) => void;
  onOpenFollowUp?: () => void;
  onOpenSettings?: () => void;
  followUpShortcut?: string;
  cycleShortcut?: string;
}

export function AgentPane({ session, focused, onRerun, onFollowUp, onDismiss, onCancel, onSelect, onOpenFollowUp, onOpenSettings, followUpShortcut, cycleShortcut }: AgentPaneProps): React.ReactElement {
  useHydrateSession(session.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [browserDead, setBrowserDead] = useState(false);
  const [browserMissing, setBrowserMissing] = useState(false);
  const [frameRect, setFrameRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Logs overlay is a separate window (see logsPill.ts). The pane tracks
  // visibility only to reflect it in the Logs button's active state.
  const [logsOpen, setLogsOpen] = useState(false);
  // Auto-open the logs overlay once per fresh session id so users see the
  // agent's stream as soon as a task starts.
  const autoLogsTriggeredRef = useRef<Set<string>>(new Set());
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

  const BROWSER_CTA_RESERVE = 64;
  const showBrowserCta = session.status === 'idle' && !session.error && !!onOpenFollowUp;

  const computeBounds = useCallback((): { x: number; y: number; width: number; height: number; slotWidth: number } | null => {
    const el = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const fullWidth = Math.round(rect.width);
    const slotWidth = fullWidth;
    const border = 1;
    const topReserve = showBrowserCta ? BROWSER_CTA_RESERVE : 0;
    return {
      x: Math.round(rect.x) + border,
      y: Math.round(rect.y) + border + topReserve,
      width: slotWidth - border * 2,
      height: Math.round(rect.height) - border * 2 - topReserve,
      slotWidth,
    };
  }, [showBrowserCta]);

  useEffect(() => {
    if (session.status === 'running') {
      setBrowserDead(false);
    }
  }, [session.id, session.status]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.on?.sessionBrowserGone) return;
    const off = api.on.sessionBrowserGone((id) => {
      if (id === session.id) {
        console.log('[AgentPane] browser-gone signal', { id });
        setBrowserDead(true);
        setFrameRect(null);
      }
    });
    return off;
  }, [session.id]);

  // A running session always has a pool entry. Treat it as ready so the
  // renderer calls viewAttach immediately — previously we also required
  // rawEntries.length>0, which stalled the initial attach until the agent
  // produced its first HlEvent.
  const browserNotReady = session.status === 'draft';

  const updateFrameRect = useCallback((slotWidth: number) => {
    const paneEl = paneRef.current;
    const outEl = paneEl?.querySelector('.pane__output') as HTMLElement | null;
    if (!paneEl || !outEl) return;
    const p = paneEl.getBoundingClientRect();
    const o = outEl.getBoundingClientRect();
    const topReserve = showBrowserCta ? BROWSER_CTA_RESERVE : 0;
    setFrameRect({
      left: Math.round(o.left - p.left),
      top: Math.round(o.top - p.top) + topReserve,
      width: slotWidth,
      height: Math.round(o.height) - topReserve,
    });
  }, [showBrowserCta]);

  const handleToggleLogs = useCallback(() => {
    const api = window.electronAPI;
    if (!api?.logs) return;
    const outEl = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    const rect = outEl?.getBoundingClientRect();
    const anchor = rect
      ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      : undefined;
    void api.logs.toggle(session.id, anchor).then((nowOpen) => setLogsOpen(nowOpen));
  }, [session.id]);

  // On session change, push the new session id to the floating logs overlay
  // so it re-targets (also handles first-mount auto-show for running sessions).
  useEffect(() => {
    if (session.status === 'draft') return;
    const api = window.electronAPI;
    if (!api?.logs?.show) return;
    const outEl = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    const rect = outEl?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const anchor = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    void api.logs.show(session.id, anchor).then((open) => setLogsOpen(open));
  }, [session.id, session.status]);

  useEffect(() => {
    const paneEl = paneRef.current;
    if (!paneEl) return;
    const api = window.electronAPI;
    if (!api) return;
    if (browserDead) {
      // Dead browser — ensure any lingering view is detached.
      api.sessions.viewDetach(session.id).catch(() => {});
      setFrameRect(null);
      return;
    }

    let lastKey = '';
    let hasAttached = false;
    let rafScheduled = 0;
    const applyBounds = () => {
      rafScheduled = 0;
      const outEl = paneEl.querySelector('.pane__output') as HTMLElement | null;
      if (!outEl) return;
      const computed = computeBounds();
      if (!computed) return;
      const { slotWidth, ...bounds } = computed;
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      if (!hasAttached) {
        hasAttached = true;
        api.sessions.viewAttach(session.id, bounds).then((ok) => {
          if (!ok) setBrowserMissing(true); else setBrowserMissing(false);
        }).catch(() => {});
      } else {
        api.sessions.viewResize(session.id, bounds);
      }
      const p = paneEl.getBoundingClientRect();
      const o = outEl.getBoundingClientRect();
      const topReserve = showBrowserCta ? BROWSER_CTA_RESERVE : 0;
      setFrameRect({
        left: Math.round(o.left - p.left),
        top: Math.round(o.top - p.top) + topReserve,
        width: slotWidth,
        height: Math.round(o.height) - topReserve,
      });
      // Auto-show the logs overlay once per session on the first real pane
      // measurement. Ref-keyed so Esc-close doesn't trigger a re-open.
      const logsAnchor = {
        x: Math.round(o.left),
        y: Math.round(o.top),
        width: Math.round(o.width),
        height: Math.round(o.height),
      };
      if (logsAnchor.width > 0 && logsAnchor.height > 0) {
        api.logs?.updateAnchor?.(logsAnchor);
      }
      if (
        session.status !== 'draft' &&
        api.logs?.show &&
        logsAnchor.width > 0 &&
        logsAnchor.height > 0 &&
        !autoLogsTriggeredRef.current.has(session.id)
      ) {
        autoLogsTriggeredRef.current.add(session.id);
        console.log('[AgentPane] auto-open logs on first pane measurement', { sessionId: session.id, logsAnchor });
        void api.logs.show(session.id, logsAnchor).then((open) => setLogsOpen(open));
      }
    };
    // Coalesce rapid ResizeObserver / layout callbacks into one IPC per frame.
    const updateBounds = () => {
      if (rafScheduled) return;
      rafScheduled = requestAnimationFrame(applyBounds);
    };

    const observer = new ResizeObserver(updateBounds);
    observer.observe(paneEl, { box: 'border-box' });

    // ResizeObserver misses position-only changes (e.g. sibling pane dismissed
    // causes a grid reflow without this pane resizing). HubApp dispatches
    // pane:layout-change when the session list or grid layout changes — we
    // re-read bounds across a few frames to catch any CSS transition.
    const onLayoutChange = () => {
      // Layout just changed (grid columns, page, session list). Force the next
      // bounds call through the viewAttach path so if the WebContentsView was
      // silently detached (e.g. by temporarilyDetachAll for pill/settings), it
      // gets re-added. Bounds are always set BEFORE addChildView so there's no
      // stale-position flash.
      hasAttached = false;
      lastKey = '';
      updateBounds();
      requestAnimationFrame(updateBounds);
      setTimeout(updateBounds, 120);
    };
    window.addEventListener('pane:layout-change', onLayoutChange);

    return () => {
      observer.disconnect();
      window.removeEventListener('pane:layout-change', onLayoutChange);
      if (rafScheduled) cancelAnimationFrame(rafScheduled);
    };
  }, [session.id, computeBounds, browserDead, session.status, showBrowserCta]);

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
    <div
      ref={paneRef}
      className={`pane pane--${session.status}${focused ? ' pane--focused' : ''}`}
      onClick={() => onSelect?.(session.id)}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) e.preventDefault();
      }}
    >
      <div className="pane__header">
        <span className={`pane__dot pane__dot--${session.status}`} />
        <span className="pane__prompt">{session.prompt}</span>
        <div className="pane__actions">
          {browserDead && (
            <span className="pane__action-btn pane__action-btn--disabled">
              <BrowserIcon />
              <span>Browser ended</span>
            </span>
          )}
          <button
            className={`pane__action-btn${logsOpen ? ' pane__action-btn--active' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleToggleLogs(); }}
            aria-label="Toggle logs overlay"
            data-tip="Toggle logs overlay"
          >
            <SplitIcon />
            <span>Logs</span>
          </button>
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

      <div className="pane__progress" aria-hidden="true">
        {session.status === 'running' && <div className="pane__progress-bar" />}
      </div>

      {frameRect && (browserDead || browserMissing || session.status === 'draft') && (
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
            {browserDead ? (
              <span>Browser ended</span>
            ) : browserMissing ? (
              <span>
                {session.status === 'stopped' || session.status === 'idle' || session.status === 'stuck'
                  ? 'Browser stopped'
                  : 'No browser started yet'}
              </span>
            ) : (
              <>
                <span className="pane__spinner" />
                <span>Browser starting…</span>
              </>
            )}
          </div>
        </div>
      )}
      <div
        className="pane__output"
        ref={scrollRef}
      >
        {showBrowserCta && (
          <button
            type="button"
            className="pane__followup-hint pane__followup-hint--top"
            onClick={(e) => { e.stopPropagation(); onOpenFollowUp?.(); }}
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
            <div className="pane__error-actions">
              {isApiKeyError(session.error) && onOpenSettings && (
                <button className="pane__rerun-btn" onClick={onOpenSettings}>
                  <span>Open Settings</span>
                </button>
              )}
              {onRerun && (
                <button className="pane__rerun-btn" onClick={() => onRerun(session.id)}>
                  <RerunIcon />
                  <span>Rerun task</span>
                </button>
              )}
            </div>
          </div>
        )}
        {session.error && entries.length > 2 && (
          <div className="pane__rerun">
            <span className="pane__rerun-error">{friendlyError(session.error)}</span>
            {isApiKeyError(session.error) && onOpenSettings && (
              <button className="pane__rerun-btn" onClick={onOpenSettings}>
                <span>Open Settings</span>
              </button>
            )}
            {onRerun && (
              <button className="pane__rerun-btn" onClick={() => onRerun(session.id)}>
                <RerunIcon />
                <span>Rerun task</span>
              </button>
            )}
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
