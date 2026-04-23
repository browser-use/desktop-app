import React, { useState, useEffect, useCallback } from 'react';
import { ConnectionsPane } from './ConnectionsPane';
import type { ActionId, KeyBinding } from './keybindings';

type ElectronPrivacyAPI = {
  get: () => Promise<{ telemetry: boolean; telemetryUpdatedAt: string | null; version: number }>;
  setTelemetry: (optedIn: boolean) => Promise<{ telemetry: boolean; telemetryUpdatedAt: string | null; version: number }>;
  openSystemNotifications: () => Promise<{ ok: boolean; error?: string }>;
};

function PrivacySection(): React.ReactElement {
  const [telemetry, setTelemetry] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const api = (window as unknown as { electronAPI: { settings: { privacy: ElectronPrivacyAPI } } }).electronAPI.settings.privacy;

  useEffect(() => {
    let cancelled = false;
    api.get().then((state) => {
      if (!cancelled) setTelemetry(state.telemetry);
    }).catch(() => { if (!cancelled) setTelemetry(false); });
    return () => { cancelled = true; };
  }, [api]);

  const handleToggle = useCallback(async () => {
    if (telemetry === null || saving) return;
    const next = !telemetry;
    setSaving(true);
    setTelemetry(next); // optimistic
    try {
      const res = await api.setTelemetry(next);
      setTelemetry(res.telemetry);
    } catch {
      setTelemetry(!next); // revert
    } finally {
      setSaving(false);
    }
  }, [telemetry, saving, api]);

  return (
    <div className="settings-pane__section">
      <span className="settings-pane__section-title">Privacy</span>
      <p className="settings-pane__hint">
        Control what leaves your machine. No prompts, credentials, or file contents are ever collected.
      </p>

      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">Allow telemetry to help us make this app better</div>
          <div className="settings-pane__sublabel">Anonymous only — app version, OS, feature usage, and crash reports.</div>
        </div>
        <button
          className="settings-pane__toggle"
          role="switch"
          aria-checked={telemetry === true}
          data-on={telemetry === true}
          onClick={handleToggle}
          disabled={telemetry === null || saving}
        >
          <span className="settings-pane__toggle-thumb" />
        </button>
      </div>

      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">System notifications</div>
          <div className="settings-pane__sublabel">Managed by your operating system.</div>
        </div>
        <button
          className="conn-card__btn conn-card__btn--secondary"
          onClick={() => { void api.openSystemNotifications(); }}
        >
          Open system settings
        </button>
      </div>
    </div>
  );
}

interface SettingsPaneProps {
  open: boolean;
  onClose: () => void;
  keybindings: KeyBinding[];
  overrides: Record<string, string[]>;
  onUpdateBinding: (id: ActionId, keys: string[]) => void;
  onResetBinding: (id: ActionId) => void;
  onResetAll: () => void;
}

function captureKeyCombo(e: KeyboardEvent): string | null {
  if (e.key === 'Escape' || e.key === 'Tab') return null;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift');

  const key = e.key === ' ' ? 'Space' : e.key;
  parts.push(key);
  return parts.join('+');
}

interface KeybindRowProps {
  kb: KeyBinding;
  isOverridden: boolean;
  onUpdate: (id: ActionId, keys: string[]) => void;
  onReset: (id: ActionId) => void;
}

function KeybindRow({ kb, isOverridden, onUpdate, onReset }: KeybindRowProps): React.ReactElement {
  const [recording, setRecording] = useState(false);
  const [firstKey, setFirstKey] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const timer = setTimeout(() => {
      if (firstKey) {
        onUpdate(kb.id, [firstKey]);
        setRecording(false);
        setFirstKey(null);
      }
    }, 700);

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(false);
        setFirstKey(null);
        return;
      }

      const combo = captureKeyCombo(e);
      if (!combo) return;

      if (firstKey) {
        clearTimeout(timer);
        onUpdate(kb.id, [`${firstKey} ${combo}`]);
        setRecording(false);
        setFirstKey(null);
        return;
      }

      // If modifier present, commit immediately. Else wait briefly for possible chord.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        onUpdate(kb.id, [combo]);
        setRecording(false);
        return;
      }

      setFirstKey(combo);
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler, true);
    };
  }, [recording, firstKey, kb.id, onUpdate]);

  return (
    <div className={`settings-pane__row${isOverridden ? ' settings-pane__row--modified' : ''}`}>
      <span className="settings-pane__label">{kb.label}</span>
      <div className="settings-pane__row-right">
        <button
          className={`settings-pane__key-btn${recording ? ' settings-pane__key-btn--recording' : ''}`}
          onClick={() => {
            setRecording(true);
            setFirstKey(null);
          }}
        >
          {recording ? (
            <span className="settings-pane__recording">
              {firstKey ? `${firstKey} + ...` : 'Press key...'}
            </span>
          ) : (
            kb.keys.map((k, i) => (
              <kbd key={i} className="settings-pane__kbd">{k}</kbd>
            ))
          )}
        </button>
        <button
          className="settings-pane__reset-btn"
          onClick={() => onReset(kb.id)}
          title="Reset to default"
          style={{ visibility: isOverridden && !recording ? 'visible' : 'hidden' }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 4.5h4a3 3 0 010 6h-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.5 2.5L2.5 4.5 4.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function SettingsPane({ open, onClose, keybindings, overrides, onUpdateBinding, onResetBinding, onResetAll }: SettingsPaneProps): React.ReactElement | null {
  if (!open) return null;

  return (
    <div className="settings-pane__scrim" onClick={onClose}>
      <div className="settings-pane" onClick={(e) => e.stopPropagation()}>
        <div className="settings-pane__header">
          <span className="settings-pane__title">Settings</span>
          <button className="settings-pane__close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="settings-pane__body">
          <div className="settings-pane__section">
            <span className="settings-pane__section-title">Connections</span>
            <ConnectionsPane embedded />
          </div>
          <PrivacySection />
          <div className="settings-pane__section">
            <div className="settings-pane__section-header">
              <span className="settings-pane__section-title">Keybindings</span>
              {Object.keys(overrides).length > 0 && (
                <button className="settings-pane__reset-all" onClick={onResetAll}>Reset all</button>
              )}
            </div>
            <p className="settings-pane__hint">Click a binding to record a new key. Press Esc to cancel.</p>
            {keybindings.map((kb) => (
              <KeybindRow
                key={kb.id}
                kb={kb}
                isOverridden={kb.id in overrides}
                onUpdate={onUpdateBinding}
                onReset={onResetBinding}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
