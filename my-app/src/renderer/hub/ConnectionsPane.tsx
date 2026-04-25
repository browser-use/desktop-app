import React, { useEffect, useState, useCallback } from 'react';
import anthropicLogo from './anthropic-logo.svg';
import claudeCodeLogo from './claude-code-logo.svg';
import openaiLogo from './openai-logo.svg';
import codexLogo from './codex-logo.svg';

type WaStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error';
type AuthType = 'oauth' | 'apiKey' | 'none';
interface AuthStatus {
  type: AuthType;
  masked?: string;
  subscriptionType?: string | null;
  expiresAt?: number;
}
interface OpenAiStatus {
  present: boolean;
  masked?: string;
}
interface CodexStatus {
  installed: boolean;
  authed: boolean;
  version?: string;
  error?: string;
}

interface ConnectionsPaneProps {
  embedded?: boolean;
}

export function ConnectionsPane({ embedded }: ConnectionsPaneProps): React.ReactElement {
  const [waStatus, setWaStatus] = useState<WaStatus>('disconnected');
  const [waIdentity, setWaIdentity] = useState<string | null>(null);
  const [waDetail, setWaDetail] = useState<string | undefined>();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const [authStatus, setAuthStatus] = useState<AuthStatus>({ type: 'none' });
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState<{ available: boolean; subscriptionType?: string | null }>({ available: false });
  // True while we've spawned `claude auth login --claudeai` and are waiting
  // for the user to complete the OAuth in their browser. Drives the card's
  // 'Waiting for login…' subtitle + button-disabled state.
  const [claudeWaiting, setClaudeWaiting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [keyError, setKeyError] = useState<string | null>(null);

  const [openaiStatus, setOpenaiStatus] = useState<OpenAiStatus>({ present: false });
  const [openaiEditing, setOpenaiEditing] = useState(false);
  const [openaiDraft, setOpenaiDraft] = useState('');
  const [openaiKeyStatus, setOpenaiKeyStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [openaiError, setOpenaiError] = useState<string | null>(null);

  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ installed: false, authed: false });
  const [codexWaiting, setCodexWaiting] = useState(false);
  // Surfaced from the codex login PTY when --device-auth is in play. Drives
  // the small "one-time code" block below the Codex card so users on
  // restricted networks (no localhost-callback) can still sign in.
  const [codexDeviceCode, setCodexDeviceCode] = useState<string | null>(null);
  const [codexVerificationUrl, setCodexVerificationUrl] = useState<string | null>(null);

  const refreshKey = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.apiKey) return;
    const status = await api.settings.apiKey.getStatus();
    setAuthStatus(status);
    const cc = await api.settings.claudeCode?.available();
    if (cc) setClaudeCodeAvailable(cc);
  }, []);

  const refreshOpenai = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.openaiKey) return;
    try {
      const s = await api.settings.openaiKey.getStatus();
      setOpenaiStatus(s);
    } catch (err) {
      console.error('[connections] refreshOpenai failed', err);
    }
  }, []);

  const refreshCodex = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.codex) return;
    try {
      const s = await api.settings.codex.status();
      setCodexStatus({
        installed: s.installed.installed,
        authed: s.authed.authed,
        version: s.installed.version,
        error: s.installed.error ?? s.authed.error,
      });
    } catch (err) {
      console.error('[connections] refreshCodex failed', err);
    }
  }, []);

  const handleUseClaudeCode = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.claudeCode) return;
    setKeyError(null);
    // Two cases: (a) Claude CLI is already authed → just record the
    // mode preference; (b) it isn't → spawn `claude auth login --claudeai`,
    // let Claude open the browser, poll until creds appear, then record.
    try {
      const cc = await api.settings.claudeCode.available();
      if (cc.available) {
        await api.settings.claudeCode.use();
        await refreshKey();
        return;
      }
      if (!api.settings.claudeCode.login) {
        setKeyError('Login flow not available — run `claude auth login` in a terminal first.');
        return;
      }
      setClaudeWaiting(true);
      const res = await api.settings.claudeCode.login();
      if (!res.ok) {
        setClaudeWaiting(false);
        setKeyError(res.error ?? 'Failed to start Claude login');
      }
      // Browser is now open with the OAuth flow. Polling effect below
      // detects completion and flips claudeWaiting off.
    } catch (err) {
      setClaudeWaiting(false);
      setKeyError((err as Error).message);
    }
  }, [refreshKey]);

  // Poll while we're waiting for `claude auth login --claudeai` to complete.
  // 1s interval so the panel flips fast once auth.json appears in the CLI's
  // own keychain. Tighter than the global 5s panel refresh.
  useEffect(() => {
    if (!claudeWaiting) return;
    let cancelled = false;
    let attempts = 0;
    const MAX = 180; // 3 minutes
    const tick = async () => {
      if (cancelled) return;
      attempts++;
      const api = window.electronAPI;
      if (!api?.settings?.claudeCode) return;
      try {
        const cc = await api.settings.claudeCode.available();
        if (cc.available) {
          await api.settings.claudeCode.use();
          setClaudeWaiting(false);
          await refreshKey();
          return;
        }
      } catch (err) {
        console.warn('[connections] claude poll failed', err);
      }
      if (attempts >= MAX) { setClaudeWaiting(false); return; }
      setTimeout(tick, 1000);
    };
    void tick();
    return () => { cancelled = true; };
  }, [claudeWaiting, refreshKey]);

  useEffect(() => {
    refreshKey();
    refreshOpenai();
    refreshCodex();
  }, [refreshKey, refreshOpenai, refreshCodex]);

  // Periodic refresh while the pane is mounted — catches external state
  // changes (user runs `claude auth logout` in a terminal, codex token
  // expires server-side, etc.) so the panel never goes more than ~5s out
  // of sync with reality.
  useEffect(() => {
    const id = setInterval(() => {
      refreshKey();
      refreshOpenai();
      refreshCodex();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshKey, refreshOpenai, refreshCodex]);

  // Poll codex status while user completes the codex OAuth flow. Tighter
  // interval than the 5s panel refresh so the UI flips to "Signed in" the
  // second `~/.codex/auth.json` appears.
  useEffect(() => {
    if (!codexWaiting) return;
    let cancelled = false;
    let attempts = 0;
    const MAX = 180;
    const tick = async () => {
      if (cancelled) return;
      attempts++;
      await refreshCodex();
      if (codexStatus.authed) {
        setCodexWaiting(false);
        setCodexDeviceCode(null);
        setCodexVerificationUrl(null);
        return;
      }
      if (attempts >= MAX) { setCodexWaiting(false); return; }
      setTimeout(tick, 1000);
    };
    void tick();
    return () => { cancelled = true; };
  }, [codexWaiting, refreshCodex, codexStatus.authed]);

  const handleSaveOpenai = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.openaiKey) return;
    const trimmed = openaiDraft.trim();
    if (!trimmed) return;
    setOpenaiKeyStatus('testing');
    setOpenaiError(null);
    const test = await api.settings.openaiKey.test(trimmed);
    if (!test.success) {
      setOpenaiKeyStatus('error');
      setOpenaiError(test.error ?? 'Key rejected by OpenAI');
      return;
    }
    await api.settings.openaiKey.save(trimmed);
    setOpenaiKeyStatus('ok');
    setOpenaiDraft('');
    setOpenaiEditing(false);
    await refreshOpenai();
  }, [openaiDraft, refreshOpenai]);

  const handleDeleteOpenai = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.openaiKey) return;
    await api.settings.openaiKey.delete();
    setOpenaiKeyStatus('idle');
    setOpenaiError(null);
    await refreshOpenai();
  }, [refreshOpenai]);

  const handleCodexLogin = useCallback(async (opts?: { deviceAuth?: boolean }) => {
    const api = window.electronAPI;
    if (!api?.settings?.codex) return;
    setCodexWaiting(true);
    setCodexDeviceCode(null);
    setCodexVerificationUrl(null);
    const res = await api.settings.codex.login(opts);
    if (!res.opened) {
      console.warn('[connections] codex login failed', res.error);
      setCodexWaiting(false);
      return;
    }
    if (res.deviceCode) setCodexDeviceCode(res.deviceCode);
    if (res.verificationUrl) setCodexVerificationUrl(res.verificationUrl);
  }, []);
  // Stable callbacks for the Codex login buttons. Plain OAuth is the default;
  // device-auth is the "Having trouble?" fallback for users on networks/setups
  // where the localhost callback can't reach the browser.
  const handleCodexLoginPlain = useCallback(() => handleCodexLogin(), [handleCodexLogin]);
  const handleCodexLoginDeviceAuth = useCallback(() => handleCodexLogin({ deviceAuth: true }), [handleCodexLogin]);

  const handleCodexLogout = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.codex?.logout) return;
    // codex logout is now a non-interactive subprocess (codex logout writes
    // to ~/.codex/auth.json then exits); no Terminal involvement. Refresh
    // immediately, no polling needed.
    const res = await api.settings.codex.logout();
    if (!res.opened) console.warn('[connections] codex logout failed', res.error);
    setCodexDeviceCode(null);
    setCodexVerificationUrl(null);
    await refreshCodex();
  }, [refreshCodex]);

  const handleSaveKey = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.apiKey) return;
    const trimmed = draftKey.trim();
    if (!trimmed) return;
    setKeyStatus('testing');
    setKeyError(null);
    const test = await api.settings.apiKey.test(trimmed);
    if (!test.success) {
      setKeyStatus('error');
      setKeyError(test.error ?? 'Key rejected by Anthropic');
      return;
    }
    await api.settings.apiKey.save(trimmed);
    setKeyStatus('ok');
    setDraftKey('');
    setEditing(false);
    await refreshKey();
  }, [draftKey, refreshKey]);

  const handleDeleteKey = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.settings?.apiKey) return;
    // If user signed in via Claude OAuth, also run `claude logout` in Terminal
    // so the CLI's own keychain entry is cleared — otherwise the next run
    // silently reuses the CLI's stored creds.
    if (authStatus.type === 'oauth' && api.settings.claudeCode?.logout) {
      await api.settings.claudeCode.logout();
    } else {
      await api.settings.apiKey.delete();
    }
    setKeyStatus('idle');
    setKeyError(null);
    await refreshKey();
  }, [authStatus.type, refreshKey]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.channels?.whatsapp.status().then((res) => {
      setWaStatus(res.status as WaStatus);
      setWaIdentity(res.identity);
    }).catch(() => {});

    const unsubStatus = api.on?.channelStatus?.((channelId, status, detail) => {
      if (channelId !== 'whatsapp') return;
      setWaStatus(status as WaStatus);
      setWaDetail(detail);
      if (status === 'connected' && detail) {
        setWaIdentity(detail);
        setQrDataUrl(null);
      }
      if (status === 'disconnected' || status === 'error') {
        setQrDataUrl(null);
      }
    });

    const unsubQr = api.on?.whatsappQr?.((dataUrl) => {
      setQrDataUrl(dataUrl);
    });

    return () => {
      unsubStatus?.();
      unsubQr?.();
    };
  }, []);

  const handleConnect = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    setQrDataUrl(null);
    await api.channels.whatsapp.connect();
  }, []);

  const handleDisconnect = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    await api.channels.whatsapp.clearAuth();
    setWaIdentity(null);
    setQrDataUrl(null);
  }, []);

  const handleCancel = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    await api.channels.whatsapp.disconnect();
    setQrDataUrl(null);
  }, []);

  const statusDotClass =
    waStatus === 'connected' ? 'conn-card__dot--connected' :
    waStatus === 'connecting' || waStatus === 'qr_ready' ? 'conn-card__dot--connecting' :
    waStatus === 'error' ? 'conn-card__dot--error' :
    'conn-card__dot--disconnected';

  const statusText =
    waStatus === 'connected' ? `Connected as ${waIdentity ?? 'unknown'}` :
    waStatus === 'connecting' ? 'Connecting...' :
    waStatus === 'qr_ready' ? 'Waiting for scan...' :
    waStatus === 'error' ? (waDetail ?? 'Connection error') :
    'Not connected';

  return (
    <div className={embedded ? 'conn-section' : 'conn-pane'}>
      {!embedded && <span className="conn-pane__title">Connections</span>}

      <div className="conn-card">
        <div className="conn-card__header">
          <img
            className="conn-card__icon"
            src={authStatus.type === 'oauth' ? claudeCodeLogo : anthropicLogo}
            alt=""
          />
          <div className="conn-card__info">
            <div className="conn-card__title-row">
              <span className="conn-card__name">Anthropic</span>
              <span className={`conn-card__dot ${authStatus.type !== 'none' ? 'conn-card__dot--connected' : 'conn-card__dot--disconnected'}`} />
            </div>
            <span className="conn-card__subtitle">
              {editing
                ? 'Enter a new key — it will be tested before saving'
                : claudeWaiting
                ? 'Finish the OAuth flow in your browser…'
                : authStatus.type === 'oauth'
                ? `Signed in with Claude ${authStatus.subscriptionType === 'max' ? 'Max' : authStatus.subscriptionType === 'pro' ? 'Pro' : 'subscription'}`
                : authStatus.type === 'apiKey' && authStatus.masked
                ? `API key · ${authStatus.masked}`
                : 'Not connected'}
            </span>
          </div>
          <div className="conn-card__actions">
            {!editing && authStatus.type === 'none' && (
              <button
                className="conn-card__btn conn-card__btn--primary"
                onClick={handleUseClaudeCode}
                disabled={claudeWaiting}
              >
                {claudeWaiting ? 'Waiting…' : 'Sign in with Claude'}
              </button>
            )}
            {!editing && authStatus.type === 'none' && (
              <button
                className="conn-card__btn conn-card__btn--secondary"
                onClick={() => { setEditing(true); setDraftKey(''); setKeyStatus('idle'); setKeyError(null); }}
              >
                Add API key
              </button>
            )}
            {!editing && authStatus.type === 'apiKey' && (
              <button
                className="conn-card__btn conn-card__btn--primary"
                onClick={() => { setEditing(true); setDraftKey(''); setKeyStatus('idle'); setKeyError(null); }}
              >
                Change
              </button>
            )}
            {!editing && authStatus.type !== 'none' && (
              <button className="conn-card__btn conn-card__btn--secondary" onClick={handleDeleteKey}>
                Sign out
              </button>
            )}
            {editing && (
              <button
                className="conn-card__btn conn-card__btn--secondary"
                onClick={() => { setEditing(false); setDraftKey(''); setKeyError(null); setKeyStatus('idle'); }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        {editing && (
          <div className="conn-card__api-key-edit">
            <input
              type="password"
              className="conn-card__api-key-input"
              placeholder="sk-ant-..."
              value={draftKey}
              onChange={(e) => { setDraftKey(e.target.value); setKeyStatus('idle'); setKeyError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
              autoFocus
            />
            <button
              className="conn-card__btn conn-card__btn--primary"
              onClick={handleSaveKey}
              disabled={!draftKey.trim() || keyStatus === 'testing'}
            >
              {keyStatus === 'testing' ? 'Testing...' : 'Save'}
            </button>
            {keyStatus === 'error' && keyError && (
              <span className="conn-card__api-key-error">{keyError}</span>
            )}
          </div>
        )}
      </div>

      <div className="conn-card">
        <div className="conn-card__header">
          <img
            className="conn-card__icon"
            src={codexStatus.authed ? codexLogo : openaiLogo}
            alt=""
          />
          <div className="conn-card__info">
            <div className="conn-card__title-row">
              <span className="conn-card__name">OpenAI</span>
              <span className={`conn-card__dot ${codexStatus.authed || openaiStatus.present ? 'conn-card__dot--connected' : codexWaiting ? 'conn-card__dot--connecting' : 'conn-card__dot--disconnected'}`} />
            </div>
            <span className="conn-card__subtitle">
              {openaiEditing
                ? 'Enter a new key — it will be tested before saving'
                : codexStatus.authed
                ? `Signed in with Codex${codexStatus.version ? ` · v${codexStatus.version}` : ''}`
                : codexWaiting && codexDeviceCode
                ? 'Enter the code shown below on the verification page.'
                : codexWaiting
                ? 'Finish the OAuth flow in your browser…'
                : openaiStatus.present && openaiStatus.masked
                ? `API key · ${openaiStatus.masked}`
                : 'Not connected'}
            </span>
          </div>
          <div className="conn-card__actions">
            {!openaiEditing && codexStatus.authed && (
              <button className="conn-card__btn conn-card__btn--secondary" onClick={handleCodexLogout}>
                Sign out
              </button>
            )}
            {!openaiEditing && !openaiStatus.present && !codexStatus.authed && codexStatus.installed && (
              <button
                className="conn-card__btn conn-card__btn--primary"
                onClick={handleCodexLoginPlain}
              >
                {codexWaiting ? 'Restart' : 'Sign in with Codex'}
              </button>
            )}
            {!openaiEditing && !openaiStatus.present && !codexStatus.authed && (
              <button
                className="conn-card__btn conn-card__btn--secondary"
                onClick={() => { setOpenaiEditing(true); setOpenaiDraft(''); setOpenaiKeyStatus('idle'); setOpenaiError(null); }}
              >
                Add API key
              </button>
            )}
            {!openaiEditing && openaiStatus.present && (
              <button
                className="conn-card__btn conn-card__btn--primary"
                onClick={() => { setOpenaiEditing(true); setOpenaiDraft(''); setOpenaiKeyStatus('idle'); setOpenaiError(null); }}
              >
                Change
              </button>
            )}
            {!openaiEditing && openaiStatus.present && (
              <button className="conn-card__btn conn-card__btn--secondary" onClick={handleDeleteOpenai}>
                Sign out
              </button>
            )}
            {openaiEditing && (
              <button
                className="conn-card__btn conn-card__btn--secondary"
                onClick={() => { setOpenaiEditing(false); setOpenaiDraft(''); setOpenaiError(null); setOpenaiKeyStatus('idle'); }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        {codexDeviceCode && (
          <div className="codex-device-auth">
            <div className="codex-device-auth__label">One-time code</div>
            <div className="codex-device-auth__code">{codexDeviceCode}</div>
            {codexVerificationUrl && (
              <div className="codex-device-auth__hint">
                Verification page should have opened automatically.{' '}
                If not, navigate to{' '}
                <span className="codex-device-auth__url">{codexVerificationUrl}</span>{' '}
                and enter the code above.
              </div>
            )}
          </div>
        )}
        {/* Remote/headless fallback. Mirrors the onboarding affordance —
            ChatGPT accounts need 'Enable device code authorization' in
            Security Settings for this path to work server-side. */}
        {!openaiEditing && !openaiStatus.present && !codexStatus.authed && codexStatus.installed && !codexDeviceCode && (
          <button
            type="button"
            className="codex-device-auth__link codex-device-auth__link--secondary codex-device-auth__fallback"
            onClick={handleCodexLoginDeviceAuth}
          >
            Having trouble? Use device code flow instead
          </button>
        )}
        {openaiEditing && (
          <div className="conn-card__api-key-edit">
            <input
              type="password"
              className="conn-card__api-key-input"
              placeholder="sk-..."
              value={openaiDraft}
              onChange={(e) => { setOpenaiDraft(e.target.value); setOpenaiKeyStatus('idle'); setOpenaiError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveOpenai(); }}
              autoFocus
            />
            <button
              className="conn-card__btn conn-card__btn--primary"
              onClick={handleSaveOpenai}
              disabled={!openaiDraft.trim() || openaiKeyStatus === 'testing'}
            >
              {openaiKeyStatus === 'testing' ? 'Testing...' : 'Save'}
            </button>
            {openaiKeyStatus === 'error' && openaiError && (
              <span className="conn-card__api-key-error">{openaiError}</span>
            )}
          </div>
        )}
      </div>

      <div className="conn-card">
        <div className="conn-card__header">
          <img
            className="conn-card__icon"
            src="https://static.whatsapp.net/rsrc.php/v3/yP/r/rYZqPCBaG70.png"
            alt=""
          />
          <div className="conn-card__info">
            <div className="conn-card__title-row">
              <span className="conn-card__name">WhatsApp</span>
              <span className={`conn-card__dot ${statusDotClass}`} />
            </div>
            <span className="conn-card__subtitle">
              {waStatus === 'connected' && waIdentity
                ? `Connected as +${waIdentity.replace(/(\d{1})(\d{3})(\d{3})(\d{4})/, '$1 ($2) $3-$4')} — text yourself to start sessions and receive agent notifications in WhatsApp.`
                : waStatus === 'disconnected'
                ? 'Connect WhatsApp to auto-configure self-chat task starts and agent notifications.'
                : statusText}
            </span>
          </div>
          <div className="conn-card__actions">
            {waStatus === 'disconnected' && (
              <button className="conn-card__btn conn-card__btn--primary" onClick={handleConnect}>
                Connect
              </button>
            )}
            {(waStatus === 'qr_ready' || waStatus === 'connecting') && (
              <button className="conn-card__btn conn-card__btn--secondary" onClick={handleCancel}>
                Cancel
              </button>
            )}
            {waStatus === 'connected' && (
              <button className="conn-card__btn conn-card__btn--secondary" onClick={handleDisconnect}>
                Disconnect
              </button>
            )}
            {waStatus === 'error' && (
              <button className="conn-card__btn conn-card__btn--primary" onClick={handleConnect}>
                Reconnect
              </button>
            )}
          </div>
        </div>

        {(waStatus === 'qr_ready' || qrDataUrl) && (
          <div className="conn-card__qr">
            {qrDataUrl ? (
              <img
                className="conn-card__qr-img"
                src={qrDataUrl}
                alt="WhatsApp QR code"
              />
            ) : (
              <div className="conn-card__qr-loading">Generating QR...</div>
            )}
            <p className="conn-card__qr-hint">
              Open WhatsApp on your phone, go to Linked Devices, and scan this code. After linking, texting yourself will start sessions and notifications will come back to the same chat.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ConnectionsPane;
