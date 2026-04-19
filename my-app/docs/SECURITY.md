# The Browser — Security Review

**Date:** 2026-04-17 (iter 17)
**Branch:** `feat/agent-wiring`
**Scope:** `src/main/`, `src/preload/`, `src/renderer/`, `forge.config.ts`, `python/agent_daemon/`

## Summary

| Severity | Count | Status        |
|----------|-------|---------------|
| Critical | 0     | —             |
| High     | 3     | Fixed iter 17 |
| Medium   | 5     | Tracked       |
| Low      | 4     | Tracked       |
| Info     | 3     | Positive      |

**Overall risk:** MEDIUM → LOW after iter 17 high-severity fixes.

## High-severity findings (fixed iter 17)

### H1 — `sandbox: false` on shell + pill windows
`src/main/window.ts:85`, `src/main/pill.ts:120`
Renderer compromise (e.g., XSS via tab title) could reach Node.js through preload.
**Fix:** set `sandbox: true` on both; verify preload still works (contextBridge is already used correctly).

### H2 — CSP `unsafe-eval` + `unsafe-inline` in all 4 renderers
`src/renderer/shell/shell.html:9`, `pill/pill.html:9`, `onboarding/onboarding.html:7`, `settings/settings.html:7`
`unsafe-eval` allows `eval()`/`new Function()`. Required for Vite HMR in dev ONLY.
**Fix:** strip both for production builds; nonce-inject in dev via Vite plugin.

### H3 — DevTools unconditionally opened in shell + onboarding
`src/main/window.ts:106`, `src/main/identity/onboardingWindow.ts:75`
Local attacker can inspect renderer, extract OAuth tokens, call any IPC handler.
**Fix:** gate behind `process.env.NODE_ENV !== 'production'` (same pattern used in `SettingsWindow.ts:104`).

## Medium-severity findings (tracked)

- **M1** — `daemonLifecycle.ts:144` spreads parent `process.env` to daemon child. Use explicit allowlist: `PATH`, `HOME`, `TMPDIR`, `DAEMON_SOCKET_PATH`, `ANTHROPIC_API_KEY`, `NODE_ENV`.
- **M2** — No IPC input validation anywhere. Add type/length guards: `pill:submit` prompt >10KB, `settings:save-api-key` length cap, `settings:set-theme` enum check.
- **M3** — `tabs:create` accepts any URL scheme; can load `javascript:`, `file:`, `data:`. Add scheme blocklist in `TabManager.createTab`.
- **M4** — OAuthClient decodes `id_token` JWT payload without signature verification (`OAuthClient.ts:320`). Defense-in-depth: use `jose` to verify against Google keys.
- **M5** — Overly permissive `connect-src 'self' ws: http: https:` in pill/onboarding/settings CSPs. Restrict to `api.anthropic.com` + `oauth2.googleapis.com`.

## Low-severity findings (tracked)

- **L1** — `GOOGLE_CLIENT_ID` falls back to `PLACEHOLDER_CLIENT_ID` — throw at startup in production instead.
- **L2** — Test IPCs gated on `DEV_MODE=1 || NODE_ENV=test`. Standardize to `NODE_ENV=test` only.
- **L3** — `npm audit`: 25 high in build tooling (`@electron-forge/*`, `tar`, `cacache`). Runtime deps clean. Wait for Forge upstream fix.
- **L4** — `getTaskLogger(taskId)` uses task ID as filename. Sanitize in `LoggerFactory.getLogger()` against `/`, `\\`, `..`, null bytes.

## Info (positive confirmations)

- **I1** — All 6 Electron fuses correctly set in `forge.config.ts:204-242` (RunAsNode=false, CookieEncryption=true, NodeOptions=false, NodeCliInspectArgs=false, AsarIntegrityValidation=true, OnlyLoadAppFromAsar=true).
- **I2** — No hardcoded secrets. `.env` gitignored at root + `my-app/`. API keys masked in all log paths.
- **I3** — Python sandbox: 109/109 tests pass (post-S2 RCE fix, path-traversal fix, thread-zombie DoS fix all present).

## Threat model

| Surface | Risk | Mitigation |
|---------|------|------------|
| Web content in shell tabs | High | Sandbox + strict CSP (H1 + H2 fixes) |
| Python daemon exec | Medium | AST inspection + subprocess + memory cap + timeout (already in place) |
| IPC surface | Medium | Input validation (M2 — tracked) |
| OAuth flow | Low | PKCE + state validation correct; JWT signature (M4) defense-in-depth |

## Out of scope

- LLM prompt injection risk in `python/agent_daemon/llm.py`
- macOS entitlements file audit (referenced, not present in repo)
- TLS pinning / certificate validation
- Electron autoupdater (not active yet)
- DAST / penetration testing
