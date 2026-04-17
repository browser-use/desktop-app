/**
 * SettingsApp.tsx — Settings window root component.
 *
 * Layout: sidebar (200px) on left, content area on right.
 * Tabs: API Key | Agent | Appearance | Google Scopes | Danger Zone
 *
 * Uses base components: Button, Input, Card, Modal, Toast, Spinner.
 * No !important, no Inter font, no sparkles icon, no left outline.
 */

import React, { useState, useEffect, useCallback } from 'react';
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
// Constants
// ---------------------------------------------------------------------------

const TAB_API_KEY      = 'api-key'     as const;
const TAB_AGENT        = 'agent'       as const;
const TAB_APPEARANCE   = 'appearance'  as const;
const TAB_SCOPES       = 'scopes'      as const;
const TAB_DANGER       = 'danger'      as const;

type TabId =
  | typeof TAB_API_KEY
  | typeof TAB_AGENT
  | typeof TAB_APPEARANCE
  | typeof TAB_SCOPES
  | typeof TAB_DANGER;

const TABS: Array<{ id: TabId; label: string }> = [
  { id: TAB_API_KEY,    label: 'API Key' },
  { id: TAB_AGENT,      label: 'Agent' },
  { id: TAB_APPEARANCE, label: 'Appearance' },
  { id: TAB_SCOPES,     label: 'Google Scopes' },
  { id: TAB_DANGER,     label: 'Danger Zone' },
];

const THEME_ONBOARDING = 'onboarding';
const THEME_SHELL      = 'shell';

// ---------------------------------------------------------------------------
// Types (mirror preload shape)
// ---------------------------------------------------------------------------

interface OAuthScopeStatus {
  scope: string;
  label: string;
  granted: boolean;
}

interface ApiKeyTestResult {
  success: boolean;
  error?: string;
}

