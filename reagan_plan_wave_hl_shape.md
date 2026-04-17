# Wave `hl` port — shape plan

Port `harnessless` (Python, ~500 loc) to TypeScript inside this Electron app. Replace the Python daemon with an in-process TS CDP module. Wire Cmd+K pill to a command palette that drives a tool-use LLM loop against this app's own `WebContentsView` tabs.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Pill renderer (pill window, React)                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ PillInput  ─ command palette ─ rows: Switch-to-tab / Run-as-agent   │ │
│  │ ResultDisplay ─ streams {thinking, tool_call, tool_result, done}    │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│              │                                   ▲                         │
│              │ preload/pill.ts: pillAPI.hl.run   │ pillAPI.hl.onEvent      │
└──────────────┼───────────────────────────────────┼─────────────────────────┘
               │                                   │
               ▼                                   │ webContents.send
┌────────────────────────────────────────────────────────────────────────────┐
│ Main process                                                              │
│  ipcMain.handle('hl:run') ── engine flag router ── 'hl-inprocess'         │
│           │                                       │                       │
│           │                                       ▼                       │
│           │              ┌───────────────────────────────────────────┐   │
│           │              │ hl/agent.ts ── Anthropic tool-use loop    │   │
│           │              │ N≤25 iterations, streams events           │   │
│           │              └───────────────────────────────────────────┘   │
│           │                              │                                │
│           │                              ▼                                │
│           │              ┌───────────────────────────────────────────┐   │
│           │              │ hl/helpers.ts — 15 helpers, each ≤15 LOC │   │
│           │              │ (goto, click, js, screenshot, …)          │   │
│           │              └───────────────────────────────────────────┘   │
│           │                              │                                │
│           │                              ▼                                │
│           │              ┌───────────────────────────────────────────┐   │
│           │              │ hl/cdp.ts — CDP client                    │   │
│           │              │ path A: wc.debugger (preferred)           │   │
│           │              │ path B: ws:// URL (kept for remote)       │   │
│           │              └───────────────────────────────────────────┘   │
│           │                              │                                │
│           └──────────────────────────────┤                                │
│                                          ▼                                │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ tabs/TabManager → active WebContentsView.webContents           │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────┘
```

The in-process path uses `WebContents.debugger.sendCommand` (Electron built-in CDP). No external WebSocket, no Python child, no Unix socket.

## Ported helpers (15)

Each helper is ≤15 lines, no classes, takes `ctx: HlContext` as first arg.

| Python           | TypeScript           | CDP call(s)                               |
| ---------------- | -------------------- | ----------------------------------------- |
| `cdp`            | `cdp`                | raw `(method, params)`                    |
| `drain_events`   | `drainEvents`        | returns + clears ring buffer              |
| `goto`           | `goto`               | `Page.navigate` + `Page.loadEventFired`   |
| `wait`           | `wait`               | `setTimeout`                              |
| `wait_for_load`  | `waitForLoad`        | `Page.loadEventFired` with timeout        |
| `screenshot`     | `screenshot`         | `Page.captureScreenshot`                  |
| `page_info`      | `pageInfo`           | `Runtime.evaluate` (title/URL/viewport)   |
| `click`          | `click`              | `Input.dispatchMouseEvent` press+release  |
| `js`             | `js`                 | `Runtime.evaluate` (returnByValue)        |
| `type_in`        | `typeIn`             | focus + `Input.insertText`                |
| `dispatch_key`   | `dispatchKey`        | focus + `Input.dispatchKeyEvent`          |
| `iframe_target`  | `iframeTarget`       | `Target.getTargets` + URL substring match |
| `http_get`       | `httpGet`            | Node `fetch`                              |
| `capture_dialogs`| `captureDialogs`     | subscribe `Page.javascriptDialogOpening`  |
| `dialogs`        | `dialogs`            | returns dialog buffer                     |
| `ensure_real_tab`| `ensureRealTab`      | re-attach if session stale                |

Out-of-scope helpers (deferred): `ensure_daemon`, `kill_daemon`, `start_remote_daemon`, `browser_use_create`.

## LLM tool schema

Anthropic Messages API `tool_use` mode. Each helper becomes a tool.

```ts
[
  { name: "goto",         input_schema: { url: string } },
  { name: "click",        input_schema: { x: number, y: number } },
  { name: "js",           input_schema: { expr: string } },
  { name: "type_in",      input_schema: { selector: string, text: string } },
  { name: "dispatch_key", input_schema: { selector: string, key: string } },
  { name: "screenshot",   input_schema: {} },      // returns base64 + metadata
  { name: "page_info",    input_schema: {} },
  { name: "wait",         input_schema: { seconds: number } },
  { name: "wait_for_load",input_schema: { timeout?: number } },
  { name: "http_get",     input_schema: { url: string } },
  { name: "capture_dialogs", input_schema: {} },
  { name: "dialogs",      input_schema: {} },
  { name: "iframe_target",input_schema: { substr: string } },
  { name: "drain_events", input_schema: {} },
  { name: "done",         input_schema: { summary: string } },  // terminal tool
]
```

Model: `claude-opus-4-7` (latest from env knowledge), max_tokens 4096, up to 25 iterations.

## Pill palette wireframe

```
 ╭──────────────────────────────────────────────────────────╮
 │ ● Ask, search, or jump to a tab…               [↵]      │  56px input row
 ├──────────────────────────────────────────────────────────┤
 │ ▸ github.com/… — "PR #42 review"                         │  tab match
 │ ▸ news.ycombinator.com — "Hacker News"                   │  tab match
 │ ▸ Run as agent task: "<user's text>"                     │  agent row (highlighted)
 ╰──────────────────────────────────────────────────────────╯
   expanded: 480×320, palette scrolls if >5 rows
