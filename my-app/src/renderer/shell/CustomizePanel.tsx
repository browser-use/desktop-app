/**
 * CustomizePanel: Chrome-parity "Customize this page" side panel.
 * Four tabs: Background, Color & Theme, Shortcuts, Cards.
 * Reads/writes NTP customization via electronAPI.ntp.* IPC channels.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NtpCustomization, NtpShortcut } from '../../main/ntp/NtpCustomizationStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type CustomizeTab = 'background' | 'color' | 'shortcuts' | 'cards';

const TAB_DEFS: Array<{ id: CustomizeTab; label: string }> = [
  { id: 'background', label: 'Background' },
  { id: 'color', label: 'Color & theme' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'cards', label: 'Cards' },
];

const PRESET_BACKGROUNDS: string[] = [
  '#202124', '#303134', '#3c4043',
  '#174EA6', '#1A73E8', '#8AB4F8',
  '#0D652D', '#1E8E3E', '#81C995',
  '#E8710A', '#F29900', '#FDD663',
  '#A50E0E', '#D93025', '#F28B82',
  '#7627BB', '#A142F4', '#D7AEFB',
];

const ACCENT_PRESETS: string[] = [
  '#c8f135', '#1A73E8', '#8AB4F8', '#1E8E3E',
  '#81C995', '#F29900', '#FDD663', '#D93025',
  '#F28B82', '#A142F4', '#D7AEFB', '#FF6D00',
  '#EC407A', '#00BCD4', '#78909C', '#FFFFFF',
];

// ---------------------------------------------------------------------------
// electronAPI type declaration
// ---------------------------------------------------------------------------

declare const electronAPI: {
  ntp: {
    get: () => Promise<NtpCustomization>;
    set: (patch: Partial<NtpCustomization>) => Promise<NtpCustomization>;
    reset: () => Promise<NtpCustomization>;
    addShortcut: (s: { name: string; url: string }) => Promise<NtpCustomization>;
    editShortcut: (s: { id: string; name: string; url: string }) => Promise<NtpCustomization>;
    deleteShortcut: (id: string) => Promise<NtpCustomization>;
    pickImage: () => Promise<string | null>;
  };
  on: {
    ntpCustomizationUpdated: (cb: (data: NtpCustomization) => void) => () => void;
  };
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CustomizePanel(): React.ReactElement {
  const [tab, setTab] = useState<CustomizeTab>('background');
  const [config, setConfig] = useState<NtpCustomization | null>(null);

  useEffect(() => {
    console.log('[CustomizePanel] Loading NTP customization');
    electronAPI.ntp.get().then((data) => {
      console.log('[CustomizePanel] Loaded:', data.backgroundType, data.colorScheme);
      setConfig(data);
    });
    const unsub = electronAPI.on.ntpCustomizationUpdated((data) => {
      console.log('[CustomizePanel] Updated via IPC:', data.backgroundType);
      setConfig(data);
    });
    return unsub;
  }, []);

  const update = useCallback((patch: Partial<NtpCustomization>) => {
    console.log('[CustomizePanel] Saving patch:', Object.keys(patch));
    electronAPI.ntp.set(patch).then(setConfig);
  }, []);

  const handleReset = useCallback(() => {
    console.log('[CustomizePanel] Resetting to defaults');
    electronAPI.ntp.reset().then(setConfig);
  }, []);

  if (!config) {
    return <div className="customize-panel__loading">Loading...</div>;
  }

  return (
    <div className="customize-panel">
      <div className="customize-panel__tabs">
        {TAB_DEFS.map((t) => (
          <button
            key={t.id}
            className={`customize-panel__tab ${tab === t.id ? 'customize-panel__tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="customize-panel__body">
        {tab === 'background' && <BackgroundTab config={config} onUpdate={update} />}
        {tab === 'color' && <ColorTab config={config} onUpdate={update} />}
        {tab === 'shortcuts' && <ShortcutsTab config={config} onUpdate={update} />}
        {tab === 'cards' && <CardsTab config={config} onUpdate={update} />}
      </div>

      <div className="customize-panel__footer">
        <button className="customize-panel__reset-btn" onClick={handleReset}>
          Reset to default
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Background Tab
// ---------------------------------------------------------------------------

function BackgroundTab({
  config,
  onUpdate,
}: {
  config: NtpCustomization;
  onUpdate: (patch: Partial<NtpCustomization>) => void;
}): React.ReactElement {
  const handleSolidColor = useCallback(
    (color: string) => {
      onUpdate({ backgroundType: 'solid-color', backgroundColor: color });
    },
    [onUpdate],
  );

  const handleDefault = useCallback(() => {
    onUpdate({ backgroundType: 'default', backgroundImageDataUrl: '' });
  }, [onUpdate]);

  const handleUpload = useCallback(() => {
    electronAPI.ntp.pickImage().then((dataUrl) => {
      if (dataUrl) {
        onUpdate({ backgroundType: 'uploaded-image', backgroundImageDataUrl: dataUrl });
      }
    });
  }, [onUpdate]);

  return (
    <div className="customize-panel__section">
      <div className="customize-panel__section-label">Background</div>

      <button
        className={`customize-panel__option-btn ${config.backgroundType === 'default' ? 'customize-panel__option-btn--active' : ''}`}
        onClick={handleDefault}
      >
        <span className="customize-panel__option-swatch customize-panel__option-swatch--default" />
        <span>Default</span>
      </button>

      <button className="customize-panel__option-btn" onClick={handleUpload}>
        <span className="customize-panel__option-swatch customize-panel__option-swatch--upload">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M4 6l4-4 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 12h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </span>
        <span>Upload image</span>
      </button>

      {config.backgroundType === 'uploaded-image' && config.backgroundImageDataUrl && (
        <div className="customize-panel__preview">
          <img
            className="customize-panel__preview-img"
            src={config.backgroundImageDataUrl}
            alt="Background preview"
          />
        </div>
      )}

      <div className="customize-panel__section-label" style={{ marginTop: '12px' }}>
        Solid colors
      </div>
      <div className="customize-panel__color-grid">
        {PRESET_BACKGROUNDS.map((color) => (
          <button
            key={color}
            className={`customize-panel__color-swatch ${
              config.backgroundType === 'solid-color' && config.backgroundColor === color
                ? 'customize-panel__color-swatch--active'
                : ''
            }`}
            style={{ backgroundColor: color }}
            onClick={() => handleSolidColor(color)}
            title={color}
          />
        ))}
      </div>

      <div className="customize-panel__custom-color-row">
        <label className="customize-panel__label">Custom color</label>
        <input
          type="color"
          className="customize-panel__color-input"
          value={config.backgroundColor}
          onChange={(e) => handleSolidColor(e.target.value)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color & Theme Tab
// ---------------------------------------------------------------------------

type ColorScheme = 'light' | 'dark' | 'system';

const SCHEME_OPTIONS: Array<{ id: ColorScheme; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Device' },
];

function ColorTab({
  config,
  onUpdate,
}: {
  config: NtpCustomization;
  onUpdate: (patch: Partial<NtpCustomization>) => void;
}): React.ReactElement {
  return (
    <div className="customize-panel__section">
      <div className="customize-panel__section-label">Accent color</div>
      <div className="customize-panel__color-grid">
        {ACCENT_PRESETS.map((color) => (
          <button
            key={color}
            className={`customize-panel__color-swatch ${
              config.accentColor === color ? 'customize-panel__color-swatch--active' : ''
            }`}
            style={{ backgroundColor: color }}
            onClick={() => onUpdate({ accentColor: color })}
            title={color}
          />
        ))}
      </div>

      <div className="customize-panel__custom-color-row">
        <label className="customize-panel__label">Custom accent</label>
        <input
          type="color"
          className="customize-panel__color-input"
          value={config.accentColor}
          onChange={(e) => onUpdate({ accentColor: e.target.value })}
        />
      </div>

      <div className="customize-panel__section-label" style={{ marginTop: '16px' }}>
        Color scheme
      </div>
      <div className="customize-panel__scheme-group">
        {SCHEME_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            className={`customize-panel__scheme-btn ${
              config.colorScheme === opt.id ? 'customize-panel__scheme-btn--active' : ''
            }`}
            onClick={() => onUpdate({ colorScheme: opt.id })}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts Tab
// ---------------------------------------------------------------------------

function ShortcutsTab({
  config,
  onUpdate,
}: {
  config: NtpCustomization;
  onUpdate: (patch: Partial<NtpCustomization>) => void;
}): React.ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [addingNew, setAddingNew] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleToggleVisibility = useCallback(() => {
    onUpdate({ shortcutsVisible: !config.shortcutsVisible });
  }, [config.shortcutsVisible, onUpdate]);

  const handleModeChange = useCallback(
    (mode: 'most-visited' | 'custom') => {
      onUpdate({ shortcutMode: mode });
    },
    [onUpdate],
  );

  const handleStartAdd = useCallback(() => {
    setAddingNew(true);
    setEditName('');
    setEditUrl('');
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const handleSaveNew = useCallback(() => {
    if (!editName.trim() || !editUrl.trim()) return;
    electronAPI.ntp.addShortcut({ name: editName.trim(), url: editUrl.trim() });
    setAddingNew(false);
    setEditName('');
    setEditUrl('');
  }, [editName, editUrl]);

  const handleStartEdit = useCallback((s: NtpShortcut) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditUrl(s.url);
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingId || !editName.trim() || !editUrl.trim()) return;
    electronAPI.ntp.editShortcut({ id: editingId, name: editName.trim(), url: editUrl.trim() });
    setEditingId(null);
  }, [editingId, editName, editUrl]);

  const handleDelete = useCallback((id: string) => {
    electronAPI.ntp.deleteShortcut(id);
  }, []);

  const handleCancel = useCallback(() => {
    setEditingId(null);
    setAddingNew(false);
    setEditName('');
    setEditUrl('');
  }, []);

  return (
    <div className="customize-panel__section">
      <div className="customize-panel__toggle-row">
        <span className="customize-panel__label">Show shortcuts</span>
        <button
          className={`customize-panel__toggle ${config.shortcutsVisible ? 'customize-panel__toggle--on' : ''}`}
          onClick={handleToggleVisibility}
          role="switch"
          aria-checked={config.shortcutsVisible}
        >
          <span className="customize-panel__toggle-thumb" />
        </button>
      </div>

      {config.shortcutsVisible && (
        <>
          <div className="customize-panel__section-label">Shortcut source</div>
          <div className="customize-panel__radio-group">
            <label className="customize-panel__radio">
              <input
                type="radio"
                name="shortcutMode"
                checked={config.shortcutMode === 'most-visited'}
                onChange={() => handleModeChange('most-visited')}
              />
              <span>Most visited sites</span>
            </label>
            <label className="customize-panel__radio">
              <input
                type="radio"
                name="shortcutMode"
                checked={config.shortcutMode === 'custom'}
                onChange={() => handleModeChange('custom')}
              />
              <span>My shortcuts</span>
            </label>
          </div>

          {config.shortcutMode === 'custom' && (
            <div className="customize-panel__shortcuts-list">
              {config.customShortcuts.map((s) =>
                editingId === s.id ? (
                  <ShortcutForm
                    key={s.id}
                    nameRef={nameRef}
                    editName={editName}
                    editUrl={editUrl}
                    onNameChange={setEditName}
                    onUrlChange={setEditUrl}
                    onSave={handleSaveEdit}
                    onCancel={handleCancel}
                  />
                ) : (
                  <div key={s.id} className="customize-panel__shortcut-row">
                    <div className="customize-panel__shortcut-info">
                      <span className="customize-panel__shortcut-name">{s.name}</span>
                      <span className="customize-panel__shortcut-url">{s.url}</span>
                    </div>
                    <div className="customize-panel__shortcut-actions">
                      <button
                        className="customize-panel__icon-btn"
                        onClick={() => handleStartEdit(s)}
                        title="Edit"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button
                        className="customize-panel__icon-btn"
                        onClick={() => handleDelete(s.id)}
                        title="Delete"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ),
              )}

              {addingNew ? (
                <ShortcutForm
                  nameRef={nameRef}
                  editName={editName}
                  editUrl={editUrl}
                  onNameChange={setEditName}
                  onUrlChange={setEditUrl}
                  onSave={handleSaveNew}
                  onCancel={handleCancel}
                />
              ) : (
                <button className="customize-panel__add-btn" onClick={handleStartAdd}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  Add shortcut
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShortcutForm({
  nameRef,
  editName,
  editUrl,
  onNameChange,
  onUrlChange,
  onSave,
  onCancel,
}: {
  nameRef: React.RefObject<HTMLInputElement | null>;
  editName: string;
  editUrl: string;
  onNameChange: (v: string) => void;
  onUrlChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="customize-panel__shortcut-form">
      <input
        ref={nameRef}
        className="customize-panel__shortcut-input"
        placeholder="Name"
        value={editName}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <input
        className="customize-panel__shortcut-input"
        placeholder="URL"
        value={editUrl}
        onChange={(e) => onUrlChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="customize-panel__shortcut-form-actions">
        <button className="customize-panel__text-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="customize-panel__text-btn customize-panel__text-btn--primary" onClick={onSave}>
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards Tab
// ---------------------------------------------------------------------------

function CardsTab({
  config,
  onUpdate,
}: {
  config: NtpCustomization;
  onUpdate: (patch: Partial<NtpCustomization>) => void;
}): React.ReactElement {
  return (
    <div className="customize-panel__section">
      <div className="customize-panel__section-label">NTP Cards</div>
      <p className="customize-panel__hint">
        Cards appear on your New Tab page below the search bar and shortcuts.
      </p>
      <div className="customize-panel__toggle-row">
        <span className="customize-panel__label">Show cards</span>
        <button
          className={`customize-panel__toggle ${config.cardsVisible ? 'customize-panel__toggle--on' : ''}`}
          onClick={() => onUpdate({ cardsVisible: !config.cardsVisible })}
          role="switch"
          aria-checked={config.cardsVisible}
        >
          <span className="customize-panel__toggle-thumb" />
        </button>
      </div>
    </div>
  );
}
