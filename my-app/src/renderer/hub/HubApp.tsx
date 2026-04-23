import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentPane } from './AgentPane';
import { ListView } from './ListView';
import { Dashboard } from './Dashboard';
import { KeybindingsOverlay } from './KeybindingsOverlay';
import { CommandBar } from './CommandBar';
import { SettingsPane } from './SettingsPane';
import { useVimKeys } from './useVimKeys';
import { useSessionsQuery, useDismissSession, useUpdateSession } from './useSessionsQuery';
import { MemoryIndicator } from './MemoryIndicator';
import { Sidebar } from './Sidebar';
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

interface HubViewToggleProps {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  tipDashboard: string;
  tipGrid: string;
  tipList: string;
}

const HubViewToggle = React.memo(function HubViewToggle({
  viewMode, setViewMode, tipDashboard, tipGrid, tipList,
}: HubViewToggleProps): React.ReactElement {
  return (
    <div className="hub-toolbar__view-toggle" role="radiogroup" aria-label="View mode">
      <button
        className={`hub-toolbar__view-btn${viewMode === 'dashboard' ? ' hub-toolbar__view-btn--active' : ''}`}
        onClick={() => setViewMode('dashboard')}
        aria-label="Dashboard"
        data-tip={tipDashboard}
      >
        <DashboardIcon />
      </button>
      <button
        className={`hub-toolbar__view-btn${viewMode === 'grid' ? ' hub-toolbar__view-btn--active' : ''}`}
        onClick={() => setViewMode('grid')}
        aria-label="Grid view"
        data-tip={tipGrid}
      >
        <GridIcon />
      </button>
      <button
        className={`hub-toolbar__view-btn${viewMode === 'list' ? ' hub-toolbar__view-btn--active' : ''}`}
        onClick={() => setViewMode('list')}
        aria-label="List view"
        data-tip={tipList}
      >
        <ListIcon />
      </button>
    </div>
  );
});

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

  useEffect(() => {
    console.log('[HubApp] mount -> detaching all browser views to clear stale state');
    window.electronAPI?.sessions.viewsDetachAll?.().catch((err) => {
      console.warn('[HubApp] viewsDetachAll failed', err);
    });
  }, []);

  const [viewMode, setViewModeRaw] = useState<ViewMode>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('hub-view-mode') : null;
    if (saved === 'dashboard' || saved === 'grid' || saved === 'list') return saved;
    return 'dashboard';
  });
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeRaw(mode);
    try { window.localStorage.setItem('hub-view-mode', mode); } catch {}
  }, []);
  const openPill = useCallback(() => { window.electronAPI?.pill.toggle(); }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [zoomFactor, setZoomFactor] = useState(1.0);
  // Grid is permanently 1x1 (gridColumns = 1), but gridPage is real state —
  // it's what selects WHICH session is currently rendered. We repurpose it
  // as "which single session to render" and let the existing focusIndex-
  // driven effect keep it in sync with the focused session.
  const gridColumns = 1;
  const [gridPage, setGridPage] = useState(0);
  const [cmdBarVisible, setCmdBarVisible] = useState<boolean>(() => {
    try { return window.localStorage.getItem('hub-cmdbar-visible') !== '0'; } catch { return true; }
  });
  const hideCmdBar = useCallback(() => {
    setCmdBarVisible(false);
    try { window.localStorage.setItem('hub-cmdbar-visible', '0'); } catch {}
  }, []);

  const visibleSessionCount = sessions.filter((s) => !s.hidden).length;
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('pane:layout-change'));
  }, [visibleSessionCount, gridColumns, gridPage, viewMode]);

  const vimHandlers = useMemo<Partial<Record<ActionId, () => void>>>(() => ({
    'nav.down': () => {
      const visible = sessions.filter((s) => !s.hidden);
      if (!visible.length) return;
      const currVis = visible.findIndex((v) => v.id === sessions[focusIndex]?.id);
      const nextVis = Math.min((currVis < 0 ? 0 : currVis + 1), visible.length - 1);
      const nextGlobal = sessions.findIndex((s) => s.id === visible[nextVis].id);
      console.log('[VimKeys] nav.down', { from: focusIndex, to: nextGlobal, visIdx: nextVis });
      setFocusIndex(nextGlobal);
    },
    'nav.up': () => {
      const visible = sessions.filter((s) => !s.hidden);
      if (!visible.length) return;
      const currVis = visible.findIndex((v) => v.id === sessions[focusIndex]?.id);
      const nextVis = Math.max((currVis < 0 ? 0 : currVis - 1), 0);
      const nextGlobal = sessions.findIndex((s) => s.id === visible[nextVis].id);
      console.log('[VimKeys] nav.up', { from: focusIndex, to: nextGlobal, visIdx: nextVis });
      setFocusIndex(nextGlobal);
    },
    'nav.top': () => {
      const visible = sessions.filter((s) => !s.hidden);
      if (!visible.length) return;
      const nextGlobal = sessions.findIndex((s) => s.id === visible[0].id);
      setFocusIndex(nextGlobal);
    },
    'nav.bottom': () => {
      const visible = sessions.filter((s) => !s.hidden);
      if (!visible.length) return;
      const lastVis = visible.length - 1;
      const nextGlobal = sessions.findIndex((s) => s.id === visible[lastVis].id);
      setFocusIndex(nextGlobal);
    },
    'nav.open': () => {
      console.log('[VimKeys] open session', sessions[focusIndex]?.id);
    },
    'goto.dashboard': () => setViewMode('dashboard'),
    'goto.agents': () => setViewMode('grid'),
    'goto.list': () => setViewMode('list'),
    'goto.settings': () => { window.electronAPI?.pill.hide(); hideBrowserViews(); setSettingsOpen(true); },
    'search.open': () => { window.electronAPI?.pill.toggle(); },
    'action.create': () => { window.electronAPI?.pill.toggle(); },
    'action.createPane': () => { window.electronAPI?.pill.toggle(); },
    'action.dismiss': () => {
      const s = sessions[focusIndex];
      if (!s) return;
      window.electronAPI?.sessions.viewDetach(s.id).catch(() => {});
      window.electronAPI?.sessions.hide(s.id).catch(() => {});
      console.log('[VimKeys] dismiss session', s.id);
      dismissSession(s.id);
      setFocusIndex((i) => Math.min(i, sessions.length - 2));
    },
    // grid.nextPage / grid.prevPage removed — single-pane layout, no paging.
    'action.cancel': () => {
      const s = sessions[focusIndex];
      if (!s || (s.status !== 'running' && s.status !== 'stuck')) return;
      const api = window.electronAPI;
      if (!api) return;
      console.log('[VimKeys] cancel session', s.id);
      api.sessions.cancel(s.id).catch((err) => console.error('[VimKeys] cancel failed', err));
    },
    'action.followUp': () => {
      const s = sessions[focusIndex];
      if (!s || s.status !== 'idle') return;
      console.log('[VimKeys] follow up', s.id);
      window.electronAPI?.pill.openFollowUp(s.id, s.prompt);
    },
    'scroll.halfDown': () => {
      const el = document.querySelector('.hub-grid, .list-view__body, .dashboard');
      if (el) el.scrollBy({ top: el.clientHeight / 2, behavior: 'smooth' });
    },
    'scroll.halfUp': () => {
      const el = document.querySelector('.hub-grid, .list-view__body, .dashboard');
      if (el) el.scrollBy({ top: -(el.clientHeight / 2), behavior: 'smooth' });
    },
    'meta.help': () => { window.electronAPI?.pill.hide(); hideBrowserViews(); setSettingsOpen(true); },
    'meta.commandPalette': () => { window.electronAPI?.pill.toggle(); },
    'meta.escape': () => {
      if (helpOpen) { setHelpOpen(false); showBrowserViews(); return; }
      if (settingsOpen) { setSettingsOpen(false); showBrowserViews(); return; }
      setFocusIndex(-1);
    },
  }), [sessions, focusIndex, helpOpen, settingsOpen, gridColumns]);

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

  // Grid density auto-clamp removed — grid is always 1x1.

  useEffect(() => {
    const api = window.electronAPI;
    if (!api || isMock) return;
    sessions.forEach((s) => {
      api.sessions.viewDetach(s.id).catch(() => {});
    });
  }, [viewMode, gridColumns, gridPage]);

  const pendingFocusIdRef = useRef<string | null>(null);

  useEffect(() => {
    const pendingId = pendingFocusIdRef.current;
    if (!pendingId) return;
    const globalIdx = sessions.findIndex((s) => s.id === pendingId);
    if (globalIdx < 0) return;
    console.log('[HubApp] focusing pending new session', { pendingId, globalIdx });
    setFocusIndex(globalIdx);
    pendingFocusIdRef.current = null;
  }, [sessions]);

  const knownIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (knownIdsRef.current === null) {
      knownIdsRef.current = new Set(sessions.map((s) => s.id));
      console.log('[HubApp] initialize knownIds', { count: knownIdsRef.current.size });
      return;
    }
    const known = knownIdsRef.current;
    const newSession = sessions.find((s) => !known.has(s.id));
    knownIdsRef.current = new Set(sessions.map((s) => s.id));
    if (!newSession) return;
    const globalIdx = sessions.findIndex((s) => s.id === newSession.id);
    console.log('[HubApp] new session detected -> focus', { id: newSession.id, globalIdx });
    setViewMode('grid');
    setFocusIndex(globalIdx);
  }, [sessions, setViewMode]);

  useEffect(() => {
    const visible = sessions.filter((s) => !s.hidden);
    if (!visible.length) return;
    const focused = sessions[focusIndex];
    if (!focused) return;
    const visIdx = visible.findIndex((v) => v.id === focused.id);
    if (visIdx < 0) return;
    const pageSize = Math.max(1, gridColumns);
    const correctPage = Math.floor(visIdx / pageSize);
    if (correctPage !== gridPage) {
      console.log('[HubApp] auto-correct gridPage', { from: gridPage, to: correctPage, focusIndex, visIdx, gridColumns });
      setGridPage(correctPage);
    }
  }, [focusIndex, sessions, gridColumns, gridPage]);

  const handleCreateSession = useCallback(async (input: string | { prompt: string; attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>; engine?: string }) => {
    const prompt = typeof input === 'string' ? input : input.prompt;
    const attachments = typeof input === 'string' ? [] : (input.attachments ?? []);
    const engine = typeof input === 'string' ? undefined : input.engine;
    if (isMock) {
      const id = `session-${++sessionCounter}`;
      const now = Date.now();
      const newSession: AgentSession = {
        id, prompt, status: 'running', createdAt: now,
        output: [{ type: 'thinking', text: `Analyzing the task: "${prompt}". Let me break this down and determine the best approach.` }],
      };
      console.log('[HubApp] createSession (mock)', { id, prompt });
      pendingFocusIdRef.current = id;
      setViewMode('grid');
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
      return;
    }

    const api = window.electronAPI;
    if (!api) { console.error('[HubApp] electronAPI not available'); return; }

    try {
      console.log('[HubApp] createSession (live)', { prompt, attachmentCount: attachments.length });
      const id = await api.sessions.create(
        attachments.length > 0 || engine
          ? { prompt, attachments, engine }
          : prompt,
      );
      console.log('[HubApp] session created', { id });
      pendingFocusIdRef.current = id;
      setViewMode('grid');
      await api.sessions.start(id);
      console.log('[HubApp] session started', { id });
    } catch (err) {
      console.error('[HubApp] createSession failed', err);
    }
  }, [isMock, setViewMode]);


  const handleFollowUp = useCallback(async (
    sessionId: string,
    prompt: string,
    attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
  ) => {
    if (!isMock) {
      const api = window.electronAPI;
      if (!api) return;
      try {
        console.log('[HubApp] followUp', { sessionId, prompt, attachmentCount: attachments?.length ?? 0 });
        const result = await api.sessions.resume(sessionId, prompt, attachments);
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

  const visibleCount = sessions.filter((s) => !s.hidden).length;
  const gridPageSize = Math.max(1, gridColumns);
  const gridTotalPages = Math.max(1, Math.ceil(visibleCount / gridPageSize));
  const gridSafePage = Math.min(gridPage, gridTotalPages - 1);
  const goToPage = useCallback((target: number) => {
    const clamped = Math.max(0, Math.min(target, gridTotalPages - 1));
    const visible = sessions.filter((s) => !s.hidden);
    const firstOnPage = visible[clamped * gridPageSize];
    if (firstOnPage) {
      const globalIdx = sessions.findIndex((s) => s.id === firstOnPage.id);
      if (globalIdx >= 0) setFocusIndex(globalIdx);
    }
    setGridPage(clamped);
  }, [gridTotalPages, gridPageSize, sessions]);

  const selectedSessionId = sessions[focusIndex]?.id ?? null;

  return (
    <div className="hub-root">
      <header className="hub-toolbar">
        <div className="hub-toolbar__left">
          <span className="hub-toolbar__title">Browser Use</span>
          <MemoryIndicator onOpenSettings={() => { hideBrowserViews(); setSettingsOpen(true); }} />
        </div>
        <div className="hub-toolbar__center">
          <HubViewToggle
            viewMode={viewMode}
            setViewMode={setViewMode}
            tipDashboard={tip('Dashboard', 'goto.dashboard')}
            tipGrid={tip('Grid view', 'goto.agents')}
            tipList={tip('List view', 'goto.list')}
          />
        </div>
        <div className="hub-toolbar__right">
          {/* Grid density + pager removed — single-pane (1x1) layout. */}
          {viewMode !== 'dashboard' && (
            <button
              className="hub-toolbar__new-btn"
              onClick={() => openPill()}
              aria-label="New agent"
              data-tip={tip('New agent', 'action.createPane')}
            >
              <PlusIcon />
              <span className="hub-toolbar__new-label">New agent</span>
            </button>
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

      <div className="hub-body">
      <Sidebar
        sessions={sessions}
        selectedId={selectedSessionId}
        onSelect={(id) => {
          window.electronAPI?.sessions.unhide(id).catch(() => {});
          updateSession(id, { hidden: false });
          handleSelectSession(id);
          if (viewMode === 'dashboard') setViewMode('grid');
        }}
        onNewAgent={() => openPill()}
        onRowAction={(id, action) => {
          console.log('[HubApp] sidebar row action', { id, action });
          switch (action) {
            case 'rerun':
              window.electronAPI?.sessions.rerun(id).catch((err) => console.error('[HubApp] rerun failed', err));
              break;
            case 'stop':
              window.electronAPI?.sessions.cancel(id).catch(() => {});
              break;
            case 'hide':
              window.electronAPI?.sessions.viewDetach(id).catch(() => {});
              window.electronAPI?.sessions.hide(id).catch(() => {});
              updateSession(id, { hidden: true });
              break;
            case 'unhide':
              window.electronAPI?.sessions.unhide(id).catch(() => {});
              updateSession(id, { hidden: false });
              break;
            case 'delete':
              window.electronAPI?.sessions.viewDetach(id).catch(() => {});
              dismissSession(id);
              break;
          }
        }}
      />
      <div className="hub-main">
      {viewMode === 'dashboard' ? (
        <Dashboard
          sessions={sessions}
          onSwitchToGrid={() => setViewMode('grid')}
          onSubmitTask={(submission) => { handleCreateSession(submission); }}
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
          if (visibleSessions.length === 0) {
            const shortcut = shortcutFor('action.createPane');
            return (
              <div className="hub-grid-container">
                <button
                  type="button"
                  className="hub-grid__empty"
                  onClick={() => window.electronAPI?.pill.toggle()}
                >
                  press {shortcut ? <kbd className="hub-grid__empty-kbd">{shortcut}</kbd> : 'the global command'} to start a new task
                </button>
              </div>
            );
          }
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
                      onOpenSettings={() => {
                        window.electronAPI?.pill.hide();
                        hideBrowserViews();
                        setSettingsOpen(true);
                      }}
                      followUpShortcut={shortcutFor('action.followUp')}
                    />
                  );
                })}
              </div>
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

      </div>
      </div>

      {vim.chordPrefix && (
        <div className="chord-indicator">
          <kbd className="chord-indicator__key">{vim.chordPrefix}</kbd>
          <span className="chord-indicator__hint">...</span>
        </div>
      )}

      {cmdBarVisible && (
        <CommandBar
          screen={viewMode}
          keybindings={vim.keybindings}
          onClose={hideCmdBar}
          onInvoke={(id) => vimHandlers[id]?.()}
        />
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
