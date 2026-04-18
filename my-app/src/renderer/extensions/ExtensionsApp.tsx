/**
 * ExtensionsApp.tsx — Extensions window root component.
 *
 * Two tabs: "Extensions" (grid of extension cards) and "Shortcuts"
 * (keyboard shortcut bindings for extension commands).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Button,
  Card,
  Modal,
  ToastProvider,
  useToast,
  Spinner,
  KeyHint,
} from '../components/base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  enabled: boolean;
  permissions: string[];
  hostPermissions: string[];
  hostAccess: 'all-sites' | 'specific-sites' | 'on-click';
  icons: Record<string, string>;
}

interface ExtensionCommandEntry {
  extensionId: string;
  extensionName: string;
  commandName: string;
  description: string;
  shortcut: string;
  isAction: boolean;
}

type HostAccessLevel = 'all-sites' | 'specific-sites' | 'on-click';
type Tab = 'extensions' | 'shortcuts';

declare global {
  interface Window {
    extensionsAPI: {
      listExtensions: () => Promise<ExtensionRecord[]>;
      enableExtension: (id: string) => Promise<void>;
      disableExtension: (id: string) => Promise<void>;
      removeExtension: (id: string) => Promise<void>;
      getExtensionDetails: (id: string) => Promise<ExtensionRecord | null>;
      loadUnpacked: () => Promise<ExtensionRecord | null>;
      updateExtension: (id: string) => Promise<void>;
      setHostAccess: (id: string, access: HostAccessLevel) => Promise<void>;
      getDeveloperMode: () => Promise<boolean>;
      setDeveloperMode: (enabled: boolean) => Promise<void>;
      pickDirectory: () => Promise<string | null>;
      closeWindow: () => void;
      listCommands: () => Promise<ExtensionCommandEntry[]>;
      setShortcut: (extensionId: string, commandName: string, shortcut: string) => Promise<void>;
    };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOST_ACCESS_LABELS: Record<HostAccessLevel, string> = {
  'all-sites': 'On all sites',
  'specific-sites': 'On specific sites',
  'on-click': 'On click',
};

// Chrome built-in shortcuts that should be flagged as conflicts.
// Uses the same format as Electron accelerators but lowercased for comparison.
const CHROME_RESERVED_SHORTCUTS = new Set([
  'ctrl+t', 'cmd+t',
  'ctrl+n', 'cmd+n',
  'ctrl+shift+n', 'cmd+shift+n',
  'ctrl+w', 'cmd+w',
  'ctrl+shift+w', 'cmd+shift+w',
  'ctrl+l', 'cmd+l',
  'ctrl+r', 'cmd+r',
  'ctrl+shift+r', 'cmd+shift+r',
  'ctrl+f', 'cmd+f',
  'ctrl+g', 'cmd+g',
  'ctrl+shift+g', 'cmd+shift+g',
  'ctrl+p', 'cmd+p',
  'ctrl+s', 'cmd+s',
  'ctrl+o', 'cmd+o',
  'ctrl+d', 'cmd+d',
  'ctrl+=', 'cmd+=',
  'ctrl+-', 'cmd+-',
  'ctrl+0', 'cmd+0',
  'ctrl+,', 'cmd+,',
  'ctrl+alt+i', 'cmd+alt+i',
  'ctrl+alt+j', 'cmd+alt+j',
  'ctrl+alt+u', 'cmd+alt+u',
  'ctrl+shift+i', 'cmd+shift+i',
  'f12',
  'f5',
  'escape',
]);

function normalizeShortcut(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/commandorcontrol/g, 'ctrl');
}

function isConflict(shortcut: string): boolean {
  if (!shortcut) return false;
  return CHROME_RESERVED_SHORTCUTS.has(normalizeShortcut(shortcut));
}

// ---------------------------------------------------------------------------
// SVG Icons
// ---------------------------------------------------------------------------

function PuzzleIcon(): React.ReactElement {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20.5 11H19V7a2 2 0 00-2-2h-4V3.5a2.5 2.5 0 00-5 0V5H4a2 2 0 00-2 2v3.8h1.5a2.5 2.5 0 010 5H2V20a2 2 0 002 2h3.8v-1.5a2.5 2.5 0 015 0V22H17a2 2 0 002-2v-4h1.5a2.5 2.5 0 000-5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M1.75 3.5h10.5M4.667 3.5V2.333a1.167 1.167 0 011.166-1.166h2.334a1.167 1.167 0 011.166 1.166V3.5m1.75 0v8.167a1.167 1.167 0 01-1.166 1.166H4.083a1.167 1.167 0 01-1.166-1.166V3.5h8.166z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
    >
      <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M11.667 2.333v3.5h-3.5M2.333 11.667v-3.5h3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.43 5.25A4.083 4.083 0 017.7 2.45l3.967 3.383M2.333 8.167L6.3 11.55a4.083 4.083 0 004.27-2.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M12.25 10.5a1.167 1.167 0 01-1.167 1.167H2.917A1.167 1.167 0 011.75 10.5V3.5a1.167 1.167 0 011.167-1.167h2.916L7 3.5h4.083A1.167 1.167 0 0112.25 4.667v5.833z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KeyboardIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.167" y="3.5" width="11.666" height="7" rx="1.167" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 6.417h.583M5.25 6.417h.583M7 6.417h.583M8.75 6.417h.583M10.5 6.417h.583M3.5 8.167h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function WarningIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1L11 10H1L6 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 5v2.5M6 8.5v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Toggle Switch
// ---------------------------------------------------------------------------

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`ext-toggle ${checked ? 'ext-toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="ext-toggle-thumb" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Extension Card
// ---------------------------------------------------------------------------

function ExtensionCard({
  ext,
  onToggle,
  onRemove,
  onDetails,
  onHostAccessChange,
  onUpdate,
}: {
  ext: ExtensionRecord;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string, name: string) => void;
  onDetails: (id: string) => void;
  onHostAccessChange: (id: string, access: HostAccessLevel) => void;
  onUpdate: (id: string) => void;
}): React.ReactElement {
  const [hostMenuOpen, setHostMenuOpen] = useState(false);

  return (
    <Card variant="default" padding="md" className="ext-card">
      <div className="ext-card-header">
        <div className="ext-card-icon">
          <PuzzleIcon />
        </div>
        <div className="ext-card-info">
          <div className="ext-card-title-row">
            <h3 className="ext-card-name">{ext.name}</h3>
            <span className="ext-card-version">{ext.version}</span>
          </div>
          {ext.description && (
            <p className="ext-card-desc">{ext.description}</p>
          )}
          <code className="ext-card-id">{ext.id}</code>
        </div>
        <ToggleSwitch
          checked={ext.enabled}
          onChange={(checked) => onToggle(ext.id, checked)}
          label={`${ext.enabled ? 'Disable' : 'Enable'} ${ext.name}`}
        />
      </div>

      <div className="ext-card-actions">
        <div className="ext-card-actions-left">
          <div className="ext-host-access-wrapper">
            <button
              type="button"
              className="ext-host-access-btn"
              onClick={() => setHostMenuOpen(!hostMenuOpen)}
              aria-expanded={hostMenuOpen}
            >
              {HOST_ACCESS_LABELS[ext.hostAccess]}
              <ChevronIcon open={hostMenuOpen} />
            </button>
            {hostMenuOpen && (
              <div className="ext-host-access-menu" role="listbox">
                {(Object.keys(HOST_ACCESS_LABELS) as HostAccessLevel[]).map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="option"
                    aria-selected={ext.hostAccess === level}
                    className={`ext-host-access-option ${ext.hostAccess === level ? 'ext-host-access-option--active' : ''}`}
                    onClick={() => {
                      onHostAccessChange(ext.id, level);
                      setHostMenuOpen(false);
                    }}
                  >
                    {HOST_ACCESS_LABELS[level]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="ext-card-actions-right">
          <Button variant="ghost" size="sm" onClick={() => onUpdate(ext.id)}>
            <RefreshIcon />
            Update
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDetails(ext.id)}>
            Details
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onRemove(ext.id, ext.name)}>
            <TrashIcon />
            Remove
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Details Drawer
// ---------------------------------------------------------------------------

function DetailsDrawer({
  ext,
  open,
  onClose,
}: {
  ext: ExtensionRecord | null;
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  if (!open || !ext) return null;

  return (
    <div className="ext-drawer-overlay" onClick={onClose}>
      <div className="ext-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${ext.name} details`}>
        <div className="ext-drawer-header">
          <h2 className="ext-drawer-title">{ext.name}</h2>
          <button type="button" className="ext-drawer-close" onClick={onClose} aria-label="Close details">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="ext-drawer-body">
          <div className="ext-drawer-section">
            <h3 className="ext-drawer-section-title">General</h3>
            <div className="ext-drawer-field">
              <span className="ext-drawer-label">Version</span>
              <span className="ext-drawer-value">{ext.version}</span>
            </div>
            <div className="ext-drawer-field">
              <span className="ext-drawer-label">ID</span>
              <code className="ext-drawer-value ext-drawer-value--mono">{ext.id}</code>
            </div>
            {ext.description && (
              <div className="ext-drawer-field">
                <span className="ext-drawer-label">Description</span>
                <span className="ext-drawer-value">{ext.description}</span>
              </div>
            )}
            <div className="ext-drawer-field">
              <span className="ext-drawer-label">Source</span>
              <code className="ext-drawer-value ext-drawer-value--mono ext-drawer-value--path">{ext.path}</code>
            </div>
          </div>

          {ext.permissions.length > 0 && (
            <div className="ext-drawer-section">
              <h3 className="ext-drawer-section-title">Permissions</h3>
              <ul className="ext-drawer-list">
                {ext.permissions.map((perm) => (
                  <li key={perm} className="ext-drawer-list-item">
                    <code>{perm}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {ext.hostPermissions.length > 0 && (
            <div className="ext-drawer-section">
              <h3 className="ext-drawer-section-title">Site access</h3>
              <ul className="ext-drawer-list">
                {ext.hostPermissions.map((host) => (
                  <li key={host} className="ext-drawer-list-item">
                    <code>{host}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {ext.permissions.length === 0 && ext.hostPermissions.length === 0 && (
            <div className="ext-drawer-section">
              <h3 className="ext-drawer-section-title">Permissions</h3>
              <p className="ext-drawer-empty">No permissions requested.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState(): React.ReactElement {
  return (
    <div className="ext-empty">
      <div className="ext-empty-icon">
        <PuzzleIcon />
      </div>
      <h3 className="ext-empty-title">No extensions installed</h3>
      <p className="ext-empty-desc">
        Enable Developer mode and click "Load unpacked" to install an extension
        from a local directory.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shortcut capture field
// ---------------------------------------------------------------------------

function ShortcutField({
  value,
  onSave,
  hasConflict,
}: {
  value: string;
  onSave: (shortcut: string) => void;
  hasConflict: boolean;
}): React.ReactElement {
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState('');
  const inputRef = useRef<HTMLDivElement>(null);

  function startCapture(): void {
    setPending('');
    setCapturing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelCapture(): void {
    setCapturing(false);
    setPending('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cancelCapture();
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      setCapturing(false);
      onSave('');
      return;
    }

    // Only record when a non-modifier key is pressed along with at least one modifier
    const isModifier = ['Control', 'Meta', 'Alt', 'Shift'].includes(e.key);
    if (isModifier) return;

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Ctrl'); // normalize Meta to Ctrl for cross-platform
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    // Need at least one modifier (except for function keys)
    const isFunctionKey = /^F\d+$/.test(e.key);
    if (parts.length === 0 && !isFunctionKey) return;

    const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    parts.push(keyName);

    const combo = parts.join('+');
    setPending(combo);
    setCapturing(false);
    onSave(combo);
  }

  if (capturing) {
    return (
      <div
        ref={inputRef}
        className="ext-shortcut-capture ext-shortcut-capture--active"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onBlur={cancelCapture}
        aria-label="Press shortcut keys"
      >
        <span className="ext-shortcut-capture-hint">Press shortcut…</span>
        <button
          type="button"
          className="ext-shortcut-cancel"
          onMouseDown={(e) => { e.preventDefault(); cancelCapture(); }}
          aria-label="Cancel"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }

  const displayValue = pending || value;

  return (
    <div className="ext-shortcut-field-row">
      {hasConflict && displayValue && (
        <span className="ext-shortcut-conflict-badge" title="Conflicts with a browser shortcut">
          <WarningIcon />
        </span>
      )}
      <button
        type="button"
        className={`ext-shortcut-capture ${hasConflict && displayValue ? 'ext-shortcut-capture--conflict' : ''}`}
        onClick={startCapture}
        aria-label={displayValue ? `Current shortcut: ${displayValue}. Click to change.` : 'Click to set shortcut'}
      >
        {displayValue ? (
          <kbd className="ext-shortcut-keys">{displayValue}</kbd>
        ) : (
          <span className="ext-shortcut-placeholder">Click to set</span>
        )}
      </button>
      {displayValue && (
        <button
          type="button"
          className="ext-shortcut-clear"
          onClick={() => { setPending(''); onSave(''); }}
          aria-label="Clear shortcut"
          title="Clear shortcut"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts page
// ---------------------------------------------------------------------------

function ShortcutsPage(): React.ReactElement {
  const toast = useToast();
  const [commands, setCommands] = useState<ExtensionCommandEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCommands = useCallback(async () => {
    try {
      const list = await window.extensionsAPI.listCommands();
      setCommands(list);
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to load shortcuts', message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadCommands();
  }, [loadCommands]);

  async function handleSaveShortcut(
    extensionId: string,
    commandName: string,
    shortcut: string,
  ): Promise<void> {
    try {
      await window.extensionsAPI.setShortcut(extensionId, commandName, shortcut);
      // Update local state immediately
      setCommands((prev) =>
        prev.map((cmd) =>
          cmd.extensionId === extensionId && cmd.commandName === commandName
            ? { ...cmd, shortcut }
            : cmd,
        ),
      );
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to save shortcut', message: (err as Error).message });
    }
  }

  if (loading) {
    return (
      <div className="ext-loading">
        <Spinner size="md" />
      </div>
    );
  }

  if (commands.length === 0) {
    return (
      <div className="ext-empty">
        <div className="ext-empty-icon">
          <KeyboardIcon />
        </div>
        <h3 className="ext-empty-title">No extension commands</h3>
        <p className="ext-empty-desc">
          Extensions that define keyboard commands will appear here.
          Install an extension with a <code>commands</code> manifest field to get started.
        </p>
      </div>
    );
  }

  // Group by extension
  const grouped = new Map<string, { name: string; commands: ExtensionCommandEntry[] }>();
  for (const cmd of commands) {
    const existing = grouped.get(cmd.extensionId);
    if (existing) {
      existing.commands.push(cmd);
    } else {
      grouped.set(cmd.extensionId, { name: cmd.extensionName, commands: [cmd] });
    }
  }

  return (
    <div className="ext-shortcuts-page">
      <div className="ext-shortcuts-intro">
        <p className="ext-shortcuts-intro-text">
          Assign keyboard shortcuts to extension commands. Press <kbd>Backspace</kbd> or <kbd>Delete</kbd> while capturing to clear a shortcut.
        </p>
      </div>

      <div className="ext-shortcuts-list">
        {Array.from(grouped.entries()).map(([extId, group]) => (
          <div key={extId} className="ext-shortcuts-group">
            <div className="ext-shortcuts-group-header">
              <div className="ext-shortcuts-group-icon">
                <PuzzleIcon />
              </div>
              <h3 className="ext-shortcuts-group-name">{group.name}</h3>
            </div>

            <div className="ext-shortcuts-rows">
              {group.commands.map((cmd) => {
                const conflict = isConflict(cmd.shortcut);
                const displayName = cmd.isAction
                  ? 'Activate extension'
                  : cmd.description || cmd.commandName;

                return (
                  <div key={cmd.commandName} className="ext-shortcuts-row">
                    <div className="ext-shortcuts-row-info">
                      <span className="ext-shortcuts-row-name">{displayName}</span>
                      {cmd.isAction && (
                        <span className="ext-shortcuts-row-badge">Action</span>
                      )}
                    </div>
                    <ShortcutField
                      value={cmd.shortcut}
                      hasConflict={conflict}
                      onSave={(shortcut) => void handleSaveShortcut(cmd.extensionId, cmd.commandName, shortcut)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner app (uses useToast — must be inside ToastProvider)
// ---------------------------------------------------------------------------

function ExtensionsInner(): React.ReactElement {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('extensions');
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [devMode, setDevMode] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<ExtensionRecord | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const refreshList = useCallback(async () => {
    try {
      const list = await window.extensionsAPI.listExtensions();
      setExtensions(list);
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to load extensions', message: (err as Error).message });
    }
  }, [toast]);

  useEffect(() => {
    async function init(): Promise<void> {
      const [, dm] = await Promise.all([
        refreshList(),
        window.extensionsAPI.getDeveloperMode(),
      ]);
      setDevMode(dm);
      setLoading(false);
    }
    void init();
  }, [refreshList]);

  async function handleToggle(id: string, enabled: boolean): Promise<void> {
    try {
      if (enabled) {
        await window.extensionsAPI.enableExtension(id);
      } else {
        await window.extensionsAPI.disableExtension(id);
      }
      await refreshList();
      toast.show({ variant: 'success', title: `Extension ${enabled ? 'enabled' : 'disabled'}` });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Toggle failed', message: (err as Error).message });
    }
  }

  async function handleRemoveConfirm(): Promise<void> {
    if (!removeTarget) return;
    try {
      await window.extensionsAPI.removeExtension(removeTarget.id);
      setRemoveTarget(null);
      await refreshList();
      toast.show({ variant: 'success', title: 'Extension removed' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Remove failed', message: (err as Error).message });
    }
  }

  async function handleDetails(id: string): Promise<void> {
    try {
      const details = await window.extensionsAPI.getExtensionDetails(id);
      setDetailsTarget(details);
      setDrawerOpen(true);
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to load details', message: (err as Error).message });
    }
  }

  async function handleHostAccessChange(id: string, access: HostAccessLevel): Promise<void> {
    try {
      await window.extensionsAPI.setHostAccess(id, access);
      await refreshList();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to update site access', message: (err as Error).message });
    }
  }

  async function handleUpdate(id: string): Promise<void> {
    try {
      await window.extensionsAPI.updateExtension(id);
      await refreshList();
      toast.show({ variant: 'success', title: 'Extension updated (force-reloaded)' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Update failed', message: (err as Error).message });
    }
  }

  async function handleDevModeToggle(enabled: boolean): Promise<void> {
    try {
      await window.extensionsAPI.setDeveloperMode(enabled);
      setDevMode(enabled);
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to toggle developer mode', message: (err as Error).message });
    }
  }

  async function handleLoadUnpacked(): Promise<void> {
    try {
      const ext = await window.extensionsAPI.loadUnpacked();
      if (ext) {
        await refreshList();
        toast.show({ variant: 'success', title: `Loaded: ${ext.name}` });
      }
    } catch (err) {
      toast.show({ variant: 'error', title: 'Load failed', message: (err as Error).message });
    }
  }

  function handleClose(): void {
    window.extensionsAPI.closeWindow();
  }

  if (loading) {
    return (
      <div className="ext-shell" role="application" aria-label="Extensions">
        <div className="ext-loading">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  return (
    <div className="ext-shell" role="application" aria-label="Extensions">
      {/* Header */}
      <header className="ext-header">
        <div className="ext-header-left">
          <h1 className="ext-title">Extensions</h1>
          <nav className="ext-tabs" aria-label="Extensions navigation">
            <button
              type="button"
              className={`ext-tab ${tab === 'extensions' ? 'ext-tab--active' : ''}`}
              onClick={() => setTab('extensions')}
              aria-current={tab === 'extensions' ? 'page' : undefined}
            >
              Extensions
            </button>
            <button
              type="button"
              className={`ext-tab ${tab === 'shortcuts' ? 'ext-tab--active' : ''}`}
              onClick={() => setTab('shortcuts')}
              aria-current={tab === 'shortcuts' ? 'page' : undefined}
            >
              <KeyboardIcon />
              Keyboard shortcuts
            </button>
          </nav>
        </div>
        <div className="ext-header-right">
          {tab === 'extensions' && (
            <div className="ext-dev-mode">
              <span className="ext-dev-mode-label">Developer mode</span>
              <ToggleSwitch
                checked={devMode}
                onChange={handleDevModeToggle}
                label="Toggle developer mode"
              />
            </div>
          )}
          <KeyHint keys={['Esc']} size="xs" aria-label="Esc to close" />
          <button
            type="button"
            className="ext-close-btn"
            onClick={handleClose}
            aria-label="Close extensions"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* Developer mode toolbar — only on extensions tab */}
      {tab === 'extensions' && devMode && (
        <div className="ext-dev-toolbar">
          <Button variant="secondary" size="sm" onClick={handleLoadUnpacked}>
            <FolderIcon />
            Load unpacked
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              for (const ext of extensions) {
                if (ext.enabled) {
                  await window.extensionsAPI.updateExtension(ext.id);
                }
              }
              await refreshList();
              toast.show({ variant: 'success', title: 'All extensions updated' });
            }}
            disabled={extensions.filter((e) => e.enabled).length === 0}
          >
            <RefreshIcon />
            Update all
          </Button>
        </div>
      )}

      {/* Tab content */}
      <main className="ext-main">
        {tab === 'extensions' ? (
          extensions.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="ext-grid">
              {extensions.map((ext) => (
                <ExtensionCard
                  key={ext.id}
                  ext={ext}
                  onToggle={(id, en) => void handleToggle(id, en)}
                  onRemove={(id, name) => setRemoveTarget({ id, name })}
                  onDetails={(id) => void handleDetails(id)}
                  onHostAccessChange={(id, access) => void handleHostAccessChange(id, access)}
                  onUpdate={(id) => void handleUpdate(id)}
                />
              ))}
            </div>
          )
        ) : (
          <ShortcutsPage />
        )}
      </main>

      {/* Remove confirmation modal */}
      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove extension"
        size="sm"
      >
        <p className="ext-modal-body">
          Remove <strong>{removeTarget?.name}</strong>? This will also clear its data.
          This action cannot be undone.
        </p>
        <div className="ext-modal-actions">
          <Button variant="secondary" size="sm" onClick={() => setRemoveTarget(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => void handleRemoveConfirm()}>
            Remove
          </Button>
        </div>
      </Modal>

      {/* Details drawer */}
      <DetailsDrawer
        ext={detailsTarget}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setDetailsTarget(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function ExtensionsApp(): React.ReactElement {
  return (
    <ToastProvider>
      <ExtensionsInner />
    </ToastProvider>
  );
}

export default ExtensionsApp;
