# The Browser

Mac-native AI browser with a hotkey agent pill (Cmd+K).

## What it does

- **Browse normally** — tabs, URL bar, back/forward/reload
- **Cmd+K → agent task** — tell Claude what to do on the current page; it executes with Chrome DevTools Protocol
- **Onboarding** — Keychain-backed API key storage, Google OAuth for scopes
- **Settings** (Cmd+,) — reconfigure API key, agent name, theme, factory reset

## Prerequisites

- **Node 20+** — for app build and dev tools
- **Python 3.11+** — for the agent daemon (language model loop + execution sandbox)
- **macOS 13+** — primary target; Windows/Linux untested
- **Anthropic API key** — set via `ANTHROPIC_API_KEY` in `.env` or via Settings window

## Quick start

```bash
cd my-app
npm install
cd python && pip install -r requirements.txt && cd ..
npm run dev          # electron-forge start (shell + daemon together)
```

### First run

The app opens an onboarding flow:
1. Welcome page
2. Name the agent
3. Google account link (OAuth — optional, for scopes)
4. Ready — shell opens

API key can be set via Settings (Cmd+,) after onboarding.

## Dev shortcuts

| Command | What | Use case |
|---|---|---|
| `npm run dev` | Full app (Electron + daemon) | Normal development |
| `npm run dev:settings` | Shell + Settings window open side-by-side | Design review, Settings-specific work |
| `npm run test` | Vitest unit + integration (no e2e) | Quick feedback loop |
| `npm run e2e` | Playwright end-to-end tests | Verify user flows |
| `npm run visual:capture` | Write baseline screenshots (15 specs) | Before UI changes |
| `npm run visual:diff` | Compare current vs baseline PNGs | Visual regression detection |
| `npm run visual:qa` | Run capture + diff, open HTML review | Full visual QA pass |
| `npm run qa:review` | Open `review.html` (visual gallery) | Browse captured & diff outputs |
| `npm run qa` | Lint + typecheck + test (CI-like) | Before commit / before push |

## Architecture

### Directory structure

```
src/
  main/               Electron main process
    index.ts         App entry, window management, IPC
    agentApiKey.ts   Keychain integration
    daemonLifecycle  Spawn/kill agent daemon subprocess
    settings/        Settings store (macOS UserDefaults via Keychain)
  preload/           ContextBridge APIs (shell, pill, onboarding, settings)
    index.ts         API surface for renderer
    settings.ts      Settings getter/setter
  renderer/          React apps (one per window type)
    shell/          Main browser window (tabs, URL bar, Cmd+K pill)
    pill/           Modal overlay (streaming agent task UI)
    onboarding/     Login flow (name, account link, API key)
    settings/       Preferences (theme, API key, reset)
    design/         Design system tokens, CSS, DESIGN_SYSTEM.md
python/
  agent_daemon.py   Entry point — Unix socket server + agent loop
  agent/
    loop.py        Agent step loop (plan → code → execute → eval)
    exec_sandbox   Sandboxed JS/Python execution
    llm.py         Anthropic SDK client with streaming
    protocol.py    Socket message format (request/response/events)
    budget.py      Step + token budgets (safety limits)
    events.py      Event emitter + telemetry
    logger.py      JSON-line structured logging
tests/
  unit/             Vitest specs (.test.ts)
  integration/      Vitest specs (IPC, daemon, settings)
  e2e/              Playwright specs (pill-flow, golden-path, etc.)
  visual/           Screenshot baselines + visual QA
  setup/            Playwright config, test utilities
```

### Key files

- **`forge.config.ts`** — Electron Forge config (Vite plugin, makers, CSP)
- **`vite.config.ts`** — Vite dev server (shell, pill, onboarding windows)
- **`vite.settings.config.ts`** — Separate Vite config for standalone Settings renderer
- **`src/main/index.ts`** — Window creation, IPC contract, daemon lifecycle
- **`my-app/python/requirements.txt`** — Python daemon dependencies (anthropic, pytest, etc.)

### How the agent works

1. User presses Cmd+K in the shell
2. Pill window opens (empty, ready for input)
3. User types a task (e.g., "Find the cheapest flight to NYC")
4. Pill sends `agent_task` to the daemon via Unix socket
5. Daemon spawns an `AgentLoop`:
   - LLM generates a plan
   - LLM generates code (JavaScript or Python)
   - Sandbox executes the code
   - Results fed back to LLM
   - Loop repeats until done or budget exhausted
