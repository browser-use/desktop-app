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

const TAB_API_KEY        = 'api-key'          as const;
const TAB_AGENT          = 'agent'            as const;
const TAB_APPEARANCE     = 'appearance'       as const;
const TAB_SCOPES         = 'scopes'           as const;
const TAB_DANGER         = 'danger'           as const;
const TAB_PROFILES       = 'profiles'         as const;
const TAB_SYNC           = 'sync'             as const;
const TAB_PRIVACY        = 'privacy'          as const;
const TAB_PASSWORDS      = 'passwords'        as const;
const TAB_ZOOM           = 'site-zoom'        as const;
const TAB_CONTENT        = 'content'          as const;
const TAB_PERMISSIONS    = 'permissions'      as const;
const TAB_ADDRESSES      = 'addresses'        as const;
const TAB_PAYMENTS       = 'payments'         as const;
const TAB_DOWNLOADS      = 'downloads'        as const;
const TAB_ACCESSIBILITY  = 'accessibility'    as const;
const TAB_SEARCH_ENGINES = 'search-engines'   as const;

type TabId =
  | typeof TAB_API_KEY
  | typeof TAB_AGENT
  | typeof TAB_APPEARANCE
  | typeof TAB_SCOPES
  | typeof TAB_PASSWORDS
  | typeof TAB_PROFILES
  | typeof TAB_SYNC
  | typeof TAB_PRIVACY
  | typeof TAB_ZOOM
  | typeof TAB_CONTENT
  | typeof TAB_PERMISSIONS
  | typeof TAB_ADDRESSES
  | typeof TAB_PAYMENTS
  | typeof TAB_DOWNLOADS
  | typeof TAB_ACCESSIBILITY
  | typeof TAB_SEARCH_ENGINES
  | typeof TAB_DANGER;

const TABS: Array<{ id: TabId; label: string }> = [
  { id: TAB_API_KEY,        label: 'API Key' },
  { id: TAB_AGENT,          label: 'Agent' },
  { id: TAB_APPEARANCE,     label: 'Appearance' },
  { id: TAB_SCOPES,         label: 'Google Scopes' },
  { id: TAB_PASSWORDS,      label: 'Passwords' },
  { id: TAB_PROFILES,       label: 'Profiles' },
  { id: TAB_SYNC,           label: 'Sync' },
  { id: TAB_PRIVACY,        label: 'Privacy and security' },
  { id: TAB_ZOOM,           label: 'Site Zoom' },
  { id: TAB_CONTENT,        label: 'Content' },
  { id: TAB_PERMISSIONS,    label: 'Permissions' },
  { id: TAB_ADDRESSES,      label: 'Addresses' },
  { id: TAB_PAYMENTS,       label: 'Payments' },
  { id: TAB_DOWNLOADS,      label: 'Downloads' },
  { id: TAB_ACCESSIBILITY,  label: 'Accessibility' },
  { id: TAB_SEARCH_ENGINES, label: 'Search Engines' },
  { id: TAB_DANGER,         label: 'Danger Zone' },
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

interface SearchEngineEntry {
  id: string;
  name: string;
  keyword: string;
  searchUrl: string;
  isBuiltIn: boolean;
}

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

// Issue #200: `hostedApp` was removed after its checkbox was wired to a
// silent no-op in the main process.
type ClearDataTypeId =
  | 'history' | 'cookies' | 'cache' | 'downloads'
  | 'passwords' | 'autofill' | 'siteSettings';

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
      getLiveCaption: () => Promise<{ enabled: boolean; language: string }>;
      setLiveCaption: (patch: { enabled?: boolean; language?: string }) => Promise<boolean>;
      getContentCategoryDefaults: () => Promise<Record<string, string>>;
      setContentCategoryDefault: (category: string, state: string) => Promise<void>;
      getContentCategorySite: (origin: string) => Promise<Array<{ origin: string; category: string; state: string; updatedAt: number }>>;
      setContentCategorySite: (origin: string, category: string, state: string) => Promise<void>;
      removeContentCategorySite: (origin: string, category: string) => Promise<boolean>;
      getAllContentCategoryOverrides: () => Promise<Array<{ origin: string; category: string; state: string; updatedAt: number }>>;
      clearContentCategoryOrigin: (origin: string) => Promise<void>;
      resetAllContentCategoryOverrides: () => Promise<void>;
      saveAddress: (fields: Omit<{ id: string; fullName: string; company: string; addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string; phone: string; email: string; createdAt: number; updatedAt: number }, 'id' | 'createdAt' | 'updatedAt'>) => Promise<{ id: string; fullName: string; company: string; addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string; phone: string; email: string; createdAt: number; updatedAt: number }>;
      listAddresses: () => Promise<Array<{ id: string; fullName: string; company: string; addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string; phone: string; email: string; createdAt: number; updatedAt: number }>>;
      updateAddress: (payload: { id: string } & Partial<{ fullName: string; company: string; addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string; phone: string; email: string }>) => Promise<boolean>;
      deleteAddress: (id: string) => Promise<boolean>;
      saveCard: (fields: { nameOnCard: string; cardNumber: string; expiryMonth: string; expiryYear: string; nickname: string }) => Promise<{ id: string; nameOnCard: string; lastFour: string; network: string; expiryMonth: string; expiryYear: string; nickname: string; createdAt: number; updatedAt: number }>;
      listCards: () => Promise<Array<{ id: string; nameOnCard: string; lastFour: string; network: string; expiryMonth: string; expiryYear: string; nickname: string; createdAt: number; updatedAt: number }>>;
      revealCardNumber: (id: string) => Promise<string | null>;
      updateCard: (payload: { id: string; nameOnCard?: string; cardNumber?: string; expiryMonth?: string; expiryYear?: string; nickname?: string }) => Promise<boolean>;
      deleteCard: (id: string) => Promise<boolean>;
      deleteAllAutofill: () => Promise<void>;
      scanAutoRevokePermissions: () => Promise<{
        candidates: Array<{
          origin: string;
          permissionType: string;
          grantedAt: number;
          daysSinceVisit: number | null;
          lastVisit: number | null;
        }>;
        scannedAt: number;
      }>;
      applyAutoRevokePermissions: (revocations: Array<{ origin: string; permissionType: string }>) => Promise<number>;
      optOutAutoRevoke: (origin: string, permissionType: string) => Promise<void>;
      getSyncPrefs: () => Promise<SyncPrefs>;
      setSyncPrefs: (patch: object) => Promise<boolean>;
      setSyncPassphrase: (passphrase: string) => Promise<boolean>;
      verifySyncPassphrase: (passphrase: string) => Promise<boolean>;
      clearSyncPassphrase: () => Promise<void>;
      getDownloadFolder: () => Promise<string>;
      setDownloadFolder: () => Promise<string>;
      getAskBeforeSave: () => Promise<boolean>;
      setAskBeforeSave: (enabled: boolean) => Promise<void>;
      getFileTypeAssociations: () => Promise<Record<string, boolean>>;
      setFileTypeAssociation: (ext: string, enabled: boolean) => Promise<void>;
      removeFileTypeAssociation: (ext: string) => Promise<void>;
      listSearchEngines: () => Promise<SearchEngineEntry[]>;
      getDefaultSearchEngine: () => Promise<SearchEngineEntry>;
      setDefaultSearchEngine: (id: string) => Promise<void>;
      addCustomSearchEngine: (p: { name: string; keyword: string; searchUrl: string }) => Promise<SearchEngineEntry>;
      updateCustomSearchEngine: (id: string, p: Partial<{ name: string; keyword: string; searchUrl: string }>) => Promise<boolean>;
      removeCustomSearchEngine: (id: string) => Promise<boolean>;
    };
  }
}

