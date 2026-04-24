/**
 * Cross-platform Codex login driver.
 *
 * Default: plain `codex login` — opens a localhost callback server and prints
 * an auth.openai.com/oauth/authorize URL. Matches the Claude Code flow and
 * does NOT require the account-level "Enable device code authorization"
 * toggle in ChatGPT Security Settings. `codex login --device-auth` is the
 * remote/headless fallback and is gated on that toggle.
 *
 * Both variants need a TTY — plain `child_process.spawn` yields zero bytes —
 * so we go through node-pty either way. The URL is parsed from stdout and
 * handed to `shell.openExternal`; when `--device-auth` is in play we also
 * capture the XXXX-XXXXX one-time code.
 *
 * Replaces the previous macOS-only `osascript → Terminal.app` flow.
 */

import { shell } from 'electron';
import * as pty from 'node-pty';
import { mainLogger } from '../logger';
import { enrichedEnv } from '../hl/engines/pathEnrich';

const LOGIN_BIN = 'codex';
const TIMEOUT_MS = 15 * 60 * 1000;   // Device-auth codes expire in 15m; cap plain-OAuth at the same.
const PARSE_BUDGET_MS = 15_000;       // Fail fast if no URL surfaces in 15s.

export interface CodexLoginOptions {
  /** Force the `--device-auth` fallback (remote/headless). Off by default —
   *  plain OAuth is simpler for desktop and doesn't require the ChatGPT
   *  security-settings toggle. */
  deviceAuth?: boolean;
}

// ANSI-stripping regex — codex emits coloured output even under a pty.
// Matches CSI sequences and the OSC-8 hyperlink wrappers codex sometimes uses.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^\x07]*\x07/g;

// Device-verification URL and XXXX-XXXX code extraction. Both patterns are
// matched after ANSI is stripped so colour codes don't confuse the regex.
const URL_RE = /https:\/\/auth\.openai\.com\/[^\s]+/;
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/;

export interface CodexLoginResult {
  opened: boolean;
  error?: string;
  /** Device verification URL — caller should display it and/or open in browser. */
  verificationUrl?: string;
  /** One-time code the user pastes into the verification page. */
  deviceCode?: string;
}

// Only one login attempt at a time. A second call kills the previous PTY
// (user clicked "login" twice or restarted the flow) before spawning again.
let activePty: pty.IPty | null = null;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function killActiveCodexLogin(): void {
  if (activePty) {
    try { activePty.kill(); } catch { /* already dead */ }
    activePty = null;
    mainLogger.info('codexLogin.killed');
  }
}

/**
 * Spawn `codex login` (or `codex login --device-auth` when requested) and
 * extract the verification URL from stdout, plus the XXXX-XXXXX code when in
 * device-auth mode. Resolves as soon as the URL is parsed — the PTY process
 * stays alive in the background, polling OpenAI; its success is observed
 * separately by probing `~/.codex/auth.json`.
 */
export function runCodexDeviceLogin(opts: CodexLoginOptions = {}): Promise<CodexLoginResult> {
  killActiveCodexLogin();

  const args = opts.deviceAuth ? ['login', '--device-auth'] : ['login'];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CodexLoginResult) => {
      if (!settled) { settled = true; resolve(r); }
    };

    let child: pty.IPty;
    try {
      child = pty.spawn(LOGIN_BIN, args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        env: enrichedEnv() as { [k: string]: string },
      });
    } catch (err) {
      mainLogger.warn('codexLogin.spawnFailed', { error: (err as Error).message });
      finish({ opened: false, error: `pty spawn failed: ${(err as Error).message}` });
      return;
    }

    activePty = child;
    mainLogger.info('codexLogin.spawned', { pid: child.pid });

    let buf = '';
    let foundUrl: string | undefined;
    let foundCode: string | undefined;

    child.onData((chunk) => {
      buf = (buf + chunk).slice(-8192);   // Cap tail buffer; ANSI is verbose.
      const clean = stripAnsi(buf);

      if (!foundUrl) {
        const m = clean.match(URL_RE);
        if (m) {
          foundUrl = m[0];
          mainLogger.info('codexLogin.urlFound', { url: foundUrl });
        }
      }
      if (!foundCode) {
        const m = clean.match(CODE_RE);
        if (m) {
          foundCode = m[1];
          mainLogger.info('codexLogin.codeFound', { code: foundCode });
        }
      }

      // Device-auth mode needs both URL and code; plain OAuth only needs the
      // URL (the CLI runs a localhost callback server on :1455 to capture
      // the redirect, no user-typed code required).
      const ready = opts.deviceAuth ? Boolean(foundUrl && foundCode) : Boolean(foundUrl);
      if (ready && !settled) {
        // Open the verification page in the user's default browser. If this
        // fails (no browser, headless CI, etc.) we still return the URL so
        // the renderer can show a copyable link.
        shell.openExternal(foundUrl!).catch((err) => {
          mainLogger.warn('codexLogin.openExternalFailed', { error: (err as Error).message });
        });
        finish({ opened: true, verificationUrl: foundUrl, deviceCode: foundCode });
      }
    });

    child.onExit(({ exitCode, signal }) => {
      mainLogger.info('codexLogin.exit', {
        exitCode,
        signal,
        tail: stripAnsi(buf).slice(-400),
      });
      if (activePty === child) activePty = null;
      if (!settled) {
        // Exited before surfacing the code — propagate whatever stderr-ish
        // text we captured so the user sees a useful hint.
        finish({
          opened: false,
          error: stripAnsi(buf).trim().slice(-400) || `codex login exited ${exitCode}`,
        });
      }
    });

    // Hard timeout for the parse phase — if neither URL nor code appears
    // in PARSE_BUDGET_MS we abort, otherwise we'd hang the UI indefinitely.
    setTimeout(() => {
      if (!settled) {
        mainLogger.warn('codexLogin.parseTimeout', { tail: stripAnsi(buf).slice(-400) });
        try { child.kill(); } catch { /* already dead */ }
        finish({ opened: false, error: 'codex login did not emit a verification URL' });
      }
    }, PARSE_BUDGET_MS).unref();

    // Outer safety net — if codex keeps polling past the 15-min code-expiry
    // window, reap the process so we don't leak a zombie subprocess.
    setTimeout(() => {
      if (activePty === child) {
        mainLogger.warn('codexLogin.expired', { pid: child.pid });
        try { child.kill(); } catch { /* already dead */ }
        activePty = null;
      }
    }, TIMEOUT_MS).unref();
  });
}
