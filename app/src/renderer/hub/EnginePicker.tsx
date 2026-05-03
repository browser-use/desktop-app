import React, { useCallback, useEffect, useRef, useState } from 'react';
import claudeLogoSrc from './claude-logo.svg?raw';
import openaiLogoSrc from './openai-logo.svg?raw';
import opencodeLogoSrc from './opencode-logo-dark.svg?raw';

export interface EngineInfo {
  id: string;
  displayName: string;
  binaryName: string;
}

export interface EngineStatus {
  id: string;
  displayName: string;
  installed: { installed: boolean; version?: string; error?: string };
  authed: { authed: boolean; error?: string };
}

function EngineLogo({ id }: { id: string }): React.ReactElement {
  if (id === 'claude-code') {
    return <span className="engine-logo" dangerouslySetInnerHTML={{ __html: claudeLogoSrc as string }} />;
  }
  if (id === 'codex') {
    return <span className="engine-logo" dangerouslySetInnerHTML={{ __html: openaiLogoSrc as string }} />;
  }
  if (id === 'browsercode') {
    return <span className="engine-logo" dangerouslySetInnerHTML={{ __html: opencodeLogoSrc as string }} />;
  }
  return (
    <span className="engine-logo">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </span>
  );
}

function ChevronIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface EnginePickerProps {
  value: string;
  onChange: (engineId: string) => void;
  /** Fires when the dropdown opens/closes. Used by hosts (e.g. the pill
   *  renderer) that need to grow their window so the menu isn't clipped. */
  onOpenChange?: (open: boolean) => void;
}