// Extend Window for TypeScript
declare global {
  interface Window {
    settingsAPI: {
      saveApiKey: (key: string) => Promise<void>;
      loadApiKey: () => Promise<string | null>;
      testApiKey: (key: string) => Promise<ApiKeyTestResult>;
      getAgentName: () => Promise<string | null>;
      setAgentName: (name: string) => Promise<void>;
      getTheme: () => Promise<string>;
      setTheme: (theme: string) => Promise<void>;
      getOAuthScopes: () => Promise<OAuthScopeStatus[]>;
      reConsentScope: (scope: string) => Promise<void>;
      factoryReset: () => Promise<void>;
      closeWindow: () => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Eye icon (show/hide password)
// ---------------------------------------------------------------------------

function EyeIcon({ open }: { open: boolean }): React.ReactElement {
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 3C4.5 3 1.5 5.5 1 8c.5 2.5 3.5 5 7 5s6.5-2.5 7-5c-.5-2.5-3.5-5-7-5z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 2l12 12M8 3C4.5 3 1.5 5.5 1 8c.5 2.5 3.5 5 7 5s6.5-2.5 7-5c-.5-2.5-3.5-5-7-5z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// API Key tab
// ---------------------------------------------------------------------------

function ApiKeyTab(): React.ReactElement {
  const toast = useToast();
  const [keyInput, setKeyInput]   = useState('');
  const [showKey, setShowKey]     = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [status, setStatus]       = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [testing, setTesting]     = useState(false);

  useEffect(() => {
    void window.settingsAPI.loadApiKey().then((masked) => {
      setMaskedKey(masked);
    });
  }, []);

  async function handleSave(): Promise<void> {
    if (!keyInput.trim()) {
      setStatus('Please enter an API key.');
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await window.settingsAPI.saveApiKey(keyInput.trim());
      const masked = await window.settingsAPI.loadApiKey();
      setMaskedKey(masked);
      setKeyInput('');
      setStatus('Saved');
      toast.show({ variant: 'success', title: 'API key saved' });
    } catch (err) {
      const msg = (err as Error).message ?? 'Failed to save';
      setStatus(`Error: ${msg}`);
      toast.show({ variant: 'error', title: 'Save failed', message: msg });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    const keyToTest = keyInput.trim() || null;
    if (!keyToTest) {
      setStatus('Enter a key to test.');
      return;
    }
    setTesting(true);
    setStatus(null);
    try {
      const result = await window.settingsAPI.testApiKey(keyToTest);
      if (result.success) {
        setStatus('Connected');
        toast.show({ variant: 'success', title: 'API key is valid' });
      } else {
        const msg = result.error ?? 'Invalid key';
        setStatus(`Invalid key: ${msg}`);
        toast.show({ variant: 'error', title: 'API key invalid', message: msg });
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'Test failed';
      setStatus(`Error: ${msg}`);
      toast.show({ variant: 'error', title: 'Test failed', message: msg });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Anthropic API Key</h2>
      <p className="settings-section-desc">
        Your API key is stored securely in the system keychain and never logged.
      </p>

      {maskedKey && (
        <Card variant="outline" padding="sm" className="settings-current-key">
          <span className="settings-label">Current key</span>
          <code className="settings-masked-key">{maskedKey}</code>
        </Card>
      )}

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-field">
          <label htmlFor="api-key-input" className="settings-label">
            New API key
          </label>
          <div className="settings-input-row">
            <input
              id="api-key-input"
              className="settings-input"
              type={showKey ? 'text' : 'password'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-ant-api03-…"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="settings-eye-btn"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
            >
              <EyeIcon open={showKey} />
            </button>
          </div>
        </div>

        {status && (
          <p
            className={`settings-status ${
              status === 'Saved' || status === 'Connected'
                ? 'settings-status--ok'
                : 'settings-status--err'
            }`}
            role="status"
            aria-live="polite"
          >
            {status === 'Connected' ? 'Connected' : status}
          </p>
        )}

        <div className="settings-row-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleTest()}
            loading={testing}
            disabled={saving}
          >
            Test
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
            disabled={testing}
          >
            Save
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent tab
// ---------------------------------------------------------------------------

function AgentTab(): React.ReactElement {
  const toast = useToast();
  const [agentName, setAgentName] = useState('');
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [email, setEmail]         = useState<string | null>(null);

  useEffect(() => {
    void window.settingsAPI.getAgentName().then((name) => {
      setSavedName(name);
      if (name) setAgentName(name);
    });
    // Read email from window title attribute if available; otherwise show nothing
  }, []);

  async function handleSave(): Promise<void> {
    if (!agentName.trim()) return;
    setSaving(true);
    try {
      await window.settingsAPI.setAgentName(agentName.trim());
      setSavedName(agentName.trim());
      toast.show({ variant: 'success', title: 'Agent name saved' });
    } catch (err) {
      toast.show({
        variant: 'error',
        title: 'Save failed',
        message: (err as Error).message,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Agent</h2>
      <p className="settings-section-desc">
        Name and identity settings for your AI companion.
      </p>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-field">
          <label htmlFor="agent-name-input" className="settings-label">
            Agent name
          </label>
          <input
            id="agent-name-input"
            className="settings-input"
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="e.g. Aria"
            maxLength={40}
          />
        </div>

        {email && (
          <div className="settings-field">
            <span className="settings-label">Account email</span>
            <span className="settings-readonly">{email}</span>
          </div>
        )}

        <div className="settings-row-actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
            disabled={!agentName.trim() || agentName.trim() === savedName}
          >
            Save
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance tab
// ---------------------------------------------------------------------------

function AppearanceTab(): React.ReactElement {
  const toast = useToast();
  const [theme, setTheme]   = useState(THEME_ONBOARDING);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.settingsAPI.getTheme().then((t) => setTheme(t));
  }, []);

  async function handleChange(next: string): Promise<void> {
    setTheme(next);
    setSaving(true);
    try {
      await window.settingsAPI.setTheme(next);
      toast.show({ variant: 'success', title: 'Theme updated' });
    } catch (err) {
      toast.show({
        variant: 'error',
        title: 'Theme save failed',
        message: (err as Error).message,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Appearance</h2>
      <p className="settings-section-desc">
        Choose the visual theme for the application.
      </p>

      <Card variant="default" padding="md" className="settings-card">
        <fieldset className="settings-fieldset" disabled={saving}>
          <legend className="settings-label">Theme</legend>

          <label className="settings-radio-row">
            <input
              type="radio"
              name="theme"
              value={THEME_ONBOARDING}
              checked={theme === THEME_ONBOARDING}
              onChange={() => void handleChange(THEME_ONBOARDING)}
            />
            <span className="settings-radio-content">
              <span className="settings-radio-label">Warm</span>
              <span className="settings-radio-desc">Onboarding palette — warm dark tones</span>
              <span
                className="settings-swatch"
                aria-hidden="true"
                style={{ background: 'linear-gradient(135deg, #1a1a1f 50%, #c8f135 50%)' }}
              />
            </span>
          </label>

          <label className="settings-radio-row">
            <input
              type="radio"
              name="theme"
              value={THEME_SHELL}
              checked={theme === THEME_SHELL}
              onChange={() => void handleChange(THEME_SHELL)}
            />
            <span className="settings-radio-content">
              <span className="settings-radio-label">Crisp</span>
              <span className="settings-radio-desc">Shell palette — cooler neutral tones</span>
              <span
                className="settings-swatch"
                aria-hidden="true"
                style={{ background: 'linear-gradient(135deg, #111118 50%, #6366f1 50%)' }}
              />
            </span>
          </label>
        </fieldset>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google Scopes tab
// ---------------------------------------------------------------------------

function GoogleScopesTab(): React.ReactElement {
  const toast = useToast();
  const [scopes, setScopes]         = useState<OAuthScopeStatus[]>([]);
  const [loading, setLoading]       = useState(true);
  const [reconsentId, setReconsentId] = useState<string | null>(null);

  useEffect(() => {
    void window.settingsAPI.getOAuthScopes().then((s) => {
      setScopes(s);
      setLoading(false);
    });
  }, []);

  async function handleReconsent(scope: string): Promise<void> {
    setReconsentId(scope);
    try {
      await window.settingsAPI.reConsentScope(scope);
      toast.show({
        variant: 'info',
        title: 'Re-consent initiated',
        message: `Scope: ${scope}`,
      });
    } catch (err) {
      toast.show({
        variant: 'error',
        title: 'Re-consent failed',
        message: (err as Error).message,
      });
    } finally {
      setReconsentId(null);
    }
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Google Scopes</h2>
        <div className="settings-loading">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Google Scopes</h2>
      <p className="settings-section-desc">
        Manage which Google services your agent has access to.
      </p>

      <Card variant="default" padding="none" className="settings-card">
        {scopes.map((s, idx) => (
          <div
            key={s.scope}
            className={`settings-scope-row ${idx < scopes.length - 1 ? 'settings-scope-row--bordered' : ''}`}
          >
            <div className="settings-scope-info">
              <span className="settings-scope-label">{s.label}</span>
              <code className="settings-scope-name">{s.scope}</code>
            </div>
            <div className="settings-scope-actions">
              <span
                className={`settings-scope-badge ${s.granted ? 'settings-scope-badge--granted' : 'settings-scope-badge--missing'}`}
              >
                {s.granted ? 'Granted' : 'Not granted'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleReconsent(s.scope)}
                loading={reconsentId === s.scope}
              >
                Re-consent
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger Zone tab
// ---------------------------------------------------------------------------

function DangerZoneTab(): React.ReactElement {
  const toast = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [resetting, setResetting]     = useState(false);

  async function handleReset(): Promise<void> {
    setResetting(true);
    setShowConfirm(false);
    try {
      await window.settingsAPI.factoryReset();
      // If we reach here (test env), show toast
      toast.show({ variant: 'success', title: 'Factory reset complete' });
    } catch (err) {
      toast.show({
        variant: 'error',
        title: 'Reset failed',
        message: (err as Error).message,
      });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title settings-section-title--danger">Danger Zone</h2>
      <p className="settings-section-desc">
        These actions are irreversible. Proceed with caution.
      </p>

      <Card variant="outline" padding="md" className="settings-card settings-card--danger">
        <div className="settings-danger-row">
          <div>
            <p className="settings-danger-label">Factory Reset</p>
            <p className="settings-danger-desc">
              Deletes all account data, API keys, preferences and logs. The app
              will restart. This cannot be undone.
            </p>
          </div>
          <Button
            variant="danger"
            size="sm"
            className="settings-danger-btn-solid"
            onClick={() => setShowConfirm(true)}
            loading={resetting}
          >
            {/* Warning glyph — 12px, stroked, no fill */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path
                d="M6 1.5L11 10.5H1L6 1.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <line x1="6" y1="5" x2="6" y2="7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="6" cy="9" r="0.6" fill="currentColor" />
            </svg>
            Factory Reset
          </Button>
        </div>
      </Card>

      <Modal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Confirm Factory Reset"
        size="sm"
      >
        <p className="settings-modal-body">
          This will permanently delete all your data including your API key,
          account info, and preferences. The app will restart.
        </p>
        <div className="settings-modal-actions">
          <Button variant="secondary" size="sm" onClick={() => setShowConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleReset()}
            loading={resetting}
          >
            Yes, reset everything
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner app (uses useToast — must be inside ToastProvider)
// ---------------------------------------------------------------------------

function SettingsInner(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>(TAB_API_KEY);
  const navListRef = React.useRef<HTMLUListElement>(null);

  function handleClose(): void {
    window.settingsAPI.closeWindow();
  }

  /** Arrow-key navigation between sidebar items (ARIA tabs pattern) */
  function handleSidebarKeyDown(e: React.KeyboardEvent<HTMLUListElement>): void {
    const items = navListRef.current?.querySelectorAll<HTMLButtonElement>('.settings-nav-item');
    if (!items || items.length === 0) return;
    const currentIndex = TABS.findIndex((t) => t.id === activeTab);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (currentIndex + 1) % TABS.length;
      setActiveTab(TABS[next].id);
      items[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (currentIndex - 1 + TABS.length) % TABS.length;
      setActiveTab(TABS[prev].id);
      items[prev]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveTab(TABS[0].id);
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveTab(TABS[TABS.length - 1].id);
      items[TABS.length - 1]?.focus();
    }
  }

  const content: Record<TabId, React.ReactElement> = {
    [TAB_API_KEY]:    <ApiKeyTab />,
    [TAB_AGENT]:      <AgentTab />,
    [TAB_APPEARANCE]: <AppearanceTab />,
    [TAB_SCOPES]:     <GoogleScopesTab />,
    [TAB_DANGER]:     <DangerZoneTab />,
  };

  return (
    <div className="settings-shell" role="application" aria-label="Settings">
      {/* Sidebar */}
      <nav className="settings-sidebar" aria-label="Settings navigation">
        <div className="settings-sidebar-header">
          <span className="settings-sidebar-title">Settings</span>
        </div>
        <ul
          ref={navListRef}
          className="settings-nav-list"
          role="list"
          onKeyDown={handleSidebarKeyDown}
          aria-label="Settings sections"
        >
          {TABS.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                className={`settings-nav-item ${activeTab === tab.id ? 'settings-nav-item--active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                tabIndex={activeTab === tab.id ? 0 : -1}
              >
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content area */}
      <div className="settings-content">
        {/* Header */}
        <header className="settings-header">
          <h1 className="settings-title">
            {TABS.find((t) => t.id === activeTab)?.label ?? 'Settings'}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <KeyHint keys={['Esc']} size="xs" aria-label="Esc to close" />
            <button
              type="button"
              className="settings-close-btn"
              onClick={handleClose}
              aria-label="Close settings"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M1 1l12 12M13 1L1 13"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </header>

        {/* Tab content */}
        <main className="settings-main">
          {content[activeTab]}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function SettingsApp(): React.ReactElement {
  return (
    <ToastProvider>
      <SettingsInner />
    </ToastProvider>
  );
}

export default SettingsApp;
