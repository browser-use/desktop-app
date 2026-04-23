import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  classifyAttachmentMime,
  maxBytesForAttachmentMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
  formatBytes,
} from '../../shared/attachments';
import { EnginePicker } from '../hub/EnginePicker';

declare global {
  interface Window {
    pillAPI: {
      submit: (
        prompt: string,
        attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
        engine?: string,
      ) => Promise<{ task_id: string }>;
      hide: () => void;
      setExpanded: (expanded: boolean | number) => void;
      listSessions: () => Promise<Array<{ id: string; prompt: string; status: string; createdAt: number }>>;
      selectSession: (id: string) => void;
      followUpSubmit: (
        sessionId: string,
        prompt: string,
        attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
      ) => Promise<{ resumed?: boolean; error?: string }>;
      onFollowUpMode: (cb: (data: { sessionId: string; sessionPrompt: string }) => void) => () => void;
      // Mode management
      setMode?: (mode: 'pill' | 'panel' | 'hidden') => Promise<{ mode: string }>;
      getMode?: () => Promise<'pill' | 'panel' | 'hidden'>;
      onPillModeChanged?: (cb: (mode: 'pill' | 'panel' | 'hidden') => void) => () => void;
      // Active session
      setActiveSession?: (id: string | null) => Promise<{ ok: boolean }>;
      getActiveSession?: () => Promise<string | null>;
      onActiveSessionChanged?: (cb: (id: string | null) => void) => () => void;
    };
  }
}

function PaperclipIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9.5 3.5L4.5 8.5a2 2 0 1 0 2.83 2.83L11.5 7.5a3 3 0 0 0-4.24-4.24L2.5 8.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PillCloseIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

interface SessionLite {
  id: string;
  prompt: string;
  status: string;
  createdAt: number;
}

function ArrowUpIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12V3M3 6.5L7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fuzzyMatch(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => lower.includes(t));
}

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function statusDot(status: string): string {
  switch (status) {
    case 'running': return 'cmdbar__dot--running';
    case 'stuck': return 'cmdbar__dot--stuck';
    case 'idle': return 'cmdbar__dot--idle';
    case 'draft': return 'cmdbar__dot--draft';
    default: return 'cmdbar__dot--stopped';
  }
}