// ---------------------------------------------------------------------------
// Sync types and defaults
// ---------------------------------------------------------------------------

interface SyncPrefs {
  enabled: boolean;
  syncEverything: boolean;
  bookmarks: boolean;
  readingList: boolean;
  passwords: boolean;
  addresses: boolean;
  payments: boolean;
  historyAndTabs: boolean;
  savedTabGroups: boolean;
  extensions: boolean;
  settings: boolean;
  encryptionEnabled: boolean;
}

const DEFAULT_SYNC_PREFS: SyncPrefs = {
  enabled: false, syncEverything: true, bookmarks: true, readingList: true,
  passwords: true, addresses: true, payments: true, historyAndTabs: true,
  savedTabGroups: true, extensions: true, settings: true, encryptionEnabled: false,
};

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
                style={{ background: 'linear-gradient(135deg, #1a1a1f 50%, #6D8196 50%)' }}
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
        variant: 'success',
        title: 'Re-consent complete',
        message: `Scope: ${scope}`,
      });
    } catch (err) {
      toast.show({
        variant: 'warning',
        title: 'Re-consent not available',
        message: 'Re-consent is not yet available. Please sign out and sign back in to update permissions.',
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
                title="Re-consent is not yet available"
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
// Content categories tab
// ---------------------------------------------------------------------------

type CategoryState = 'allow' | 'block' | 'ask';

type ContentCategory =
  | 'sound'
  | 'images'
  | 'javascript'
  | 'popups'
  | 'ads'
  | 'automatic-downloads'
  | 'protected-content'
  | 'clipboard-read'
  | 'clipboard-write';

interface ContentCategoryRow {
  category: ContentCategory;
  label: string;
  description: string;
  defaultState: CategoryState;
  allowedStates: CategoryState[];
  /**
   * Issue #222 — whether this category is actually wired into the runtime.
   * `false` means the toggle is persisted but has no effect; the UI disables
   * the select and shows a "Not enforced yet" note so users aren't misled.
   */
  enforced: boolean;
}

const CONTENT_CATEGORY_ROWS: ContentCategoryRow[] = [
  {
    category: 'sound',
    label: 'Sound',
    description: 'Allow sites to play audio. Autoplay is subject to browser policy.',
    defaultState: 'allow',
    allowedStates: ['allow', 'block'],
    enforced: true,
  },
  {
    category: 'images',
    label: 'Images',
    description: 'Allow sites to show images.',
    defaultState: 'allow',
    allowedStates: ['allow', 'block'],
    enforced: true,
  },
  {
    category: 'javascript',
    label: 'JavaScript',
    description: 'Allow sites to run JavaScript. Takes effect for newly opened tabs.',
    defaultState: 'allow',
    allowedStates: ['allow', 'block'],
    enforced: true,
  },
  {
    category: 'popups',
    label: 'Pop-ups and redirects',
    description: 'Block sites from opening new windows or redirecting you.',
    defaultState: 'block',
    allowedStates: ['allow', 'block'],
    enforced: true,
  },
  {
    category: 'ads',
    label: 'Intrusive ads',
    description: 'Block ads on sites that show intrusive or misleading ads (Better Ads Standards).',
    defaultState: 'block',
    allowedStates: ['allow', 'block'],
    enforced: false,
  },
  {
    category: 'automatic-downloads',
    label: 'Automatic downloads',
    description: 'Ask before allowing sites to download multiple files automatically.',
    defaultState: 'ask',
    allowedStates: ['allow', 'ask', 'block'],
    enforced: false,
  },
  {
    category: 'protected-content',
    label: 'Protected content IDs',
    description: 'Allow sites to check your device for a protected content license.',
    defaultState: 'allow',
    allowedStates: ['allow', 'block'],
    enforced: false,
  },
  {
    category: 'clipboard-read',
    label: 'Clipboard read',
    description: 'Ask before allowing sites to read data you copied.',
    defaultState: 'ask',
    allowedStates: ['allow', 'ask', 'block'],
    enforced: false,
  },
  {
    category: 'clipboard-write',
    label: 'Clipboard write',
    description: 'Allow sites to write data to your clipboard when you interact with the page.',
    defaultState: 'allow',
    allowedStates: ['allow', 'block'],
    enforced: false,
  },
];

const STATE_LABELS: Record<CategoryState, string> = {
  allow: 'Allow',
  block: 'Block',
  ask: 'Ask',
};

function ContentCategoriesTab(): React.ReactElement {
  const toast = useToast();
  const [defaults, setDefaults] = React.useState<Record<ContentCategory, CategoryState> | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    void window.settingsAPI.getContentCategoryDefaults().then((d) => {
      setDefaults(d as Record<ContentCategory, CategoryState>);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  async function handleChange(category: ContentCategory, state: CategoryState): Promise<void> {
    if (!defaults) return;
    const prev = defaults[category];
    setDefaults((d) => d ? { ...d, [category]: state } : d);
    try {
      await window.settingsAPI.setContentCategoryDefault(category, state);
      toast.show({ variant: 'success', title: `${CONTENT_CATEGORY_ROWS.find((r) => r.category === category)?.label ?? category} set to ${STATE_LABELS[state]}` });
    } catch (err) {
      setDefaults((d) => d ? { ...d, [category]: prev } : d);
      toast.show({ variant: 'error', title: 'Failed to update setting', message: (err as Error).message });
    }
  }

  if (loading || !defaults) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Content</h2>
        <div className="settings-loading">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Content</h2>
      <p className="settings-section-desc">
        Control what content sites can show or run. These are global defaults; per-site
        overrides take priority.
      </p>

      <Card variant="default" padding="none" className="settings-card">
        {CONTENT_CATEGORY_ROWS.map((row, idx) => {
          const currentState = defaults[row.category] ?? row.defaultState;
          // Issue #222 — unenforced rows stay visible (so the list matches
          // what Chrome shows) but the toggle is disabled and labelled.
          const disabled = !row.enforced;
          return (
            <div
              key={row.category}
              className={`settings-scope-row ${idx < CONTENT_CATEGORY_ROWS.length - 1 ? 'settings-scope-row--bordered' : ''}`}
              data-testid={`content-category-row-${row.category}`}
              data-enforced={row.enforced ? 'true' : 'false'}
            >
              <div className="settings-scope-info">
                <span className="settings-scope-label">
                  {row.label}
                  {disabled && (
                    <span
                      style={{
                        marginLeft: 8,
                        padding: '2px 6px',
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                        borderRadius: 4,
                        background: 'var(--color-surface-muted, #eee)',
                        color: 'var(--color-text-muted, #666)',
                      }}
                      title="This setting is persisted but is not yet enforced by the browser."
                    >
                      Not enforced yet
                    </span>
                  )}
                </span>
                <span className="settings-scope-name" style={{ fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                  {row.description}
                </span>
              </div>
              <div className="settings-scope-actions">
                <select
                  className="settings-select"
                  value={currentState}
                  disabled={disabled}
                  onChange={(e) => void handleChange(row.category, e.target.value as CategoryState)}
                  style={{ minWidth: 80, opacity: disabled ? 0.5 : 1 }}
                  aria-disabled={disabled}
                  title={disabled ? 'Not enforced yet (Issue #222 follow-up)' : undefined}
                >
                  {row.allowedStates.map((s) => (
                    <option key={s} value={s}>{STATE_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Permissions tab — auto-revoke unused permissions (issue #58)
// ---------------------------------------------------------------------------

const PERMISSION_TYPE_LABELS: Record<string, string> = {
  notifications: 'Notifications',
  geolocation:   'Location',
  camera:        'Camera',
  microphone:    'Microphone',
};

interface AutoRevokeEntry {
  origin: string;
  permissionType: string;
  grantedAt: number;
  daysSinceVisit: number | null;
  lastVisit: number | null;
}

function formatDaysSinceVisit(days: number | null): string {
  if (days === null) return 'Never visited';
  if (days === 0) return 'Visited today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

function PermissionsTab(): React.ReactElement {
  const toast = useToast();
  const [candidates, setCandidates] = React.useState<AutoRevokeEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [revoking, setRevoking] = React.useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

  const candidateKey = (c: AutoRevokeEntry): string =>
    `${c.origin}::${c.permissionType}`;

  const loadCandidates = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.settingsAPI.scanAutoRevokePermissions();
      setCandidates(result.candidates);
      console.debug('[PermissionsTab] scan result', {
        candidateCount: result.candidates.length,
        scannedAt: result.scannedAt,
      });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Scan failed', message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  async function handleRevoke(candidate: AutoRevokeEntry): Promise<void> {
    const key = candidateKey(candidate);
    setRevoking((prev) => new Set([...prev, key]));
    try {
      await window.settingsAPI.applyAutoRevokePermissions([
        { origin: candidate.origin, permissionType: candidate.permissionType },
      ]);
      setCandidates((prev) => prev.filter((c) => candidateKey(c) !== key));
      toast.show({ variant: 'success', title: 'Permission revoked', message: `${PERMISSION_TYPE_LABELS[candidate.permissionType] ?? candidate.permissionType} removed for ${candidate.origin}` });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Revoke failed', message: (err as Error).message });
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleRevokeAll(): Promise<void> {
    const visible = candidates.filter((c) => !dismissed.has(candidateKey(c)));
    if (visible.length === 0) return;
    try {
      const revocations = visible.map((c) => ({
        origin: c.origin,
        permissionType: c.permissionType,
      }));
      await window.settingsAPI.applyAutoRevokePermissions(revocations);
      setCandidates([]);
      toast.show({ variant: 'success', title: `${visible.length} permission${visible.length === 1 ? '' : 's'} revoked` });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Revoke all failed', message: (err as Error).message });
    }
  }

  async function handleKeep(candidate: AutoRevokeEntry): Promise<void> {
    const key = candidateKey(candidate);
    try {
      await window.settingsAPI.optOutAutoRevoke(candidate.origin, candidate.permissionType);
      setDismissed((prev) => new Set([...prev, key]));
      toast.show({ variant: 'info', title: 'Permission kept', message: `${candidate.origin} will not be flagged again this session` });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to keep permission', message: (err as Error).message });
    }
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Permissions</h2>
        <div className="settings-loading">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  const visible = candidates.filter((c) => !dismissed.has(candidateKey(c)));

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Permissions</h2>
      <p className="settings-section-desc">
        Sites that were granted permissions but have not been visited in the
        last 90 days. Revoking permissions here follows the same safety-first
        policy Chrome uses for inactive sites.
      </p>

      {visible.length === 0 ? (
        <Card variant="outline" padding="md" className="settings-card">
          <p style={{ color: 'var(--color-fg-tertiary)', fontSize: 13 }}>
            No unused permissions found. All granted permissions belong to
            recently visited sites.
          </p>
        </Card>
      ) : (
        <>
          <Card variant="default" padding="none" className="settings-card">
            {visible.map((candidate, idx) => {
              const key = candidateKey(candidate);
              const isRevoking = revoking.has(key);
              const typeLabel = PERMISSION_TYPE_LABELS[candidate.permissionType] ?? candidate.permissionType;
              return (
                <div
                  key={key}
                  className={`settings-scope-row ${idx < visible.length - 1 ? 'settings-scope-row--bordered' : ''}`}
                >
                  <div className="settings-scope-info">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="settings-scope-label">{candidate.origin}</span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 7px',
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--color-bg-elevated)',
                          color: 'var(--color-fg-secondary)',
                          border: '1px solid var(--color-border-subtle)',
                        }}
                      >
                        {typeLabel}
                      </span>
                    </div>
                    <span className="settings-scope-name">
                      {formatDaysSinceVisit(candidate.daysSinceVisit)}
                    </span>
                  </div>
                  <div className="settings-scope-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleKeep(candidate)}
                      disabled={isRevoking}
                    >
                      Keep
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleRevoke(candidate)}
                      loading={isRevoking}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
              );
            })}
          </Card>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void loadCandidates()}
            >
              Rescan
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleRevokeAll()}
            >
              Revoke all ({visible.length})
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search Engines tab
// ---------------------------------------------------------------------------

function SearchEnginesTab(): React.ReactElement {
  const toast = useToast();
  const [engines, setEngines] = useState<SearchEngineEntry[]>([]);
  const [defaultId, setDefaultId] = useState<string>('google');
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addKeyword, setAddKeyword] = useState('');
  const [addSearchUrl, setAddSearchUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, def] = await Promise.all([
        window.settingsAPI.listSearchEngines(),
        window.settingsAPI.getDefaultSearchEngine(),
      ]);
      setEngines(all);
      setDefaultId(def.id);
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to load search engines', message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSetDefault(id: string): Promise<void> {
    try {
      await window.settingsAPI.setDefaultSearchEngine(id);
      setDefaultId(id);
      toast.show({ variant: 'success', title: 'Default search engine updated' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to set default', message: (err as Error).message });
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await window.settingsAPI.removeCustomSearchEngine(id);
      toast.show({ variant: 'success', title: 'Search engine removed' });
      void load();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to remove', message: (err as Error).message });
    }
  }

  async function handleAdd(): Promise<void> {
    if (!addName.trim() || !addSearchUrl.trim()) {
      toast.show({ variant: 'error', title: 'Name and search URL are required' });
      return;
    }
    if (!addSearchUrl.includes('%s')) {
      toast.show({ variant: 'error', title: 'Search URL must contain %s as the query placeholder' });
      return;
    }
    if (!/^https?:\/\//i.test(addSearchUrl.trim())) {
      toast.show({ variant: 'error', title: 'Search URL must start with http:// or https://' });
      return;
    }
    setSaving(true);
    try {
      await window.settingsAPI.addCustomSearchEngine({
        name: addName.trim(),
        keyword: addKeyword.trim(),
        searchUrl: addSearchUrl.trim(),
      });
      setAddName('');
      setAddKeyword('');
      setAddSearchUrl('');
      setShowAddForm(false);
      toast.show({ variant: 'success', title: 'Custom search engine added' });
      void load();
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to add', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="settings-section">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Search Engines</h2>
      <p className="settings-section-desc">
        Choose which search engine is used when you type a search query in the address bar.
      </p>

      <Card variant="default" padding="md" className="settings-card">
        {engines.map((engine) => (
          <div
            key={engine.id}
            className="settings-scope-row"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="radio"
                name="default-search-engine"
                id={`se-${engine.id}`}
                checked={defaultId === engine.id}
                onChange={() => void handleSetDefault(engine.id)}
              />
              <label htmlFor={`se-${engine.id}`} style={{ cursor: 'pointer' }}>
                <span style={{ fontWeight: 500 }}>{engine.name}</span>
                {engine.keyword && (
                  <span className="settings-label" style={{ marginLeft: 8 }}>
                    @{engine.keyword}
                  </span>
                )}
              </label>
            </div>
            {!engine.isBuiltIn && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDelete(engine.id)}
              >
                Delete
              </Button>
            )}
          </div>
        ))}
      </Card>

      {!showAddForm && (
        <div style={{ marginTop: 16 }}>
          <Button variant="secondary" size="sm" onClick={() => setShowAddForm(true)}>
            Add custom engine
          </Button>
        </div>
      )}

      {showAddForm && (
        <Card variant="outline" padding="md" className="settings-card" style={{ marginTop: 16 }}>
          <h3 className="settings-label" style={{ marginBottom: 12 }}>Add custom search engine</h3>

          <div className="settings-field">
            <label htmlFor="se-add-name" className="settings-label">Name</label>
            <input
              id="se-add-name"
              className="settings-input"
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="My Search Engine"
            />
          </div>

          <div className="settings-field" style={{ marginTop: 8 }}>
            <label htmlFor="se-add-keyword" className="settings-label">Keyword (optional)</label>
            <input
              id="se-add-keyword"
              className="settings-input"
              type="text"
              value={addKeyword}
              onChange={(e) => setAddKeyword(e.target.value)}
              placeholder="ms"
            />
          </div>

          <div className="settings-field" style={{ marginTop: 8 }}>
            <label htmlFor="se-add-url" className="settings-label">
              Search URL (use %s for query placeholder)
            </label>
            <input
              id="se-add-url"
              className="settings-input"
              type="text"
              value={addSearchUrl}
              onChange={(e) => setAddSearchUrl(e.target.value)}
              placeholder="https://example.com/search?q=%s"
            />
          </div>

          <div className="settings-row-actions" style={{ marginTop: 12 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setShowAddForm(false); setAddName(''); setAddKeyword(''); setAddSearchUrl(''); }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleAdd()}
              loading={saving}
            >
              Add
            </Button>
          </div>
        </Card>
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
// Addresses tab
// ---------------------------------------------------------------------------

interface AddressEntry {
  id: string;
  fullName: string;
  company: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  createdAt: number;
  updatedAt: number;
}

const EMPTY_ADDRESS: Omit<AddressEntry, 'id' | 'createdAt' | 'updatedAt'> = {
  fullName: '',
  company: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  phone: '',
  email: '',
};

function AddressForm({
  value,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  value: Omit<AddressEntry, 'id' | 'createdAt' | 'updatedAt'>;
  onChange: (patch: Partial<typeof value>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input className="settings-input" placeholder="Full name" value={value.fullName} onChange={(e) => onChange({ fullName: e.target.value })} />
      <input className="settings-input" placeholder="Company (optional)" value={value.company} onChange={(e) => onChange({ company: e.target.value })} />
      <input className="settings-input" placeholder="Address line 1" value={value.addressLine1} onChange={(e) => onChange({ addressLine1: e.target.value })} />
      <input className="settings-input" placeholder="Address line 2 (optional)" value={value.addressLine2} onChange={(e) => onChange({ addressLine2: e.target.value })} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="settings-input" placeholder="City" value={value.city} onChange={(e) => onChange({ city: e.target.value })} style={{ flex: 2 }} />
        <input className="settings-input" placeholder="State" value={value.state} onChange={(e) => onChange({ state: e.target.value })} style={{ flex: 1 }} />
        <input className="settings-input" placeholder="ZIP / Postal" value={value.postalCode} onChange={(e) => onChange({ postalCode: e.target.value })} style={{ flex: 1 }} />
      </div>
      <input className="settings-input" placeholder="Country" value={value.country} onChange={(e) => onChange({ country: e.target.value })} />
      <input className="settings-input" placeholder="Phone (optional)" value={value.phone} onChange={(e) => onChange({ phone: e.target.value })} />
      <input className="settings-input" placeholder="Email (optional)" value={value.email} onChange={(e) => onChange({ email: e.target.value })} />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button variant="primary" size="sm" onClick={onSave} loading={saving} disabled={!value.fullName.trim() && !value.addressLine1.trim()}>
          Save
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddressesTab(): React.ReactElement {
  const toast = useToast();
  const [addresses, setAddresses] = useState<AddressEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newAddr, setNewAddr] = useState({ ...EMPTY_ADDRESS });
  const [editId, setEditId] = useState<string | null>(null);
  const [editAddr, setEditAddr] = useState({ ...EMPTY_ADDRESS });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    const addrs = await window.settingsAPI.listAddresses();
    setAddresses(addrs);
    setLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const filtered = addresses.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.fullName.toLowerCase().includes(q) ||
      a.addressLine1.toLowerCase().includes(q) ||
      a.city.toLowerCase().includes(q) ||
      a.country.toLowerCase().includes(q)
    );
  });

  async function handleAdd(): Promise<void> {
    setSaving(true);
    try {
      await window.settingsAPI.saveAddress(newAddr);
      setNewAddr({ ...EMPTY_ADDRESS });
      setShowAdd(false);
      void loadData();
      toast.show({ variant: 'success', title: 'Address saved' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Save failed', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(): Promise<void> {
    if (!editId) return;
    setSaving(true);
    try {
      await window.settingsAPI.updateAddress({ id: editId, ...editAddr });
      setEditId(null);
      void loadData();
      toast.show({ variant: 'success', title: 'Address updated' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Update failed', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    await window.settingsAPI.deleteAddress(id);
    setAddresses((prev) => prev.filter((a) => a.id !== id));
    toast.show({ variant: 'success', title: 'Address deleted' });
  }

  function startEdit(addr: AddressEntry): void {
    setEditId(addr.id);
    setEditAddr({
      fullName: addr.fullName,
      company: addr.company,
      addressLine1: addr.addressLine1,
      addressLine2: addr.addressLine2,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode,
      country: addr.country,
      phone: addr.phone,
      email: addr.email,
    });
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Addresses</h2>
        <div className="settings-loading"><Spinner size="md" /></div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Addresses</h2>
      <p className="settings-section-desc">
        Saved addresses are offered when filling out forms. Your addresses are stored locally and never sent to servers.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <input
          className="settings-input"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search addresses..."
          style={{ flex: 1 }}
        />
        {!showAdd && (
          <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
            Add address
          </Button>
        )}
      </div>

      {showAdd && (
        <Card variant="default" padding="md" className="settings-card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>New address</div>
          <AddressForm
            value={newAddr}
            onChange={(patch) => setNewAddr((prev) => ({ ...prev, ...patch }))}
            onSave={() => void handleAdd()}
            onCancel={() => { setShowAdd(false); setNewAddr({ ...EMPTY_ADDRESS }); }}
            saving={saving}
          />
        </Card>
      )}

      <Card variant="default" padding="none" className="settings-card">
        {filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-fg-tertiary)' }}>
            {addresses.length === 0 ? 'No saved addresses' : 'No matching addresses'}
          </div>
        ) : (
          filtered.map((addr, idx) => (
            <div
              key={addr.id}
              className={`settings-scope-row ${idx < filtered.length - 1 ? 'settings-scope-row--bordered' : ''}`}
            >
              {editId === addr.id ? (
                <div style={{ flex: 1, padding: '4px 0' }}>
                  <AddressForm
                    value={editAddr}
                    onChange={(patch) => setEditAddr((prev) => ({ ...prev, ...patch }))}
                    onSave={() => void handleEditSave()}
                    onCancel={() => setEditId(null)}
                    saving={saving}
                  />
                </div>
              ) : (
                <>
                  <div className="settings-scope-info">
                    <span className="settings-scope-label">{addr.fullName}</span>
                    <span className="settings-scope-name" style={{ fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                      {[addr.addressLine1, addr.addressLine2, addr.city, addr.state, addr.postalCode, addr.country]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                    {addr.phone && (
                      <span className="settings-scope-name" style={{ fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                        {addr.phone}
                      </span>
                    )}
                  </div>
                  <div className="settings-scope-actions">
                    <Button variant="ghost" size="sm" onClick={() => startEdit(addr)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(addr.id)}>Delete</Button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payments tab
// ---------------------------------------------------------------------------

interface CardEntry {
  id: string;
  nameOnCard: string;
  lastFour: string;
  network: string;
  expiryMonth: string;
  expiryYear: string;
  nickname: string;
  createdAt: number;
  updatedAt: number;
}

const MONTHS = ['01','02','03','04','05','06','07','08','09','10','11','12'] as const;

function currentYear(): number {
  return new Date().getFullYear();
}

function cardLabel(card: CardEntry): string {
  const name = card.nickname || `${card.network} ending in ${card.lastFour}`;
  return `${name} — expires ${card.expiryMonth}/${card.expiryYear}`;
}

function PaymentsTab(): React.ReactElement {
  const toast = useToast();
  const [cards, setCards] = useState<CardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newCard, setNewCard] = useState({
    nameOnCard: '',
    cardNumber: '',
    expiryMonth: '01',
    expiryYear: String(currentYear()),
    nickname: '',
  });
  const [cvcInput, setCvcInput] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editCard, setEditCard] = useState({ nameOnCard: '', expiryMonth: '01', expiryYear: String(currentYear()), nickname: '' });
  const [saving, setSaving] = useState(false);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedNumber, setRevealedNumber] = useState<string | null>(null);
  const [cvcChallenge, setCvcChallenge] = useState<{ id: string; cvc: string } | null>(null);

  const loadData = useCallback(async () => {
    const list = await window.settingsAPI.listCards();
    setCards(list);
    setLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const YEAR_OPTIONS = Array.from({ length: 12 }, (_, i) => String(currentYear() + i));

  async function handleAdd(): Promise<void> {
    if (!newCard.cardNumber.replace(/\D/g, '') || !newCard.nameOnCard.trim()) {
      toast.show({ variant: 'error', title: 'Card number and name are required' });
      return;
    }
    setSaving(true);
    try {
      await window.settingsAPI.saveCard(newCard);
      setNewCard({ nameOnCard: '', cardNumber: '', expiryMonth: '01', expiryYear: String(currentYear()), nickname: '' });
      setCvcInput('');
      setShowAdd(false);
      void loadData();
      toast.show({ variant: 'success', title: 'Card saved' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Save failed', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(): Promise<void> {
    if (!editId) return;
    setSaving(true);
    try {
      await window.settingsAPI.updateCard({ id: editId, ...editCard });
      setEditId(null);
      void loadData();
      toast.show({ variant: 'success', title: 'Card updated' });
    } catch (err) {
      toast.show({ variant: 'error', title: 'Update failed', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleReveal(id: string): Promise<void> {
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedNumber(null);
      return;
    }
    // Show CVC challenge dialog
    setCvcChallenge({ id, cvc: '' });
  }

  async function handleCvcConfirm(): Promise<void> {
    if (!cvcChallenge) return;
    const { id, cvc } = cvcChallenge;
    if (!cvc.match(/^\d{3,4}$/)) {
      toast.show({ variant: 'error', title: 'Enter a valid CVC (3-4 digits)' });
      return;
    }
    // CVC is validated locally for format only — never sent anywhere
    try {
      const number = await window.settingsAPI.revealCardNumber(id);
      setRevealedId(id);
      setRevealedNumber(number);
      setCvcChallenge(null);
      toast.show({ variant: 'success', title: 'Card number revealed' });
    } catch (err) {
      setCvcChallenge(null);
      toast.show({ variant: 'error', title: 'Authentication required', message: (err as Error).message });
    }
  }

  async function handleDelete(id: string): Promise<void> {
    await window.settingsAPI.deleteCard(id);
    setCards((prev) => prev.filter((c) => c.id !== id));
    if (revealedId === id) { setRevealedId(null); setRevealedNumber(null); }
    toast.show({ variant: 'success', title: 'Card deleted' });
  }

  function startEdit(card: CardEntry): void {
    setEditId(card.id);
    setEditCard({ nameOnCard: card.nameOnCard, expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, nickname: card.nickname });
  }

  if (loading) {
    return (
      <div className="settings-section">
        <h2 className="settings-section-title">Payment methods</h2>
        <div className="settings-loading"><Spinner size="md" /></div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Payment methods</h2>
      <p className="settings-section-desc">
        Saved payment cards are offered when filling checkout forms.
        CVC is never stored — it is requested each time a card is revealed.
        Card numbers are encrypted locally using the system keychain.
      </p>

      {/* CVC challenge modal */}
      {cvcChallenge && (
        <Modal open onClose={() => setCvcChallenge(null)} title="Enter CVC to reveal card" size="sm">
          <p className="settings-modal-body">
            Enter the 3 or 4 digit security code on the back of your card. The CVC is never stored.
          </p>
          <input
            className="settings-input"
            type="password"
            inputMode="numeric"
            maxLength={4}
            placeholder="CVC"
            value={cvcChallenge.cvc}
            onChange={(e) => setCvcChallenge({ ...cvcChallenge, cvc: e.target.value })}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCvcConfirm(); }}
          />
          <div className="settings-modal-actions">
            <Button variant="secondary" size="sm" onClick={() => setCvcChallenge(null)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={() => void handleCvcConfirm()}>Confirm</Button>
          </div>
        </Modal>
      )}

      {!showAdd && (
        <div style={{ marginBottom: 16 }}>
          <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
            Add card
          </Button>
        </div>
      )}

      {showAdd && (
        <Card variant="default" padding="md" className="settings-card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>New card</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input className="settings-input" placeholder="Name on card" value={newCard.nameOnCard} onChange={(e) => setNewCard((p) => ({ ...p, nameOnCard: e.target.value }))} />
            <input className="settings-input" placeholder="Card number" type="text" inputMode="numeric" maxLength={19} value={newCard.cardNumber} onChange={(e) => setNewCard((p) => ({ ...p, cardNumber: e.target.value }))} />
            <input className="settings-input" placeholder="Nickname (optional)" value={newCard.nickname} onChange={(e) => setNewCard((p) => ({ ...p, nickname: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="settings-label" style={{ fontSize: 12 }}>Expiry month</label>
                <select className="settings-select" value={newCard.expiryMonth} onChange={(e) => setNewCard((p) => ({ ...p, expiryMonth: e.target.value }))}>
                  {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="settings-label" style={{ fontSize: 12 }}>Expiry year</label>
                <select className="settings-select" value={newCard.expiryYear} onChange={(e) => setNewCard((p) => ({ ...p, expiryYear: e.target.value }))}>
                  {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="settings-label" style={{ fontSize: 12 }}>CVC (not stored)</label>
                <input className="settings-input" type="password" inputMode="numeric" maxLength={4} placeholder="CVC" value={cvcInput} onChange={(e) => setCvcInput(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Button variant="primary" size="sm" onClick={() => void handleAdd()} loading={saving}>Save</Button>
              <Button variant="secondary" size="sm" onClick={() => { setShowAdd(false); setNewCard({ nameOnCard: '', cardNumber: '', expiryMonth: '01', expiryYear: String(currentYear()), nickname: '' }); setCvcInput(''); }}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}

      <Card variant="default" padding="none" className="settings-card">
        {cards.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-fg-tertiary)' }}>
            No saved payment cards
          </div>
        ) : (
          cards.map((card, idx) => (
            <div
              key={card.id}
              className={`settings-scope-row ${idx < cards.length - 1 ? 'settings-scope-row--bordered' : ''}`}
            >
              {editId === card.id ? (
                <div style={{ flex: 1, padding: '4px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input className="settings-input" placeholder="Name on card" value={editCard.nameOnCard} onChange={(e) => setEditCard((p) => ({ ...p, nameOnCard: e.target.value }))} />
                  <input className="settings-input" placeholder="Nickname (optional)" value={editCard.nickname} onChange={(e) => setEditCard((p) => ({ ...p, nickname: e.target.value }))} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label className="settings-label" style={{ fontSize: 12 }}>Month</label>
                      <select className="settings-select" value={editCard.expiryMonth} onChange={(e) => setEditCard((p) => ({ ...p, expiryMonth: e.target.value }))}>
                        {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="settings-label" style={{ fontSize: 12 }}>Year</label>
                      <select className="settings-select" value={editCard.expiryYear} onChange={(e) => setEditCard((p) => ({ ...p, expiryYear: e.target.value }))}>
                        {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="primary" size="sm" onClick={() => void handleEditSave()} loading={saving}>Save</Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="settings-scope-info">
                    <span className="settings-scope-label">{cardLabel(card)}</span>
                    {card.nameOnCard && (
                      <span className="settings-scope-name" style={{ fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                        {card.nameOnCard}
                      </span>
                    )}
                    {revealedId === card.id && revealedNumber && (
                      <code className="settings-scope-name" style={{ color: 'var(--color-fg-primary)', letterSpacing: '0.1em' }}>
                        {revealedNumber}
                      </code>
                    )}
                  </div>
                  <div className="settings-scope-actions" style={{ gap: 4 }}>
                    <Button variant="ghost" size="sm" onClick={() => void handleReveal(card.id)}>
                      {revealedId === card.id ? 'Hide' : 'Reveal'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => startEdit(card)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(card.id)}>Delete</Button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Downloads tab
// ---------------------------------------------------------------------------

const COMMON_FILE_TYPES: Array<{ ext: string; label: string }> = [
  { ext: 'pdf',  label: 'PDF documents (.pdf)' },
  { ext: 'zip',  label: 'ZIP archives (.zip)' },
  { ext: 'dmg',  label: 'Disk images (.dmg)' },
  { ext: 'pkg',  label: 'Installer packages (.pkg)' },
  { ext: 'mp4',  label: 'Video files (.mp4)' },
  { ext: 'mp3',  label: 'Audio files (.mp3)' },
  { ext: 'csv',  label: 'CSV spreadsheets (.csv)' },
  { ext: 'txt',  label: 'Text files (.txt)' },
];

function DownloadsTab(): React.ReactElement {
  const toast = useToast();
  const [downloadFolder, setDownloadFolder] = useState('');
  const [askBeforeSave, setAskBeforeSave] = useState(false);
  const [fileTypeAssoc, setFileTypeAssoc] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void Promise.all([
      window.settingsAPI.getDownloadFolder(),
      window.settingsAPI.getAskBeforeSave(),
      window.settingsAPI.getFileTypeAssociations(),
    ]).then(([folder, ask, assoc]) => {
      setDownloadFolder(folder);
      setAskBeforeSave(ask);
      setFileTypeAssoc(assoc);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function handleChangeFolderClick(): Promise<void> {
    try {
      const newFolder = await window.settingsAPI.setDownloadFolder();
      if (newFolder !== null) {
        setDownloadFolder(newFolder);
        toast.show({ variant: 'success', title: 'Download folder updated' });
      }
    } catch (err) {
      toast.show({ variant: 'error', title: 'Failed to change folder', message: (err as Error).message });
    }
  }

  async function handleAskBeforeSaveToggle(checked: boolean): Promise<void> {
    setAskBeforeSave(checked);
    try {
      await window.settingsAPI.setAskBeforeSave(checked);
      toast.show({
        variant: 'success',
        title: checked ? 'Will prompt for save location' : 'Saving to download folder automatically',
      });
    } catch (err) {
      setAskBeforeSave(!checked);
      toast.show({ variant: 'error', title: 'Failed to update setting', message: (err as Error).message });
    }
  }

  async function handleFileTypeToggle(ext: string, checked: boolean): Promise<void> {
    setFileTypeAssoc((prev) => ({ ...prev, [ext]: checked }));
    try {
      await window.settingsAPI.setFileTypeAssociation(ext, checked);
    } catch (err) {
      setFileTypeAssoc((prev) => ({ ...prev, [ext]: !checked }));
      toast.show({ variant: 'error', title: 'Failed to update setting', message: (err as Error).message });
    }
  }

  const displayFolder = downloadFolder || '(System default downloads folder)';

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Downloads</h2>
      <p className="settings-section-desc">
        Choose where downloads are saved and when to be prompted.
      </p>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <Card variant="default" padding="md" className="settings-card">
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Download location</span>
                <span className="settings-toggle-desc" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {displayFolder}
                </span>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void handleChangeFolderClick()}>
                Change…
              </Button>
            </div>
          </Card>

          <Card variant="default" padding="md" className="settings-card">
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Ask where to save each file before downloading</span>
                <span className="settings-toggle-desc">
                  When enabled, a save dialog appears for every download. When disabled,
                  files are saved directly to the download folder.
                </span>
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={askBeforeSave}
                  onChange={(e) => void handleAskBeforeSaveToggle(e.target.checked)}
                />
                <span className="settings-toggle-track" />
              </label>
            </div>
          </Card>

          <Card variant="default" padding="md" className="settings-card">
            <div style={{ marginBottom: 12 }}>
              <span className="settings-toggle-label">Open files of these types automatically</span>
              <p className="settings-toggle-desc" style={{ marginTop: 4 }}>
                Files of the selected types will be opened after downloading completes.
              </p>
            </div>
            {COMMON_FILE_TYPES.map(({ ext, label }) => (
              <div key={ext} className="settings-toggle-row" style={{ paddingTop: 8, paddingBottom: 8 }}>
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label" style={{ fontWeight: 400 }}>{label}</span>
                </div>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={fileTypeAssoc[ext] === true}
                    onChange={(e) => void handleFileTypeToggle(ext, e.target.checked)}
                  />
                  <span className="settings-toggle-track" />
                </label>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accessibility tab
// ---------------------------------------------------------------------------

const LIVE_CAPTION_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'German' },
  { value: 'fr-FR', label: 'French' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'ja-JP', label: 'Japanese' },
];

function AccessibilityTab(): React.ReactElement {
  const toast = useToast();
  const [liveCaptionEnabled, setLiveCaptionEnabled] = useState(false);
  const [liveCaptionLanguage, setLiveCaptionLanguage] = useState('en-US');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void window.settingsAPI.getLiveCaption().then(({ enabled, language }) => {
      setLiveCaptionEnabled(enabled);
      setLiveCaptionLanguage(language);
    }).catch(() => {
      // ignore; leave defaults
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  async function handleLiveCaptionToggle(checked: boolean): Promise<void> {
    setLiveCaptionEnabled(checked);
    try {
      const ok = await window.settingsAPI.setLiveCaption({ enabled: checked });
      if (!ok) throw new Error('Settings update failed');
      toast.show({
        variant: 'success',
        title: checked ? 'Live Caption enabled' : 'Live Caption disabled',
      });
    } catch (err) {
      setLiveCaptionEnabled(!checked);
      toast.show({
        variant: 'error',
        title: 'Failed to update setting',
        message: (err as Error).message,
      });
    }
  }

  async function handleLanguageChange(language: string): Promise<void> {
    const previous = liveCaptionLanguage;
    setLiveCaptionLanguage(language);
    try {
      await window.settingsAPI.setLiveCaption({ language });
    } catch (err) {
      // Only roll back if the user hasn't already selected a different language.
      setLiveCaptionLanguage((cur) => (cur === language ? previous : cur));
      toast.show({
        variant: 'error',
        title: 'Failed to update language',
        message: (err as Error).message,
      });
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Accessibility</h2>
      <p className="settings-section-desc">
        Configure accessibility features to improve your browsing experience.
      </p>

      <Card variant="default" padding="md" className="settings-card">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Live Caption</span>
            <span className="settings-toggle-desc">
              Automatically caption speech in audio and video
            </span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={liveCaptionEnabled}
              disabled={loading}
              onChange={(e) => void handleLiveCaptionToggle(e.target.checked)}
            />
            <span className="settings-toggle-track" />
          </label>
        </div>

        {liveCaptionEnabled && (
          <div className="settings-field" style={{ marginTop: 12 }}>
            <label htmlFor="live-caption-language" className="settings-label">
              Caption language
            </label>
            <select
              id="live-caption-language"
              className="settings-input"
              value={liveCaptionLanguage}
              disabled={loading}
              onChange={(e) => void handleLanguageChange(e.target.value)}
            >
              {LIVE_CAPTION_LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>
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
    [TAB_API_KEY]:        <ApiKeyTab />,
    [TAB_AGENT]:          <AgentTab />,
    [TAB_APPEARANCE]:     <AppearanceTab />,
    [TAB_SCOPES]:         <GoogleScopesTab />,
    [TAB_PASSWORDS]:      <PasswordsTab />,
    [TAB_PROFILES]:       <ProfilesTab />,
    [TAB_SYNC]:           <SyncTab />,
    [TAB_PRIVACY]:        <PrivacyTab openDialog={clearDataOpen} onDialogChange={setClearDataOpen} />,
    [TAB_ZOOM]:           <SiteZoomTab />,
    [TAB_PERMISSIONS]:    <PermissionsTab />,
    [TAB_ADDRESSES]:      <AddressesTab />,
    [TAB_PAYMENTS]:       <PaymentsTab />,
    [TAB_DOWNLOADS]:      <DownloadsTab />,
    [TAB_CONTENT]:        <ContentCategoriesTab />,
    [TAB_ACCESSIBILITY]:  <AccessibilityTab />,
    [TAB_SEARCH_ENGINES]: <SearchEnginesTab />,
    [TAB_DANGER]:         <DangerZoneTab />,
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
// Sync tab
// ---------------------------------------------------------------------------

function SyncTab(): React.ReactElement {
  const toast = useToast();
  const [syncPrefs, setSyncPrefsState] = useState<SyncPrefs>(DEFAULT_SYNC_PREFS);
  const [saving, setSaving] = useState(false);
  const [showPassphraseForm, setShowPassphraseForm] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [passphraseError, setPassphraseError] = useState('');
  const [passphraseSaved, setPassphraseSaved] = useState(false);

  useEffect(() => {
    void window.settingsAPI.getSyncPrefs().then((p: SyncPrefs) => setSyncPrefsState(p));
  }, []);

  const toggle = useCallback(async (key: keyof SyncPrefs) => {
    const previous = syncPrefs;
    const next = { ...syncPrefs, [key]: !syncPrefs[key] };
    // If toggling syncEverything ON, enable all data categories (but not encryption settings)
    const NON_CATEGORY_KEYS = new Set(['enabled', 'syncEverything', 'encryptionEnabled']);
    if (key === 'syncEverything' && next.syncEverything) {
      Object.keys(DEFAULT_SYNC_PREFS).forEach((k) => {
        if (!NON_CATEGORY_KEYS.has(k)) {
          (next as Record<string, boolean>)[k] = true;
        }
      });
    }
    setSyncPrefsState(next);
    setSaving(true);
    try {
      await window.settingsAPI.setSyncPrefs(next);
    } catch (err) {
      setSyncPrefsState(previous);
      toast.show({ variant: 'error', title: 'Failed to update sync setting', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [syncPrefs, toast]);

  const categories: Array<{ key: keyof SyncPrefs; label: string; description: string }> = [
    { key: 'bookmarks',      label: 'Bookmarks',             description: 'Sync bookmarks across devices' },
    { key: 'readingList',    label: 'Reading list',          description: 'Sync reading list items' },
    { key: 'passwords',      label: 'Passwords and passkeys', description: 'Sync saved passwords' },
    { key: 'addresses',      label: 'Addresses and more',    description: 'Sync autofill data' },
    { key: 'payments',       label: 'Payment methods',       description: 'Sync payment methods' },
    { key: 'historyAndTabs', label: 'History and tabs',      description: 'Sync browsing history and open tabs' },
    { key: 'savedTabGroups', label: 'Saved tab groups',      description: 'Sync saved tab groups' },
    { key: 'extensions',     label: 'Extensions and apps',   description: 'Sync installed extensions' },
    { key: 'settings',       label: 'Settings and theme',    description: 'Sync browser preferences' },
  ];

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Sync</h2>
      <p className="settings-section-desc">
        Keep your data up-to-date across all your devices.
        {saving && <span style={{ marginLeft: 8, color: 'var(--color-text-secondary, #666)', fontSize: 12 }}>Saving…</span>}
      </p>

      {/* Master enable toggle */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
          <div>
            <div style={{ fontWeight: 500 }}>Sync is {syncPrefs.enabled ? 'on' : 'off'}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #666)', marginTop: 2 }}>
              {syncPrefs.enabled ? 'Your data is being synced.' : 'Turn on sync to keep your data up-to-date.'}
            </div>
          </div>
          <button
            className={`settings-sync-toggle ${syncPrefs.enabled ? 'settings-sync-toggle--on' : ''}`}
            role="switch"
            aria-checked={syncPrefs.enabled}
            disabled={saving}
            onClick={() => void toggle('enabled')}
          />
        </div>
      </Card>

      {syncPrefs.enabled && (
        <>
          {/* Sync everything toggle */}
          <Card style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Sync everything</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #666)', marginTop: 2 }}>
                  Automatically sync all data types
                </div>
              </div>
              <button
                className={`settings-sync-toggle ${syncPrefs.syncEverything ? 'settings-sync-toggle--on' : ''}`}
                role="switch"
                aria-checked={syncPrefs.syncEverything}
                disabled={saving}
                onClick={() => void toggle('syncEverything')}
              />
            </div>
          </Card>

          {/* Individual category toggles */}
          {!syncPrefs.syncEverything && (
            <Card style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {categories.map(({ key, label, description }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{label}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #666)', marginTop: 2 }}>{description}</div>
                    </div>
                    <button
                      className={`settings-sync-toggle ${syncPrefs[key] ? 'settings-sync-toggle--on' : ''}`}
                      role="switch"
                      aria-checked={Boolean(syncPrefs[key])}
                      disabled={saving}
                      onClick={() => void toggle(key)}
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Encryption passphrase section */}
          <Card style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Encrypt synced data with your own passphrase</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #666)', marginTop: 2 }}>
                  {syncPrefs.encryptionEnabled
                    ? 'Your synced data is encrypted with your passphrase. Payment methods are excluded.'
                    : 'Add a passphrase to encrypt all synced data. Payment methods via Google Pay are not encrypted.'}
                </div>
              </div>
              <button
                className={`settings-sync-toggle ${syncPrefs.encryptionEnabled ? 'settings-sync-toggle--on' : ''}`}
                role="switch"
                aria-checked={syncPrefs.encryptionEnabled}
                onClick={() => {
                  if (syncPrefs.encryptionEnabled) {
                    void window.settingsAPI.clearSyncPassphrase()
                      .then(() => {
                        setSyncPrefsState(prev => ({ ...prev, encryptionEnabled: false }));
                        setPassphraseSaved(false);
                        setShowPassphraseForm(false);
                      })
                      .catch((err: Error) => {
                        toast.show({ variant: 'error', title: 'Failed to clear passphrase', message: err.message });
                      });
                  } else {
                    setShowPassphraseForm(true);
                  }
                }}
              />
            </div>

            {showPassphraseForm && !syncPrefs.encryptionEnabled && (
              <div style={{ marginTop: 16, borderTop: '1px solid var(--color-border, #e0e0e0)', paddingTop: 16 }}>
                <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 500 }}>Set encryption passphrase</div>
                <div style={{ marginBottom: 8 }}>
                  <input
                    type="password"
                    value={newPassphrase}
                    onChange={(e) => { setNewPassphrase(e.target.value); setPassphraseError(''); }}
                    placeholder="Passphrase (min 8 characters)"
                    style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--color-border, #ccc)', fontSize: 13, boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <input
                    type="password"
                    value={confirmPassphrase}
                    onChange={(e) => { setConfirmPassphrase(e.target.value); setPassphraseError(''); }}
                    placeholder="Confirm passphrase"
                    style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--color-border, #ccc)', fontSize: 13, boxSizing: 'border-box' }}
                  />
                </div>
                {passphraseError && (
                  <div style={{ color: 'var(--color-danger, #d32f2f)', fontSize: 12, marginBottom: 8 }}>{passphraseError}</div>
                )}
                {passphraseSaved && (
                  <div style={{ color: 'var(--color-success, #2e7d32)', fontSize: 12, marginBottom: 8 }}>Passphrase saved successfully.</div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (newPassphrase.length < 8) { setPassphraseError('Passphrase must be at least 8 characters.'); return; }
                      if (newPassphrase !== confirmPassphrase) { setPassphraseError('Passphrases do not match.'); return; }
                      void window.settingsAPI.setSyncPassphrase(newPassphrase)
                        .then((ok) => {
                          if (ok) {
                            setSyncPrefsState(prev => ({ ...prev, encryptionEnabled: true }));
                            setShowPassphraseForm(false);
                            setPassphraseSaved(true);
                            setNewPassphrase('');
                            setConfirmPassphrase('');
                          } else {
                            setPassphraseError('Failed to save passphrase. Try again.');
                          }
                        })
                        .catch((err: Error) => {
                          setPassphraseError(`Error: ${err.message}`);
                        });
                    }}
                  >Save passphrase</Button>
                  <Button size="sm" variant="secondary" onClick={() => { setShowPassphraseForm(false); setNewPassphrase(''); setConfirmPassphrase(''); setPassphraseError(''); }}>Cancel</Button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
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
