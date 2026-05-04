import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  maxBytesForAttachmentMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_BYTES,
  formatBytes,
} from '../../shared/attachments';
import { fallbackShortcutPlatform, formatShortcutForPlatform } from '../../shared/hotkeys';
import { EnginePicker } from '../hub/EnginePicker';
import { BrowserCodeModelPicker } from '../hub/BrowserCodeModelPicker';
import {
  RESULT_ROW_HEIGHT,
  MAX_RESULTS,
  SEARCH_ROW_HEIGHT,
  FOOTER_HEIGHT,
  CHIP_ROW_HEIGHT,
  ERROR_ROW_HEIGHT,
  TEXTAREA_MIN_HEIGHT,
  TEXTAREA_MAX_HEIGHT,
  MAX_RECENTS,
  ACTIONS_ROW_HEIGHT,
  SECTION_HEADER_HEIGHT,
  MAX_VISIBLE_FAVICONS,
} from './constants';

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
      listSessions: () => Promise<Array<{ id: string; prompt: string; status: string; createdAt: number; primarySite?: string | null; lastActivityAt?: number }>>;
      selectSession: (id: string) => void;
      openHub?: () => void;
      openSettings?: () => void;
      setMode?: (mode: 'pill' | 'panel' | 'hidden') => Promise<{ mode: string }>;
      getMode?: () => Promise<'pill' | 'panel' | 'hidden'>;
      onPillModeChanged?: (cb: (mode: 'pill' | 'panel' | 'hidden') => void) => () => void;
      onShown?: (cb: () => void) => () => void;
      setActiveSession?: (id: string | null) => Promise<{ ok: boolean }>;
      getActiveSession?: () => Promise<string | null>;
      onActiveSessionChanged?: (cb: (id: string | null) => void) => () => void;
    };
  }
}

interface SessionLite {
  id: string;
  prompt: string;
  status: string;
  createdAt: number;
  primarySite?: string | null;
  lastActivityAt?: number;
}