6. Events stream back to pill (step/progress/result/error)
7. User sees live updates, then the result

### IPC contract

Main → Renderer (events):
- `ipc-shell:target-changed` — active tab URL changed
- `ipc-pill:task-started` — agent task began
- `ipc-pill:step` — agent step result (code, output)
- `ipc-pill:task-done` — task completed or failed

Renderer → Main (requests):
- `ipc-shell:navigate` — go to URL
- `ipc-pill:submit-task` — send task to daemon
- `ipc-onboarding:submit-account` — complete signup
- `ipc-settings:get-state` — fetch current settings
- `ipc-settings:set-key` — update API key, theme, etc.

## Design system

See `/src/renderer/design/DESIGN_SYSTEM.md` for:
- Theme tokens (shell: neon + dark; onboarding: warm + character)
- Typography (Geist UI, Berkeley Mono)
- Color palette (shell: obsidian + neon; onboarding: pastel)
- Component library (Shell, Pill, Onboarding, Settings)

Brand assets in `/assets/brand/BRAND.md`.

## Testing

### Unit + integration

```bash
npm test              # Run once
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

**Test structure:**
- `src/**/*.test.ts` — vitest (mocked Keychain, IPC)
- `tests/integration/*.test.ts` — vitest with real daemon or mocks
- **Rule:** NEVER mock Keychain or file system unless instructed. Use real data + fixtures.

### End-to-end

```bash
npm run e2e                  # Run all Playwright specs
DAEMON_MOCK=1 npm run e2e    # Use mock daemon (faster, no Python)
```

**Test files:**
- `pill-flow.spec.ts` — Cmd+K → task → stream → done
- `golden-path.spec.ts` — onboarding → shell → pill → quit → reopen
- `preload-path.spec.ts` — preload bridge isolation tests

### Visual QA

```bash
npm run visual:capture  # Write PNG baselines (do this before UI changes)
npm run visual:diff     # Compare current vs baseline
npm run visual:qa       # Run both + open review.html
npm run qa:review       # Open review.html directly
```

**Baselines live in:** `tests/visual/references/`

### Python tests

```bash
cd my-app/python
source .venv/bin/activate    # or: python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest                       # Run all tests
pytest -v                    # Verbose (show test names)
pytest tests/test_budget.py  # Single file
```

**Test coverage:**
- Budget enforcement (step/token limits)
- Sandbox security (blocked imports, safe builtins)
- Event protocol (serialization, ordering)
- Agent loop (happy path, budget exhaustion, cancellation)

## Troubleshooting

### Blank shell window

Check `/Users/reagan/Documents/GitHub/desktop-app/memory/project_electron_forge_vite_paths.md` — the preload/HTML/CSP paths are strict. If changed:
- Verify `preload.ts` path in `forge.config.ts`
- Verify HTML entry in `vite.config.ts`
- Verify CSP directives in forge.config.ts
- Curl the dev server to confirm it's running
- Check DevTools (Cmd+Option+I) for CSP violations

### Hotkeys not working

- **Cmd+K** — handled by `globalShortcut` in main process (only this one)
- **All other shortcuts** (Cmd+T, Cmd+W, Cmd+,) — are Menu accelerators (not globalShortcut)
- Menu accelerators are safer (don't steal focus system-wide)
- See `/Users/reagan/Documents/GitHub/desktop-app/memory/project_electron_shortcuts.md`

### No daemon connection

1. Check Settings (Cmd+,) — is API Key set?
2. Look at Electron console (Cmd+Option+I) for daemon spawn errors
3. Check `/tmp/agent-daemon.sock` exists
4. Run Python daemon standalone: `cd python && python3 agent_daemon.py`
5. Check logs: daemon logs to stderr (JSON-line format, readable via `jq`)

### Agent task times out or goes silent

- Check step budget (default 50 steps)
- Check token budget (default 1M input, 2M output)
- See `my-app/python/agent/budget.py` for limits
- Set `ANTHROPIC_API_KEY` — daemon will not run without it

### Settings window doesn't open

- Try `npm run dev:settings` — opens shell + Settings side-by-side
- Check for errors in terminal — preload or IPC bridge issues
- Verify CSP allows `data:` URIs (for inline styles)

## Contributing

See `CONTRIBUTING.md` at repo root for:
- Branch naming & commit style
- Test rules (no mocks unless instructed)
- Design system rules (no Inter, no sparkles, no !important)
- Adding a new window (checklist)
- AI-assisted work (co-author rule)

## License

MIT — see LICENSE file in repo root.
