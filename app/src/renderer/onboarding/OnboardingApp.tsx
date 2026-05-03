import React, { useState, useEffect, useCallback, useRef } from 'react';
import { OnboardingCookieList } from './OnboardingCookieList';
import introImage from './intro.png';
import chromeLogo from './chrome-logo.svg';
import claudeCodeLogo from './claude-code-logo.svg';
import codexLogo from './codex-logo.svg';
import {
  acceleratorToDisplayParts,
  defaultGlobalCmdbarAccelerator,
  keyboardEventToShortcut,
  normalizeShortcutPlatform,
  rendererToAccelerator,
} from '../../shared/hotkeys';

interface ChromeProfile {
  directory: string;
  name: string;
  email: string;
  avatarIcon: string;
}

interface CookieImportResult {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
  domains: string[];
  failedDomains: string[];
  errorReasons: Record<string, number>;
}

declare global {
  interface Window {
    onboardingAPI: {
      detectChromeProfiles: () => Promise<ChromeProfile[]>;
      importChromeProfileCookies: (profileDir: string) => Promise<CookieImportResult>;
      listSessionCookies: () => Promise<Array<{
        name: string;
        domain: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
        expires: number | null;
        sameSite: string;
      }>>;
      getChromeProfileSyncs: () => Promise<Record<string, {
        last_synced_at: string;
        imported: number;
        total: number;
        domain_count: number;
        new_cookies?: number;
        updated_cookies?: number;
        unchanged_cookies?: number;
        new_domain_count?: number;
        updated_domain_count?: number;
      }>>;
      saveApiKey: (key: string) => Promise<void>;
      testApiKey: (key: string) => Promise<{ success: boolean; error?: string }>;
      saveOpenAIKey: (key: string) => Promise<void>;
      testOpenAIKey: (key: string) => Promise<{ success: boolean; error?: string }>;
      detectClaudeCode: () => Promise<{
        available: boolean;
        installed: boolean;
        authed: boolean;
        version: string | null;
        subscriptionType?: string | null;
        hasInference?: boolean;
        error?: string | null;
      }>;
      useClaudeCode: () => Promise<{ subscriptionType: string | null }>;
      runClaudeLogin: () => Promise<{ ok: boolean; error?: string; stdout?: string }>;
      openClaudeLoginTerminal: () => Promise<{ opened: boolean; error?: string }>;
      detectCodex: () => Promise<{
        available: boolean;
        installed: boolean;
        authed: boolean;
        version: string | null;
        error?: string | null;
      }>;
      useCodex: () => Promise<{ ok: boolean }>;
      openCodexLoginTerminal: (opts?: { deviceAuth?: boolean }) => Promise<{ opened: boolean; error?: string; verificationUrl?: string; deviceCode?: string }>;
      openExternal: (url: string) => Promise<{ opened: boolean }>;
      requestNotifications: () => Promise<{ supported: boolean }>;
      platform: string;
      getPlatform: () => Promise<string>;
      listenShortcut: () => Promise<{ ok: boolean; accelerator: string }>;
      setShortcut: (accelerator: string) => Promise<{ ok: boolean; accelerator: string }>;
      triggerShortcut: () => Promise<{ ok: boolean }>;
      onShortcutActivated: (cb: () => void) => () => void;
      onTaskSubmitted: (cb: () => void) => () => void;
      onPillShown: (cb: () => void) => () => void;
      onPillHidden: (cb: () => void) => () => void;
      getConsent: () => Promise<{ telemetry: boolean; telemetryUpdatedAt: string | null; version: number }>;
      setTelemetryConsent: (optedIn: boolean) => Promise<{ telemetry: boolean; telemetryUpdatedAt: string | null; version: number }>;
      capture: (name: string, props?: Record<string, string | number | boolean>) => void;
      complete: (opts?: { initialHubView?: 'dashboard' | 'grid' | 'list' }) => Promise<void>;
      getState: () => Promise<{ lastStep: string | null }>;
      setStep: (step: string) => Promise<void>;
      whatsapp: {
        connect: () => Promise<{ status: string }>;
        disconnect: () => Promise<{ status: string }>;
        status: () => Promise<{ status: string; identity: string | null }>;
      };
      onWhatsappQr: (cb: (dataUrl: string) => void) => () => void;
      onChannelStatus: (cb: (channelId: string, status: string, detail?: string) => void) => () => void;
    };
  }
}

type Step = 'intro' | 'profile' | 'apikey' | 'notifications' | 'shortcut';

function buildAccelerator(e: KeyboardEvent, platform: string): string | null {
  const shortcut = keyboardEventToShortcut(e, platform);
  if (!shortcut || (!e.metaKey && !e.ctrlKey && !e.altKey)) return null;
  return rendererToAccelerator(shortcut);
}

function acceleratorsMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function PreferencesStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const [requested, setRequested] = useState(false);
  const [supported, setSupported] = useState(true);
  const [telemetryOptIn, setTelemetryOptIn] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleEnable = useCallback(async () => {
    try {
      const res = await window.onboardingAPI.requestNotifications();
      setSupported(res.supported);
      setRequested(true);
    } catch (err) {
      console.error('[onboarding] requestNotifications failed', err);
      setRequested(true);
    }
  }, []);

  const handleContinue = useCallback(async () => {
    setSaving(true);
    try {
      // Always persist the telemetry choice — including an explicit "no" —
      // so we have a dated consent record and don't re-prompt on next launch.
      await window.onboardingAPI.setTelemetryConsent(telemetryOptIn);
    } catch (err) {
      console.error('[onboarding] setTelemetryConsent failed', err);
    } finally {
      setSaving(false);
      onContinue();
    }
  }, [telemetryOptIn, onContinue]);

  const handlePrivacyLink = useCallback(() => {
    window.onboardingAPI.openExternal?.('https://browser-use.com/privacy');
  }, []);

  return (
    <div className="step-panel">
      <h1 className="step-title">Preferences</h1>
      <p className="step-subtitle">
        A couple of defaults you can change anytime in Settings.
      </p>

      <div className="pref-row">
        <div className="pref-row-body">
          <div className="pref-row-title">Notifications</div>
          <div className="pref-row-desc">
            Get alerts when agents finish tasks, get stuck, or need your input.
          </div>
          {requested && supported && (
            <p className="notif-status">
              Check the system dialog to allow notifications.
            </p>
          )}
          {requested && !supported && (
            <p className="notif-status notif-status-error">
              Notifications aren&rsquo;t supported in this environment.
            </p>
          )}
        </div>
        <button
          className="btn btn-secondary pref-row-action"
          onClick={handleEnable}
          disabled={requested}
        >
          {requested ? 'Requested' : 'Enable'}
        </button>
      </div>

      <label className="pref-row pref-row-toggle">
        <input
          type="checkbox"
          checked={telemetryOptIn}
          onChange={(e) => setTelemetryOptIn(e.target.checked)}
        />
        <div className="pref-row-body">
          <div className="pref-row-title">Allow telemetry to help us make this app better</div>
          <div className="pref-row-desc">
            Anonymous usage only — no prompts, credentials, or file contents.{' '}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); handlePrivacyLink(); }}
            >
              Learn more
            </a>
          </div>
        </div>
      </label>

      <div className="apikey-actions">
        <button className="btn btn-primary" onClick={handleContinue} disabled={saving}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>

      <div className="step-subactions">
        <button className="back-btn" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

const VALID_STEPS: readonly Step[] = ['intro', 'profile', 'apikey', 'notifications', 'shortcut'];

