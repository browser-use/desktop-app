# Agentic Browser v0.1 — Full-Scope Plan (v2)

**Status:** awaiting approval
**Date:** 2026-04-17
**Supersedes:** `reagan_plan_agentic_browser_v01.md` (v0.1 infra, delivered)
**Figma target:** https://www.figma.com/design/AnYunq5B4ekWJMwDmnVMo2/Browser-Use----All (file key `AnYunq5B4ekWJMwDmnVMo2`)

---

## 0. Baseline — what's already done (locked)

- Shell renders: tabs with favicons, URL bar, nav buttons, session restore (Track A)
- Onboarding flow renders: welcome → naming → account → scopes modal (Track C)
- Pill opens on Cmd+K as **app-local Menu accelerator** — NO globalShortcut (Track B + today's shortcut refactor)
- Python daemon: sandbox secured after frame-walk RCE fix, 252 tests passing (Track D + S2)
- IPC schemas + Unix socket client (Track E) — PID-scoped socket path, per-target CDP URL
- Unsigned DMG builds (`out/make/my-app-1.0.0-arm64.dmg` 110MB) (Track F)
- Design tokens + 2 themes + 7 base components + mascot SVG (Track G)
- Test infra: 52 unit + 26 E2E specs + visual QA scaffold at `tests/visual/` (Track H)
- Memory saved: path invariants, shortcut rules, evidence-before-edit (`~/.claude/projects/...-desktop-app/memory/`)

## 0.5 Gap this plan closes

1. **Agent wiring** — `pill:submit` is still `TODO`; daemon never spawned; no API key flow
2. **Design polish** — tokens exist, but no screen has had the `impeccable` skill applied; Linear+Obsidian feel is NOT yet in the UI
3. **Visual QA review surface** — captures exist but there's no clickable review UI
4. **Figma sync loop** — no Figma designs exist for this app; no bidirectional sync
5. **Settings** — no way to enter API key, change agent name, reset
6. **Commits** — 50+ files uncommitted since initial commit

---

## 0.6 Global rules (apply to every track, every sub)

- **Autonomous testability.** User should never need to click through to verify a feature. Every acceptance criterion is backed by a Playwright-Electron test (or vitest for pure TS) that runs in CI. Track 3 is responsible for exercising the app end-to-end without manual steps.
- **Playwright MCP usage.** The Playwright MCP is live in this session (`mcp__playwright__browser_*`). Use it directly for live debugging/verification AND write reusable Playwright-Electron specs to `my-app/tests/e2e/` or `my-app/tests/visual/` for CI.
- **Loop / re-verify rule.** Never declare a task "done" without a re-verification step. Each Lead's final report MUST include: (a) the test command that proves done, (b) the actual output showing green, (c) a re-run after any last-minute cleanup. If anything is unclear, loop.
- **Branding + custom assets.** Everything on-theme with a deliberate visual system (see Track 6). NO conventional pre-packaged libraries for data viz / charts / diagrams (no `recharts`, `chart.js`, `victory`, `mermaid-renderer`, or similar). Any chart, diagram, or asset is hand-crafted SVG / canvas / custom React components that match the brand.
- **No broken intermediate states.** If a Lead's change leaves the app broken, they roll back, fix locally, and resubmit. Track 0 Historian only commits verified-working work; everything else stays uncommitted until verified.
- **Don't rush.** Better to loop than to ship a half-broken state. Every Lead re-reads their own acceptance criteria before claiming done.

## 1. Orchestration hierarchy

```
Commander (me)
├── Track 1 — Agent Wiring Lead (startup-harness:backend)
├── Track 2 — Design Polish Lead (oh-my-claudecode:designer)
├── Track 3 — QA Harness Lead (oh-my-claudecode:test-engineer)
├── Track 4 — Figma Sync Lead (startup-harness:website, Figma-versed)
├── Track 5 — Settings Lead (startup-harness:website)
├── Track 6 — Branding + Assets Lead (oh-my-claudecode:designer)
└── Track 0 — Git Historian (oh-my-claudecode:git-master) — runs FIRST
```

Each Lead:
- Spawns its own subagents (non-overlapping file ownership)
- Delivers a single consolidated handoff + report
- Signs off only on verified-working work

## 2. Track breakdown

### Track 0 — Git Historian (runs FIRST, ~30 min)

**Owner:** git-master
**Goal:** Produce atomic conventional commits for the 50+ uncommitted files; ONLY commit work confirmed working.

**Verified-working (commit-eligible):**
- Plan + directives docs → `docs: plan and directives for v0.1 build`
- Forge + signing scaffolding → `build(forge): DMG maker, fuses audit, PyInstaller stub, signing scripts`
- Shared IPC schemas + TS/Python codegen → `feat(ipc): shared schemas + socket client + event stream`
- Design system tokens + components → `feat(design): tokens, themes, base components, mascot SVG`
- Shell (restructured + chrome rendering) → `feat(shell): tab manager, URL bar, nav, session restore`
- Onboarding (renders, Keychain working) → `feat(onboarding): welcome, naming, account, OAuth + Keychain`
- Pill (opens, hotkey, IPC) → `feat(pill): Cmd+K overlay window + IPC (stubbed submit)`
- Python agent daemon + sandbox (252 tests) → `feat(daemon): agent loop, exec sandbox (post-S2 RCE fix), LLM client`
- Testing infra → `test: Playwright-Electron harness, unit tests, visual QA scaffold`
- Logger + telemetry with D2 gating → `feat(logger): dev-only structured logger (TS + Python)`
- Bug fixes from today → `fix(shell): preload path + CSP + relative script src (resolves invisible chrome)`, `fix(shortcuts): convert globalShortcut to Menu accelerators (resolves focus stealing)`, `fix(sandbox): block traceback frame-walk RCE + path traversal + thread zombie DoS`

**NOT yet commit-eligible** (stays uncommitted until verified):
- Agent wiring (`pill:submit` TODO)
- Any impeccable polish (not done yet)
- Figma sync scripts (not written yet)
- Settings screen (not built yet)

**Acceptance:** `git log` shows ~12 logical commits, each with a tight scope and conventional prefix; `git status` only shows the in-flight tracks.

---

### Track 1 — Agent Wiring (~8h elapsed)

**Lead owns:** `src/main/index.ts` (pill:submit handler), `src/main/daemonLifecycle.ts` (new), `src/main/agentApiKey.ts` (new)

**Subagents:**
1. **utilityProcess daemon spawn** — spawn `python/dist/agent_daemon` via `utilityProcess.fork`; pass env `DAEMON_SOCKET_PATH=${userData}/daemon-${pid}.sock`, `ANTHROPIC_API_KEY` from Keychain, `AGENTIC_DEV=1` in dev. Restart-on-crash with exponential backoff. File: `src/main/daemonLifecycle.ts`.
2. **DaemonClient connect + reconnect** — instantiate `DaemonClient` at app-ready, call `connect()` after daemon health-check, subscribe `onEvent` → `forwardAgentEvent`. Reconnect on socket drop. Expose `getDaemonClient()` for other modules.
3. **Wire `pill:submit`** — replace the TODO at `src/main/index.ts:96-105` with `daemonClient.send({meta: 'agent_task', prompt, per_target_cdp_url: cdpUrl, task_id})`. Handle error envelope → pill shows "agent unavailable".
4. **Cancel on Esc during active task** — pill's Esc while task is running sends `{meta: 'cancel_task', task_id}`; daemon emits `task_cancelled`.
5. **API key sourcing** — read from `KeychainStore` (service `com.agenticbrowser.anthropic`); if missing, route the user to the Settings screen (Track 5) before spawning daemon.
6. **Un-skip `tests/e2e/pill-flow.spec.ts`** — drive real flow with mock LLM on localhost fixture.

**Acceptance:** From fresh install → onboarding → key entered → Cmd+K → "scroll to bottom of this page" on en.wikipedia.org/wiki/Electron → page scrolls + pill shows "done" within 15s. Daemon crash (`kill -9`) detected within 3s; next Cmd+K respawns.

---

### Track 2 — Design Polish via `impeccable` (~12h elapsed, 5 subs)

**Lead owns:** design QA, cross-screen consistency
**Each sub runs `startup-harness:impeccable` on its assigned screen family**

**Subagents (file ownership is disjoint):**
1. **Onboarding family** — Welcome.tsx, NamingFlow.tsx, AccountCreation.tsx, GoogleScopesModal.tsx, CharacterMascot.tsx, StepIndicator.tsx, CapabilitiesGrid.tsx + `onboarding.css`. Apply warm character-forward polish per reference screenshots. Mascot animations (idle float + loading accelerated), pill color correction, step indicator polish, Google scopes modal cleaner.
2. **Shell chrome family** — TabStrip.tsx, URLBar.tsx, NavButtons.tsx, WindowChrome.tsx + `shell.css` + `components.css`. Linear+Obsidian polish: refined tab hover/active states, favicon loading state, close-button hitbox fix, URL bar focus ring, secure/insecure icon, loading progress indicator, custom scrollbars.
3. **Pill family** — Pill.tsx, PillInput.tsx, ProgressToast.tsx, ResultDisplay.tsx + `pill.css`. Backdrop blur, accent glow when active, streaming step animation, result presentation with action buttons, empty-state copy.
4. **Empty + error states** — NEW: EmptyShellState.tsx, EmptyAgentState.tsx, ErrorBoundary.tsx, OfflineBanner.tsx. When no tabs, no recent agent task, daemon unavailable, offline.
5. **Loading skeletons + KeyHint usage** — loading placeholders for tab content, URL bar while resolving; consistent KeyHint chip usage on every screen (hint for Esc, Cmd+K, Cmd+L, Enter).

**Acceptance:** Lead runs a side-by-side review (pre vs post) on each screen; all 5 subs report "impeccable-applied" with before/after screenshots. No file outside the sub's scope is touched.

---

### Track 3 — QA Harness + Visual Review Surface (~6h)

**Lead owns:** `tests/visual/`, `tests/e2e/*.spec.ts` un-skip, `.github/workflows/qa.yml`, regression suite

**Subagents:**
1. **Baseline captures** — run `tests/visual/capture.spec.ts` against current app; commit `tests/visual/references/*.png` as baselines.
2. **HTML review surface** — NEW `tests/visual/review.html` with a React or vanilla app that shows a clickable gallery: every screen × every state, with ref + current side-by-side, slider diff, approve/reject buttons. Output to `tests/visual/review-report.json`. Launched via `npm run qa:review`.
3. **Un-skip E2E specs** — after each track's prerequisites land: `onboarding-flow` now, `golden-path`/`session-restore`/`crash-recovery`/`multi-instance` now, `pill-flow` after Track 1.
4. **CI workflow** — `.github/workflows/qa.yml`: on PR, run `npm run make` → `npm run e2e` → `npm run qa:capture` → upload HTML review as artifact. Fail PR on any new diff above threshold.
5. **Regression tests for today's bugs** — `tests/regression/preload-path.spec.ts` (assert `window.electronAPI` exists), `csp-hmr.spec.ts` (assert React mounts in dev), `no-global-shortcuts.spec.ts` (assert `globalShortcut.isRegistered(...)` returns false for every combo).

**Acceptance:** `npm run qa` green; `npm run qa:review` opens localhost review UI with every screen; PR artifact contains browsable HTML.

---

### Track 4 — Figma Sync Loop (~6h initial + ongoing)

**Target file:** `AnYunq5B4ekWJMwDmnVMo2` ("Browser-Use — All"). User requested a NEW section in this file.

**Lead owns:** `scripts/figma/*.ts`, `.github/workflows/figma-sync.yml`, Code Connect template files

**Subagents:**
1. **Inspect + create section** — load figma-use skill, call `get_metadata` on file `AnYunq5B4ekWJMwDmnVMo2` to inspect existing pages/sections. Use `use_figma` to create a new `Section` named "Agentic Browser" at the right of existing content. Create child pages: "Design System", "Onboarding", "Shell", "Pill", "Settings", "Error/Empty States".
2. **Generate design library** — via `figma-generate-library`: mirror `src/renderer/design/tokens.ts` (colors, spacing, radii, durations) as Figma variables; mirror `src/renderer/components/base/*.tsx` (Button, Input, Modal, Toast, Spinner, Card, KeyHint) as Figma components with variants matching props. Scope variables appropriately per `project_electron_forge_vite_paths` memory rule (not all-scopes).
3. **Push current screens with screenshots** — via `figma-generate-design`: capture live app states via Playwright-Electron (Track 3's harness), create Figma frames for: welcome, naming, account, scopes modal, shell (empty + 3 tabs), pill (idle + streaming + done + error), onboarding mascot states. Include screenshots as Figma image fills on reference frames + structured Figma frames alongside.
4. **Code Connect mappings** — for each base component, create `.figma.tsx` Code Connect template. For each screen frame, map to its source file. This means any Figma edit pulls back into the right code file.
5. **Auto-sync hook** — `.github/workflows/figma-sync.yml`: on merged PR that touched `src/renderer/**`, run `scripts/figma/push-changed-screens.ts` which diffs changed files and pushes only affected screens to Figma. Local equivalent: `npm run figma:sync`. Rate-limit to avoid pointless re-pushes. **Opt-out** env var `AGENTIC_NO_FIGMA=1` for sensitive branches.

**Acceptance:** Open file `AnYunq5B4ekWJMwDmnVMo2` in browser → see new "Agentic Browser" section with all screens + design system present. Edit Pill.tsx in a test branch → CI job updates the Pill frame screenshot within 2 min.

---

### Track 5 — Settings / Config UX (~6h)

**Lead owns:** new Settings window + integration points

**Subagents:**
1. **Settings window shell** — new BrowserWindow, warm theme (Settings feels like onboarding), frameless, 720×560. `src/main/settings/*.ts` + `src/renderer/settings/*`.
2. **API key entry** — textarea input, "Save" → KeychainStore.setPassword(`com.agenticbrowser.anthropic`, email, key). Click "Test" → daemon attempts a zero-token probe call, reports success/failure. Never log the key (scrub per D2).
3. **Agent name edit** — read/write `userData/account.json` `agent_name` field.
4. **Theme toggle** — preview of shell theme vs onboarding theme; switch adjusts `document.documentElement.dataset.theme`.
5. **OAuth scope re-consent** — launch Google OAuth flow with current + new scopes, save to Keychain.
6. **Factory reset** — confirm dialog → delete `userData/account.json`, clear Keychain entries, close window, re-launch onboarding.

**Acceptance:** Fresh install → no key → onboarding fires a "Configure API key" step → Settings opens → key saved to Keychain → agent ready.

---

### Track 6 — Branding + Custom Assets (~8h)

**Lead owns:** `assets/brand/*`, custom SVG / canvas components under `src/renderer/assets/*`, updates to design tokens for brand primitives

**Non-goals (explicit):** no `recharts`, no `chart.js`, no `victory`, no `mermaid`, no `d3-mermaid`, no `react-flow`, no pre-packaged visualization libs. Every chart / diagram / illustration is hand-crafted SVG or canvas drawn against the brand system.

**Subagents:**
1. **Brand identity system** — wordmark, app icon (macOS .icns source), favicon for in-app chrome, palette extension beyond tokens (hero/marketing colors), typography scale for brand moments (hero copy, onboarding headlines). File: `assets/brand/BRAND.md` (system doc) + `assets/brand/icons/*`, `assets/brand/wordmarks/*`.
2. **Custom SVG components for dynamic visuals** — `<AgentThinkingIndicator/>` (animated, tied to step index), `<TabConnectionGraph/>` (custom SVG showing agent-tab relationship), `<TaskProgressOrb/>` (generative visual for in-progress tasks), `<CdpPulse/>` (heartbeat indicator for daemon health). Pure SVG + CSS animations; zero external deps.
3. **Hand-drawn diagrams** — any architectural or UX diagram shipped in docs or in the app uses `assets/brand/diagrams/*.svg` that we hand-author (via `use_figma` to draft, export, then refine). Zero mermaid renderers.
4. **Mascot evolution** — take Track G's placeholder mascot and evolve into a branded character: multiple poses (idle, thinking, celebrating, error, offline), consistent SVG vector library, Lottie export optional. `assets/brand/mascot/*`.
5. **Brand-aware emoji/iconography** — custom glyph set for in-app iconography that isn't sparkles/stars (per user rule), delivered as an inline SVG sprite sheet.

**Acceptance:** Brand system doc exists and every component references the brand tokens (verified by lint); `grep -rE 'from [\"']recharts|chart.js|victory|mermaid|react-flow' src/ assets/` returns zero matches; the app's chrome + loading/error visuals use the custom assets, not generic icons or stock libraries.

---

## 3. Execution order

```
T+0    Track 0 (Git Historian)              ─────────╮ 30min, serial
                                                     │
T+0    Track 4 sub (a) inspect Figma file   ─────┐  │ first 15 min
T+0    Track 4 sub (b) generate library          │  │
T+0    Track 4 sub (c) push current screens      │  │ 3h, parallel to others
                                                 │  │
T+0    Track 1 Agent Wiring (6 subs)        ─────┤  ▼
T+0    Track 2 Design Polish (5 subs)            ├─ Tracks 1-5 fan out after T+0
T+0    Track 3 QA Harness (5 subs)               │   (Track 0 can run parallel
T+0    Track 5 Settings (6 subs)                 │    since it only touches git,
                                                 │    not source)
T+4h   Track 4 sub (d) Code Connect         ─────┘
       Track 4 sub (e) Auto-sync CI
                                                    
T+8h   Track 1 done → Track 3 unskip pill-flow spec
T+12h  Track 2 design polish done → Track 4 re-push with polished screens
T+14h  Ship gate: all tracks green, visual review shows 0 regressions
```

Total: ~14h elapsed if 5 Leads + 21 subagents run truly in parallel.

## 4. Ship gate (everything must be true)

- Agent round-trip works end-to-end with a real LLM call (Track 1 acceptance)
- Visual QA review shows zero new diffs vs baselines on the 10 core screens (Track 3)
- Figma file `AnYunq5B4ekWJMwDmnVMo2` has "Agentic Browser" section with all 10 screens + design system, auto-sync job runs on PR (Track 4)
- Settings can add API key from fresh install (Track 5)
- All previously-passing tests still pass; 300+ unit/integration/regression tests total
- Zero `globalShortcut.register()` calls in the codebase (enforced by `no-global-shortcuts.spec.ts`)
- `npm run qa:review` works locally
- Git log: ~12 conventional commits for baseline + per-track feature commits after acceptance

## 5. Commits policy (conventional commits)

- Per track Lead's sign-off, ONE commit per significant deliverable (not per sub)
- Convention: `<type>(<scope>): <summary>` where types = `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `chore`, `perf`
- Scopes = `shell`, `pill`, `onboarding`, `daemon`, `ipc`, `design`, `figma`, `settings`, `qa`, `signing`, `security`
- No commits for unverified work. If a track Lead says "done but pill doesn't open reliably," that's uncommitted until fixed.
- Commits include the Co-Authored-By trailer only when requested by the user

## 6. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Sub-agents on the same track collide on a shared config file | Lead defines file-ownership manifest upfront; subs acknowledge before starting |
| Figma API rate limits on sync | Auto-sync is PR-scoped only; local `npm run figma:sync` debounces |
| Design polish regresses agent wiring | Track 2 cannot touch anything in `src/main/*` (pure render-layer work) |
| API key gets logged accidentally | Logger has allowlist-based scrubber + Track 1 sub 5 has explicit test for zero-key-in-logs |
| Ship gate never reached due to cascading reworks | Each Lead ships to a track-specific branch; merges into main via PR with green CI |

---

## 7. Decisions needed from you before I dispatch

1. **All 5 leads in parallel, or narrower?** (see options 1-4 from the prior message)
2. **Figma target confirmed?** (create new "Agentic Browser" section in `AnYunq5B4ekWJMwDmnVMo2`, not a new file)
3. **Apple signing credentials available?** If yes, I can chain the CI run to produce a signed DMG this pass; if not, Track 4 skips signed-artifact publishing
4. **Commits with or without `Co-Authored-By`?** Your preference — I'll default to WITHOUT unless you say include it

Answer these and I kick off Track 0 (Git Historian) immediately, fan out the other 5 leads once it's done.

## Changelog

- **2026-04-17 v2 draft 0:** rescoped after user feedback ("where is the design system / impeccable / QA pipeline / everything"). Added Figma sync loop track + settings track. Hierarchical orchestration with Leads + subs. Git Historian runs first.