export function Pill(): React.ReactElement {
  const [value, setValue] = useState('');
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [followUp, setFollowUp] = useState<{ sessionId: string; sessionPrompt: string } | null>(null);
  const [engine, setEngine] = useState<string>('claude-code');
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ name: string; mime: string; bytes: Uint8Array }>>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 50);
    window.pillAPI.listSessions().then(setSessions).catch(() => {});
    const unsub = window.pillAPI.onFollowUpMode((data) => {
      setFollowUp(data);
      setValue('');
      setAttachments([]);
      setAttachError(null);
      setTimeout(() => ref.current?.focus(), 50);
    });
    return unsub;
  }, []);

  useEffect(() => {
    setSelectedIdx(0);
  }, [value]);

  const results = useMemo(() => {
    if (!value.trim()) return [];
    return sessions
      .filter((s) => fuzzyMatch(value, s.prompt))
      .slice(0, 8);
  }, [value, sessions]);

  const hasResults = results.length > 0;

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
    }
    const textareaHeight = ta ? Math.min(ta.scrollHeight, 240) : 28;
    const baseHeight = 82 + textareaHeight;
    const resultHeight = hasResults ? Math.min(results.length + 1, 9) * 36 + 2 : 0;
    // Chips row is ~24px; wraps every ~3 chips. Error row adds ~18px.
    const chipsRows = attachments.length > 0 ? Math.ceil(attachments.length / 3) : 0;
    const chipsHeight = chipsRows * 26;
    const errorHeight = attachError ? 20 : 0;
    window.pillAPI.setExpanded(baseHeight + resultHeight + chipsHeight + errorHeight);
  }, [hasResults, results.length, value, attachments.length, attachError]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setAttachError(null);
    const list = Array.from(files);
    const next = [...attachments];
    let total = next.reduce((s, a) => s + a.bytes.byteLength, 0);
    for (const f of list) {
      if (next.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        setAttachError(`Max ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
        break;
      }
      const mime = f.type || 'application/octet-stream';
      if (classifyAttachmentMime(mime) === null) {
        setAttachError(`Unsupported: ${mime || 'unknown'} (${f.name})`);
        continue;
      }
      const max = maxBytesForAttachmentMime(mime) ?? 0;
      if (f.size > max) {
        setAttachError(`${f.name} exceeds ${formatBytes(max)}`);
        continue;
      }
      if (f.size === 0) {
        setAttachError(`${f.name} is empty`);
        continue;
      }
      if (total + f.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        setAttachError(`Total exceeds ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}`);
        break;
      }
      const buf = await f.arrayBuffer();
      next.push({ name: f.name, mime, bytes: new Uint8Array(buf) });
      total += f.size;
    }
    setAttachments(next);
  }, [attachments]);

  const removeAttachment = useCallback((i: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    if (followUp) {
      window.pillAPI.followUpSubmit(followUp.sessionId, trimmed, attachments.length > 0 ? attachments : undefined);
      setValue('');
      setAttachments([]);
      setAttachError(null);
      setFollowUp(null);
      window.pillAPI.hide();
      return;
    }
    if (!trimmed) return;
    const attachArg = attachments.length > 0 ? attachments : undefined;
    if (hasResults && selectedIdx === 0) {
      window.pillAPI.submit(trimmed, attachArg, engine);
      setValue('');
      setAttachments([]);
      setAttachError(null);
      return;
    }
    if (hasResults && selectedIdx > 0 && selectedIdx <= results.length) {
      window.pillAPI.selectSession(results[selectedIdx - 1].id);
      setValue('');
      return;
    }
    window.pillAPI.submit(trimmed, attachArg, engine);
    setValue('');
    setAttachments([]);
    setAttachError(null);
  }, [value, hasResults, selectedIdx, results, followUp, attachments, engine]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFollowUp(null);
        setValue('');
        setAttachments([]);
        setAttachError(null);
        window.pillAPI.hide();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          const attachArg = attachments.length > 0 ? attachments : undefined;
          window.pillAPI.submit(trimmed, attachArg, engine);
          setValue('');
          setAttachments([]);
          setAttachError(null);
        }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit, value, results.length, attachments, engine],
  );

  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
      ref.current?.focus();
    }
  }, [addFiles]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  return (
    <div className="cmdbar__scrim" onClick={() => window.pillAPI.hide()}>
      <div
        className={`cmdbar${isDragging ? ' cmdbar--dragging' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
      >
        <div className="cmdbar__drag-handle" />
        {isDragging && (
          <div className="cmdbar__drop-overlay">Drop files to attach</div>
        )}
        {attachments.length > 0 && (
          <div className="cmdbar__chips">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="cmdbar__chip" title={`${a.mime} · ${formatBytes(a.bytes.byteLength)}`}>
                <span className="cmdbar__chip-name">{a.name}</span>
                <button
                  type="button"
                  className="cmdbar__chip-remove"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${a.name}`}
                >
                  <PillCloseIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError && <div className="cmdbar__error">{attachError}</div>}
        <div className="cmdbar__input-row">
          <textarea
            ref={ref}
            className="cmdbar__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={followUp ? `Follow up on: ${followUp.sessionPrompt.slice(0, 40)}${followUp.sessionPrompt.length > 40 ? '...' : ''}` : 'Search sessions or create new agent...'}
            rows={1}
            aria-label="Search or create"
          />
          <button
            type="button"
            className="cmdbar__attach has-tooltip"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            data-tooltip="Attach files"
          >
            <PaperclipIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {!followUp && (
            <div className="cmdbar__engine-picker">
              <EnginePicker value={engine} onChange={setEngine} onOpenChange={setEngineMenuOpen} />
            </div>
          )}
          <button
            className="cmdbar__send"
            onClick={submit}
            disabled={!value.trim() && attachments.length === 0}
            aria-label="Submit"
          >
            <ArrowUpIcon />
          </button>
        </div>

        {hasResults && !followUp && (
          <div className="cmdbar__results">
            <button
              className={`cmdbar__result cmdbar__result--create${selectedIdx === 0 ? ' cmdbar__result--active' : ''}`}
              onClick={submit}
              onMouseEnter={() => setSelectedIdx(0)}
            >
              <span className="cmdbar__result-create-icon">+</span>
              <span className="cmdbar__result-prompt">New agent: &ldquo;{value}&rdquo;</span>
              <kbd className="cmdbar__result-kbd">{'\u2318\u21B5'}</kbd>
            </button>
            {results.map((s, i) => (
              <button
                key={s.id}
                className={`cmdbar__result${i + 1 === selectedIdx ? ' cmdbar__result--active' : ''}`}
                onClick={() => { window.pillAPI.selectSession(s.id); setValue(''); }}
                onMouseEnter={() => setSelectedIdx(i + 1)}
              >
                <span className={`cmdbar__dot ${statusDot(s.status)}`} />
                <span className="cmdbar__result-prompt">{s.prompt}</span>
                <span className="cmdbar__result-time">{formatElapsed(s.createdAt)}</span>
                <span className="cmdbar__result-status">{s.status}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cmdbar__footer">
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">Enter</kbd> {followUp ? 'follow up' : hasResults ? 'select' : 'create'}
          </span>
          {hasResults && !followUp && (
            <span className="cmdbar__hint">
              <kbd className="cmdbar__kbd">{'\u2318\u21B5'}</kbd> new agent
            </span>
          )}
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">Esc</kbd> {followUp ? 'cancel' : 'close'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default Pill;
