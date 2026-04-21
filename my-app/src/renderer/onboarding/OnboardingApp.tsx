import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DomainList } from './DomainList';
import introImage from './intro.png';
import chromeLogo from './chrome-logo.svg';

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
      saveApiKey: (key: string) => Promise<void>;
      testApiKey: (key: string) => Promise<{ success: boolean; error?: string }>;
      requestNotifications: () => Promise<{ supported: boolean }>;
      listenShortcut: () => Promise<{ ok: boolean; accelerator: string }>;
      setShortcut: (accelerator: string) => Promise<{ ok: boolean; accelerator: string }>;
      onShortcutActivated: (cb: () => void) => () => void;
      onTaskSubmitted: (cb: () => void) => () => void;
      onPillShown: (cb: () => void) => () => void;
      onPillHidden: (cb: () => void) => () => void;
      complete: () => Promise<void>;
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

type Step = 'intro' | 'profile' | 'apikey' | 'whatsapp' | 'notifications' | 'shortcut';

const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space';

function formatAccelerator(accel: string): string {
  return accel
    .replace('CommandOrControl', '\u2318')
    .replace('Command', '\u2318')
    .replace('Control', 'Ctrl')
    .replace('Shift', '\u21E7')
    .replace('Alt', '\u2325')
    .replace(/\+/g, ' ');
}

function buildAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push('CommandOrControl');
  else if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');

  let key = e.key;
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(key)) return null;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();

  if (mods.length === 0) return null;
  return [...mods, key].join('+');
}

function NotificationsStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const [requested, setRequested] = useState(false);
  const [supported, setSupported] = useState(true);

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

  return (
    <div className="step-panel">
      <h1 className="step-title">Turn on notifications</h1>
      <p className="step-subtitle">
        Get alerts when agents finish tasks, get stuck, or need your input.
      </p>

      {requested && supported && (
        <p className="notif-status">
          Check the system dialog to allow notifications from Browser Use Desktop.
        </p>
      )}
      {requested && !supported && (
        <p className="notif-status notif-status-error">
          Notifications aren&rsquo;t supported in this environment.
        </p>
      )}

      <div className="apikey-actions">
        {!requested ? (
          <button className="btn btn-primary" onClick={handleEnable}>
            Enable notifications
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onContinue}>
            Continue
          </button>
        )}
      </div>

      <div className="step-subactions">
        <button className="back-btn" onClick={onBack}>
          Back
        </button>
        {!requested && (
          <button className="back-btn back-btn-link" onClick={onContinue}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function FailedSection({
  failed,
  failedDomains,
  errorReasons,
}: {
  failed: number;
  failedDomains: string[];
  errorReasons: Record<string, number>;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const hasReasons = Object.keys(errorReasons).length > 0;

  return (
    <div className="import-failed-section">
      <div className="import-failed-row">
        <div className="import-stat import-stat-error">
          <svg className="import-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{failed} failed from {failedDomains.length} domains</span>
        </div>
        {hasReasons && (
          <button
            type="button"
            className="error-reasons-toggle"
            onClick={() => setShowDetails((v) => !v)}
          >
            <span>{showDetails ? 'Hide details' : 'Show details'}</span>
            <span className="error-reasons-chevron">{showDetails ? '\u25B4' : '\u25BE'}</span>
          </button>
        )}
      </div>
      <DomainList domains={failedDomains} collapsible />
      {showDetails && <ErrorReasonsDetails reasons={errorReasons} />}
    </div>
  );
}

function ErrorReasonsDetails({ reasons }: { reasons: Record<string, number> }) {
  const entries = Object.entries(reasons).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return null;
  return (
    <div className="error-reasons">
      {entries.map(([reason, count]) => (
        <div key={reason} className="error-reason-row">
          <span className="error-reason-count">{count}</span>
          <span className="error-reason-text">{reason}</span>
        </div>
      ))}
    </div>
  );
}

export function OnboardingApp() {
  const [step, setStep] = useState<Step>('intro');
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CookieImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [accelerator, setAccelerator] = useState<string>(DEFAULT_ACCELERATOR);
  const [recording, setRecording] = useState(false);
  const [shortcutActivated, setShortcutActivated] = useState(false);
  const [pillOpen, setPillOpen] = useState(false);

  const [waStatus, setWaStatus] = useState<string>('disconnected');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [waIdentity, setWaIdentity] = useState<string | null>(null);

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
    try {
      const result = await window.onboardingAPI.importChromeProfileCookies(profileDir);
      setImportResult(result);
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(null);
    }
  }, []);

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
      setStep('whatsapp');
    } catch (err) {
      console.error('[onboarding] save key failed', err);
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  const handleConnectWhatsApp = useCallback(async () => {
    setQrDataUrl(null);
    await window.onboardingAPI.whatsapp.connect();
  }, []);

  const handleFinish = useCallback(async () => {
    try {
      await window.onboardingAPI.complete();
    } catch (err) {
      console.error('[onboarding] complete failed', err);
    }
  }, []);

  // WhatsApp status listeners
  useEffect(() => {
    if (step !== 'whatsapp') return;
    const unsubQr = window.onboardingAPI.onWhatsappQr((dataUrl) => {
      setQrDataUrl(dataUrl);
    });
    const unsubStatus = window.onboardingAPI.onChannelStatus((channelId, status, detail) => {
      if (channelId !== 'whatsapp') return;
      setWaStatus(status);
      if (status === 'connected' && detail) {
        setWaIdentity(detail);
        setQrDataUrl(null);
      }
    });
    return () => { unsubQr(); unsubStatus(); };
  }, [step]);

  // Shortcut step: register default, listen for activation + task submission
  useEffect(() => {
    if (step !== 'shortcut') return;
    window.onboardingAPI.listenShortcut().then((res) => {
      if (res.accelerator) setAccelerator(res.accelerator);
    });
    const unsubActivated = window.onboardingAPI.onShortcutActivated(() => {
      setShortcutActivated(true);
    });
    const unsubShown = window.onboardingAPI.onPillShown(() => {
      setPillOpen(true);
    });
    const unsubHidden = window.onboardingAPI.onPillHidden(() => {
      setPillOpen(false);
    });
    const unsubSubmitted = window.onboardingAPI.onTaskSubmitted(() => {
      void window.onboardingAPI.complete();
    });
    return () => { unsubActivated(); unsubShown(); unsubHidden(); unsubSubmitted(); };
  }, [step]);

  // Key recording
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  useEffect(() => {
    if (!recording) return;
    const handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = buildAccelerator(e);
      if (!accel) return;
      setRecording(false);
      try {
        const res = await window.onboardingAPI.setShortcut(accel);
        setAccelerator(res.accelerator);
      } catch (err) {
        console.error('[onboarding] setShortcut failed', err);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording]);

  return (
    <div className="onboarding-container">
      <div className="onboarding-drag-region" />

      <div className={`onboarding-content ${step === 'intro' ? 'onboarding-content-wide' : ''}`}>
        <div className="step-indicator">
          {(['intro', 'profile', 'apikey', 'whatsapp', 'notifications', 'shortcut'] as Step[]).map((s, i, all) => {
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
                <div className="import-stat import-stat-success">
                  <svg className="import-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>
                    Imported {importResult.imported.toLocaleString()} cookies from {importResult.domains.length} domains
                  </span>
                </div>
                <DomainList domains={importResult.domains} collapsible />

                {importResult.failedDomains.length > 0 && (
                  <FailedSection
                    failed={importResult.failed}
                    failedDomains={importResult.failedDomains}
                    errorReasons={importResult.errorReasons}
                  />
                )}

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
                    setImportError(null);
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
          </div>
        )}

        {step === 'apikey' && (
          <div className="step-panel">
            <h1 className="step-title">Anthropic API Key</h1>
            <p className="step-subtitle">
              Your key is stored locally in the system keychain.
            </p>

            <div className="apikey-input-wrap">
              <input
                type={showKey ? 'text' : 'password'}
                className="apikey-input"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                spellCheck={false}
                autoFocus
              />
              <button
                className="apikey-toggle"
                onClick={() => setShowKey(!showKey)}
                tabIndex={-1}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>

            <div className="apikey-actions">
              <button
                className="btn btn-secondary"
                onClick={handleTestKey}
                disabled={!apiKey.trim() || testing}
              >
                {testing ? 'Testing...' : 'Test Key'}
              </button>

              <button
                className="btn btn-primary"
                onClick={handleSaveKeyAndContinue}
                disabled={!apiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Continue'}
              </button>
            </div>


            <button className="back-btn" onClick={() => setStep('profile')}>
              Back
            </button>
          </div>
        )}

        {step === 'whatsapp' && (
          <div className="step-panel">
            <div className="step-title-row">
              <img
                className="step-title-icon"
                src="https://static.whatsapp.net/rsrc.php/v3/yP/r/rYZqPCBaG70.png"
                alt=""
              />
              <h1 className="step-title">Connect WhatsApp</h1>
            </div>
            <p className="step-subtitle">
              Receive agent notifications and trigger tasks from WhatsApp.
            </p>

            {waStatus === 'connected' && (
              <div className="wa-connected">
                <div className="wa-connected__icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="wa-connected__text">
                  Connected as {waIdentity ?? 'WhatsApp'}
                </p>
              </div>
            )}

            {waStatus !== 'connected' && (waStatus === 'qr_ready' || qrDataUrl) && (
              <div className="wa-qr">
                {qrDataUrl ? (
                  <img className="wa-qr__img" src={qrDataUrl} alt="WhatsApp QR code" />
                ) : (
                  <div className="wa-qr__loading">Generating QR...</div>
                )}
                <p className="wa-qr__hint">
                  Open WhatsApp on your phone, go to Linked Devices, and scan this code
                </p>
              </div>
            )}

            {waStatus === 'connecting' && !qrDataUrl && (
              <div className="wa-connecting">
                <div className="profile-spinner" />
                <p>Connecting...</p>
              </div>
            )}

            <div className="apikey-actions">
              {waStatus === 'connected' ? (
                <button className="btn btn-primary" onClick={() => setStep('notifications')}>
                  Continue
                </button>
              ) : (
                <button className="btn btn-primary" onClick={handleConnectWhatsApp}>
                  Connect WhatsApp
                </button>
              )}
            </div>

            <div className="step-subactions">
              <button className="back-btn" onClick={() => setStep('apikey')}>
                Back
              </button>
              {waStatus !== 'connected' && (
                <button className="back-btn back-btn-link" onClick={() => setStep('notifications')}>
                  Skip for now
                </button>
              )}
            </div>
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
                  onClick={() => setRecording(false)}
                  title="Click to cancel"
                >
                  <div className="shortcut-recording-dot" />
                  <span>Press keys...</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="shortcut-keys shortcut-clickable"
                  onClick={() => setRecording(true)}
                  title="Click to change shortcut"
                >
                  {formatAccelerator(accelerator).split(' ').map((key, i, arr) => (
                    <React.Fragment key={i}>
                      <kbd className="kbd">{key}</kbd>
                      {i < arr.length - 1 && <span className="kbd-plus">+</span>}
                    </React.Fragment>
                  ))}
                </button>
              )}
            </div>

            <p className="shortcut-hint">
              Press the shortcut to try it.
            </p>

            <div className="apikey-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setRecording((r) => !r)}
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
          <NotificationsStep
            onContinue={() => setStep('shortcut')}
            onBack={() => setStep('whatsapp')}
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
