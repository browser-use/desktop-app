import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TerminalPane } from '../hub/TerminalPane';
// Reuse the hub's editor-logo assets so the logs window's "Open in ..." menu
// matches the hub's FileOutputRow visually.
import cursorLogoSrc from '../hub/cursor-logo.svg?raw';
import vscodeLogo from '../hub/vscode-logo.svg';

declare global {
  interface Window {
    logsAPI: {
      close: () => void;
      setMode: (mode: 'dot' | 'normal' | 'full') => void;
      onModeChanged: (cb: (mode: 'dot' | 'normal' | 'full') => void) => () => void;
      onActiveSessionChanged: (cb: (id: string | null) => void) => () => void;
      onFocusFollowUp: (cb: () => void) => () => void;
      followUp: (sessionId: string, prompt: string) => Promise<{ resumed?: boolean; error?: string }>;
    };
  }
}

// Matches the RAW HlEvent shape emitted by the main process (see
// src/renderer/hub/types.ts). This is what session.output stores, BEFORE
// it's adapted into OutputEntry on the hub side.
interface FileOutputEntry {
  type: 'file_output';
  name: string;
  path: string;
  size: number;
  mime: string;
}

interface DoneInfo {
  summary: string;
  iterations: number;
}

interface SessionShape {
  id: string;
  status?: string;
  error?: string;
  output?: Array<{ type: string } & Partial<Record<string, unknown>>>;
}

function formatSize(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function EditorIcon({ id }: { id: string }): React.ReactElement {
  if (id === 'cursor') {
    return (
      <span
        className="logs-editor-logo logs-editor-logo--cursor"
        dangerouslySetInnerHTML={{ __html: cursorLogoSrc as string }}
      />
    );
  }
  if (id === 'vscode' || id === 'vscode-insiders') {
    return <img src={vscodeLogo} alt="" width={13} height={13} />;
  }
  if (id === 'zed' || id === 'zed-preview') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="#9a62ff" />
        <path d="M8 8h8L8 16h8" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      </svg>
    );
  }
  if (id === 'windsurf') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 16c4-3 6-3 8 0s6 3 8 0" stroke="#39c4b5" strokeWidth="2" strokeLinecap="round" fill="none" />
        <path d="M4 10c4-3 6-3 8 0s6 3 8 0" stroke="#39c4b5" strokeWidth="2" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  if (id === 'sublime') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 5v14l14-4V1L5 5Z" fill="#FF9800" />
      </svg>
    );
  }
  if (['webstorm', 'intellij', 'intellij-ce', 'pycharm', 'pycharm-ce', 'rider', 'goland'].includes(id)) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="3" fill="#000" />
        <path d="M7 17h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 11.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function FinderIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 4.5v6A1.5 1.5 0 003.5 12h7A1.5 1.5 0 0012 10.5V5.5A1.5 1.5 0 0010.5 4H7L5.5 2.5h-2A1.5 1.5 0 002 4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

// Editor list is fetched once per logs-window lifetime; filter out
// blocklisted entries defensively on the renderer.
const EDITOR_BLOCKLIST = new Set(['xcode']);
let editorsPromise: Promise<Array<{ id: string; name: string }>> | null = null;
function getEditors(): Promise<Array<{ id: string; name: string }>> {
  if (!editorsPromise) {
    const base = window.electronAPI?.sessions.listEditors?.() ?? Promise.resolve([]);
    editorsPromise = base.then((list) => list.filter((e) => !EDITOR_BLOCKLIST.has(e.id)));
  }
  return editorsPromise;
}

