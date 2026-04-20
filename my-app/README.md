# Agent Hub

Desktop app for running AI browser automation agents. Each agent gets its own sandboxed WebContentsView so multiple agents can work side-by-side without interfering with each other.

## Quick start

```bash
task up    # Install deps, build agent image, start the app
```

On first run, the onboarding flow walks through Google OAuth and API key setup (stored in OS keychain via keytar).

## How it works

1. Open the command bar (`c` or click "New agent")
2. Type a task
3. An agent starts in its own sandboxed WebContentsView
4. Watch the agent work in real time, or take over the browser to intervene
5. Send follow-up prompts to running or stopped sessions

The agent engine runs in-process using Chrome DevTools Protocol to control each browser context. Sessions persist to SQLite so conversation history survives restarts.

## Directory structure

```
src/
  main/                    # Electron main process
    index.ts               # App entry, menu, IPC wiring
    window.ts              # BrowserWindow lifecycle
    sessions/              # SessionManager, SessionDb (SQLite), BrowserPool
      SessionManager.ts    # Session lifecycle, stuck detection, event relay
      SessionDb.ts         # SQLite persistence (sessions, events, conversation history)
      BrowserPool.ts       # Sandboxed WebContentsView pool
    hl/                    # In-process agent engine
      agent.ts             # Agent loop (prompt -> tools -> result)
      context.ts           # CDP browser context creation
      tools.ts             # Agent tool definitions
      runtime.ts           # Tool execution runtime
      cdp.ts               # Chrome DevTools Protocol helpers
    channels/              # Inbound message channels
      WhatsAppAdapter.ts   # WhatsApp Web bridge
      ChannelRouter.ts     # Routes inbound messages to agent sessions
    identity/              # OAuth, account store, keychain, onboarding
    pill.ts                # Agent pill overlay window
    hotkeys.ts             # Cmd+K registration
    settings/              # Settings window
    chrome-import/         # Chrome data import
    startup/               # CLI args, CDP port, user data dir

  preload/                 # Context bridge scripts
    shell.ts               # Hub window preload

  renderer/                # React renderers
    hub/                   # Agent Hub UI
      HubApp.tsx           # Root layout, view switching, session management
      AgentPane.tsx        # Individual agent pane (output stream + browser view)
      CommandBar.tsx        # Task input overlay
      Dashboard.tsx        # Session overview
      ListView.tsx         # Compact table view
      SessionCard.tsx      # Session summary card
      SettingsPane.tsx     # Keybinding editor, preferences
      KeybindingsOverlay.tsx # Help overlay (?-key)
    pill/                  # Agent pill overlay
    onboarding/            # First-run flow
    components/            # Shared React components
    design/                # Design tokens, global CSS

docker/
  agent/                   # Containerized agent runtime
```

## Views

- **Dashboard** — overview with session status summary
- **Grid** — tmux-style split panes (1x1, 2x2, 3x3) for watching agents work
- **List** — compact table with status, prompt, elapsed time

## Keybindings

Vim-style by default, all remappable in settings (`s`).

| Key | Action |
|---|---|
| `c` | New agent session |
| `j` / `k` | Navigate sessions |
| `g g` / `G` | Jump to top / bottom |
| `x` | Dismiss session |
| `q` | Cancel running session |
| `1` / `2` / `3` | Dashboard / Grid / List view |
| `?` | Help overlay |
| `s` | Settings |
| `Cmd+K` | Command bar |

## Dev commands

All commands run from the repo root via [Task](https://taskfile.dev).

| Command | What |
|---|---|
| `task start` | Start the app |
| `task start:fresh` | Start against a throwaway profile |
| `task start:onboarding` | Start with onboarding forced open |
| `task up` | Build agent image + start |
| `task logs` | Tail app logs |
| `task qa` | Lint + typecheck + test |
| `task test` | Vitest unit + integration |
| `task e2e` | Playwright end-to-end |
| `task visual` | Screenshot capture + diff |
| `task agent:build` | Bundle hl/ agent code + build Docker image |
| `task agent:ps` | List running agent containers |
| `task make` | Build platform installers |

## Tech stack

- **Electron 41** — Chromium, context isolation, renderer sandbox
- **React 19** — Vite 5 renderer bundles
- **TypeScript 5.4**
- **SQLite** (better-sqlite3) — session and conversation persistence
- **CDP** — Chrome DevTools Protocol for agent browser control
- **Anthropic SDK** — AI agent integration
- **keytar** — OS keychain (API key storage)
- **Electron Forge 7** — packaging (DMG, DEB, RPM, ZIP, Squirrel)