export function EnginePicker({ value, onChange, onOpenChange }: EnginePickerProps): React.ReactElement {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, EngineStatus>>({});
  const [open, setOpen] = useState(false);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  const refreshStatus = useCallback(async (ids: string[]) => {
    console.info('[EnginePicker] refreshStatus.request', { ids });
    const updates = await Promise.all(
      ids.map(async (id) => {
        try { return await window.electronAPI?.sessions?.engineStatus?.(id); }
        catch (err) {
          console.warn('[EnginePicker] refreshStatus.failed', { id, error: (err as Error).message });
          return null;
        }
      }),
    );
    console.info('[EnginePicker] refreshStatus.result', {
      updates: updates.filter(Boolean).map((u) => ({
        id: u?.id,
        installed: u?.installed?.installed,
        installedError: u?.installed?.error,
        authed: u?.authed?.authed,
        authError: u?.authed?.error,
      })),
    });
    setStatuses((prev) => {
      const next = { ...prev };
      for (const u of updates) if (u) next[u.id] = u;
      return next;
    });
  }, []);

  // Mount: fetch engine list + initial statuses.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await window.electronAPI?.sessions?.listEngines?.()) ?? [];
        if (cancelled) return;
        setEngines(list);
        if (list.length > 0) void refreshStatus(list.map((e) => e.id));
      } catch (err) { console.error('[EnginePicker] listEngines failed', err); }
    })();
    return () => { cancelled = true; };
  }, [refreshStatus]);

  // Re-probe auth whenever the menu opens so a just-completed login flow is
  // reflected without needing to re-mount the component.
  useEffect(() => {
    if (!open) return;
    if (engines.length === 0) return;
    void refreshStatus(engines.map((e) => e.id));
  }, [open, engines, refreshStatus]);

  useEffect(() => {
    if (!installing) return;
    if (statuses[installing]?.installed?.installed) setInstalling(null);
  }, [installing, statuses]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // While a login is pending, poll auth status until it flips to `true` or
  // the user gives up (stops interacting for ~2 min).
  useEffect(() => {
    if (!loggingIn) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      attempts++;
      await refreshStatus([loggingIn]);
      const st = statuses[loggingIn];
      if (st?.authed?.authed) { setLoggingIn(null); return; }
      if (attempts >= 40) { setLoggingIn(null); return; }
      setTimeout(tick, 3000);
    };
    const id = setTimeout(tick, 2000);
    return () => { cancelled = true; clearTimeout(id); };
    // statuses intentionally excluded — we only poll while loggingIn flag is set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggingIn, refreshStatus]);

  const currentEngine = engines.find((e) => e.id === value) ?? engines[0];
  const currentStatus = currentEngine ? statuses[currentEngine.id] : undefined;
  const currentInstalled = currentStatus?.installed?.installed ?? true;
  const currentAuthed = currentStatus?.authed?.authed ?? true;

  const selectEngine = (id: string) => {
    console.info('[EnginePicker] selectEngine', { id });
    onChange(id);
    setOpen(false);
  };

  const onLoginClick = async (id: string) => {
    console.info('[EnginePicker] login.request', { id });
    setLoggingIn(id);
    try {
      const result = await window.electronAPI?.sessions?.engineLogin?.(id);
      console.info('[EnginePicker] login.result', { id, result });
      if (!result?.opened) setLoggingIn(null);
    } catch (err) {
      console.error('[EnginePicker] engineLogin failed', err);
      setLoggingIn(null);
    }
  };

  const openBrowserCodeSetup = async () => {
    console.info('[EnginePicker] browsercode.setup.openSettings');
    onChange('browsercode');
    setOpen(false);
    try {
      await window.electronAPI?.settings?.open?.();
    } catch (err) {
      console.error('[EnginePicker] browsercode.setup.openSettings.failed', err);
    }
  };

  const onInstallClick = async (id: string) => {
    console.info('[EnginePicker] install.request', { id });
    setInstalling(id);
    try {
      const result = await window.electronAPI?.sessions?.engineInstall?.(id);
      console.info('[EnginePicker] install.result', { id, result });
      if (!result?.opened) setInstalling(null);
      setTimeout(() => { void refreshStatus([id]); }, 3000);
      setTimeout(() => {
        setInstalling((current) => (current === id ? null : current));
      }, 120000);
    } catch (err) {
      console.error('[EnginePicker] engineInstall failed', err);
      setInstalling(null);
    }
  };

  const onItemClick = (id: string, installed: boolean, authed: boolean) => {
    console.info('[EnginePicker] item.click', { id, installed, authed });
    if (!installed) {
      void onInstallClick(id);
      return;
    }
    if (id === 'browsercode' && !authed) {
      void openBrowserCodeSetup();
      return;
    }
    if (!authed) {
      void onLoginClick(id);
      return;
    }
    selectEngine(id);
  };

  if (engines.length === 0) return <span className="engine-picker engine-picker--empty" />;

  return (
    <div className="engine-picker" ref={menuRef}>
      <button
        type="button"
        className="engine-picker__toggle"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentEngine ? `Engine: ${currentEngine.displayName}${!currentAuthed ? ' — not logged in' : ''}` : 'Pick engine'}
      >
        {currentEngine && <EngineLogo id={currentEngine.id} />}
        <span className="engine-picker__name">{currentEngine?.displayName ?? '…'}</span>
        {(!currentInstalled || !currentAuthed) && <span className="engine-picker__dot" aria-label="Needs setup" />}
        <ChevronIcon />
      </button>
      {open && (
        <div className="engine-picker__menu" role="menu">
          {engines.map((e) => {
            const st = statuses[e.id];
            const installed = st?.installed?.installed ?? true;
            const authed = st?.authed?.authed ?? true;
            const needsSetup = !installed || !authed;
            const setupLabel = e.id === 'browsercode' ? 'Set up' : 'Log in';
            const installLabel = installing === e.id ? 'Installing…' : 'Install';
            return (
              <button
                key={e.id}
                type="button"
                className={`engine-picker__item${e.id === value ? ' engine-picker__item--active' : ''}`}
                onClick={() => onItemClick(e.id, installed, authed)}
                title={!installed ? st?.installed?.error ?? `Install ${e.displayName}` : !authed ? st?.authed?.error ?? 'Start setup' : `Use ${e.displayName}`}
                role="menuitem"
              >
                <EngineLogo id={e.id} />
                <span className="engine-picker__item-name">{e.displayName}</span>
                {e.id === value && <span className="engine-picker__check">✓</span>}
                {needsSetup && installed && (
                  <span className="engine-picker__item-login">
                    {loggingIn === e.id ? 'Waiting…' : setupLabel}
                  </span>
                )}
                {!installed && (
                  <span className="engine-picker__item-login">{installLabel}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