function FileRow({ entry }: { entry: FileOutputEntry }): React.ReactElement {
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // Anchor coordinates for the portal-rendered menu. We render the menu via
  // createPortal so it escapes `.logs-files` (which has overflow-x: auto and
  // therefore clips on Y too — the menu would otherwise be invisible).
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void getEditors().then(setEditors).catch(() => setEditors([])); }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideButton = buttonRef.current?.contains(target);
      const insideMenu = menuPortalRef.current?.contains(target);
      if (!insideButton && !insideMenu) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const openMenu = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      // Place the menu's bottom 4px above the button's top, left-aligned to
      // the button. Coordinates are viewport-relative; portal renders into
      // document.body so they map directly.
      setMenuAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    }
    setMenuOpen(true);
  }, []);
  const toggleMenu = useCallback(() => {
    if (menuOpen) setMenuOpen(false);
    else openMenu();
  }, [menuOpen, openMenu]);

  const onOpenInEditor = useCallback(async (editorId: string) => {
    console.log('[LogsApp file] onOpenInEditor click', { editorId, path: entry.path });
    if (!entry.path) {
      console.warn('[LogsApp file] entry.path is falsy; aborting');
      return;
    }
    setMenuOpen(false);
    const api = window.electronAPI?.sessions?.openInEditor;
    if (!api) {
      console.error('[LogsApp file] window.electronAPI.sessions.openInEditor is undefined — preload bridge missing');
      return;
    }
    try {
      const res = await api(editorId, entry.path);
      console.log('[LogsApp file] openInEditor success', res);
    } catch (err) {
      console.error('[LogsApp file] openInEditor failed', err);
      try { await window.electronAPI?.sessions?.revealOutput?.(entry.path); }
      catch (revealErr) { console.error('[LogsApp file] reveal fallback also failed', revealErr); }
    }
  }, [entry.path]);

  const onReveal = useCallback(async () => {
    if (!entry.path) return;
    setMenuOpen(false);
    try { await window.electronAPI?.sessions.revealOutput(entry.path); }
    catch (err) { console.error('[LogsApp file] reveal failed', err); }
  }, [entry.path]);

  return (
    <div className="logs-file-row-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="logs-file-row"
        onClick={(e) => { e.stopPropagation(); toggleMenu(); }}
        title={entry.path}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M8 1.5H4a1.5 1.5 0 00-1.5 1.5v8A1.5 1.5 0 004 12.5h6a1.5 1.5 0 001.5-1.5V5L8 1.5z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M8 1.5V5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <span className="logs-file-row__name">{entry.name}</span>
        <span className="logs-file-row__size">{formatSize(entry.size)}</span>
        <span className="logs-file-row__caret">{'▾'}</span>
      </button>
      {menuOpen && menuAnchor && createPortal(
        <div
          ref={menuPortalRef}
          className="logs-file-menu"
          role="menu"
          style={{ position: 'fixed', left: menuAnchor.left, bottom: menuAnchor.bottom }}
        >
          {editors.map((ed) => (
            <button
              key={ed.id}
              role="menuitem"
              className="logs-file-menu__item"
              onClick={() => onOpenInEditor(ed.id)}
            >
              <span className="logs-file-menu__icon"><EditorIcon id={ed.id} /></span>
              <span>Open in {ed.name}</span>
            </button>
          ))}
          {editors.length > 0 && <div className="logs-file-menu__sep" />}
          <button
            role="menuitem"
            className="logs-file-menu__item"
            onClick={onReveal}
          >
            <span className="logs-file-menu__icon"><FinderIcon /></span>
            <span>Reveal in Finder</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

export function LogsApp(): React.ReactElement {
  console.log('[LogsApp] render');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setModeState] = useState<'dot' | 'normal' | 'full'>('normal');
  const [files, setFiles] = useState<FileOutputEntry[]>([]);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    console.log('[LogsApp] mount');
    const unsub = window.logsAPI.onActiveSessionChanged((id) => {
      console.log('[LogsApp] active-session-changed', { id });
      setSessionId(id);
    });
    return unsub;
  }, []);

  // Pressing 'f' on a hub card tells the logs window to focus its follow-up
  // input. rAF so the mode-change → re-render settles before focus(), else
  // the textarea may not be in the DOM yet when coming from dot mode.
  useEffect(() => {
    return window.logsAPI.onFocusFollowUp(() => {
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, []);

  // Auto-grow the follow-up textarea upward as the user types multi-line
  // input. Cap at window-height minus the header so the textarea never
  // pushes the output area offscreen; beyond that it scrolls internally.
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = Math.max(72, window.innerHeight - 80);
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  }, [input]);

  // Auto-focus the follow-up textarea on active-session switch so the user
  // can start typing immediately after clicking a card. Skip when the logs
  // are collapsed (dot has no input) or the session is ended (textarea
  // replaced with "Session ended" label). rAF lets the sessionStatus state
  // update settle first.
  useEffect(() => {
    if (!sessionId) return;
    if (mode === 'dot') return;
    if (sessionStatus === 'stopped') return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [sessionId, mode, sessionStatus]);

  useEffect(() => {
    const unsub = window.logsAPI.onModeChanged((m) => {
      console.log('[LogsApp] mode-changed', { mode: m });
      setModeState(m);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI?.on.sessionUpdated?.((raw) => {
      const session = raw as SessionShape;
      if (!session || session.id !== sessionId) return;
      const out = session.output ?? [];
      const fileEntries: FileOutputEntry[] = out
        .filter((e) => (e as { type?: string }).type === 'file_output')
        .map((e) => {
          const f = e as unknown as { name: string; path: string; size: number; mime: string };
          return { type: 'file_output' as const, name: f.name, path: f.path, size: f.size, mime: f.mime };
        });
      setFiles(fileEntries);
      const doneEv = [...out].reverse().find((e) => (e as { type?: string }).type === 'done') as
        | { type: 'done'; summary?: string; iterations?: number }
        | undefined;
      setDone(doneEv ? { summary: String(doneEv.summary ?? 'Task completed'), iterations: Number(doneEv.iterations ?? 0) } : null);
      setErrorMsg(session.error ?? null);
      setSessionStatus(session.status ?? null);
    });
    return unsub;
  }, [sessionId]);

  // SessionManager.appendOutput emits `session-output` but NOT `session-updated`,
  // so without this subscription file rows only appear after the next status
  // transition (or a session switch). Listen to the per-event stream and
  // append file_output events as they arrive; dedupe by path in case an event
  // is delivered twice.
  useEffect(() => {
    if (!sessionId) return;
    const unsub = window.electronAPI?.on.sessionOutput?.((id, event) => {
      if (id !== sessionId) return;
      if ((event as { type?: string }).type !== 'file_output') return;
      const ev = event as unknown as FileOutputEntry;
      setFiles((prev) => {
        if (prev.some((f) => f.path === ev.path)) return prev;
        return [...prev, { type: 'file_output', name: ev.name, path: ev.path, size: ev.size, mime: ev.mime }];
      });
    });
    return unsub;
  }, [sessionId]);

  // Reset + initial-fetch file list on session switch so:
  //  (a) stale rows from the previous session don't leak across, and
  //  (b) if the session already produced files BEFORE the logs window
  //      subscribed (or if session-updated isn't firing mid-stream), we
  //      still show what's there.
  useEffect(() => {
    setFiles([]);
    setDone(null);
    setErrorMsg(null);
    setSessionStatus(null);
    if (!sessionId) return;
    let cancelled = false;
    void window.electronAPI?.sessions.get(sessionId).then((raw) => {
      if (cancelled) return;
      const session = raw as SessionShape | null;
      const out = session?.output ?? [];
      const fileEntries: FileOutputEntry[] = out
        .filter((e) => (e as { type?: string }).type === 'file_output')
        .map((e) => {
          const f = e as unknown as { name: string; path: string; size: number; mime: string };
          return { type: 'file_output' as const, name: f.name, path: f.path, size: f.size, mime: f.mime };
        });
      setFiles(fileEntries);
      const doneEv = [...out].reverse().find((e) => (e as { type?: string }).type === 'done') as
        | { type: 'done'; summary?: string; iterations?: number }
        | undefined;
      setDone(doneEv ? { summary: String(doneEv.summary ?? 'Task completed'), iterations: Number(doneEv.iterations ?? 0) } : null);
      setErrorMsg(session?.error ?? null);
      setSessionStatus(session?.status ?? null);
    }).catch((err) => console.error('[LogsApp] sessions.get failed', err));
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mode === 'dot') return;
        // Step down one size per Esc press: full → normal → dot. Jumping
        // full → dot in one keystroke skips the card view the user most
        // often wants when exiting a deep-dive read.
        window.logsAPI.setMode(mode === 'full' ? 'normal' : 'dot');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  const onExpandFromDot = useCallback(() => { window.logsAPI.setMode('normal'); }, []);
  // Minus steps down one size: full → normal (card), normal → dot. Going
  // full → dot in one click skips the card view the user most often wants.
  const onMinimize = useCallback(() => {
    window.logsAPI.setMode(mode === 'full' ? 'normal' : 'dot');
  }, [mode]);
  const onToggleFull = useCallback(() => {
    window.logsAPI.setMode(mode === 'full' ? 'normal' : 'full');
  }, [mode]);

  const sendFollowUp = useCallback(async () => {
    if (!sessionId) return;
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await window.logsAPI.followUp(sessionId, trimmed);
      setInput('');
    } catch (err) {
      console.error('[LogsApp] follow-up failed', err);
    } finally {
      setSending(false);
    }
  }, [sessionId, input, sending]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendFollowUp();
      }
    },
    [sendFollowUp],
  );

  const hasFiles = files.length > 0;
  const cappedFiles = useMemo(() => files.slice(-5), [files]);

  if (mode === 'dot') {
    return (
      <button
        type="button"
        className="logs-dot"
        onClick={onExpandFromDot}
        aria-label="Expand logs"
        title="Expand logs"
      >
        <span className="logs-dot__pulse" />
      </button>
    );
  }

  return (
    <div className={`logs-root${mode === 'full' ? ' logs-root--full' : ''}`}>
      <header className="logs-header">
        <span className="logs-header__title">Logs</span>
        <div className="logs-header__actions">
          <button
            type="button"
            className="logs-header__btn"
            onClick={onMinimize}
            aria-label="Minimize to dot"
            title="Minimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 7h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="logs-header__btn"
            onClick={onToggleFull}
            aria-label={mode === 'full' ? 'Restore size' : 'Expand to full pane'}
            title={mode === 'full' ? 'Restore' : 'Expand'}
          >
            {mode === 'full' ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="2.5" y="2.5" width="5" height="5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="logs-header__btn"
            onClick={() => window.logsAPI.close()}
            aria-label="Close"
            title="Close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      <div className="logs-term">
        {sessionId ? (
          <TerminalPane key={sessionId} sessionId={sessionId} />
        ) : (
          <div className="logs-empty">waiting for session…</div>
        )}
      </div>
      {hasFiles && (
        <div className="logs-files" aria-label="Produced files">
          {cappedFiles.map((f, i) => <FileRow key={`${f.path}-${i}`} entry={f} />)}
        </div>
      )}
      {sessionStatus === 'stopped' ? (
        <div className="logs-followup logs-followup--ended" aria-live="polite">
          <span className="logs-followup__ended-label">Session ended</span>
        </div>
      ) : (
        <form
          className="logs-followup"
          onSubmit={(e) => { e.preventDefault(); void sendFollowUp(); }}
        >
          <span className="logs-followup__chevron">&rsaquo;</span>
          <textarea
            ref={inputRef}
            className="logs-followup__input"
            value={input}
            placeholder={sessionId ? 'Follow up…' : 'No session'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            rows={1}
            disabled={!sessionId || sending}
          />
        </form>
      )}
    </div>
  );
}

export default LogsApp;
