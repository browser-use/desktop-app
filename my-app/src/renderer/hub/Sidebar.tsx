import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, SessionStatus } from './types';

interface SidebarSession extends AgentSession {
  primarySite?: string | null;
  lastActivityAt?: number;
}

export type SidebarRowAction = 'rerun' | 'stop';

interface SidebarProps {
  sessions?: SidebarSession[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onNewAgent?: () => void;
  onRowAction?: (id: string, action: SidebarRowAction) => void;
}

const MOCK_SIDEBAR_SESSIONS: SidebarSession[] = [
  {
    id: 'mock-1',
    prompt: 'Reply to unread DMs on LinkedIn',
    status: 'running',
    createdAt: Date.now() - 1000 * 60 * 4,
    output: [],
    primarySite: 'linkedin.com',
    lastActivityAt: Date.now() - 1000 * 5,
  },
  {
    id: 'mock-2',
    prompt: 'Summarize latest X notifications',
    status: 'idle',
    createdAt: Date.now() - 1000 * 60 * 12,
    output: [],
    primarySite: 'x.com',
    lastActivityAt: Date.now() - 1000 * 60 * 2,
  },
  {
    id: 'mock-3',
    prompt: 'Find 10 SaaS founders hiring eng managers',
    status: 'stuck',
    createdAt: Date.now() - 1000 * 60 * 30,
    output: [],
    primarySite: 'google.com',
    lastActivityAt: Date.now() - 1000 * 60 * 8,
  },
  {
    id: 'mock-4',
    prompt: 'Draft a reply to Jessica from Tuesday',
    status: 'stopped',
    createdAt: Date.now() - 1000 * 60 * 60 * 2,
    output: [],
    primarySite: 'gmail.com',
    lastActivityAt: Date.now() - 1000 * 60 * 55,
  },
  {
    id: 'mock-5',
    prompt: 'Check Reddit for competitor mentions',
    status: 'stopped',
    createdAt: Date.now() - 1000 * 60 * 60 * 5,
    output: [],
    primarySite: 'reddit.com',
    lastActivityAt: Date.now() - 1000 * 60 * 60 * 4,
  },
  {
    id: 'mock-6',
    prompt: 'Old calendar cleanup run',
    status: 'stopped',
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    output: [],
    primarySite: 'calendar.google.com',
    lastActivityAt: Date.now() - 1000 * 60 * 60 * 23,
  },
];

const STATUS_DOT: Record<SessionStatus, { color: string; label: string }> = {
  running: { color: '#3fb950', label: 'Running' },
  idle:    { color: '#d29922', label: 'Waiting for input' },
  stuck:   { color: '#f85149', label: 'Stuck' },
  stopped: { color: '#6e7681', label: 'Stopped' },
  draft:   { color: '#6e7681', label: 'Draft' },
};

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  const m = Math.floor(delta / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function faviconUrl(site: string | null | undefined): string | null {
  if (!site) return null;
  const clean = site.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://www.google.com/s2/favicons?domain=${clean}&sz=64`;
}

function PlusIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
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

function MoreIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="3" cy="7" r="1.1" fill="currentColor" />
      <circle cx="7" cy="7" r="1.1" fill="currentColor" />
      <circle cx="11" cy="7" r="1.1" fill="currentColor" />
    </svg>
  );
}

function SessionRow({
  s,
  selected,
  onSelect,
  onAction,
}: {
  s: SidebarSession;
  selected: boolean;
  onSelect?: (id: string) => void;
  onAction?: (id: string, action: SidebarRowAction) => void;
}): React.ReactElement {
  const dot = STATUS_DOT[s.status];
  const favicon = faviconUrl(s.primarySite);
  const last = s.lastActivityAt ?? s.createdAt;
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const isRunning = s.status === 'running' || s.status === 'stuck';
  const handleAction = (action: SidebarRowAction): void => {
    setMenuOpen(false);
    onAction?.(s.id, action);
  };

  return (
    <div
      ref={rootRef}
      className={`sidebar__row-wrapper${menuOpen ? ' sidebar__row-wrapper--menu-open' : ''}`}
    >
      <button
        type="button"
        className={`sidebar__row has-tooltip${selected ? ' sidebar__row--active' : ''}`}
        onClick={() => onSelect?.(s.id)}
        data-tooltip={s.prompt}
      >
        <span className="sidebar__row-icon">
          {favicon ? (
            <img src={favicon} alt="" width={18} height={18} />
          ) : (
            <span className="sidebar__row-icon-fallback" aria-label="No site">
              <TerminalFallbackIcon />
            </span>
          )}
          <span className="sidebar__row-dot" style={{ background: dot.color }} aria-label={dot.label} />
        </span>
        <span className="sidebar__row-title">{s.prompt}</span>
        <span className="sidebar__row-time">{formatRelative(last)}</span>
      </button>

      {onAction && (
        <button
          type="button"
          className="sidebar__row-menu-btn"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Session actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreIcon />
        </button>
      )}

      {menuOpen && (
        <div className="sidebar__row-menu" role="menu">
          <button className="sidebar__row-menu-item" role="menuitem" onClick={() => handleAction('rerun')}>
            Re-run
          </button>
          {isRunning && (
            <button className="sidebar__row-menu-item" role="menuitem" onClick={() => handleAction('stop')}>
              Stop
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ sessions, selectedId, onSelect, onNewAgent, onRowAction }: SidebarProps): React.ReactElement {
  const data = sessions ?? MOCK_SIDEBAR_SESSIONS;

  const { active, done } = useMemo(() => {
    const sortByActivity = (a: SidebarSession, b: SidebarSession): number =>
      (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt);
    const act: SidebarSession[] = [];
    const don: SidebarSession[] = [];
    for (const s of data) {
      if (s.status === 'running' || s.status === 'idle' || s.status === 'stuck' || s.status === 'draft') act.push(s);
      else don.push(s);
    }
    act.sort(sortByActivity);
    don.sort(sortByActivity);
    return { active: act, done: don };
  }, [data]);

  return (
    <aside className="sidebar" aria-label="Agent sessions">
      <div className="sidebar__header">
        <span className="sidebar__header-title">Agents</span>
        <div className="sidebar__header-actions">
          <button
            type="button"
            className="sidebar__icon-btn sidebar__icon-btn--new has-tooltip"
            onClick={onNewAgent}
            aria-label="New agent"
            data-tooltip="New agent"
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="sidebar__groups">
        <div className="sidebar__group-body">
          {[...active, ...done].map((s) => (
            <SessionRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} onAction={onRowAction} />
          ))}
        </div>
      </div>

    </aside>
  );
}

export default Sidebar;
