# Mandatory Directives — All Tracks

These are **non-negotiable constraints** for every track. Added 2026-04-16 by user directive after Wave 1 launched. If you are a track agent reading this, apply these to all work and revise existing work to comply.

---

## D1 — Test-Driven Development (TDD)

**Write tests BEFORE implementation. Always.**

- For every new function / module / component, a failing test exists first
- Commit (or stage) tests in the same change as the implementation, but tests were written first
- When a bug is found, write a failing test that reproduces it, then fix
- Unit tests use `vitest` (TS) or `pytest` (Python); E2E uses `@playwright/test` with `_electron.launch()`
- Minimum coverage expectations:
  - New TypeScript modules in `src/main/` or `src/shared/`: ≥80% line coverage
  - New Python modules under `python/agent/`: ≥80% line coverage
  - Renderer components: snapshot + at least one interaction test

**Why:** This project is multi-track parallel. Tests are the contract between tracks; without them, integration breaks silently.

---

## D2 — Verbose, LLM-friendly logging (DEV ONLY)

Logs must be **dense, structured, and useful to an LLM reading a failure transcript**. They are **dev-mode only** and must not ship in production builds.

### What to log

Every non-trivial function entry, state transition, and external call:

```ts
log.debug('TabManager.openTab', { url, position, totalTabs: tabs.size });
log.debug('TabManager.openTab.complete', { tabId, targetId, took_ms: duration });
log.warn('TabManager.openTab.retry', { url, attempt, lastError: err.message });
log.error('TabManager.openTab.failed', {
  url,
  error: err.message,
  stack: err.stack,
  state: { tabCount: tabs.size, activeTabId },
});
```

### Required shape

- **JSONL in files** (`.log` lines are JSON objects); **human-readable in console** (main process only)
- Every log entry includes: `timestamp` (ISO), `level`, `component` (dot-path like `TabManager.openTab`), `message`, `context` (object)
- Errors include `error.message`, `error.stack`, and the **surrounding state** an LLM would need to diagnose (e.g. tab count, current URL, relevant config)
- Never log secrets (API keys, tokens, cookies, user credentials) — scrub before logging

### Dev-only guardrail

All verbose logging must be **compiled out or gated** in production:

```ts
// src/main/logger.ts
const DEV = process.env.NODE_ENV !== 'production' || process.env.AGENTIC_DEV === '1';

export const log = {
  debug: DEV ? (comp: string, ctx: object) => emit('debug', comp, ctx) : () => {},
  info:  DEV ? (comp: string, ctx: object) => emit('info',  comp, ctx) : () => {},
  warn:  (comp: string, ctx: object) => emit('warn', comp, ctx),    // warn/error always on
  error: (comp: string, ctx: object) => emit('error', comp, ctx),
};
```

Python equivalent:

```python
# python/agent/logger.py
import os, json, sys, time
DEV = os.getenv("NODE_ENV") != "production" or os.getenv("AGENTIC_DEV") == "1"

def _emit(level: str, component: str, ctx: dict) -> None:
    entry = {"ts": time.time(), "level": level, "component": component, **ctx}
    sys.stderr.write(json.dumps(entry, default=str) + "\n")

def debug(component: str, **ctx) -> None:
    if DEV: _emit("debug", component, ctx)

def info(component: str, **ctx) -> None:
    if DEV: _emit("info", component, ctx)

def warn(component: str, **ctx) -> None:
    _emit("warn", component, ctx)

def error(component: str, **ctx) -> None:
    _emit("error", component, ctx)
```

**Only `warn` and `error` run in production.** `debug` and `info` are tree-shaken or no-op in prod.

### Log file rotation

Rotating logs land under `~/Library/Application Support/AgenticBrowser/logs/` — 10MB rotation, keep 5 files, JSONL. This is Track H's `logger.ts` contract; other tracks import and use it rather than rolling their own.

---

## D3 — Apply-to-existing directive

If your Wave 1 briefing did not include D1/D2 (they were added after launch):
1. Before reporting done, audit your code: do the new tests exist? Is logging gated by `DEV`?
2. If not, **fix before reporting** — revise implementation to be tests-first, add dev-only logging to all non-trivial entry points.

Tracks are responsible for their own files; cross-track fixes go in a handoff note.

---

## Quick reference

| Track | TDD surface | Logging hotspots |
|---|---|---|
| A | TabManager, SessionStore, URL parse, NavigationController | openTab / closeTab / switchTab / did-navigate / session save+load |
| B | pill.show/hide, hotkey register, IPC submit | Cmd+K → show timing, event stream subscribe, result render |
| C | OAuth flow, Keychain write/read, onboarding state machine | OAuth callback, scope modal interactions, token refresh |
| D | agent loop, exec_sandbox, budget, protocol | task_start, step_start, step_result, step_error, sandbox violations (log the AST that was rejected) |
| E | schema validate, socket client reconnect, event dispatch | every message send + receive, reconnect attempts with attempt# |
| F | build script, signing, notarize, updater | every shell command + exit code |
| G | (lighter — tokens/components rarely need logs) | theme switch events only |
| H | telemetry emit, logger itself, parity runner | every metric emission, every parity site (start + end + error count) |
