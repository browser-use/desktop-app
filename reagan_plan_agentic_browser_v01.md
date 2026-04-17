# Agentic Browser v0.1 — Work Plan

**Status:** Revised draft (post Architect + Critic review, awaiting user approval)
**Owner:** Reagan Hsu
**Date:** 2026-04-16
**Mode:** RALPLAN-DR deliberate
**Revision:** 1 (incorporates Architect + Critic feedback + 8-track parallel factoring)

---

## 1. Executive Summary

Build a macOS-only Chromium-based desktop browser in Electron with a Cmd+K pill (Wispr-style one-shot) that dispatches tasks to a bundled Python agent (harnessless + RL'd Python model). v0.1 is functional-first: Chrome-emulating tab strip with favicons and loading states, Cmd+K pill, agent acts on the active tab only, character-forward onboarding with Google OAuth.

The plan is factored into **8 parallel tracks** (A–H) with disjoint file ownership so ~8 agents can execute concurrently after Track E (IPC/Protocol) lands the shared schemas in week 1.

**Target ship window:** 8–10 weeks to first signed+notarized external build (estimation honestly revised after Critic pass — original 4–6-week target was aspirational).

---

## 2. Locked Scope Decisions

| # | Decision | Value | Rationale |
|---|---|---|---|
| 1 | MVP scope | Agent-first minimal Chrome-emulating browser + onboarding | Validate agent+pill UX + user acquisition funnel |
| 2 | Integration | Option A — bundled Python daemon (PyInstaller) | RL'd model emits Python; harnessless self-edit pattern is Python-native |
| 3 | Tab model | Chrome-style horizontal tabs (favicons, loading, drag, close) | Lowest design risk, users expect Chrome |
| 4 | Pill hotkey | Cmd+K | Decided |
| 5 | Pill UX | One-shot Wispr-style, text-only | Simplest agent loop; voice v0.2 |
| 6 | Agent scope (v0.1) | Active tab only, enforced by per-target CDP WS URL | Transport-level enforcement, not advisory |
| 7 | Platforms | macOS only (Intel + Apple Silicon) | Halves packaging/signing work |
| 8 | State persistence | Session restore + cookies/cache | Chrome parity |
| 9 | Aesthetic — main shell | Linear + Obsidian (dense, dark, keyboard-first) | Agent-forward productivity feel |
| 10 | Aesthetic — onboarding | Warm character-forward (mascot, pastel capability pills, naming flow) | Approachable user acquisition; ref screenshots in `/Users/reagan/Desktop/CleanShot 2026-04-16 at 23.16.58@2x.png` and `23.18.16@2x.png` |
| 11 | Onboarding | Welcome → character naming → account creation → Google OAuth (Gmail, Calendar, Sheets, Drive, Docs) → first-task prompt | User-driven product inclusion |
| 12 | Deferred to v0.2+ | Extensions, drawer/Dynamic-Island, voice, bookmarks UI, Windows/Linux, multi-tab agent spawning, Cmd+Shift+T undo-close | Focus v0.1 |
| 13 | Electron | v41.2.1 pinned; bump minor within 7 days of High/Critical Chromium advisory | Security cadence |
| 14 | Packaging | Electron Forge (not electron-builder); commit to single toolchain | Consistency with existing `forge.config.ts` |
| 15 | Font | NOT Inter (user constraint); use Söhne or Geist for UI, Berkeley Mono or JetBrains Mono for code/URL bar | User CLAUDE.md directive |

---

## 3. RALPLAN-DR Summary

### 3.1 Principles

1. **CDP is the universal interface.** All agent↔browser traffic flows through Chrome DevTools Protocol. No Electron-specific agent APIs. Keeps the agent layer portable to a future Chromium fork.
2. **Functional before beautiful.** v0.1 ships correct-and-plain for the main shell; onboarding gets first-impression polish. Linear+Obsidian visual pass on the shell is a v0.2 milestone.
3. **Python is load-bearing, not incidental.** RL'd agent emits Python; harnessless self-editing is Python-native. Bundling Python is a product requirement.
4. **Agents only act on what the user sees, enforced at the transport layer.** The daemon connects to the per-target CDP WebSocket URL (`ws://host:port/devtools/page/{targetId}`) — not the browser-level endpoint. Attempts to spawn/drive other tabs are impossible at the protocol layer, not just "forbidden by convention."
5. **Prefer well-trodden paths over clever ones.** Electron Forge, WebContentsView, `utilityProcess`, `@electron-forge/maker-dmg`, `@electron/notarize`, `electron-updater` feed or Squirrel.Mac — all battle-tested. Save novelty budget for agent UX.
6. **Parallel-first factoring.** File/module ownership is disjoint per track so agents execute concurrently. Shared surfaces (IPC schemas, design tokens) are locked before fan-out.

### 3.2 Decision Drivers (top 3)

1. **Agent must speak Python end-to-end** (model → daemon → harnessless) — non-negotiable.
2. **Shippable install for non-technical users** — signed, notarized, auto-updating .dmg. No Python onboarding visible to user.
3. **Maximize parallel throughput** — with ~8 agents available, factoring must minimize merge conflicts and unblock fan-out by end of week 1.

### 3.3 Viable Options (evaluated)

**Option A — Bundled Python daemon via Electron `utilityProcess` + PyInstaller (CHOSEN, revised)**
- Pros: RL'd Python native; harnessless reused; CDP-pure; `utilityProcess` is the Electron-sanctioned way to spawn child processes (works with `RunAsNode: false` fuse); asarUnpack places the PyInstaller binary correctly outside the asar archive.
- Cons: +30–40MB install; nested binary signing complexity; two-process lifecycle mgmt; dual-arch PyInstaller requires two CI runners (no cross-compile).
- Why chosen: only option that preserves the Python agent stack AND meets Electron's security fuse constraints.

**Option A-alt — Re-enable `RunAsNode: true` + plain `child_process.spawn` (REJECTED)**
- Pros: simpler spawn code.
- Cons: `RunAsNode: false` is a deliberate hardening fuse (prevents ELECTRON_RUN_AS_NODE execution arbitrary code path); re-enabling expands attack surface.
- Why rejected: `utilityProcess` achieves the same outcome without weakening the security posture.

**Option B — TypeScript orchestration + per-step Python `exec()` (REJECTED with fairer framing)**
- Pros: single long-running runtime; per-step Python subprocess spawns the RL'd model's output without a persistent daemon; simpler dev loop.
- Cons: Per-step spawn cost (~200–500ms × every step); loses harnessless's persistent CDP WebSocket advantage; duplicates the agent loop into TS; loses the "helpers-as-live-doc" Python idiom.
- Why rejected: the per-step spawn penalty compounds across a 10-step task (2–5s added latency vs persistent daemon); and the agent loop logic duplicated in TS is a second implementation to maintain. Steelman acknowledged — this is a real option, just net-worse than A.

**Option C — External daemon (dev only) (PARTIALLY ADOPTED)**
- Adopted as the primary dev workflow (fast iteration on Python without PyInstaller rebuild). Prod uses bundled. WS-9 (DevEx) makes this explicit.

**Option D — Chromium fork (DEFERRED)**
- Same rejection as v0.0 draft. Re-evaluate at v0.4+ if Electron's ceiling (extension coverage, CDP version drift, DRM) becomes a blocker.

---

## 4. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Agentic Browser.app (~180MB signed + notarized .dmg, Forge-built)   │
│                                                                      │
│  ┌─────────────────────┐    utilityProcess   ┌─────────────────────┐ │
│  │  Electron main (TS) │ ───spawn(daemon)──▶ │  PyInstaller        │ │
│  │                     │                     │  agent_daemon       │ │
│  │  - window mgmt      │ ◀── unix socket ──  │  (asarUnpack        │ │
│  │  - tab state        │   /daemon-{pid}.sock│   Resources/)       │ │
│  │  - IPC hub          │                     │  - harnessless      │ │
│  │  - session store    │                     │  - agent loop       │ │
│  │  - global hotkey    │                     │  - LLM client       │ │
│  │  - Keychain + OAuth │                     │                     │ │
│  │  - updater          │                     │                     │ │
│  └──────────┬──────────┘                     └──────────┬──────────┘ │
│             │                                           │            │
│             │ --remote-debugging-port=0 (OS-assigned)   │            │
│             │ port discovered via /json/version          │            │
│             │                                           │            │
│             ▼                                           ▼            │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Chromium (one WebContentsView per user tab)                   │  │
│  │  - renders pages                                               │  │
│  │  - exposes CDP per-target: ws://host:port/devtools/page/{tid}  │  │
│  │  - daemon attaches ONLY to the active tab's per-target URL     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Renderers (Vite + React, one per surface):                          │
│  ┌─────────────────┐ ┌────────────┐ ┌────────────────────────────┐   │
│  │ shell           │ │ pill       │ │ onboarding                 │   │
│  │ (tabs, URL bar, │ │ (Cmd+K)    │ │ (welcome, naming, OAuth)   │   │
│  │  nav)           │ │            │ │                            │   │
│  └─────────────────┘ └────────────┘ └────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Key invariants:**
- Electron main owns: BrowserWindows, WebContentsViews, tab state, session, global hotkey, daemon lifecycle, IPC routing, Keychain, OAuth token storage, auto-update.
- Python daemon owns: CDP connection (per-target), agent loop, harnessless helpers (locked in prod), LLM client, event stream.
- Renderers own: UI only (shell / pill / onboarding).
- IPC boundaries: renderer ↔ main = Electron `ipcMain`/`contextBridge`; main ↔ daemon = Unix socket (JSON-line, push-based events); daemon ↔ Chromium = CDP WS (per-target).

**Changes from revision 0 (driven by Architect + Critic findings):**
- `child_process` → `utilityProcess` (fuse-safe)
- Port 9222 → OS-assigned port discovered via `/json/version`
- Socket path includes PID: `${userData}/daemon-${pid}.sock`
- Daemon attaches to **per-target** CDP WS URL (active-tab enforcement at transport)
- PyInstaller binary goes in `extraResource` with `asarUnpack` directive
- Dropped BrowserView fallback (deprecated in Electron 30+; null in v41)
- Committed to Electron Forge toolchain; removed electron-builder references
- Event stream is **push** (daemon writes to socket as events occur) not pull

---

## 5. Parallel Track Breakdown

Eight tracks, disjoint file ownership. Track E lands first (days 1–3) so schemas unblock A/B/C/D/H. F starts in parallel with E (fuse audit + signing prototype is week-1 critical).

### Track A — Browser Chrome
**Scope:** Tab system (WebContentsView per tab), tab strip UI (favicons, loading, drag, close, new-tab), URL bar (+ search fallback), navigation buttons (back/forward/reload), window chrome, session restore, window-bounds persistence, Cmd+T / Cmd+W / Cmd+L / Cmd+1..9.

**Files owned:**
```
src/main/window.ts
src/main/tabs/
  TabManager.ts
  SessionStore.ts
  NavigationController.ts
src/main/navigation.ts
src/renderer/shell/
  TabStrip.tsx
  URLBar.tsx
  NavButtons.tsx
  WindowChrome.tsx
  index.tsx
src/preload/shell.ts
```

**Depends on:** E (IPC schemas for tab state events).

**Exposes (for other tracks):** `window-ready`, `tab-activated` events on Electron IPC; an active-tab-target-id getter via preload.

**Acceptance criteria (testable):**
1. Launch app → `BrowserWindow` appears at `userData/window-bounds.json` coords (or reasonable default on first run). Measured by reading the JSON, bouncing the app, reading again, diffing.
2. Open 20 tabs, no crash. Tab strip renders all 20 with correct title/favicon within 2s of `page-title-updated`/`page-favicon-updated` events. Measured by Playwright-Electron E2E counting DOM tab elements + asserting favicon src matches.
3. Drag tab #3 to position #1 → order reflected in DOM + persisted to `session.json` on next quit. Measured by automated drag event + file diff.
4. Cmd+T / Cmd+W / Cmd+L / Cmd+1..9 each fire their handlers (verified by IPC event assertion).
5. Quit with 5 tabs → relaunch → exactly the same 5 tabs appear with correct titles, URLs, and per-tab back/forward history.
6. URL bar: typing `github.com` → navigates to `https://github.com` within 3s. Typing `how to make sourdough` → navigates to `https://www.google.com/search?q=how+to+make+sourdough`. Padlock shows `secure` icon for https, `warning` for http.

**Risks for this track:** WebContentsView rough edges around focus, context menus, find-in-page. Owner files upstream bugs; pins Electron version if blocking.

---

### Track B — Agent UX (Pill)
**Scope:** Global Cmd+K hotkey, transparent frameless `BrowserWindow` overlay, text input with autofocus, Enter to submit, Esc to dismiss, progress toast during agent work, final result display, toggle behavior on repeat Cmd+K. Drawer / Dynamic-Island **deferred to v0.2** — spec the interface in this track but don't build.

**Files owned:**
```
src/main/pill.ts
src/main/hotkeys.ts
src/renderer/pill/
  Pill.tsx
  PillInput.tsx
  ProgressToast.tsx
  ResultDisplay.tsx
  index.tsx
src/preload/pill.ts
src/main/presence.ts       // stub; Dynamic-Island v0.2
```

**Depends on:** E (agent_task / event schemas), G (design tokens).

**Exposes:** nothing external — pill is a terminal UX.

**Acceptance criteria (testable):**
1. Cmd+K anywhere in the app → pill `BrowserWindow.show()` called within **100ms**, measured as `performance.now()` delta from `globalShortcut` callback entry to `show()` call, logged in main process.
2. Typed prompt + Enter → `agent_task` message appears in daemon log within 200ms of keypress (verified by grepping log).
3. During an agent run: pill UI shows at least two intermediate `step_*` events as toast text updates (verified by E2E capturing DOM text at 500ms intervals).
4. On `task_done`: result text displayed; pill auto-dismisses after 5s (configurable) or on Esc.
5. On `task_failed` / `target_lost`: pill shows specific error copy ("Tab was closed — task cancelled" for `target_lost`; "Agent couldn't finish — see logs" for `task_failed`).
6. Second Cmd+K while pill is open → pill dismisses (toggle).
7. Cmd+K during an active agent run → queues the new prompt (NOT interrupts — v0.2 will add interrupt).

---

### Track C — Onboarding & Identity
**Scope:** First-launch welcome flow (character intro, capability pills, naming), account creation (email/password + Google OAuth), Google services permission modal (Gmail / Calendar / Sheets / Drive / Docs scope checkboxes), token storage in macOS Keychain, refresh flow. References screenshots at `/Users/reagan/Desktop/CleanShot 2026-04-16 at 23.16.58@2x.png` and `23.18.16@2x.png`.

**Files owned:**
```
src/main/identity/
  OAuthClient.ts
  KeychainStore.ts
  AccountStore.ts
src/main/oauth.ts
src/renderer/onboarding/
  Welcome.tsx          // screen 1: "I'm your Companion"
  NamingFlow.tsx       // pick a name for the agent
  CapabilitiesGrid.tsx // research/sourcing/scraping/etc pills
  AccountCreation.tsx  // email+password or Continue with Google
  GoogleScopesModal.tsx// Gmail/Calendar/Sheets/Drive/Docs checkboxes
  CharacterMascot.tsx  // mascot render + animations
  StepIndicator.tsx    // 1/5 dots at top
  index.tsx
src/preload/onboarding.ts
assets/character/       // mascot SVG + animation frames
```

**Depends on:** G (design tokens — warm onboarding variant), E (for firing `onboarding-complete` event that bootstraps the daemon).

**Exposes:** `onboarding-complete` event with `{ agent_name, account: {...}, oauth_scopes: [...] }`; a `getAgentName()` preload method.

**Acceptance criteria (testable):**
1. Fresh launch (empty `userData`) → onboarding window opens; shell window does not.
2. Welcome screen renders mascot + capability pills; step indicator at 1/5.
3. User types agent name → stored in `${userData}/account.json` under `agent_name`.
4. "Continue with Google" opens system browser to OAuth URL with state parameter; callback URL (`agentic-browser://oauth/callback`) is registered via `app.setAsDefaultProtocolClient`; callback hits Electron main; tokens written to Keychain under service name `com.agenticbrowser.oauth` / account `<user email>`.
5. Google Scopes modal: all five services listed with descriptions; unchecking any scope removes it from the requested OAuth scope set (verified by intercepting the auth URL).
6. On completion: onboarding window closes; shell window opens; `onboarding-complete` event fires; daemon spawns.
7. Relaunch after completion: shell opens directly; no onboarding shown.
8. Token refresh: mock expired access_token; next API call triggers refresh using the stored refresh_token; new access_token written to Keychain.

**Risks:** OAuth custom protocol handler on macOS can misfire if another app claims the same scheme. Track owner namespaces the scheme as `agentic-browser-${version}://` in dev to avoid prod conflicts.

---

### Track D — Python Agent
**Scope:** Extend harnessless's daemon with agent-task meta-op; LLM client (Anthropic SDK by default; pluggable); agent loop (LLM → Python exec → observation → next step) with step + token budget; sandboxed `exec()` against a locked `helpers` namespace; event stream production.

**Files owned:**
```
python/agent_daemon.py       // extends harnessless daemon.py
python/agent/
  __init__.py
  loop.py                    // outer agent loop
  llm.py                     // LLM client (Anthropic)
  exec_sandbox.py            // locked-namespace exec
  events.py                  // event emission (push-to-socket)
  protocol.py                // message schemas (imports from shared)
  budget.py                  // step + token budget
python/harnessless/          // vendored or submoduled from browser-use/harnessless
python/requirements.txt
python/tests/
  test_loop.py
  test_exec_sandbox.py
  test_protocol.py
  test_budget.py
```

**Depends on:** E (protocol schemas — shared between TS and Python via code-gen or parallel schema files).

**Exposes:** Unix socket protocol (defined by E); daemon binary for Track F to bundle.

**Acceptance criteria (testable):**
1. `agent_task` message → daemon emits `task_started` event within 50ms; emits at least one `step_*` event before `task_done` or `task_failed` (except for instant-success tasks).
2. LLM-generated Python that calls `os.system("rm -rf /")` is **blocked**: `exec_sandbox` raises `SandboxViolation` and emits `step_error` with the violation. Verified by unit test that feeds known-malicious Python and asserts the exception.
3. Step budget exhausted (default 20 steps) → daemon emits `task_failed` with `reason: "step_budget_exhausted"` and a partial result.
4. Token budget exhausted (default 100k input tokens per task) → `task_failed` with `reason: "token_budget_exhausted"`.
5. Cancel flag: main sends `cancel_task` → daemon completes current step then emits `task_cancelled`. Max latency from cancel to termination: one step (≤15s typical, bounded by step timeout of 30s).
6. `target_lost`: when Chromium emits `Target.detachedFromTarget` for the task's target → daemon emits `target_lost` event with `task_id` and marks task cancelled.
7. Agent loop replays errors: if step N raises, the observation fed into step N+1 contains the exception (so LLM can self-correct) — verified by mocking LLM to return a broken call and asserting next call input contains the error text.

**Security gate:** Track D cannot ship to integration without sign-off from `security-reviewer` on `exec_sandbox.py`. Specific checks: blocked-import list (`os.system`, `subprocess`, `eval` outside whitelist, `open()` on paths outside temp), AST inspection of emitted code, verification that the exec namespace contains only `helpers.*` + a `print` proxy that logs to event stream.

---

### Track E — IPC & Protocol (critical path, lands days 1–3)
**Scope:** Single source of truth for all cross-process message schemas. Unix socket client (TS side), server extension (Python side). Push-based event streaming. Error envelope. Versioning.

**Files owned:**
```
shared/schemas/              // source-of-truth schemas
  agent_task.schema.json     // JSON Schema; code-gen target for TS + Python
  agent_events.schema.json
  tab_state.schema.json
  onboarding.schema.json
scripts/
  codegen-schemas.ts         // produces src/shared/types.ts + python/agent/schemas.py
src/main/daemon/
  client.ts                  // Unix socket client
  eventStream.ts             // push event subscriber
  reconnect.ts               // crash-recovery logic
src/shared/types.ts          // generated from schemas
python/agent/schemas.py      // generated from schemas
```

**Depends on:** — (critical path, blocks A/B/C/D/H).

**Exposes:**

Protocol (extends harnessless):
```
# Request shapes
{meta: "agent_task",          prompt: str, per_target_cdp_url: str, task_id: str}
{meta: "cancel_task",         task_id: str}
{meta: "set_active_target",   per_target_cdp_url: str}
{meta: "ping"}                                               # liveness
{meta: "shutdown"}

# Response envelopes
{ok: true, result?: {...}}
{ok: false, error: {code: str, message: str, retryable: bool}}

# Event shapes (pushed from daemon, one JSON per line):
{event: "task_started",    task_id: str, started_at: iso}
{event: "step_start",      task_id: str, step: int, plan: str}
{event: "step_result",     task_id: str, step: int, result: any, duration_ms: int}
{event: "step_error",      task_id: str, step: int, error: {...}}
{event: "task_done",       task_id: str, result: any, steps_used: int, tokens_used: int}
{event: "task_failed",     task_id: str, reason: str, partial_result?: any}
{event: "task_cancelled",  task_id: str}
{event: "target_lost",     task_id: str, target_id: str}
```

**Acceptance criteria (testable):**
1. Schema compilation: `npm run codegen:schemas` produces `src/shared/types.ts` and `python/agent/schemas.py`. Both compile (tsc + mypy) with zero errors.
2. Round-trip test: construct a message of each type in TS, JSON-encode, decode in Python, assert structural equality. Mirror TS→Python→TS.
3. Push event test: daemon writes 100 events to the socket over 1s; TS client receives all 100 in order with no drops. Verified by sequence-number assertion.
4. Reconnect test: kill the daemon mid-stream; TS client detects socket close within 2s; attempts respawn within 2s; resubscribes events.
5. Error envelope: any unhandled exception on the Python side produces `{ok: false, error: {...}}` — never a raw stacktrace leak to main.
6. Socket path: `${app.getPath('userData')}/daemon-${process.pid}.sock` — each Electron instance has its own; two concurrent app instances do not collide (E2E: launch two copies, both function).

**This track gets completed first.** Weeks-1 goal: publish schemas + stubs; other tracks then code against them.

---

### Track F — Packaging & Distribution
**Scope:** Forge fuse audit, DMG maker integration, PyInstaller dual-arch build, code signing with hardened runtime, Apple notarization, DMG produced per arch, auto-update feed (S3 + `electron-updater` or `update.electronjs.org`). CI pipeline for release tags.

**Files owned:**
```
forge.config.ts              // updated: maker-dmg, osxSign, osxNotarize, extraResource, asarUnpack
package.json                 // add @electron-forge/maker-dmg, @electron/notarize
python/build.sh              // PyInstaller dual-arch
python/pyinstaller.spec
scripts/
  sign-python.sh             // codesign the PyInstaller binary with entitlements
  build-dmg.sh
  release.sh
.github/workflows/
  release.yml                // matrix: macos-13 (Intel) + macos-14 (arm64)
  ci.yml
src/main/updater.ts
entitlements.plist           // com.apple.security.cs.allow-jit, allow-unsigned-executable-memory
```

**Depends on:** D (daemon binary to bundle); week-1 starts in parallel with E with stub daemon.

**Exposes:** Signed, notarized `.dmg` per arch; auto-update feed URL.

**Acceptance criteria (testable):**
1. **Fuse audit complete**: `forge.config.ts` fuses table documented with rationale per fuse. `RunAsNode` stays `false`; `OnlyLoadAppFromAsar` stays `true`; PyInstaller binary uses `extraResource` + `asarUnpack` pattern so it lives in `Resources/app.asar.unpacked/python/agent_daemon`.
2. `npm run make` produces **two .dmg files** (`x64` from macos-13 runner; `arm64` from macos-14 runner). Both are code-signed with hardened runtime. Verified by `codesign -dvvv` + `spctl --assess --type execute`.
3. Nested Python binary is individually signed before parent signing. Verified by `codesign -vv --verify Resources/app.asar.unpacked/python/agent_daemon` inside the notarized .dmg.
4. Notarization: `xcrun notarytool submit --wait` returns `status: Accepted` for each .dmg.
5. Fresh macOS install (no Xcode/Python/Homebrew): .dmg mounts, app drags to Applications, first launch shows no security warning, onboarding opens, daemon spawns successfully (verified by `launchctl list | grep agent_daemon` or daemon log appearing).
6. Auto-update: publish v0.1.0 to feed; client v0.1.0 on next launch detects v0.1.1 feed entry, downloads delta, applies on quit. Verified end-to-end on a staging feed.
7. **Multi-instance safety**: launch two copies of the installed app; both spawn daemons (different PIDs, different socket paths). No port/socket collision.

**Week-1 deliverable (critical):** a minimal signed DMG with a stub daemon. If this fails in week 1, surface immediately — Scenario-1 pre-mortem mitigation.

---

### Track G — Design System & Character
**Scope:** Shared CSS tokens (two variants: Linear+Obsidian for shell, warm character for onboarding), typography (NOT Inter — Söhne or Geist), base components (Button, Input, Modal, Toast, Spinner, Card), character mascot SVGs + idle/loading animations. Global CSS file per CLAUDE.md rule.

**Files owned:**
```
src/renderer/design/
  tokens.ts                  // spacing, radius, durations
  theme.shell.css            // Linear+Obsidian dark
  theme.onboarding.css       // warm character
  theme.global.css           // reset + shared
  fonts.ts                   // Söhne/Geist loader (NOT Inter)
src/renderer/components/base/
  Button.tsx
  Input.tsx
  Modal.tsx
  Toast.tsx
  Spinner.tsx
  Card.tsx
  KeyHint.tsx                // Cmd+K style hint
  index.ts
assets/character/
  mascot.default.svg
  mascot.variants/           // color/race variants (see onboarding screenshot bottom row)
  mascot.anim.json           // Lottie or CSS animation spec
```

**Depends on:** —

**Exposes:** imports for A/B/C (and H for test fixtures).

**Acceptance criteria (testable):**
1. Token file has no hardcoded hex colors outside `tokens.ts` — verified by lint rule `no-raw-hex`.
2. Zero `!important` declarations in any CSS file (CLAUDE.md rule). Verified by `rg "!important" src/renderer/` returning zero matches.
3. Font loader produces zero `Inter` references. Verified by `rg -i "inter" src/renderer/design/`.
4. Base components export deterministic className output (snapshot tests).
5. Mascot SVG animates on `loading` state; idle state is static. Verified by E2E capturing two screenshots 1s apart during load and diffing.

---

### Track H — Testing & Observability
**Scope:** Playwright-Electron E2E harness, 20-site Chrome parity smoke (concrete diff methodology), unit test scaffolding, structured log pipeline, telemetry with thresholds, crash reporting (Sentry or equivalent).

**Files owned:**
```
tests/
  e2e/
    golden-path.spec.ts
    pill-flow.spec.ts
    onboarding-flow.spec.ts
    session-restore.spec.ts
    crash-recovery.spec.ts
  parity/
    sites.json               // 20 URLs
    chrome-baseline.json     // captured console errors from stock Chrome
    run-parity.ts            // launches both browsers, diffs console errors
  fixtures/
  setup/
src/main/telemetry.ts        // metric emitter
src/main/logger.ts           // rotating logs to userData/logs/
python/agent/telemetry.py
config/sentry.ts             // Sentry DSN, scrub rules
```

**Depends on:** A/B/C/D stubs (uses their exported IPC as test surface).

**Exposes:** test harness invoked via `npm run e2e`.

**Acceptance criteria (testable):**
1. E2E harness boots Electron from built artifact (not `npm start`) and drives it via Playwright. Golden-path test passes end-to-end in < 60s.
2. Parity smoke: `npm run parity` produces `parity-report.json` with per-site: `{ url, chrome_console_errors: N, agentic_console_errors: M, new_errors: [...], missing_errors: [...] }`. Ship gate: `new_errors.length === 0` across all 20 sites at `error` level.
3. Telemetry metrics defined with **thresholds** (not just names):
   - `pill_open_latency_ms`: p95 ≤ 150ms, p99 ≤ 300ms
   - `agent_first_step_latency_ms`: p95 ≤ 3000ms cold, ≤ 500ms warm
   - `agent_task_duration_ms`: per-success / per-failure histograms
   - `daemon_startup_ms`: p95 ≤ 3000ms
   - `session_restore_success_rate`: ≥ 99%
   - `daemon_crash_rate_per_session`: ≤ 0.01
4. Logs rotate at 10MB; `~/Library/Application Support/AgenticBrowser/logs/` contains `main.log`, `daemon.log`, `agent-task-{id}.log`.
5. Crash reports: synthetic crash in main → report in Sentry within 30s; renderer crash → same; daemon crash → same.
6. Internal `agentic://diagnostics` page (gated by `DEV_MODE=1` env) shows daemon status, recent agent tasks, log file paths.

---

## 6. Acceptance Criteria (v0.1 ship gate)

A build is v0.1-ready when **all** of the following are true and reproducible on a fresh macOS 14+ machine (no Xcode, no Python, no Homebrew):

| # | Criterion | Concrete check |
|---|---|---|
| 1 | Install cleanly | `spctl --assess --type execute` passes on both arch .dmgs; first launch no security warnings |
| 2 | Chrome parity smoke | `npm run parity` produces `parity-report.json` with `new_errors.length === 0` at `error` level for all 20 sites in `tests/parity/sites.json` |
| 3 | Tabs | Open 20 tabs, drag-reorder, close, new-tab, Cmd+T/W/L/1..9 all fire (E2E assertion) |
| 4 | URL bar | URL parse, Google search fallback, padlock indicator, Cmd+L focus+select (E2E) |
| 5 | Session restore | Quit with 3+ tabs → relaunch → identical tab state (URLs + per-tab back/forward lengths) |
| 6 | Pill opens fast | p95 `pill_open_latency_ms` ≤ 150ms over 100 invocations |
| 7 | Agent round-trip | Given prompt "scroll to bottom" on fixture URL, active tab's `document.body.scrollTop + window.innerHeight === document.body.scrollHeight` within 15s; pill shows "done" |
| 8 | Agent streams | During a 3+ step task, pill renders ≥ 2 distinct intermediate `step_*` events (captured via DOM polling) |
| 9 | Crash recovery | `kill -9 <daemon-pid>` → main detects within 3s; next Cmd+K respawns daemon within 3s |
| 10 | Multi-instance | Launch two copies of the app simultaneously; both function; separate PIDs, separate socket paths, separate debugging ports |
| 11 | Onboarding | Fresh `userData` → onboarding opens → name + OAuth flow → Keychain token present → shell opens. Relaunch skips onboarding. |
| 12 | Auto-update | v0.1.0 client detects staged v0.1.1; update applied on quit-and-relaunch |
| 13 | Target-lost handling | Close active tab during agent task → `target_lost` event → pill shows "Tab was closed — task cancelled" |
| 14 | Sandbox | Inject known-malicious Python (e.g. `os.system("...")`) via mock LLM → daemon blocks with `SandboxViolation`, pill shows "Agent couldn't finish" |

Each criterion maps to at least one automated test in §8.

**Explicitly NOT in v0.1** (removed from prior draft's promises): Cmd+Shift+T undo-close, bookmarks UI, extensions, voice, drawer/Dynamic-Island, autonomous tab spawning, Windows/Linux.

---

## 7. Pre-mortem — Three Failure Scenarios

### Scenario 1: "Signing/notarization/fuse debugging eats 3+ weeks"
- **Symptom:** First signed DMG fails notarization or app launches but daemon never spawns (fuse interaction).
- **Root causes:** (a) nested PyInstaller binary not individually signed; (b) `RunAsNode: false` + `child_process` instead of `utilityProcess`; (c) missing `asarUnpack` so daemon path resolves inside asar; (d) entitlements missing `allow-jit` / `allow-unsigned-executable-memory` required by Python interpreter.
- **Detection:** First signed-build CI job in **week 1**. Failure is loud (notarization rejection email, daemon spawn timeout in startup logs).
- **Mitigation / surface-by:**
  - Week 1, Day 3: stub DMG with hello-world PyInstaller binary signed + notarized
  - Week 1, Day 5: daemon spawn verified inside a locally-installed signed build
  - If blocked: pair with an Electron-Forge + macOS signing specialist; worst case ship internal dogfood unsigned while fix proceeds
- **Owner:** Track F; gate is week-1 signed-stub milestone

### Scenario 2: "Agent emits Python that breaks harnessless; users see hangs and cryptic errors"
- **Symptom:** High `task_failed` rate in telemetry; qualitative reports of "agent does nothing."
- **Root causes:** (a) LLM doesn't handle React controlled inputs / iframes / shadow DOM; (b) stale session handling; (c) agent loops on a broken selector.
- **Detection:** Parity fixture suite (Track H) with known-tricky sites; `agent_failure_rate` telemetry metric with threshold alert.
- **Mitigation:**
  - helpers.py locked in prod (agent can't edit shipped code)
  - Exception fed back to LLM as observation (Track D acceptance #7)
  - Step + token budget with clean fallback message (Track D acceptance #3, #4)
  - Rotating per-task log (Track H)
- **Owner:** Track D + security-reviewer; telemetry live by week 3

### Scenario 3: "First Cmd+K feels broken due to cold-start latency"
- **Symptom:** 4–8s delay on first invocation; users repeat-press; confusion.
- **Root causes:** PyInstaller cold start + CDP attach + first LLM API latency stack.
- **Detection:** Timing harness in dev build; `agent_first_step_latency_ms` p95 threshold alert.
- **Mitigation:**
  - Spawn daemon at `app.whenReady()`, not on first Cmd+K (daemon warms during app launch)
  - Pill shows "warming up…" state if daemon not ready
  - Pre-flight CDP attach on daemon startup
  - Keepalive ping every 30s
  - Fallback: if daemon not ready in 10s, pill shows explicit "agent unavailable" with diagnostic link
- **Owner:** Track D + Track B; benchmark by end of week 2

---

## 8. Expanded Test Plan

### 8.1 Unit tests
- **Python (pytest, ≥80% coverage on `agent/`):** agent loop state machine, event emission order, cancel flag propagation, step/token budget enforcement, protocol encode/decode, LLM retry/backoff, sandbox blocks every item in the blocked-imports list.
- **TypeScript (vitest, ≥80% on `main/tabs/` and `main/daemon/`):** TabManager lifecycle (open/close/reorder/session-save), SessionStore JSON round-trip + migration for future schema changes, URL parse (URL vs query heuristic), IPC schema validation (zod), OAuth state parameter CSRF protection.

### 8.2 Integration tests
- **Daemon ↔ Electron (spawn real PyInstaller binary):** send `agent_task`; assert `task_started` < 200ms; assert events arrive in documented order; cancel mid-task; assert clean shutdown.
- **Daemon ↔ Chromium:** launch Electron with `--remote-debugging-port=0`; discover port; attach daemon to per-target WS URL; run `cdp("Page.navigate", ...)`; verify WebContentsView navigates via `did-navigate` event.
- **Session restore:** programmatic multi-tab setup, IPC quit, relaunch, assert deep equality of tab state.
- **OAuth:** mock Google's OAuth endpoint; verify state param, PKCE if applicable, token exchange, Keychain write.

### 8.3 E2E (Playwright-Electron against built artifact)
- **Golden path:** onboarding → shell → open 3 tabs → Cmd+K → "go back on this tab" → back nav observed → quit → relaunch → state intact.
- **Pill flows:** open/toggle/dismiss, streaming render, target_lost handling.
- **Crash recovery:** external daemon kill, verify respawn.
- **Chrome parity smoke:** 20 sites, diff console errors vs baseline.
- **Multi-instance:** two concurrent launches, both function.

### 8.4 Observability (specific metrics + thresholds)
| Metric | Threshold | Alert |
|---|---|---|
| `pill_open_latency_ms` | p95 ≤ 150ms, p99 ≤ 300ms | Slack #alerts |
| `agent_first_step_latency_ms` | p95 ≤ 3000ms cold, ≤ 500ms warm | Slack |
| `agent_task_duration_ms` | histogram only | dashboard |
| `daemon_startup_ms` | p95 ≤ 3000ms | Slack |
| `daemon_crash_rate_per_session` | ≤ 0.01 | page oncall |
| `session_restore_success_rate` | ≥ 99% | Slack |
| `agent_task_success_rate` | ≥ 80% on fixture suite | Slack |
| `sandbox_violations_per_day` | ≤ 5 (signals bad prompts, not attacks) | review queue |

Logs: rotating at 10MB under `~/Library/Application Support/AgenticBrowser/logs/`; `main.log`, `daemon.log`, `agent-task-{id}.log`.

Internal diagnostics page: `agentic://diagnostics` gated by `DEV_MODE=1`.

---

## 9. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Signing + notarization + fuses | High | High | Week-1 signed-stub gate; `utilityProcess` instead of child_process; explicit entitlements; asarUnpack for Python binary |
| R2 | Agent Python breaks harnessless | High | Medium | Locked helpers; exception feedback; step+token budget; parity fixtures; security-reviewer gate on exec_sandbox |
| R3 | Python cold-start latency | Medium | Medium | Spawn at app-ready; warming state in pill; pre-flight CDP; keepalive |
| R4 | WebContentsView API rough edges (focus, context menu, find-in-page) | Medium | Medium | File upstream bugs; pin Electron version; `<webview>` tag is last-resort escape hatch (NOT BrowserView — deprecated) |
| R5 | Auto-update feed breakage mid-ship | Medium | High | Ship v0.1.0 without updater if unstable; add in v0.1.1 after feed proven |
| R6 | LLM API cost runaway | Medium | Medium | Per-task token budget (100k default); per-user daily cap; telemetry alarm |
| R7 | User's Chrome data expectations | High | Low | Onboarding copy: "Agentic Browser is separate; your Chrome data doesn't migrate" |
| R8 | CDP drift between Electron's Chromium and harnessless assumptions | Low | Medium | Parity fixtures exercise all harnessless helpers against pinned Electron version |
| R9 | Scope creep | High | High | §6 ship-gate criteria are the contract; anything outside → v0.2 |
| R10 | Multi-instance collision (port, socket) | Medium | Medium | Port 0 + `/json/version` discovery; socket path includes PID |
| R11 | Electron security patch cadence | Medium | High | Policy: bump Electron minor within 7 calendar days of High/Critical Chromium advisory; automated scanner in CI |
| R12 | OAuth custom protocol handler conflicts | Low | Medium | Namespace scheme per env (`agentic-browser-dev://`, `agentic-browser://`); handle registration failures gracefully |
| R13 | PyInstaller dual-arch CI cost + flakiness | Medium | Medium | Two runners (macos-13 Intel, macos-14 arm64); don't attempt cross-compile; cache Python builds |
| R14 | Keychain access on first run (user prompt) | Low | Low | Onboarding explains why Keychain is requested; graceful fallback to encrypted file if declined |

---

## 10. Verification Steps (pre-ship)

1. `npm test && pytest python/tests/` — unit green
2. `npm run integration` — daemon spawn + CDP attach + IPC round-trip green
3. `npm run e2e` — Playwright-Electron suite green on built artifact
4. `npm run parity` — 20-site report shows `new_errors.length === 0`
5. `npm run make` — produces two signed DMGs; `spctl` + notarization status `Accepted`
6. Fresh-VM install walkthrough — each §6 criterion ticked manually
7. Pre-mortem probes:
   - `pill_open_latency_ms` p95 ≤ 150ms via 100-Cmd+K script
   - `agent_first_step_latency_ms` p95 ≤ 3000ms cold
   - `kill -9 <daemon>` + re-Cmd+K → respawn within 3s
8. Security review of `exec_sandbox.py`:
   - Run `tests/security/test_blocked_imports.py` — 100% of blocklist raises
   - AST dump of emitted Python shows no whitelisted-bypassing imports
   - `strings` output of daemon binary does not contain embedded secrets
   - `lsof -p <daemon>` during a task shows only the CDP WS, the LLM API host, the socket, and the log files — nothing else
9. Telemetry dashboard shows every metric in §8.4 populated from a dogfood session with at least 20 tasks

---

## 11. Delegation Map

**Execution pattern:** Track E + Track F kick off day 1. Once E publishes schemas (day 3 goal), A/B/C/D/G/H fan out in parallel.

| Track | Primary agent | Reviewer/gate | Parallelizable from |
|---|---|---|---|
| E — IPC & Protocol | `oh-my-claudecode:executor` | `oh-my-claudecode:architect` (schema review) | Day 1 |
| F — Packaging | `startup-harness:ops` | `oh-my-claudecode:debugger` (signing issues) | Day 1 |
| A — Browser Chrome | `oh-my-claudecode:executor` (TS) | `oh-my-claudecode:code-reviewer` | Day 3 (after E schemas) |
| B — Pill | `oh-my-claudecode:executor` | `oh-my-claudecode:designer` | Day 3 |
| C — Onboarding | `startup-harness:website` | `oh-my-claudecode:security-reviewer` (OAuth) | Day 3 |
| D — Python Agent | `startup-harness:backend` | `oh-my-claudecode:security-reviewer` (REQUIRED gate on exec_sandbox) | Day 3 |
| G — Design System | `oh-my-claudecode:designer` | — | Day 1 (tokens first), components fan out |
| H — Testing & Obs | `oh-my-claudecode:test-engineer` | `startup-harness:verify` | Day 3 (stubs) |
| Prior-art research | `startup-harness:researcher` | — | Day 1, one-shot brief |

**Interface contracts (published day-3 deliverable of Track E):**
- TS types in `src/shared/types.ts`
- Python types in `python/agent/schemas.py`
- Unix socket transport spec in `shared/schemas/README.md`
- Event schema versioned (`version: "1.0"` field in every message)

**Merge strategy:** each track works in a branch named `track/<A-H>/<name>`. PRs merge to `main` only after: (a) track's unit tests green, (b) schema-using tracks re-run `npm run codegen:schemas` against `main` before merge. Designate a weekly integration window for cross-track testing.

---

## 12. ADR — v0.1 Architecture Decision Record

- **Decision:** Build on Electron (v41.2.1 pinned) with a bundled Python daemon (PyInstaller, launched via `utilityProcess`) that connects to per-target CDP WebSocket URLs on an OS-assigned debugging port. Ship macOS-only for v0.1.
- **Drivers:**
  1. Agent model is RL'd on Python — Python runtime requirement is load-bearing
  2. Shippable-to-non-technical-users install experience (signed .dmg, auto-update, no Python visible)
  3. Maximize parallel agent throughput via 8-track disjoint-file factoring
- **Alternatives considered:**
  - **Option A-alt:** re-enable `RunAsNode: true` and use `child_process.spawn` — rejected; weakens hardening for no material benefit over `utilityProcess`.
  - **Option B:** TS orchestration + per-step Python `exec()` — rejected; per-step spawn cost compounds; duplicates agent loop; loses harnessless's persistent CDP advantage.
  - **Option C:** External user-managed daemon — rejected for distribution; adopted as dev-mode pattern only.
  - **Option D:** Chromium fork — rejected for v0.1; 6–12-month scope explosion; re-evaluate at v0.4+ if Electron hits a concrete ceiling.
- **Why chosen:** Only configuration that (a) preserves the Python agent stack, (b) honors Electron's security fuses, (c) enforces active-tab-only at the transport layer via per-target CDP WS URLs, (d) leaves a clean migration path to a Chromium fork, and (e) factors into 8 genuinely parallel tracks.
- **Consequences:**
  - +30–40MB install (acceptable; Chrome is ~200MB)
  - Dual-arch CI cost: two macOS runners
  - `utilityProcess` lifecycle management required (not trivial but well-documented)
  - Per-target WS URL approach means the daemon must be told the target URL on each `agent_task`; slightly more main-process work but closes a real security gap
  - Commitment to Electron Forge toolchain (not electron-builder)
- **Follow-ups (v0.2+):**
  - Agent presence drawer / Dynamic-Island
  - Autonomous tab spawning with visibility policy
  - Extension support via `electron-chrome-extensions` + .crx interception from Chrome Web Store URLs
  - Voice input pipeline (mic permission + Whisper/Deepgram STT)
  - Linear+Obsidian visual polish on shell (onboarding already warm)
  - Windows + Linux packaging
  - Undo-close (Cmd+Shift+T) + bookmarks + history UI
  - Re-evaluate Chromium fork if Electron hits concrete ceiling

---

## 13. What's Applied From Review

**From Architect (REVISE):**
- ✅ Per-target CDP WS URL enforces active-tab-only at transport layer (principle 4 + Track D + §4 diagram)
- ✅ Port 0 dynamic allocation via `/json/version` (§4, Track E)
- ✅ Socket path includes PID (§4, Track E acceptance #6)
- ✅ `target_lost` event in schema (Track E, Track B acceptance #5, Track D acceptance #6)
- ✅ BrowserView fallback removed (R4 uses `<webview>` as last resort)
- ✅ Electron bump cadence policy (decision #13, R11)
- ✅ Fuses + `--remote-debugging-port` interaction documented (Track F acceptance #1)

**From Critic (REVISE):**
- ✅ C1: `RunAsNode: false` fuse respected via `utilityProcess` (Track F, §4, ADR)
- ✅ C2: `@electron-forge/maker-dmg` added to Track F files
- ✅ C3: `extraResource` + `asarUnpack` pattern documented (Track F acceptance #1)
- ✅ M1: "render correctly" replaced with concrete console-error diff (§6 #2, Track H acceptance #2)
- ✅ M2: Cmd+Shift+T removed from §6 ship gate; explicitly in "deferred to v0.2+"
- ✅ M3: BrowserView fallback removed
- ✅ M4: Committed to Electron Forge; electron-builder refs removed
- ✅ M5: 100ms Cmd+K measurement methodology specified (Track B acceptance #1)
- ✅ File paths restructured to match planned nested layout; Track A includes "restructure flat src/ to nested" as first task
- ✅ Event stream is push (Track E protocol spec)
- ✅ Concrete security checks (§10 step 8)
- ✅ Telemetry thresholds (§8.4)
- ✅ Estimation revised honestly: 8–10 weeks to external ship

**From user (parallel factoring + onboarding):**
- ✅ 8-track split (A–H) with disjoint file ownership
- ✅ Dedicated onboarding workstream (Track C) with character/OAuth/scope UX
- ✅ Critical path identified: E + F in week 1; A/B/C/D/G/H fan out day 3+
- ✅ Dual aesthetic (Linear+Obsidian shell + warm onboarding) reconciled in Track G

---

## 14. Mandatory Directives (added after Wave-1 launch)

See `/Users/reagan/Documents/GitHub/desktop-app/reagan_DIRECTIVES.md` for the authoritative version. Summary:

- **D1 — TDD:** every new function/module has a failing test first. TS = vitest, Python = pytest, E2E = Playwright-Electron. Coverage: ≥80% on `src/main/`, `src/shared/`, `python/agent/`.
- **D2 — Verbose dev-only logging:** JSONL to file, human-readable to console, structured with `component` + `context`. `log.debug` / `log.info` gated by `NODE_ENV !== 'production'` (TS) or equivalent env check in Python. `log.warn` / `log.error` always on. Errors include surrounding state so an LLM can diagnose from transcript alone. No secrets in logs.
- **D3 — Apply-to-existing:** any code written before these directives landed must be revised to comply before it's reported complete.

These apply to all 8 tracks. Track H owns the shared `logger.ts` / Python `logger.py`; other tracks import.

---

## Changelog

- **2026-04-16 rev 2:** Added §14 Mandatory Directives (TDD + dev-only verbose logging). Wave 1 agents retrofit on revision pass; Wave 2 (B, C) launch with directives baked in.
- **2026-04-16 rev 1:** Incorporated Architect (NEEDS REVISION) + Critic (REVISE) feedback. Added 8-track parallel factoring. Added onboarding workstream (Track C) with character + Google OAuth + Keychain. Switched to `utilityProcess`. Per-target CDP WS URL. Port 0 + PID-scoped socket. Added `target_lost`. Dropped BrowserView fallback. Committed to Electron Forge. Added DMG maker requirement. Specified 100ms methodology. Added telemetry thresholds. Revised ship estimate to 8–10 weeks.
- **2026-04-16 rev 0:** Initial draft, pre-consensus review.
