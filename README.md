# Browser Use Desktop

<img width="1456" height="484" alt="desktop-app-banner" src="https://github.com/user-attachments/assets/550ca16a-5a61-4ded-92f0-a30421870223" />

## A desktop app for running browser agents. 

Running automations on your local Chrome interferes with your daily work and also requires permissions every time. Instead, you can port your cookies into a new Chromium environment and run tasks there. 

With a separate desktop app, you can also run agents from anywhere - WhatsApp, Slack, keyboard shortcut, etc.

## How it works

You type a task into the command bar, hit enter, and an agent starts working in its own browser view. You can watch it work in real time, take over the browser to solve a captcha or log in, then hand control back.

### Session states

| State | Indicator | Meaning |
|---|---|---|
| draft | grey dot | Prompt entered, not submitted |
| running | green dot, pulsing | Agent executing |
| stuck | amber dot | No progress, needs attention |
| stopped | blue-grey dot | Finished or cancelled |

### Views

- **Dashboard** — overview of all sessions with status summary
- **Grid** — tmux-style split panes (1x1, 2x2, 3x3 layouts) for watching agents work
- **List** — compact table with status, prompt, and elapsed time

### Controls

- **Watch** — see the agent's browser in real time from the pane
- **Intervene** — take over the browser directly
- **Follow up** — send a follow-up prompt to a running or stopped session
- **Re-run** — copy a prompt and fire it again
- **Dismiss** — hide completed sessions from the grid without deleting data
- **Cancel** — stop a running agent

Sessions persist to SQLite so conversation history survives app restarts.

### Vim keybindings

Navigation uses vim-style keys by default (`j`/`k` to move, `g g`/`G` for top/bottom, `c` to create, `x` to dismiss). All bindings are remappable in settings.

## Channels

Inbound message channels can trigger agent sessions automatically.

- **WhatsApp** — receives messages via WhatsApp Web bridge, routes them through ChannelRouter to create agent sessions

## Project structure

```
my-app/
  src/
    main/                    # Main process (Electron + Node)
      index.ts               # App entry, menu, IPC wiring
      window.ts              # BrowserWindow lifecycle
      sessions/              # SessionManager, SessionDb (SQLite), BrowserPool
      hl/                    # In-process agent engine (CDP, tools, runtime)
      channels/              # Inbound message channels (WhatsApp adapter, router)
      identity/              # OAuth, account store, keychain, onboarding
      pill.ts                # Agent pill overlay window
      hotkeys.ts             # Cmd+K registration
      settings/              # Settings window
      chrome-import/         # Chrome data import
      startup/               # CLI args, CDP port, user data dir

    preload/                 # Context bridge scripts
      shell.ts               # Hub window preload

    renderer/                # React renderer processes
      hub/                   # Agent Hub UI (HubApp, AgentPane, CommandBar,
                             #   Dashboard, ListView, SessionCard, SettingsPane)
      pill/                  # Agent pill overlay
      onboarding/            # First-run onboarding flow
      components/            # Shared React components
      design/                # Design tokens, global CSS

  docker/
    agent/                   # Containerized agent runtime
```

## Development

Requires [Task](https://taskfile.dev) (`brew install go-task`).

```bash
task up    # Install deps, build agent image, start the app
```

Other launch modes:

```bash
task start              # Start without rebuilding
task start:fresh        # Throwaway profile (preserves real userData)
task start:onboarding   # Force onboarding open
task logs               # Tail app logs
```

### Agent containers

```bash
task agent:build       # Bundle hl/ agent code + build Docker image
task agent:ps          # List running agent containers
task agent:logs        # Tail logs for a running container
```

### Quality gates

```bash
task qa                # Lint + typecheck + test
task lint              # ESLint
task typecheck         # tsc --noEmit
task test              # Vitest unit/integration
task e2e               # Playwright end-to-end
task visual            # Screenshot capture + diff
```

### Packaging

```bash
task package           # Build unpackaged app
task make              # Build platform installers (DMG, DEB, RPM, ZIP)
```

## Tech stack

- **Electron 41** — Chromium with context isolation and renderer sandbox
- **React 19** — Vite 5 renderer bundles
- **TypeScript 5.4** — main, preload, and renderer
- **SQLite** (better-sqlite3) — session and conversation persistence
- **CDP** — Chrome DevTools Protocol for agent browser control
- **Electron Forge 7** — packaging (DMG, DEB, RPM, ZIP, Squirrel)
- **Anthropic SDK** — AI agent integration
- **keytar** — OS keychain (Touch ID, API key storage)

## License

MIT