export function OnboardingApp() {
  const [step, setStep] = useState<Step>('intro');
  const [hydrated, setHydrated] = useState(false);

  // Restore the user's last step on mount — onboarding can be closed mid-flow
  // (e.g. user accidentally dismisses the window) and reopened later. We
  // resume where they left off instead of starting over from intro.
  useEffect(() => {
    let cancelled = false;
    window.onboardingAPI.getState?.().then((state) => {
      if (cancelled) return;
      const candidate = state?.lastStep;
      if (candidate && (VALID_STEPS as readonly string[]).includes(candidate)) {
        setStep(candidate as Step);
      }
      setHydrated(true);
    }).catch(() => { setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  // Persist the current step so a window close + reopen lands here, not intro.
  useEffect(() => {
    if (!hydrated) return;
    window.onboardingAPI.setStep?.(step).catch(() => { /* best-effort */ });
  }, [step, hydrated]);

  // Fire once on mount — the denominator for the onboarding funnel. Every
  // subsequent drop-off is measured against this event count.
  useEffect(() => {
    window.onboardingAPI.capture?.('onboarding_started');
  }, []);

  // Capture every step transition so PostHog can build a stepwise funnel.
  useEffect(() => {
    window.onboardingAPI.capture?.('onboarding_step_viewed', { step });
  }, [step]);

  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [importedProfile, setImportedProfile] = useState<ChromeProfile | null>(null);
  const [importResult, setImportResult] = useState<CookieImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Per-provider API key fallback — expanded via the "Use X API key instead"
  // links beneath each provider's card cluster. Each feeds a separate keychain
  // slot so Anthropic and OpenAI keys are never mixed up at spawn time.
  const [showAnthropicInput, setShowAnthropicInput] = useState(false);
  const [showOpenaiInput, setShowOpenaiInput] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [openaiTesting, setOpenaiTesting] = useState(false);
  const [openaiTestResult, setOpenaiTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [openaiSaving, setOpenaiSaving] = useState(false);

  const [claudeCode, setClaudeCode] = useState<{
    available: boolean;
    installed: boolean;
    authed: boolean;
    version: string | null;
    subscriptionType?: string | null;
    error?: string | null;
  } | null>(null);
  const [usingClaudeCode, setUsingClaudeCode] = useState(false);
  const [waitingForLogin, setWaitingForLogin] = useState(false);

  const [codex, setCodex] = useState<{
    available: boolean;
    installed: boolean;
    authed: boolean;
    version: string | null;
    error?: string | null;
  } | null>(null);
  const [usingCodex, setUsingCodex] = useState(false);
  const [waitingForCodexLogin, setWaitingForCodexLogin] = useState(false);
  // Device-auth flow state: the URL the user visits + the one-time code they
  // paste. Populated by handleStartCodexLogin and cleared once auth completes.
  const [codexDeviceCode, setCodexDeviceCode] = useState<string | null>(null);
  const [codexVerificationUrl, setCodexVerificationUrl] = useState<string | null>(null);

  const refreshClaudeStatus = useCallback(async () => {
    try {
      const res = await window.onboardingAPI.detectClaudeCode();
      setClaudeCode({
        available: res.available,
        installed: res.installed,
        authed: res.authed,
        version: res.version,
        subscriptionType: res.subscriptionType ?? null,
        error: res.error ?? null,
      });
      return res;
    } catch {
      setClaudeCode({ available: false, installed: false, authed: false, version: null });
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshClaudeStatus();
  }, [refreshClaudeStatus]);

  const refreshCodexStatus = useCallback(async () => {
    try {
      console.log('[onboarding] refreshCodexStatus: invoking detectCodex');
      const res = await window.onboardingAPI.detectCodex();
      console.log('[onboarding] refreshCodexStatus: result', res);
      setCodex({
        available: res.available,
        installed: res.installed,
        authed: res.authed,
        version: res.version,
        error: res.error ?? null,
      });
      return res;
    } catch (err) {
      console.error('[onboarding] refreshCodexStatus: detectCodex threw', err);
      setCodex({ available: false, installed: false, authed: false, version: null, error: (err as Error)?.message ?? 'detect failed' });
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshCodexStatus();
  }, [refreshCodexStatus]);

  // Poll while the user completes codex login. Short interval + immediate
  // first tick so the UI flips to "configured" within a second of auth.json
  // appearing, not after the full 3s loop.
  useEffect(() => {
    if (!waitingForCodexLogin) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 180; // 3 minutes at 1s
    const tick = async () => {
      if (cancelled) return;
      attempts++;
      const res = await refreshCodexStatus();
      if (res?.authed) { setWaitingForCodexLogin(false); return; }
      if (attempts >= MAX_ATTEMPTS) { setWaitingForCodexLogin(false); return; }
      setTimeout(tick, 1000);
    };
    // Kick off immediately (not after 3s) so the first detection happens
    // right after the main-process write, not a full interval later.
    void tick();
    return () => { cancelled = true; };
  }, [waitingForCodexLogin, refreshCodexStatus]);

  const handleUseCodex = useCallback(async () => {
    console.log('[onboarding] handleUseCodex: invoking useCodex');
    try {
      const res = await window.onboardingAPI.useCodex();
      console.log('[onboarding] handleUseCodex: ok', res);
      setUsingCodex(true);
      setUsingClaudeCode(false);
      window.onboardingAPI.capture?.('onboarding_provider_selected', { provider: 'codex' });
    } catch (err) {
      console.error('[onboarding] handleUseCodex: useCodex threw', err);
    }
  }, []);

  const handleStartCodexLogin = useCallback(async (opts?: { deviceAuth?: boolean }) => {
    console.log('[onboarding] handleStartCodexLogin: invoking openCodexLoginTerminal', opts);
    setWaitingForCodexLogin(true);
    setCodexDeviceCode(null);
    setCodexVerificationUrl(null);
    try {
      const res = await window.onboardingAPI.openCodexLoginTerminal(opts);
      console.log('[onboarding] handleStartCodexLogin: result', res);
      if (!res.opened) {
        console.warn('[onboarding] openCodexLoginTerminal failed', res.error);
        setWaitingForCodexLogin(false);
        return;
      }
      if (res.deviceCode) setCodexDeviceCode(res.deviceCode);
      if (res.verificationUrl) setCodexVerificationUrl(res.verificationUrl);
    } catch (err) {
      console.error('[onboarding] openCodexLoginTerminal threw', err);
      setWaitingForCodexLogin(false);
    }
  }, []);

  // Click handlers for the card + the explicit device-auth fallback link.
  // Keeping these as plain references so React binds identity-stable functions.
  const handleStartCodexLoginPlain = useCallback(() => handleStartCodexLogin(), [handleStartCodexLogin]);
  const handleStartCodexLoginDeviceAuth = useCallback(() => handleStartCodexLogin({ deviceAuth: true }), [handleStartCodexLogin]);

  // Clear the device code as soon as the backend observes auth.json — the
  // polling effect below flips waitingForCodexLogin off and we follow suit.
  useEffect(() => {
    if (!waitingForCodexLogin && (codexDeviceCode || codexVerificationUrl)) {
      setCodexDeviceCode(null);
      setCodexVerificationUrl(null);
    }
  }, [waitingForCodexLogin, codexDeviceCode, codexVerificationUrl]);

  // Poll while waiting for Claude Code to finish browser-based login.
  // Stops when authed becomes true or after a cap.
  useEffect(() => {
    if (!waitingForLogin) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // ~3 minutes at 3s interval
    const tick = async () => {
      if (cancelled) return;
      attempts++;
      const res = await refreshClaudeStatus();
      if (res?.authed) { setWaitingForLogin(false); return; }
      if (attempts >= MAX_ATTEMPTS) { setWaitingForLogin(false); return; }
      setTimeout(tick, 3000);
    };
    const id = setTimeout(tick, 3000);
    return () => { cancelled = true; clearTimeout(id); };
  }, [waitingForLogin, refreshClaudeStatus]);

  const handleUseClaudeCode = useCallback(async () => {
    console.log('[onboarding] handleUseClaudeCode: invoking useClaudeCode');
    try {
      await window.onboardingAPI.useClaudeCode();
      console.log('[onboarding] handleUseClaudeCode: ok');
      setUsingClaudeCode(true);
      setUsingCodex(false);
      window.onboardingAPI.capture?.('onboarding_provider_selected', { provider: 'claude-code' });
    } catch (err) {
      console.error('[onboarding] handleUseClaudeCode: threw', err);
    }
  }, []);

  const handleStartClaudeLogin = useCallback(async () => {
    setWaitingForLogin(true);
    try {
      const res = await window.onboardingAPI.runClaudeLogin();
      if (!res.ok) {
        console.warn('[onboarding] runClaudeLogin failed', res.error);
        setWaitingForLogin(false);
      } else {
        void refreshClaudeStatus();
      }
    } catch (err) {
      console.error('[onboarding] runClaudeLogin threw', err);
      setWaitingForLogin(false);
    }
  }, [refreshClaudeStatus]);

  const handleInstallClaudeCode = useCallback(() => {
    window.onboardingAPI.openExternal?.('https://docs.anthropic.com/en/docs/claude-code/overview');
  }, []);

  const [accelerator, setAccelerator] = useState<string>(() => defaultGlobalCmdbarAccelerator(window.onboardingAPI.platform));
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [shortcutActivated, setShortcutActivated] = useState(false);
  const [pillOpen, setPillOpen] = useState(false);
  const [platform, setPlatform] = useState(() => normalizeShortcutPlatform(window.onboardingAPI.platform));
  const suppressRecordingClickUntilRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    window.onboardingAPI.getPlatform?.().then((detectedPlatform) => {
      if (!cancelled) setPlatform(normalizeShortcutPlatform(detectedPlatform));
    }).catch(() => {
      if (!cancelled) setPlatform(normalizeShortcutPlatform(window.onboardingAPI.platform));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    window.onboardingAPI.detectChromeProfiles().then((p) => {
      setProfiles(p);
      setLoadingProfiles(false);
    }).catch((err) => {
      console.error('[onboarding] detectProfiles failed', err);
      setLoadingProfiles(false);
    });
  }, []);

  const handleImportProfile = useCallback(async (profileDir: string) => {
    setImporting(profileDir);
    setImportError(null);
    setImportResult(null);
    setImportedProfile(null);
    try {
      const result = await window.onboardingAPI.importChromeProfileCookies(profileDir);
      setImportResult(result);
      setImportedProfile(profiles.find((p) => p.directory === profileDir) ?? null);
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(null);
    }
  }, [profiles]);

  const handleSkipProfile = useCallback(() => setStep('apikey'), []);

  const handleTestKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.onboardingAPI.testApiKey(apiKey.trim());
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (!testResult) return;
    const t = setTimeout(() => setTestResult(null), 3500);
    return () => clearTimeout(t);
  }, [testResult]);

  const handleSaveKeyAndContinue = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await window.onboardingAPI.saveApiKey(apiKey.trim());
      setStep('notifications');
    } catch (err) {
      console.error('[onboarding] save key failed', err);
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  const handleTestOpenaiKey = useCallback(async () => {
    if (!openaiKey.trim()) return;
    console.log('[onboarding] handleTestOpenaiKey: invoking testOpenAIKey');
    setOpenaiTesting(true);
    setOpenaiTestResult(null);
    try {
      const result = await window.onboardingAPI.testOpenAIKey(openaiKey.trim());
      console.log('[onboarding] handleTestOpenaiKey: result', result);
      setOpenaiTestResult(result);
    } catch (err) {
      console.error('[onboarding] handleTestOpenaiKey: threw', err);
      setOpenaiTestResult({ success: false, error: (err as Error).message });
    } finally {
      setOpenaiTesting(false);
    }
  }, [openaiKey]);

  useEffect(() => {
    if (!openaiTestResult) return;
    const t = setTimeout(() => setOpenaiTestResult(null), 3500);
    return () => clearTimeout(t);
  }, [openaiTestResult]);

  const handleSaveOpenaiKeyAndContinue = useCallback(async () => {
    if (!openaiKey.trim()) return;
    console.log('[onboarding] handleSaveOpenaiKeyAndContinue: saving');
    setOpenaiSaving(true);
    try {
      await window.onboardingAPI.saveOpenAIKey(openaiKey.trim());
      console.log('[onboarding] handleSaveOpenaiKeyAndContinue: saved, advancing');
      setStep('notifications');
    } catch (err) {
      console.error('[onboarding] save openai key failed', err);
    } finally {
      setOpenaiSaving(false);
    }
  }, [openaiKey]);

  // Single bottom-of-step handler — saves whatever keys are filled and
  // advances. Works alongside the provider-subscription path (usingX), which
  // doesn't need a save step. Verbose logging so we can trace the path taken.
  const [stepSaving, setStepSaving] = useState(false);
  const stepCanContinue = Boolean(claudeCode?.authed) || Boolean(codex?.authed) || apiKey.trim().length > 0 || openaiKey.trim().length > 0;
  const handleStepSaveAndContinue = useCallback(async () => {
    console.log('[onboarding] handleStepSaveAndContinue', {
      claudeAuthed: Boolean(claudeCode?.authed),
      codexAuthed: Boolean(codex?.authed),
      hasAnthropicKey: apiKey.trim().length > 0,
      hasOpenaiKey: openaiKey.trim().length > 0,
    });
    setStepSaving(true);
    try {
      const ops: Promise<unknown>[] = [];
      if (apiKey.trim()) ops.push(window.onboardingAPI.saveApiKey(apiKey.trim()));
      if (openaiKey.trim()) ops.push(window.onboardingAPI.saveOpenAIKey(openaiKey.trim()));
      if (ops.length > 0) {
        console.log('[onboarding] handleStepSaveAndContinue: saving', ops.length, 'key(s)');
        await Promise.all(ops);
      }
      if (apiKey.trim()) {
        window.onboardingAPI.capture?.('onboarding_provider_selected', { provider: 'anthropic-key' });
      }
      if (openaiKey.trim()) {
        window.onboardingAPI.capture?.('onboarding_provider_selected', { provider: 'openai-key' });
      }
      console.log('[onboarding] handleStepSaveAndContinue: advancing to notifications step');
      setStep('notifications');
    } catch (err) {
      console.error('[onboarding] handleStepSaveAndContinue threw', err);
    } finally {
      setStepSaving(false);
    }
  }, [claudeCode?.authed, codex?.authed, apiKey, openaiKey]);

  const handleFinish = useCallback(async () => {
    window.onboardingAPI.capture?.('onboarding_completed');
    try {
      // Tells the main process to land the freshly-opened hub on the
      // Dashboard view (equivalent to `g d`), rather than whatever
      // hub-view-mode was last persisted. Cross-window localStorage
      // isn't shared, so this has to go via main.
      await window.onboardingAPI.complete({ initialHubView: 'dashboard' });
    } catch (err) {
      console.error('[onboarding] complete failed', err);
    }
  }, []);

  // Shortcut step: register the current shortcut, listen for activation + task submission
  useEffect(() => {
    if (step !== 'shortcut') return;
    window.onboardingAPI.listenShortcut().then((res) => {
      if (res.accelerator) setAccelerator(res.accelerator);
      setShortcutError(res.ok ? null : 'That shortcut is unavailable. Choose another one.');
    });
    const unsubActivated = window.onboardingAPI.onShortcutActivated(() => {
      setRecording(false);
      setShortcutActivated(true);
    });
    const unsubShown = window.onboardingAPI.onPillShown(() => {
      setPillOpen(true);
    });
    const unsubHidden = window.onboardingAPI.onPillHidden(() => {
      setPillOpen(false);
    });
    const unsubSubmitted = window.onboardingAPI.onTaskSubmitted(() => {
      // User kicked off a task during onboarding → they want to land on the
      // grid (agent pane) so they can see the running session, not the empty
      // dashboard. Without a submitted task the hub's default 'dashboard'
      // view stands.
      try { window.localStorage.setItem('hub-view-mode', 'grid'); } catch { /* ignore storage failures */ }
      console.log('[onboarding] task submitted during onboarding → hub→grid');
      void window.onboardingAPI.complete();
    });
    return () => { unsubActivated(); unsubShown(); unsubHidden(); unsubSubmitted(); };
  }, [step]);

  // Key recording
  const shouldIgnoreRecordingClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    return e.detail === 0 || Date.now() < suppressRecordingClickUntilRef.current;
  }, []);

  const startRecording = useCallback(() => {
    setShortcutError(null);
    setRecording(true);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timeout = window.setTimeout(() => {
      setRecording(false);
      setShortcutError('No shortcut was detected. Choose another combination.');
    }, 8000);
    const handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Unidentified') {
        window.clearTimeout(timeout);
        setRecording(false);
        setShortcutError('That shortcut is unavailable. Choose another one.');
        return;
      }
      const accel = buildAccelerator(e, platform);
      if (!accel) return;
      window.clearTimeout(timeout);
      suppressRecordingClickUntilRef.current = Date.now() + 700;
      (document.activeElement as HTMLElement | null)?.blur?.();
      setRecording(false);
      try {
        const res = await window.onboardingAPI.setShortcut(accel);
        setAccelerator(res.accelerator);
        setShortcutError(res.ok ? null : 'That shortcut is unavailable. Choose another one.');
        (document.activeElement as HTMLElement | null)?.blur?.();
      } catch (err) {
        console.error('[onboarding] setShortcut failed', err);
        setShortcutError('Shortcut setup failed. Choose another one.');
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('keydown', handler, true);
    };
  }, [recording, platform]);

  useEffect(() => {
    if (step !== 'shortcut' || recording || pillOpen) return;
    const handler = (e: KeyboardEvent) => {
      const accel = buildAccelerator(e, platform);
      if (!accel || !acceleratorsMatch(accel, accelerator)) return;
      e.preventDefault();
      e.stopPropagation();
      void window.onboardingAPI.triggerShortcut().catch((err) => {
        console.error('[onboarding] triggerShortcut failed', err);
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [accelerator, pillOpen, platform, recording, step]);

  return (
    <div className="onboarding-container">
      <div className="onboarding-drag-region" />

      <div className={`onboarding-content ${step === 'intro' ? 'onboarding-content-wide' : ''}`}>
        <div className="step-indicator">
          {(['intro', 'profile', 'apikey', 'notifications', 'shortcut'] as Step[]).map((s, i, all) => {
            const currentIdx = all.indexOf(step);
            const thisIdx = i;
            const cls = thisIdx < currentIdx ? 'done' : thisIdx === currentIdx ? 'active' : '';
            return (
              <React.Fragment key={s}>
                <div className={`step-dot ${cls}`} />
                {i < all.length - 1 && <div className="step-line" />}
              </React.Fragment>
            );
          })}
        </div>

        {step === 'intro' && (
          <div className="step-panel intro-panel">
            <div className="intro-content">
              <div className="intro-text">
                <h1 className="intro-title">Browser Use Desktop</h1>
                <p className="intro-subtitle">
                  Run AI agents that browse the web, complete tasks, and report back — all from your desktop.
                </p>
                <button className="btn btn-primary intro-cta" onClick={() => setStep('profile')}>
                  Get started
                </button>
              </div>
              <div className="intro-image-wrap">
                <img className="intro-image" src={introImage} alt="Browser Use Desktop" />
              </div>
            </div>
          </div>
        )}

        {step === 'profile' && (
          <div className="step-panel">
            <div className="step-title-row">
              <img className="step-title-icon" src={chromeLogo} alt="" />
              <h1 className="step-title">Import Chrome Profile</h1>
            </div>
            <p className="step-subtitle">
              Import your cookies so agents can browse as you, or start fresh.
            </p>

            {loadingProfiles && (
              <div className="profile-loading">Detecting Chrome profiles...</div>
            )}

            {!loadingProfiles && profiles.length === 0 && (
              <div className="profile-empty">
                <p>No Chrome profiles found.</p>
                <button className="btn btn-primary" onClick={handleSkipProfile}>
                  Continue without import
                </button>
              </div>
            )}

            {!loadingProfiles && profiles.length > 0 && (
              <div className="profile-list">
                {(importResult ? [] : profiles).map((p) => (
                    <button
                      key={p.directory}
                      className="profile-card"
                      onClick={() => handleImportProfile(p.directory)}
                      disabled={importing !== null}
                    >
                      <div className="profile-avatar">
                        {p.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="profile-info">
                        <div className="profile-name">{p.name}</div>
                        {p.email && <div className="profile-email">{p.email}</div>}
                        <div className="profile-dir">{p.directory}</div>
                      </div>
                      {importing === p.directory && (
                        <div className="profile-spinner" />
                      )}
                    </button>
                  ))}

                {!importResult && (
                  <button
                    className="profile-card profile-card-skip"
                    onClick={handleSkipProfile}
                    disabled={importing !== null}
                  >
                    <div className="profile-avatar profile-avatar-skip">+</div>
                    <div className="profile-info">
                      <div className="profile-name">Start fresh</div>
                      <div className="profile-email">No cookie import</div>
                    </div>
                  </button>
                )}
              </div>
            )}

            {importResult && (
              <div className="import-results">
                <span className="import-stat import-stat-success">
                  <svg className="import-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>
                    Imported {importResult.imported.toLocaleString()} cookies from {importResult.domains.length} domains
                  </span>
                </span>

                {importedProfile && (
                  <div className="import-summary-card">
                    <div className="profile-avatar">
                      {importedProfile.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="profile-info">
                      <div className="profile-name">{importedProfile.name}</div>
                      {importedProfile.email && (
                        <div className="profile-email">{importedProfile.email}</div>
                      )}
                      <div className="import-summary-meta">
                        {importResult.imported.toLocaleString()} cookies · {importResult.domains.length} domains
                      </div>
                    </div>
                  </div>
                )}

                <OnboardingCookieList
                  listCookies={() => window.onboardingAPI.listSessionCookies()}
                />

                <div className="apikey-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep('apikey')}
                  >
                    Continue
                  </button>
                </div>

                <button
                  className="back-btn"
                  onClick={() => {
                    setImportResult(null);
                    setImportedProfile(null);
                    setImportError(null);
                    setStep('intro');
                  }}
                >
                  Back
                </button>
              </div>
            )}

            {importError && (
              <div className="import-result import-result-error">
                {importError}
              </div>
            )}

            {!importResult && (
              <button className="back-btn" onClick={() => setStep('intro')}>
                Back
              </button>
            )}
          </div>
        )}

        {step === 'apikey' && (
          <div className="step-panel">
            <h1 className="step-title">Vendor setup</h1>
            <p className="step-subtitle">
              Sign in with Claude Code or Codex, or paste an API key. Credentials are stored locally in the system keychain.
            </p>

            {/* Installed + authed → selectable card. Click flips to configured state. */}
            {claudeCode?.installed && claudeCode?.authed && (
              <div className="claude-code-card claude-code-card--selected">
                <div className="claude-code-card__icon">
                  <img src={claudeCodeLogo} alt="" />
                </div>
                <div className="claude-code-card__text">
                  <div className="claude-code-card__title">Claude successfully configured</div>
                  <div className="claude-code-card__sub">
                    {`Signed in via Claude Code${claudeCode.version ? ` (v${claudeCode.version})` : ''}. No API key needed.`}
                  </div>
                </div>
                <div className="claude-code-card__check">✓</div>
              </div>
            )}

            {/* Not authed → one card with two interior options: subscription or API key.
                Switching once configured happens in Settings. */}
            {claudeCode && !claudeCode.authed && !usingClaudeCode && (
              <div className="provider-card">
                <div className="provider-card__tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!showAnthropicInput}
                    className={`provider-card__tab${!showAnthropicInput ? ' is-active' : ''}`}
                    onClick={() => setShowAnthropicInput(false)}
                  >
                    Connect subscription
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showAnthropicInput}
                    className={`provider-card__tab${showAnthropicInput ? ' is-active' : ''}`}
                    onClick={() => setShowAnthropicInput(true)}
                  >
                    Use API key
                  </button>
                </div>

                <div className="provider-card__body">
                  {!showAnthropicInput && claudeCode.installed && (
                    <button
                      type="button"
                      className="provider-card__action"
                      onClick={handleStartClaudeLogin}
                      disabled={waitingForLogin}
                    >
                      <div className="claude-code-card__icon">
                        <img src={claudeCodeLogo} alt="" />
                      </div>
                      <div className="claude-code-card__text">
                        <div className="claude-code-card__title">
                          {waitingForLogin ? 'Waiting for login…' : 'Click to log in'}
                        </div>
                        <div className="claude-code-card__sub">
                          {waitingForLogin
                            ? 'Finish the browser sign-in. We’ll detect it automatically.'
                            : 'Opens the Claude sign-in flow in your browser. Sign in once and we’ll detect it.'}
                        </div>
                      </div>
                      <div className="claude-code-card__chevron">{waitingForLogin ? '\u2026' : '\u203A'}</div>
                    </button>
                  )}

                  {!showAnthropicInput && !claudeCode.installed && (
                    <button
                      type="button"
                      className="provider-card__action"
                      onClick={handleInstallClaudeCode}
                    >
                      <div className="claude-code-card__icon">
                        <img src={claudeCodeLogo} alt="" />
                      </div>
                      <div className="claude-code-card__text">
                        <div className="claude-code-card__title">Install Claude Code</div>
                        <div className="claude-code-card__sub">
                          <code>npm i -g @anthropic-ai/claude-code</code>{' \u00b7 then re-open this step.'}
                        </div>
                      </div>
                      <div className="claude-code-card__chevron">&rsaquo;</div>
                    </button>
                  )}

                  {showAnthropicInput && (
                    <div className="provider-card__keyform">
                      <div className="apikey-input-wrap">
                        <input
                          type={showKey ? 'text' : 'password'}
                          className="apikey-input"
                          placeholder="sk-ant-..."
                          value={apiKey}
                          onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }}
                          spellCheck={false}
                        />
                        <button className="apikey-toggle" onClick={() => setShowKey(!showKey)} tabIndex={-1}>
                          {showKey ? 'Hide' : 'Show'}
                        </button>
                      </div>
                      <div className="apikey-actions">
                        <button className="btn btn-secondary" onClick={handleTestKey} disabled={!apiKey.trim() || testing}>
                          {testing ? 'Testing...' : 'Test Key'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Codex — authed → selectable card. Click flips to configured state. */}
            {codex?.authed && (
              <div className="claude-code-card claude-code-card--selected">
                <div className="claude-code-card__icon">
                  <img src={codexLogo} alt="" />
                </div>
                <div className="claude-code-card__text">
                  <div className="claude-code-card__title">Codex successfully configured</div>
                  <div className="claude-code-card__sub">
                    {`Signed in via Codex CLI${codex.version ? ` (v${codex.version})` : ''}. No API key needed.`}
                  </div>
                </div>
                <div className="claude-code-card__check">✓</div>
              </div>
            )}

            {/* Codex not authed → same merged card pattern as Claude. */}
            {codex && !codex.authed && !usingCodex && (
              <div className="provider-card">
                <div className="provider-card__tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!showOpenaiInput}
                    className={`provider-card__tab${!showOpenaiInput ? ' is-active' : ''}`}
                    onClick={() => setShowOpenaiInput(false)}
                  >
                    Connect subscription
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showOpenaiInput}
                    className={`provider-card__tab${showOpenaiInput ? ' is-active' : ''}`}
                    onClick={() => setShowOpenaiInput(true)}
                  >
                    Use API key
                  </button>
                </div>

                <div className="provider-card__body">
                  {!showOpenaiInput && (
                    <>
                      <button
                        type="button"
                        className="provider-card__action"
                        onClick={handleStartCodexLoginPlain}
                      >
                        <div className="claude-code-card__icon">
                          <img src={codexLogo} alt="" />
                        </div>
                        <div className="claude-code-card__text">
                          <div className="claude-code-card__title">
                            {waitingForCodexLogin ? 'Waiting for login…' : 'Log in to Codex'}
                          </div>
                          <div className="claude-code-card__sub">
                            {waitingForCodexLogin && codexDeviceCode
                              ? 'Enter the code shown below, or click to restart.'
                              : waitingForCodexLogin
                                ? 'Finish the OAuth flow in your browser. Click to restart.'
                                : 'Opens ChatGPT in your browser — sign in once, we’ll detect it.'}
                          </div>
                        </div>
                        <div className="claude-code-card__chevron">{waitingForCodexLogin ? '↻' : '›'}</div>
                      </button>
                      {codexDeviceCode && (
                        <div className="codex-device-auth">
                          <div className="codex-device-auth__label">One-time code</div>
                          <div className="codex-device-auth__code">{codexDeviceCode}</div>
                          {codexVerificationUrl && (
                            <button
                              type="button"
                              className="codex-device-auth__link"
                              onClick={() => window.onboardingAPI.openExternal?.(codexVerificationUrl)}
                            >
                              Open verification page ↗
                            </button>
                          )}
                        </div>
                      )}
                      {!codexDeviceCode && (
                        <button
                          type="button"
                          className="codex-device-auth__link codex-device-auth__link--secondary codex-device-auth__fallback"
                          onClick={handleStartCodexLoginDeviceAuth}
                        >
                          Having trouble? Use device code flow instead
                        </button>
                      )}
                    </>
                  )}

                  {showOpenaiInput && (
                    <div className="provider-card__keyform">
                      <div className="apikey-input-wrap">
                        <input
                          type={showOpenaiKey ? 'text' : 'password'}
                          className="apikey-input"
                          placeholder="sk-..."
                          value={openaiKey}
                          onChange={(e) => { setOpenaiKey(e.target.value); setOpenaiTestResult(null); }}
                          spellCheck={false}
                        />
                        <button className="apikey-toggle" onClick={() => setShowOpenaiKey(!showOpenaiKey)} tabIndex={-1}>
                          {showOpenaiKey ? 'Hide' : 'Show'}
                        </button>
                      </div>
                      <div className="apikey-actions">
                        <button className="btn btn-secondary" onClick={handleTestOpenaiKey} disabled={!openaiKey.trim() || openaiTesting}>
                          {openaiTesting ? 'Testing...' : 'Test Key'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="apikey-actions apikey-actions--footer">
              <button
                type="button"
                className="btn btn-primary apikey-continue-btn"
                onClick={handleStepSaveAndContinue}
                disabled={!stepCanContinue || stepSaving}
              >
                {stepSaving ? 'Saving...' : 'Save & Continue'}
              </button>
            </div>

            <button className="back-btn" onClick={() => setStep('profile')}>
              Back
            </button>
          </div>
        )}


        {step === 'shortcut' && pillOpen && (
          <div className="step-panel pill-takeover">
            <div className="pill-takeover-dot" />
            <h1 className="pill-takeover-title">Pill is open</h1>
            <p className="pill-takeover-subtitle">
              Type a task and press Enter to finish setup.<br/>
              Press Escape to go back.
            </p>
          </div>
        )}

        {step === 'shortcut' && !pillOpen && (
          <div className="step-panel">
            <h1 className="step-title">Set up your global shortcut</h1>
            <p className="step-subtitle">
              Press this shortcut from <strong>any app on your computer</strong> to open the command pill and send a task to an agent.
            </p>

            <div className="shortcut-demo">
              {recording ? (
                <button
                  type="button"
                  className="shortcut-recording shortcut-clickable"
                  onClick={(e) => {
                    if (shouldIgnoreRecordingClick(e)) return;
                    setRecording(false);
                  }}
                  title="Click to cancel"
                >
                  <div className="shortcut-recording-dot" />
                  <span>Press keys...</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="shortcut-keys shortcut-clickable"
                  onClick={(e) => {
                    if (shouldIgnoreRecordingClick(e)) return;
                    startRecording();
                  }}
                  title="Click to change shortcut"
                >
                  {acceleratorToDisplayParts(accelerator, platform).map((key, i, arr) => (
                    <React.Fragment key={i}>
                      <kbd className="kbd">{key}</kbd>
                      {i < arr.length - 1 && <span className="kbd-plus">+</span>}
                    </React.Fragment>
                  ))}
                </button>
              )}
            </div>

            <p className={`shortcut-hint ${shortcutError ? 'shortcut-hint-error' : ''}`}>
              {shortcutError ?? 'Press the shortcut to try it.'}
            </p>

            <div className="apikey-actions">
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  if (shouldIgnoreRecordingClick(e)) return;
                  if (recording) {
                    setRecording(false);
                  } else {
                    startRecording();
                  }
                }}
              >
                {recording ? 'Cancel' : 'Change shortcut'}
              </button>
              <button className="btn btn-primary" onClick={handleFinish}>
                Skip
              </button>
            </div>

            <button className="back-btn" onClick={() => setStep('notifications')}>
              Back
            </button>
          </div>
        )}

        {step === 'notifications' && (
          <PreferencesStep
            onContinue={() => setStep('shortcut')}
            onBack={() => setStep('notifications')}
          />
        )}
      </div>

      {testResult && (
        <div className={`toast ${testResult.success ? 'toast-success' : 'toast-error'}`}>
          {testResult.success ? (
            <svg className="toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg className="toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span>{testResult.success ? 'API key is valid' : testResult.error || 'Invalid key'}</span>
        </div>
      )}
    </div>
  );
}