```

Running state replaces palette with a streaming log:
```
 ╭──────────────────────────────────────────────────────────╮
 │ ● Agent running — 3/25                           [Stop] │
 ├──────────────────────────────────────────────────────────┤
 │ thinking: I need to search for…                          │
 │ ▶ goto({url: "https://google.com"})                      │
 │   ✓ 240ms                                                │
 │ ▶ click({x: 400, y: 300})                                │
 │   ⋯                                                      │
 ╰──────────────────────────────────────────────────────────╯
```

## Event stream schema

```ts
type HlEvent =
  | { type: 'thinking';   text: string }
  | { type: 'tool_call';  name: string; args: unknown; iteration: number }
  | { type: 'tool_result';name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done';       summary: string; iterations: number }
  | { type: 'error';      message: string };
```

## Engine flag

`settings.engine = 'python-daemon' | 'hl-inprocess'` — default `hl-inprocess`. Both code paths stay wired so we can flip if the TS port regresses.

## Files

- `src/main/hl/cdp.ts` — CDP client
- `src/main/hl/helpers.ts` — 15 helpers
- `src/main/hl/context.ts` — HlContext type + factory
- `src/main/hl/runtime.ts` — named context map
- `src/main/hl/agent.ts` — tool-use LLM loop
- `src/main/hl/index.ts` — barrel
- `src/main/hl/engine.ts` — engine flag + pill:submit router
- `src/preload/pill.ts` — extended with `pillAPI.hl.*` + `pillAPI.tabs.*`
- `src/renderer/pill/CommandPalette.tsx` — new palette component
- `src/renderer/pill/AgentStream.tsx` — new streaming log component
- `src/renderer/pill/Pill.tsx` — refit to host palette + stream
- `src/main/pill.ts` — bump `PILL_HEIGHT_EXPANDED` to 320

## Commit plan

1. `feat(hl): CDP client targeting webContents.debugger + raw ws URL`
2. `feat(hl): port helpers.py to TypeScript (goto/click/js/screenshot/…)`
3. `feat(hl): LLM agent loop with tool-use streaming`
4. `feat(pill): command palette — tab search + task spawn`
5. `feat(ipc): hl IPC + preload bridge + settings engine flag`
