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
import { ClearDataDialog } from './ClearDataDialog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_API_KEY      = 'api-key'     as const;
const TAB_AGENT        = 'agent'       as const;
const TAB_APPEARANCE   = 'appearance'  as const;
const TAB_SCOPES       = 'scopes'      as const;
const TAB_DANGER       = 'danger'      as const;
const TAB_PROFILES     = 'profiles'    as const;
const TAB_PRIVACY      = 'privacy'     as const;
const TAB_PASSWORDS    = 'passwords'   as const;
const TAB_ZOOM         = 'site-zoom'   as const;

type TabId =
  | typeof TAB_API_KEY
  | typeof TAB_AGENT
  | typeof TAB_APPEARANCE
  | typeof TAB_SCOPES
  | typeof TAB_PASSWORDS
  | typeof TAB_PROFILES
  | typeof TAB_PRIVACY
  | typeof TAB_PASSWORDS
  | typeof TAB_ZOOM
  | typeof TAB_PASSWORDS
  | typeof TAB_DANGER;

const TABS: Array<{ id: TabId; label: string }> = [
  { id: TAB_API_KEY,    label: 'API Key' },
  { id: TAB_AGENT,      label: 'Agent' },
  { id: TAB_APPEARANCE, label: 'Appearance' },
  { id: TAB_SCOPES,     label: 'Google Scopes' },
  { id: TAB_PASSWORDS,  label: 'Passwords' },
  { id: TAB_PROFILES,   label: 'Profiles' },
  { id: TAB_PRIVACY,    label: 'Privacy and security' },
  { id: TAB_ZOOM,       label: 'Site Zoom' },
  { id: TAB_DANGER,     label: 'Danger Zone' },
];

const THEME_ONBOARDING = 'onboarding';
const THEME_SHELL      = 'shell';

const FONT_SIZE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 9,  label: 'Very small' },
  { value: 12, label: 'Small' },
  { value: 16, label: 'Medium (default)' },
  { value: 20, label: 'Large' },
  { value: 24, label: 'Very large' },
];