function cleanDomain(site: string | null | undefined): string | null {
  if (!site) return null;
  try {
    const input = site.trim().toLowerCase();
    if (!input) return null;
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const hostname = url.hostname.replace(/\.$/, '');
    const validDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    return validDomain.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

const FAVICON_SIZE = 64;

function faviconUrl(site: string | null | undefined): string | null {
  const clean = cleanDomain(site);
  if (!clean) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(clean)}&sz=${FAVICON_SIZE}`;
}

const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/i;
const DOMAIN_RE_GLOBAL = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi;
const ENGINE_STORAGE_KEY = 'hub.selectedEngine';
const DEFAULT_ENGINE = 'claude-code';

function loadStoredEngine(): string {
  try {
    const value = localStorage.getItem(ENGINE_STORAGE_KEY);
    return value && value.length > 0 ? value : DEFAULT_ENGINE;
  } catch {
    return DEFAULT_ENGINE;
  }
}

function extractDomain(text: string): string | null {
  if (!text) return null;
  const m = text.match(DOMAIN_RE);
  return m ? m[1].toLowerCase() : null;
}

function extractDomains(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(DOMAIN_RE_GLOBAL)) {
    const d = m[1].toLowerCase();
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function TerminalFallbackIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 6l2 1.5L4 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 9h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

const STATUS_DOT_COLOR: Record<string, string> = {
  running: 'var(--color-status-success)',
  idle:    'var(--color-status-warning)',
  stuck:   'var(--color-status-error)',
  stopped: 'var(--color-fg-tertiary)',
  draft:   'var(--color-fg-disabled)',
};

function SearchIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
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

function ArrowUpIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12V3M3 6.5L7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.5 2.5l1 1M8.5 8.5l1 1M9.5 2.5l-1 1M3.5 8.5l-1 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function OpenHubIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
      <path d="M4.5 2H2v8h8V7.5M6.5 2H10v3.5M5 7l5-5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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

function statusLabel(status: string): string {
  switch (status) {
    case 'running': return 'running';
    case 'stuck': return 'stuck';
    case 'idle': return 'idle';
    case 'draft': return 'draft';
    case 'stopped': return 'stopped';
    default: return status;
  }
}

export function Pill(): React.ReactElement {
  const [value, setValue] = useState('');
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [engine, setEngine] = useState<string>(() => loadStoredEngine());
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ name: string; mime: string; bytes: Uint8Array }>>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [validFavicons, setValidFavicons] = useState<Set<string>>(new Set());
  const checkedDomainsRef = useRef<Set<string>>(new Set());
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const platform = window.electronAPI?.shell?.platform ?? fallbackShortcutPlatform();
  const formatShortcut = useCallback((shortcut: string) => formatShortcutForPlatform(shortcut, platform), [platform]);

  useEffect(() => {
    const refetch = (): void => {
      window.pillAPI.listSessions().then(setSessions).catch(() => {});
    };
    setTimeout(() => ref.current?.focus(), 50);
    refetch();
    const unsub = window.pillAPI.onShown?.(() => {
      setTimeout(() => ref.current?.focus(), 50);
      refetch();
    });
    return () => { unsub?.(); };
  }, []);

  useEffect(() => {
    setSelectedIdx(-1);
  }, [value]);

  const results = useMemo(() => {
    if (!value.trim()) return [];
    return sessions
      .filter((s) => fuzzyMatch(value, s.prompt))
      .slice(0, MAX_RESULTS);
  }, [value, sessions]);

  const hasResults = results.length > 0;

  const recents = useMemo(() => {
    if (value.trim()) return [];
    const ACTIVE = new Set(['running', 'idle', 'stuck']);
    return [...sessions]
      .sort((a, b) => {
        const aActive = ACTIVE.has(a.status) ? 1 : 0;
        const bActive = ACTIVE.has(b.status) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt);
      })
      .slice(0, MAX_RECENTS);
  }, [value, sessions]);

  const showDashboard = !value.trim();
  const hasRecents = showDashboard && recents.length > 0;

  const navList = hasResults ? results : recents;

  const detectedDomains = useMemo(() => extractDomains(value), [value]);

  useEffect(() => {
    const candidates = new Set<string>();
    for (const d of detectedDomains) candidates.add(d);
    for (const s of sessions) {
      const d = cleanDomain(s.primarySite ?? extractDomain(s.prompt));
      if (d) candidates.add(d);
    }
    for (const domain of candidates) {
      if (checkedDomainsRef.current.has(domain)) continue;
      checkedDomainsRef.current.add(domain);
      const url = faviconUrl(domain);
      if (!url) continue;
      const img = new Image();
      img.onload = () => {
        // Google's globe fallback always renders at 16x16 even when sz=64
        // is requested; real favicons come back at 32x32 or 64x64.
        const valid = img.naturalWidth >= 32 && img.naturalHeight >= 32;
        console.log(`[Pill] favicon probe ${JSON.stringify({
          domain,
          naturalW: img.naturalWidth,
          naturalH: img.naturalHeight,
          valid,
        })}`);
        if (valid) {
          setValidFavicons((prev) => {
            if (prev.has(domain)) return prev;
            const next = new Set(prev);
            next.add(domain);
            return next;
          });
        }
      };
      img.onerror = () => {
        console.log(`[Pill] favicon probe error ${JSON.stringify({ domain })}`);
      };
      img.src = url;
    }
  }, [detectedDomains, sessions]);

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
    }
    const taHeight = ta
      ? Math.max(TEXTAREA_MIN_HEIGHT, Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT))
      : TEXTAREA_MIN_HEIGHT;
    const searchHeight = Math.max(SEARCH_ROW_HEIGHT, taHeight + 36);
    const resultHeight = hasResults ? Math.min(results.length, MAX_RESULTS) * RESULT_ROW_HEIGHT + 12 : 0;
    const dashboardHeight = showDashboard
      ? ACTIONS_ROW_HEIGHT + (hasRecents ? SECTION_HEADER_HEIGHT + recents.length * RESULT_ROW_HEIGHT + 8 : 0)
      : 0;
    const chipsRows = attachments.length > 0 ? Math.ceil(attachments.length / 3) : 0;
    const chipsHeight = chipsRows * CHIP_ROW_HEIGHT;
    const errorHeight = attachError ? ERROR_ROW_HEIGHT : 0;
    const dropdownHeight = engineMenuOpen || modelMenuOpen ? 220 : 0;
    const total = searchHeight + resultHeight + dashboardHeight + chipsHeight + errorHeight + FOOTER_HEIGHT + dropdownHeight;
    console.log('[Pill.resize]', { taHeight, searchHeight, resultHeight, dashboardHeight, chipsHeight, errorHeight, dropdownHeight, total });
    window.pillAPI.setExpanded(total);
  }, [hasResults, results.length, value, attachments.length, attachError, showDashboard, hasRecents, recents.length, engineMenuOpen, modelMenuOpen]);

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
      const max = maxBytesForAttachmentMime(mime);
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

  const handleEngineChange = useCallback((id: string) => {
    setEngine(id);
    try { localStorage.setItem(ENGINE_STORAGE_KEY, id); } catch { /* ignore */ }
  }, []);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0 && !(showDashboard && selectedIdx >= 0)) return;
    if (selectedIdx >= 0 && selectedIdx < navList.length) {
      window.pillAPI.selectSession(navList[selectedIdx].id);
      setValue('');
      return;
    }
    if (!trimmed) return;
    const attachArg = attachments.length > 0 ? attachments : undefined;
    window.pillAPI.submit(trimmed, attachArg, engine);
    setValue('');
    setAttachments([]);
    setAttachError(null);
  }, [value, selectedIdx, navList, showDashboard, attachments, engine]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        setAttachments([]);
        setAttachError(null);
        window.pillAPI.hide();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, navList.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, -1));
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
    [submit, value, navList.length, attachments, engine],
  );

  const highlightVisible = hasResults && selectedIdx >= 0;
  const highlightTop = selectedIdx * RESULT_ROW_HEIGHT;

  return (
    <div className="cmdbar__scrim" onClick={() => window.pillAPI.hide()}>
      <div className="cmdbar" onClick={(e) => e.stopPropagation()}>
        <div className="cmdbar__drag-handle" />

        <div className="cmdbar__search">
          {(() => {
            const valid = detectedDomains.filter((d) => validFavicons.has(d));
            return (
              <span
                className={`cmdbar__search-icon${valid.length > 0 ? ' cmdbar__search-icon--favicons' : ''}`}
                aria-hidden="true"
              >
                {valid.length > 0 ? (
                  <span className="cmdbar__search-favicons">
                    {valid.slice(0, MAX_VISIBLE_FAVICONS).map((d) => (
                      <img
                        key={d}
                        src={faviconUrl(d) ?? ''}
                        alt=""
                        width={18}
                        height={18}
                        className="cmdbar__search-favicon"
                      />
                    ))}
                    {valid.length > MAX_VISIBLE_FAVICONS && (
                      <span className="cmdbar__search-favicon-more">
                        +{valid.length - MAX_VISIBLE_FAVICONS}
                      </span>
                    )}
                  </span>
                ) : (
                  <SearchIcon />
                )}
              </span>
            );
          })()}
          <textarea
            ref={ref}
            className="cmdbar__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sessions or create new agent..."
            rows={1}
            aria-label="Search or create"
          />
          <div className="cmdbar__search-actions">
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
            <div className="cmdbar__engine-picker">
              <EnginePicker value={engine} onChange={handleEngineChange} onOpenChange={setEngineMenuOpen} />
              <BrowserCodeModelPicker visible={engine === 'browsercode'} compact onOpenChange={setModelMenuOpen} />
            </div>
            <button
              className="cmdbar__send"
              onClick={submit}
              disabled={!value.trim() && attachments.length === 0}
              aria-label="Submit"
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>

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

        {showDashboard && (
          <div className="cmdbar__dashboard">
            <div className="cmdbar__actions">
              <button
                type="button"
                className="cmdbar__action-chip"
                onClick={() => { window.pillAPI.openHub?.(); }}
              >
                <span className="cmdbar__action-icon"><OpenHubIcon /></span>
                Open hub
              </button>
              <button
                type="button"
                className="cmdbar__action-chip"
                onClick={() => { window.pillAPI.openSettings?.(); }}
              >
                <span className="cmdbar__action-icon"><GearIcon /></span>
                Settings
              </button>
            </div>

            {hasRecents && (
              <>
                <div className="cmdbar__section-header">Recent</div>
                <div className="cmdbar__recents">
                  {recents.map((s, i) => {
                    const domain = cleanDomain(s.primarySite ?? extractDomain(s.prompt));
              const favicon = domain && validFavicons.has(domain) ? faviconUrl(domain) : null;
                    const dotColor = STATUS_DOT_COLOR[s.status] ?? STATUS_DOT_COLOR.stopped;
                    const last = s.lastActivityAt ?? s.createdAt;
                    return (
                      <button
                        key={s.id}
                        className={`cmdbar__result${selectedIdx === i ? ' cmdbar__result--active' : ''}`}
                        style={{ animationDelay: `${i * 30}ms` }}
                        onClick={() => { window.pillAPI.selectSession(s.id); }}
                      >
                        <span className="cmdbar__row-icon">
                          {favicon ? (
                            <img src={favicon} alt="" width={18} height={18} />
                          ) : (
                            <span className="cmdbar__row-icon-fallback" aria-hidden="true">
                              <TerminalFallbackIcon />
                            </span>
                          )}
                          <span className="cmdbar__row-dot" style={{ background: dotColor }} aria-label={statusLabel(s.status)} />
                        </span>
                        <span className="cmdbar__result-prompt">{s.prompt}</span>
                        <span className="cmdbar__result-time">{formatElapsed(last)}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {hasResults && (
          <div className="cmdbar__results">
            <div
              className="cmdbar__highlight"
              style={{
                transform: `translateY(${highlightTop}px)`,
                opacity: highlightVisible ? 1 : 0,
              }}
              aria-hidden="true"
            />
            {results.map((s, i) => {
              const domain = cleanDomain(s.primarySite ?? extractDomain(s.prompt));
              const favicon = domain && validFavicons.has(domain) ? faviconUrl(domain) : null;
              const dotColor = STATUS_DOT_COLOR[s.status] ?? STATUS_DOT_COLOR.stopped;
              const last = s.lastActivityAt ?? s.createdAt;
              return (
                <button
                  key={s.id}
                  className="cmdbar__result"
                  style={{ animationDelay: `${i * 30}ms` }}
                  onClick={() => { window.pillAPI.selectSession(s.id); setValue(''); }}
                >
                  <span className="cmdbar__row-icon">
                    {favicon ? (
                      <img src={favicon} alt="" width={18} height={18} />
                    ) : (
                      <span className="cmdbar__row-icon-fallback" aria-hidden="true">
                        <TerminalFallbackIcon />
                      </span>
                    )}
                    <span className="cmdbar__row-dot" style={{ background: dotColor }} aria-label={statusLabel(s.status)} />
                  </span>
                  <span className="cmdbar__result-prompt">{s.prompt}</span>
                  <span className="cmdbar__result-time">{formatElapsed(last)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="cmdbar__footer">
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">↵</kbd>
            {hasResults && selectedIdx >= 0 ? 'open' : 'create'}
          </span>
          {hasResults && (
            <span className="cmdbar__hint">
              <kbd className="cmdbar__kbd">{formatShortcut('CommandOrControl+Enter')}</kbd>
              new agent
            </span>
          )}
          <span className="cmdbar__hint">
            <kbd className="cmdbar__kbd">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}

export default Pill;
