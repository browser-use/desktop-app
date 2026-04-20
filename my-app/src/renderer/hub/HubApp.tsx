import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentPane } from './AgentPane';
import { ListView } from './ListView';
import { Dashboard } from './Dashboard';
import { KeybindingsOverlay } from './KeybindingsOverlay';
import { SettingsPane } from './SettingsPane';
import { useVimKeys } from './useVimKeys';
import { useSessionsQuery, useDismissSession, useUpdateSession } from './useSessionsQuery';
import { MemoryIndicator } from './MemoryIndicator';
import { MOCK_SESSIONS } from './mock-data';
import type { AgentSession, HlEvent } from './types';
import type { ActionId } from './keybindings';

function groupSessions(sessions: AgentSession[]): { group: string; sessions: AgentSession[] }[] {
  const groups = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const key = s.group ?? 'ungrouped';
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  return Array.from(groups, ([group, items]) => ({ group, sessions: items }));
}

type ViewMode = 'dashboard' | 'grid' | 'list';

let sessionCounter = MOCK_SESSIONS.length + 1;
let entryCounter = 1000;

function uid(prefix: string): string {
  return `${prefix}-${++entryCounter}`;
}

function PlusIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ListIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function DashboardIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1.5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8.5" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.5" y="8.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function HubApp(): React.ReactElement {
  const isMock = import.meta.env.VITE_MOCK_MODE === '1';
  const [mockSessions, setMockSessions] = useState<AgentSession[]>(isMock ? MOCK_SESSIONS : []);
  const sessionsQuery = useSessionsQuery();
  const dismissSession = useDismissSession();
  const updateSession = useUpdateSession();
  const sessions = isMock ? mockSessions : (sessionsQuery.data ?? []);
  const setSessions = isMock ? setMockSessions : () => {};

  useEffect(() => {
    console.log('[HubApp] sessions changed', { count: sessions.length, ts: Date.now(), ids: sessions.map((s) => s.id.slice(0, 8)) });
  }, [sessions.length]);

  const [viewMode, setViewMode] = useState<ViewMode>('dashboard');
  const openPill = useCallback(() => { window.electronAPI?.pill.toggle(); }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [gridPage, setGridPage] = useState(0);
  const [zoomFactor, setZoomFactor] = useState(1.0);
  const [gridColumns, setGridColumns] = useState(4);

  const vimHandlers = useMemo<Partial<Record<ActionId, () => void>>>(() => ({
    'nav.down': () => setFocusIndex((i) => Math.min(i + 1, sessions.length - 1)),
    'nav.up': () => setFocusIndex((i) => Math.max(i - 1, 0)),
    'nav.top': () => setFocusIndex(0),
    'nav.bottom': () => setFocusIndex(sessions.length - 1),
    'nav.open': () => {
      console.log('[VimKeys] open session', sessions[focusIndex]?.id);
    },
    'goto.dashboard': () => setViewMode('dashboard'),
    'goto.agents': () => setViewMode('grid'),
    'goto.list': () => setViewMode('list'),
    'goto.settings': () => { window.electronAPI?.pill.hide(); hideBrowserViews(); setSettingsOpen(true); },
    'search.open': () => { window.electronAPI?.pill.toggle(); },
    'action.create': () => { window.electronAPI?.pill.toggle(); },
    'action.dismiss': () => {
      const s = sessions[focusIndex];
      if (!s) return;
      window.electronAPI?.sessions.viewDetach(s.id).catch(() => {});
      window.electronAPI?.sessions.hide(s.id).catch(() => {});
      console.log('[VimKeys] dismiss session', s.id);
      dismissSession(s.id);
      setFocusIndex((i) => Math.min(i, sessions.length - 2));
    },
    'grid.nextPage': () => {
      const totalPages = Math.max(1, Math.ceil(sessions.length / 4));
      setGridPage((p) => Math.min(p + 1, totalPages - 1));
    },
    'grid.prevPage': () => {
      setGridPage((p) => Math.max(p - 1, 0));
    },
    'action.cancel': () => {
      const s = sessions[focusIndex];
      if (!s || (s.status !== 'running' && s.status !== 'stuck')) return;
      const api = window.electronAPI;
      if (!api) return;
      console.log('[VimKeys] cancel session', s.id);
      api.sessions.cancel(s.id).catch((err) => console.error('[VimKeys] cancel failed', err));
    },
    'scroll.halfDown': () => {
      const el = document.querySelector('.hub-grid, .list-view__body, .dashboard');
      if (el) el.scrollBy({ top: el.clientHeight / 2, behavior: 'smooth' });
    },
    'scroll.halfUp': () => {
      const el = document.querySelector('.hub-grid, .list-view__body, .dashboard');
      if (el) el.scrollBy({ top: -(el.clientHeight / 2), behavior: 'smooth' });
    },
    'meta.help': () => { hideBrowserViews(); setHelpOpen((prev) => !prev); },
    'meta.commandPalette': () => { window.electronAPI?.pill.toggle(); },
    'meta.escape': () => {
      if (helpOpen) { setHelpOpen(false); showBrowserViews(); return; }
      if (settingsOpen) { setSettingsOpen(false); showBrowserViews(); return; }
      setFocusIndex(-1);
    },
  }), [sessions, focusIndex, helpOpen, settingsOpen]);

  const vim = useVimKeys(vimHandlers);

  const shortcutFor = (actionId: ActionId): string => {
    const kb = vim.keybindings.find((b) => b.id === actionId);
    return kb?.keys[0] ?? '';
  };

  const hideBrowserViews = useCallback(() => {
    window.electronAPI?.sessions.viewsSetVisible(false).catch(() => {});
  }, []);

  const showBrowserViews = useCallback(() => {
    window.electronAPI?.sessions.viewsSetVisible(true).catch(() => {});
  }, []);

  const tip = (label: string, actionId: ActionId): string => {
    const key = shortcutFor(actionId);
    return key ? `${label}  (${key})` : label;
  };


  useEffect(() => {
    const unsub = window.electronAPI?.on?.openSettings?.(() => {
      window.electronAPI?.pill.hide();
      hideBrowserViews();
      setSettingsOpen(true);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI?.on?.pillToggled?.(() => {
      setSettingsOpen(false);
      setHelpOpen(false);
      showBrowserViews();
    });
    return unsub;
  }, []);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { on?: { zoomChanged?: (cb: (f: number) => void) => () => void } } }).electronAPI;
    const saved = localStorage.getItem('hub-zoom-factor');
    if (saved) {
      const f = parseFloat(saved);
      if (f >= 0.5 && f <= 2.0) setZoomFactor(f);
    }
    if (api?.on?.zoomChanged) {
      return api.on.zoomChanged((f: number) => {
        setZoomFactor(f);
        localStorage.setItem('hub-zoom-factor', String(f));
      });
    }
  }, []);

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      if (w < 600) setGridColumns(1);
      else if (w < 900) setGridColumns(2);
      else if (w < 1200) setGridColumns(3);
      else setGridColumns(4);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [zoomFactor]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api || isMock) return;
    sessions.forEach((s) => {
      api.sessions.viewDetach(s.id).catch(() => {});
    });
  }, [viewMode, gridColumns, gridPage]);

  const handleCreateSession = useCallback(async (prompt: string) => {
    if (isMock) {
      const id = `session-${++sessionCounter}`;
      const now = Date.now();
      const newSession: AgentSession = {
        id, prompt, status: 'running', createdAt: now,
        output: [{ type: 'thinking', text: `Analyzing the task: "${prompt}". Let me break this down and determine the best approach.` }],
      };
      console.log('[HubApp] createSession (mock)', { id, prompt });
      setSessions((prev) => [...prev, newSession]);

      const pushEvent = (event: HlEvent, statusOverride?: AgentSession['status']) => {
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== id) return s;
            const updated = { ...s, output: [...s.output, event] };
            if (statusOverride) updated.status = statusOverride;
            return updated;
          }),
        );
      };
      setTimeout(() => pushEvent({ type: 'tool_call', name: 'file.search', args: { pattern: '**/*.ts', query: prompt.split(' ').slice(0, 3).join(' ') }, iteration: 1 }), 2000);
      setTimeout(() => pushEvent({ type: 'tool_result', name: 'file.search', ok: true, preview: 'Found 7 relevant files across 3 directories.', ms: 1500 }), 3500);
      setTimeout(() => pushEvent({ type: 'thinking', text: 'I\'ve found the relevant files. Now analyzing the code structure.' }), 5000);
      setTimeout(() => pushEvent({ type: 'tool_call', name: 'file.read', args: { path: 'src/main/index.ts', lines: '1-50' }, iteration: 2 }), 7000);
      setTimeout(() => pushEvent({ type: 'tool_result', name: 'file.read', ok: true, preview: 'Read 50 lines. Found entry point configuration.', ms: 800 }), 8000);
      setTimeout(() => pushEvent({ type: 'done', summary: 'Implementation complete.', iterations: 2 }, 'stopped'), 10000);
      setViewMode('grid');
      setGridPage(Math.floor(sessions.length / 4));
      return;
    }

    const api = window.electronAPI;
    if (!api) { console.error('[HubApp] electronAPI not available'); return; }

    try {
      console.log('[HubApp] createSession (live)', { prompt });
      const id = await api.sessions.create(prompt);
      console.log('[HubApp] session created', { id });
      await api.sessions.start(id);
      console.log('[HubApp] session started', { id });
      setViewMode('grid');
      setGridPage(Math.floor(sessions.length / 4));
    } catch (err) {
      console.error('[HubApp] createSession failed', err);
    }
  }, [isMock]);

  const hasNoSessions = sessions.length === 0;

  const handleFollowUp = useCallback(async (sessionId: string, prompt: string) => {
    if (!isMock) {
      const api = window.electronAPI;
      if (!api) return;
      try {
        console.log('[HubApp] followUp', { sessionId, prompt });
        const result = await api.sessions.resume(sessionId, prompt);
        if (result?.error) {
          console.warn('[HubApp] followUp error', { sessionId, error: result.error });
          updateSession(sessionId, { status: 'stopped' as const, error: result.error });
        }
      } catch (err) {
        console.error('[HubApp] followUp failed', err);
      }
    }
  }, [isMock]);

  const handleSelectSession = useCallback((id: string) => {
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) setFocusIndex(idx);
    console.log('[HubApp] selectSession', { id });
  }, [sessions]);

  return (
    <div className="hub-root">
      <header className="hub-toolbar">
        <div className="hub-toolbar__left">
          <span className="hub-toolbar__title">Browser Use</span>
          <MemoryIndicator />
        </div>
        <div className="hub-toolbar__right">
          <button
            className="hub-toolbar__new-btn"
            onClick={() => openPill()}
            aria-label="New agent"
            data-tip={tip('New agent', 'action.create')}
          >
            <PlusIcon />
            <span className="hub-toolbar__new-label">New agent</span>
          </button>
          {sessions.length > 0 && (
            <>
              <div className="hub-toolbar__view-toggle" role="radiogroup" aria-label="View mode">
                <button
                  className={`hub-toolbar__view-btn${viewMode === 'dashboard' ? ' hub-toolbar__view-btn--active' : ''}`}
                  onClick={() => setViewMode('dashboard')}
                  aria-label="Dashboard"
                  data-tip={tip('Dashboard', 'goto.dashboard')}
                >
                  <DashboardIcon />
                </button>
                <button
                  className={`hub-toolbar__view-btn${viewMode === 'grid' ? ' hub-toolbar__view-btn--active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                  data-tip={tip('Grid view', 'goto.agents')}
                >
                  <GridIcon />
                </button>
                <button
                  className={`hub-toolbar__view-btn${viewMode === 'list' ? ' hub-toolbar__view-btn--active' : ''}`}
                  onClick={() => setViewMode('list')}
                  aria-label="List view"
                  data-tip={tip('List view', 'goto.list')}
                >
                  <ListIcon />
                </button>
              </div>
            </>
          )}
          {zoomFactor !== 1.0 && (
            <button
              className="hub-toolbar__zoom"
              onClick={() => {
                const api = (window as unknown as { electronAPI?: { on?: { zoomChanged?: (cb: (f: number) => void) => () => void } } }).electronAPI;
                setZoomFactor(1.0);
                localStorage.setItem('hub-zoom-factor', '1');
              }}
              title="Reset zoom (Cmd+0)"
            >
              {Math.round(zoomFactor * 100)}%
            </button>
          )}
        </div>
      </header>

      {viewMode === 'grid' && (
        <div className="hub-layout-bar">
          <div className="hub-layout-bar__group">
            <button
              className={`hub-layout-bar__btn${gridColumns === 1 ? ' hub-layout-bar__btn--active' : ''}`}
              onClick={() => { setGridColumns(1); setGridPage(0); }}
              aria-label="1x1 layout"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className={`hub-layout-bar__btn${gridColumns === 4 ? ' hub-layout-bar__btn--active' : ''}`}
              onClick={() => { setGridColumns(4); setGridPage(0); }}
              aria-label="2x2 layout"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="8" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className={`hub-layout-bar__btn${gridColumns === 9 ? ' hub-layout-bar__btn--active' : ''}`}
              onClick={() => { setGridColumns(9); setGridPage(0); }}
              aria-label="3x3 layout"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="5.5" y="1" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="10" y="1" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="1" y="5.5" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="5.5" y="5.5" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="10" y="5.5" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="1" y="10" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="5.5" y="10" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="10" y="10" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {hasNoSessions ? (
        <div className="hub-empty-state" onClick={() => openPill()} style={{ cursor: 'pointer' }}>
          <div className="hub-empty-state__icon" aria-hidden="true">
            <PlusIcon />
          </div>
          <p className="hub-empty-state__title">Start your first agent session</p>
          <p className="hub-empty-state__body">
            Press <kbd className="hub-empty-state__kbd">{vim.keybindings.find((k) => k.id === 'action.create')?.keys[0] ?? 'c'}</kbd> to begin
          </p>
        </div>
      ) : viewMode === 'dashboard' ? (
        <Dashboard
          sessions={sessions}
          onSwitchToGrid={() => setViewMode('grid')}
          onSelectSession={(id) => {
            window.electronAPI?.sessions.unhide(id).catch(() => {});
            handleSelectSession(id);
            sessionsQuery.refetch();
            setViewMode('grid');
          }}
        />
      ) : viewMode === 'grid' ? (
        (() => {
          const visibleSessions = sessions.filter((s) => !s.hidden);
          const pageSize = gridColumns;
          const totalPages = Math.max(1, Math.ceil(visibleSessions.length / pageSize));
          const safePage = Math.min(gridPage, totalPages - 1);
          const pageStart = safePage * pageSize;
          const pageSessions = visibleSessions.slice(pageStart, pageStart + pageSize);
          return (
            <div className="hub-grid-container">
              <div className="hub-grid" data-count={String(gridColumns)}>
                {pageSessions.map((session) => {
                  const globalIdx = sessions.findIndex((s) => s.id === session.id);
                  return (
                    <AgentPane
                      key={session.id}
                      session={session}
                      focused={globalIdx === focusIndex}
                      onRerun={(id) => {
                        window.electronAPI?.sessions.rerun(id).catch((err) => console.error('[HubApp] rerun failed', err));
                      }}
                      onFollowUp={handleFollowUp}
                      onDismiss={(id) => {
                        window.electronAPI?.sessions.viewDetach(id).catch(() => {});
                        window.electronAPI?.sessions.hide(id).catch(() => {});
                        dismissSession(id);
                      }}
                      onCancel={(id) => {
                        window.electronAPI?.sessions.cancel(id).catch(() => {});
                      }}
                      onSelect={handleSelectSession}
                      onOpenFollowUp={() => {
                        window.electronAPI?.pill.openFollowUp(session.id, session.prompt);
                      }}
                    />
                  );
                })}
              </div>
              {totalPages > 1 && (
                <div className="hub-grid-pages">
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={i}
                      className={`hub-grid-pages__dot${i === safePage ? ' hub-grid-pages__dot--active' : ''}`}
                      onClick={() => setGridPage(i)}
                      aria-label={`Page ${i + 1}`}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })()
      ) : (
        <ListView
          sessions={sessions}
          onSelectSession={(id) => {
            window.electronAPI?.sessions.unhide(id).catch(() => {});
            handleSelectSession(id);
            sessionsQuery.refetch();
            const idx = sessions.findIndex((s) => s.id === id);
            if (idx >= 0) setGridPage(Math.floor(idx / 4));
            setViewMode('grid');
          }}
          focusIndex={focusIndex}
        />
      )}

      {vim.chordPrefix && (
        <div className="chord-indicator">
          <kbd className="chord-indicator__key">{vim.chordPrefix}</kbd>
          <span className="chord-indicator__hint">...</span>
        </div>
      )}

      <KeybindingsOverlay
        open={helpOpen}
        onClose={() => { setHelpOpen(false); showBrowserViews(); }}
        keybindings={vim.keybindings}
        onOpenSettings={() => {
          setHelpOpen(false);
          window.electronAPI?.pill.hide();
          hideBrowserViews();
          setSettingsOpen(true);
        }}
      />

      <SettingsPane
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); showBrowserViews(); }}
        keybindings={vim.keybindings}
        overrides={vim.overrides}
        onUpdateBinding={vim.updateBinding}
        onResetBinding={vim.resetBinding}
        onResetAll={vim.resetAll}
      />
    </div>
  );
}

export default HubApp;