const PAGE_ZOOM_OPTIONS = [
  75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

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

// Shape of a password list entry, mirrored from the preload bridge.
interface PasswordListEntry {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
}

type ClearDataTypeId =
  | 'history' | 'cookies' | 'cache' | 'downloads'
  | 'passwords' | 'autofill' | 'siteSettings' | 'hostedApp';

interface ClearBrowsingDataResult {
  cleared: ClearDataTypeId[];
  errors: Partial<Record<ClearDataTypeId, string>>;
  notes: Partial<Record<ClearDataTypeId, string>>;
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
      getFontSize: () => Promise<number>;
      setFontSize: (size: number) => Promise<void>;
      getDefaultPageZoom: () => Promise<number>;
      setDefaultPageZoom: (percent: number) => Promise<void>;
      getOAuthScopes: () => Promise<OAuthScopeStatus[]>;
      reConsentScope: (scope: string) => Promise<void>;
      factoryReset: () => Promise<void>;
      clearBrowsingData: (req: {
        types: ClearDataTypeId[];
        timeRangeMs: number;
      }) => Promise<ClearBrowsingDataResult>;
      onOpenClearDataDialog: (handler: () => void) => () => void;
      getZoomOverrides: () => Promise<Array<{ origin: string; zoomLevel: number }>>;
      removeZoomOverride: (origin: string) => Promise<boolean>;
      clearAllZoomOverrides: () => Promise<void>;
      getShowProfilePicker: () => Promise<boolean>;
      setShowProfilePicker: (show: boolean) => Promise<void>;
      closeWindow: () => void;
      listPasswords: () => Promise<PasswordListEntry[]>;
      revealPassword: (id: string) => Promise<string | null>;
      updatePassword: (payload: { id: string; username?: string; password?: string }) => Promise<boolean>;
      deletePassword: (id: string) => Promise<boolean>;
      deleteAllPasswords: () => Promise<void>;
      listNeverSave: () => Promise<string[]>;
      removeNeverSave: (origin: string) => Promise<void>;
      checkPasswords: () => Promise<Array<{ id: string; flags: Array<'compromised' | 'reused' | 'weak'>; breachCount: number }>>;
      isBiometricAvailable: () => Promise<boolean>;
      getBiometricLock: () => Promise<boolean>;
      setBiometricLock: (enabled: boolean) => Promise<void>;
      getHttpsFirst: () => Promise<boolean>;
      setHttpsFirst: (enabled: boolean) => Promise<void>;
      getDntEnabled: () => Promise<boolean>;
      setDntEnabled: (enabled: boolean) => Promise<void>;
      getGpcEnabled: () => Promise<boolean>;
      setGpcEnabled: (enabled: boolean) => Promise<void>;
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
  const [theme, setTheme]       = useState(THEME_ONBOARDING);
  const [fontSize, setFontSize] = useState(16);
  const [pageZoom, setPageZoom] = useState(100);
  const [saving, setSaving]     = useState(false);

  useEffect(() => {
    void window.settingsAPI.getTheme().then((t) => setTheme(t));
    void window.settingsAPI.getFontSize().then((s) => setFontSize(s));
    void window.settingsAPI.getDefaultPageZoom().then((level) => {
      const percent = Math.round(Math.pow(1.2, level) * 100);
      setPageZoom(percent);
    });
  }, []);

  async function handleThemeChange(next: string): Promise<void> {
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

  async function handleFontSizeChange(size: number): Promise<void> {
    setFontSize(size);
    try {
      await window.settingsAPI.setFontSize(size);
      toast.show({ variant: 'success', title: `Font size set to ${FONT_SIZE_OPTIONS.find((o) => o.value === size)?.label ?? size}` });
    } catch (err) {
      toast.show({
        variant: 'error',
        title: 'Font size save failed',
        message: (err as Error).message,
      });
    }
  }

  async function handlePageZoomChange(percent: number): Promise<void> {
    setPageZoom(percent);
    try {
      await window.settingsAPI.setDefaultPageZoom(percent);
      toast.show({ variant: 'success', title: `Default page zoom set to ${percent}%` });
    } catch (err) {
      toast.show({
        variant: 'error',
        title: 'Page zoom save failed',
        message: (err as Error).message,
      });
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Appearance</h2>
      <p className="settings-section-desc">
        Customize the visual theme, font size, and page zoom.
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
              onChange={() => void handleThemeChange(THEME_ONBOARDING)}
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
              onChange={() => void handleThemeChange(THEME_SHELL)}
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

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-field">
          <label className="settings-label" htmlFor="font-size-select">Font size</label>
          <p className="settings-field-hint">Affects text size on web pages without changing layout.</p>
          <select
            id="font-size-select"
            className="settings-select"
            value={fontSize}
            onChange={(e) => void handleFontSizeChange(Number(e.target.value))}
          >
            {FONT_SIZE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </Card>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-field">
          <label className="settings-label" htmlFor="page-zoom-select">Page zoom</label>
          <p className="settings-field-hint">Sets the default zoom level for all pages. Per-site overrides take priority.</p>
          <select
            id="page-zoom-select"
            className="settings-select"
            value={pageZoom}
            onChange={(e) => void handlePageZoomChange(Number(e.target.value))}
          >
            {PAGE_ZOOM_OPTIONS.map((p) => (
              <option key={p} value={p}>{p}%{p === 100 ? ' (default)' : ''}</option>
            ))}
          </select>
        </div>
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
// Profiles tab
// ---------------------------------------------------------------------------

function ProfilesTab(): React.ReactElement {
  const toast = useToast();
  const [showPicker, setShowPicker] = useState(false);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    void window.settingsAPI.getShowProfilePicker().then((val) => {
      setShowPicker(val);
      setLoading(false);
    });
  }, []);

  async function handleToggle(checked: boolean): Promise<void> {
    setShowPicker(checked);
    try {
      await window.settingsAPI.setShowProfilePicker(checked);
      toast.show({
        variant: 'success',
        title: checked ? 'Profile picker enabled' : 'Profile picker disabled',
      });
    } catch (err) {
      setShowPicker(!checked);
      toast.show({
        variant: 'error',
        title: 'Failed to update setting',
        message: (err as Error).message,
      });
    }
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Profiles</h2>
        <div className="settings-loading">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Profiles</h2>
      <p className="settings-section-desc">
        Manage browser profiles and startup behavior.
      </p>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">
              Show profile picker when opening the browser
            </span>
            <span className="settings-toggle-desc">
              Choose which profile to use each time you start browsing.
            </span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={showPicker}
              onChange={(e) => void handleToggle(e.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Privacy and security tab
// ---------------------------------------------------------------------------

interface PrivacyTabProps {
  openDialog: boolean;
  onDialogChange: (open: boolean) => void;
}

function PrivacyTab({ openDialog, onDialogChange }: PrivacyTabProps): React.ReactElement {
  const toast = useToast();
  const [httpsFirst, setHttpsFirst] = useState(false);
  const [httpsFirstLoading, setHttpsFirstLoading] = useState(true);
  const [dntEnabled, setDntEnabled] = useState(false);
  const [gpcEnabled, setGpcEnabled] = useState(false);
  const [privacyLoading, setPrivacyLoading] = useState(true);

  useEffect(() => {
    void window.settingsAPI.getHttpsFirst().then((val) => {
      setHttpsFirst(val);
    }).catch(() => {
    }).finally(() => {
      setHttpsFirstLoading(false);
    });

    void Promise.all([
      window.settingsAPI.getDntEnabled(),
      window.settingsAPI.getGpcEnabled(),
    ]).then(([dnt, gpc]) => {
      setDntEnabled(dnt);
      setGpcEnabled(gpc);
    }).catch(() => {
    }).finally(() => {
      setPrivacyLoading(false);
    });
  }, []);

  async function handleHttpsFirstToggle(checked: boolean): Promise<void> {
    setHttpsFirst(checked);
    try {
      await window.settingsAPI.setHttpsFirst(checked);
      toast.show({
        variant: 'success',
        title: checked ? 'HTTPS-First mode enabled' : 'HTTPS-First mode disabled',
      });
    } catch (err) {
      setHttpsFirst(!checked);
      toast.show({
        variant: 'error',
        title: 'Failed to update setting',
        message: (err as Error).message,
      });
    }
  }

  async function handleDntToggle(checked: boolean): Promise<void> {
    setDntEnabled(checked);
    try {
      await window.settingsAPI.setDntEnabled(checked);
      toast.show({
        variant: 'success',
        title: checked
          ? 'Do Not Track enabled'
          : 'Do Not Track disabled',
      });
    } catch (err) {
      setDntEnabled(!checked);
      toast.show({
        variant: 'error',
        title: 'Failed to update setting',
        message: (err as Error).message,
      });
    }
  }

  async function handleGpcToggle(checked: boolean): Promise<void> {
    setGpcEnabled(checked);
    try {
      await window.settingsAPI.setGpcEnabled(checked);
      toast.show({
        variant: 'success',
        title: checked
          ? 'Global Privacy Control enabled'
          : 'Global Privacy Control disabled',
      });
    } catch (err) {
      setGpcEnabled(!checked);
      toast.show({
        variant: 'error',
        title: 'Failed to update setting',
        message: (err as Error).message,
      });
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Privacy and security</h2>
      <p className="settings-section-desc">
        Control what local browsing data is stored on this device.
      </p>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">
              Always use secure connections
            </span>
            <span className="settings-toggle-desc">
              Automatically upgrade HTTP connections to HTTPS. When a site
              does not support HTTPS, a warning is shown before continuing.
            </span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={httpsFirst}
              disabled={httpsFirstLoading}
              onChange={(e) => void handleHttpsFirstToggle(e.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
      </Card>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">
              Send a "Do Not Track" request with your browsing traffic
            </span>
            <span className="settings-toggle-desc">
              Sends a DNT: 1 header with every request. Sites are not required
              to honor this signal.
            </span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={dntEnabled}
              disabled={privacyLoading}
              onChange={(e) => void handleDntToggle(e.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
      </Card>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">
              Send a "Global Privacy Control" signal with your browsing traffic
            </span>
            <span className="settings-toggle-desc">
              Sends a Sec-GPC: 1 header with every request, signaling that you
              do not want your data sold or shared. Sites are not required to
              honor this signal.
            </span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={gpcEnabled}
              disabled={privacyLoading}
              onChange={(e) => void handleGpcToggle(e.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>
      </Card>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-privacy-row">
          <div>
            <p className="settings-privacy-label">Clear browsing data</p>
            <p className="settings-privacy-desc">
              Clear history, cookies, cache, and more. Keyboard shortcut:
              {' '}Cmd+Shift+Delete.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onDialogChange(true)}
          >
            Clear data…
          </Button>
        </div>
      </Card>

      <ClearDataDialog
        open={openDialog}
        onClose={() => onDialogChange(false)}
        onComplete={(result) => {
          const errCount = Object.keys(result.errors).length;
          if (errCount === 0) {
            toast.show({
              variant: 'success',
              title: 'Data cleared',
              message: `Cleared ${result.cleared.length} item${result.cleared.length === 1 ? '' : 's'}.`,
            });
          } else {
            toast.show({
              variant: 'error',
              title: 'Partial clear',
              message: `${errCount} item${errCount === 1 ? '' : 's'} failed.`,
            });
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site Zoom tab
// ---------------------------------------------------------------------------

function zoomLevelToPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100);
}

function SiteZoomTab(): React.ReactElement {
  const toast = useToast();
  const [overrides, setOverrides] = useState<Array<{ origin: string; zoomLevel: number }>>([]);
  const [loading, setLoading] = useState(true);

  const loadOverrides = useCallback(async () => {
    const data = await window.settingsAPI.getZoomOverrides();
    setOverrides(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  async function handleRemove(origin: string): Promise<void> {
    const ok = await window.settingsAPI.removeZoomOverride(origin);
    if (ok) {
      setOverrides((prev) => prev.filter((o) => o.origin !== origin));
      toast.show({ variant: 'success', title: 'Zoom override removed' });
    }
  }

  async function handleClearAll(): Promise<void> {
    await window.settingsAPI.clearAllZoomOverrides();
    setOverrides([]);
    toast.show({ variant: 'success', title: 'All zoom overrides cleared' });
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Site Zoom</h2>
        <div className="settings-loading">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Site Zoom</h2>
      <p className="settings-section-desc">
        Per-site zoom levels persist across sessions. Remove overrides to
        reset individual sites back to 100%.
      </p>

      {overrides.length === 0 ? (
        <Card variant="outline" padding="md" className="settings-card">
          <p style={{ color: 'var(--color-fg-tertiary)', fontSize: 13 }}>
            No per-site zoom overrides saved.
          </p>
        </Card>
      ) : (
        <>
          <Card variant="default" padding="none" className="settings-card">
            {overrides.map((entry, idx) => (
              <div
                key={entry.origin}
                className={`settings-scope-row ${idx < overrides.length - 1 ? 'settings-scope-row--bordered' : ''}`}
              >
                <div className="settings-scope-info">
                  <span className="settings-scope-label" style={{ fontFamily: 'var(--font-ui)' }}>
                    {entry.origin}
                  </span>
                  <span className="settings-scope-name">
                    {zoomLevelToPercent(entry.zoomLevel)}%
                  </span>
                </div>
                <div className="settings-scope-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRemove(entry.origin)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </Card>

          <div style={{ marginTop: 12 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleClearAll()}
            >
              Clear all overrides
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Passwords tab
// ---------------------------------------------------------------------------

interface PasswordEntry {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
}

type CheckupFlag = 'compromised' | 'reused' | 'weak';

interface CheckupResult {
  id: string;
  flags: CheckupFlag[];
  breachCount: number;
}

const FLAG_LABELS: Record<CheckupFlag, string> = {
  compromised: 'Compromised',
  reused: 'Reused',
  weak: 'Weak',
};

const FLAG_COLORS: Record<CheckupFlag, string> = {
  compromised: 'var(--color-danger, #dc3545)',
  reused: 'var(--color-warning, #f0ad4e)',
  weak: 'var(--color-warning, #f0ad4e)',
};

function CheckupBadge({ flag }: { flag: CheckupFlag }): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
        backgroundColor: FLAG_COLORS[flag],
        marginRight: 4,
      }}
    >
      {FLAG_LABELS[flag]}
    </span>
  );
}

function PasswordsTab(): React.ReactElement {
  const toast = useToast();
  const [passwords, setPasswords] = useState<PasswordEntry[]>([]);
  const [neverSave, setNeverSave] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedPw, setRevealedPw] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLock, setBiometricLock] = useState(false);

  const [checkupResults, setCheckupResults] = useState<Map<string, CheckupResult>>(new Map());
  const [checkupRunning, setCheckupRunning] = useState(false);
  const [checkupDone, setCheckupDone] = useState(false);

  const loadData = useCallback(async () => {
    const [pw, ns, bioAvail, bioLock] = await Promise.all([
      window.settingsAPI.listPasswords(),
      window.settingsAPI.listNeverSave(),
      window.settingsAPI.isBiometricAvailable(),
      window.settingsAPI.getBiometricLock(),
    ]);
    setPasswords(pw);
    setNeverSave(ns);
    setBiometricAvailable(bioAvail);
    setBiometricLock(bioLock);
    setLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const filtered = passwords.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.origin.toLowerCase().includes(q) || p.username.toLowerCase().includes(q);
  });

  async function handleCheckPasswords(): Promise<void> {
    if (passwords.length === 0) {
      toast.show({ variant: 'error', title: 'No passwords to check' });
      return;
    }
    setCheckupRunning(true);
    setCheckupDone(false);
    setCheckupResults(new Map());
    try {
      const results = await window.settingsAPI.checkPasswords();
      const map = new Map<string, CheckupResult>();
      for (const r of results) {
        map.set(r.id, r);
      }
      setCheckupResults(map);
      setCheckupDone(true);

      const compromised = results.filter((r) => r.flags.includes('compromised')).length;
      const reused = results.filter((r) => r.flags.includes('reused')).length;
      const weak = results.filter((r) => r.flags.includes('weak')).length;
      const safe = results.filter((r) => r.flags.length === 0).length;

      if (compromised === 0 && reused === 0 && weak === 0) {
        toast.show({ variant: 'success', title: `All ${safe} passwords look good` });
      } else {
        const parts: string[] = [];
        if (compromised > 0) parts.push(`${compromised} compromised`);
        if (reused > 0) parts.push(`${reused} reused`);
        if (weak > 0) parts.push(`${weak} weak`);
        toast.show({ variant: 'error', title: `Found ${parts.join(', ')}` });
      }
    } catch (err) {
      toast.show({ variant: 'error', title: 'Password check failed', message: (err as Error).message });
    } finally {
      setCheckupRunning(false);
    }
  }

  function getChangePasswordUrl(origin: string): string {
    try {
      const url = new URL(origin);
      return `${url.origin}/.well-known/change-password`;
    } catch {
      return origin;
    }
  }

  async function handleBiometricToggle(checked: boolean): Promise<void> {
    setBiometricLock(checked);
    try {
      await window.settingsAPI.setBiometricLock(checked);
      toast.show({
        variant: 'success',
        title: checked ? 'Touch ID enabled for passwords' : 'Touch ID disabled for passwords',
      });
    } catch (err) {
      setBiometricLock(!checked);
      toast.show({
        variant: 'error',
        title: 'Failed to update setting',
        message: (err as Error).message,
      });
    }
  }

  async function handleReveal(id: string): Promise<void> {
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedPw(null);
      return;
    }
    try {
      const pw = await window.settingsAPI.revealPassword(id);
      setRevealedId(id);
      setRevealedPw(pw);
    } catch (err) {
      toast.show({ variant: 'error', title: 'Authentication required', message: (err as Error).message });
    }
  }

  async function handleCopy(id: string): Promise<void> {
    try {
      const pw = await window.settingsAPI.revealPassword(id);
      if (pw) {
        await navigator.clipboard.writeText(pw);
        toast.show({ variant: 'success', title: 'Password copied' });
      }
    } catch (err) {
      toast.show({ variant: 'error', title: 'Authentication required', message: (err as Error).message });
    }
  }

  async function handleDelete(id: string): Promise<void> {
    await window.settingsAPI.deletePassword(id);
    setPasswords((prev) => prev.filter((p) => p.id !== id));
    setCheckupResults((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    toast.show({ variant: 'success', title: 'Password deleted' });
  }

  function startEdit(entry: PasswordEntry): void {
    setEditId(entry.id);
    setEditUsername(entry.username);
    setEditPassword('');
  }

  async function handleEditSave(): Promise<void> {
    if (!editId) return;
    const updates: { username?: string; password?: string } = {};
    if (editUsername) updates.username = editUsername;
    if (editPassword) updates.password = editPassword;
    try {
      await window.settingsAPI.updatePassword({ id: editId, ...updates });
      setCheckupResults((prev) => {
        const next = new Map(prev);
        next.delete(editId);
        return next;
      });
      setEditId(null);
      setEditUsername('');
      setEditPassword('');
      void loadData();
      toast.show({ variant: 'success', title: 'Password updated' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Authentication required', message: (err as Error).message });
    }
  }

  async function handleRemoveNeverSave(origin: string): Promise<void> {
    await window.settingsAPI.removeNeverSave(origin);
    setNeverSave((prev) => prev.filter((o) => o !== origin));
    toast.show({ variant: 'success', title: 'Removed from never-save list' });
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Passwords</h2>
        <div className="settings-loading"><Spinner size="md" /></div>
      </div>
    );
  }

  const compromisedCount = [...checkupResults.values()].filter((r) => r.flags.includes('compromised')).length;
  const reusedCount = [...checkupResults.values()].filter((r) => r.flags.includes('reused')).length;
  const weakCount = [...checkupResults.values()].filter((r) => r.flags.includes('weak')).length;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Passwords</h2>
      <p className="settings-section-desc">
        Manage saved passwords and sites that never save passwords.
      </p>

      {/* Password checkup */}
      <Card variant="default" padding="md" className="settings-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Password Checkup</div>
            <div style={{ fontSize: 13, color: 'var(--color-fg-secondary)' }}>
              Check your saved passwords against known data breaches, find reused
              passwords, and identify weak ones.
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleCheckPasswords()}
            loading={checkupRunning}
            style={{ marginLeft: 16, flexShrink: 0 }}
          >
            {checkupRunning ? 'Checking...' : 'Check passwords'}
          </Button>
        </div>

        {checkupDone && (
          <div style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 8,
            backgroundColor: (compromisedCount + reusedCount + weakCount) > 0
              ? 'var(--color-danger-bg, rgba(220, 53, 69, 0.08))'
              : 'var(--color-success-bg, rgba(40, 167, 69, 0.08))',
          }}>
            {(compromisedCount + reusedCount + weakCount) === 0 ? (
              <span style={{ color: 'var(--color-success, #28a745)', fontWeight: 600 }}>
                All {passwords.length} passwords are safe
              </span>
            ) : (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {compromisedCount > 0 && (
                  <span style={{ color: FLAG_COLORS.compromised, fontWeight: 600 }}>
                    {compromisedCount} compromised
                  </span>
                )}
                {reusedCount > 0 && (
                  <span style={{ color: FLAG_COLORS.reused, fontWeight: 600 }}>
                    {reusedCount} reused
                  </span>
                )}
                {weakCount > 0 && (
                  <span style={{ color: FLAG_COLORS.weak, fontWeight: 600 }}>
                    {weakCount} weak
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Biometric lock toggle */}
      {biometricAvailable && (
        <Card variant="default" padding="md" className="settings-card">
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">
                Use Touch ID to fill passwords
              </span>
              <span className="settings-toggle-desc">
                Require Touch ID or your login password before filling, revealing,
                copying, or editing saved passwords.
              </span>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={biometricLock}
                onChange={(e) => void handleBiometricToggle(e.target.checked)}
              />
              <span className="settings-toggle-track" />
            </label>
          </div>
        </Card>
      )}

      {/* Search */}
      <div className="settings-field" style={{ marginBottom: 16 }}>
        <input
          className="settings-input"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search passwords..."
        />
      </div>

      {/* Saved passwords */}
      <Card variant="default" padding="none" className="settings-card">
        {filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-fg-tertiary)' }}>
            {passwords.length === 0 ? 'No saved passwords' : 'No matching passwords'}
          </div>
        ) : (
          filtered.map((entry, idx) => {
            const result = checkupResults.get(entry.id);
            const hasFlags = result && result.flags.length > 0;
            return (
              <div
                key={entry.id}
                className={`settings-scope-row ${idx < filtered.length - 1 ? 'settings-scope-row--bordered' : ''}`}
              >
                {editId === entry.id ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
                    <input
                      className="settings-input"
                      type="text"
                      value={editUsername}
                      onChange={(e) => setEditUsername(e.target.value)}
                      placeholder="Username"
                    />
                    <input
                      className="settings-input"
                      type="password"
                      value={editPassword}
                      onChange={(e) => setEditPassword(e.target.value)}
                      placeholder="New password (leave blank to keep)"
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button variant="primary" size="sm" onClick={() => void handleEditSave()}>
                        Save
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setEditId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="settings-scope-info">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="settings-scope-label">{entry.origin}</span>
                        {hasFlags && result.flags.map((f) => (
                          <CheckupBadge key={f} flag={f} />
                        ))}
                      </div>
                      <code className="settings-scope-name">{entry.username}</code>
                      {result && result.flags.includes('compromised') && result.breachCount > 0 && (
                        <span style={{ fontSize: 12, color: FLAG_COLORS.compromised }}>
                          Found in {result.breachCount.toLocaleString()} data breaches
                        </span>
                      )}
                      {revealedId === entry.id && revealedPw !== null && (
                        <code className="settings-scope-name" style={{ color: 'var(--color-fg-primary)' }}>
                          {revealedPw}
                        </code>
                      )}
                    </div>
                    <div className="settings-scope-actions" style={{ gap: 4 }}>
                      {hasFlags && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => window.open(getChangePasswordUrl(entry.origin), '_blank')}
                        >
                          Change password
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => void handleReveal(entry.id)}>
                        {revealedId === entry.id ? 'Hide' : 'Reveal'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void handleCopy(entry.id)}>
                        Copy
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => startEdit(entry)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void handleDelete(entry.id)}>
                        Delete
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </Card>

      {/* Never-save list */}
      {neverSave.length > 0 && (
        <>
          <h3 className="settings-section-title" style={{ marginTop: 24, fontSize: 14 }}>
            Never saved
          </h3>
          <p className="settings-section-desc">
            Passwords will never be saved for these sites.
          </p>
          <Card variant="outline" padding="none" className="settings-card">
            {neverSave.map((origin, idx) => (
              <div
                key={origin}
                className={`settings-scope-row ${idx < neverSave.length - 1 ? 'settings-scope-row--bordered' : ''}`}
              >
                <div className="settings-scope-info">
                  <span className="settings-scope-label">{origin}</span>
                </div>
                <div className="settings-scope-actions">
                  <Button variant="ghost" size="sm" onClick={() => void handleRemoveNeverSave(origin)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}
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
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const navListRef = React.useRef<HTMLUListElement>(null);

  // Main -> renderer: Cmd+Shift+Delete menu click sends
  // 'settings:open-clear-data-dialog'. Route to Privacy tab and open modal.
  useEffect(() => {
    const unsubscribe = window.settingsAPI.onOpenClearDataDialog(() => {
      setActiveTab(TAB_PRIVACY);
      setClearDataOpen(true);
    });
    return () => {
      unsubscribe();
    };
  }, []);

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
    [TAB_PASSWORDS]:  <PasswordsTab />,
    [TAB_PROFILES]:   <ProfilesTab />,
    [TAB_PRIVACY]:    <PrivacyTab openDialog={clearDataOpen} onDialogChange={setClearDataOpen} />,
    [TAB_ZOOM]:       <SiteZoomTab />,
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
