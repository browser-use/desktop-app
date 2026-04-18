# Plan: harnessless JS port (1-1 with Python)

## Problem
The current TS port (`src/main/hl/`) is bundled by Vite into the Electron main process at build time. The agent cannot edit `helpers.ts` and have changes take effect — TypeScript requires compilation, and the `OnlyLoadAppFromAsar` fuse blocks dynamic `require()` of loose files.

The upstream Python harnessless works because Python is interpreted: the agent edits `helpers.py`, and the next `bh` invocation spawns a fresh process that re-imports from disk.

## Solution
Create a standalone JS port at `my-app/harnessless/` that matches the Python architecture 1-1:

| Python | JS | Role |
|--------|-----|------|
| `daemon.py` (172 lines) | `daemon.js` | Long-running CDP WebSocket ↔ Unix socket relay |
| `helpers.py` (215 lines) | `helpers.js` | Browser control functions (agent-editable) |
| `run.py` (4 lines) | `run.js` | Thin entrypoint: ensure_daemon + eval(stdin) |
| `pyproject.toml` | `package.json` | Dependencies: `ws` only |

### Why this works for self-improvement
1. `helpers.js` is plain JS — no compilation step
2. Each `bh` invocation spawns a fresh Node.js process that `require()`s `helpers.js` from disk
3. Agent edits `helpers.js` → next run picks up changes immediately
4. `npm install -g --prefix . .` (or symlink) makes `bh` globally available pointing at source checkout

### Architecture (matches Python exactly)
```
Chrome Browser (running, remote-debug enabled)
    ↓
CDP WebSocket (ws://127.0.0.1:<port><path>)
    ↓
daemon.js (async, ws + net.createServer on Unix socket)
    ↓
Unix Socket (/tmp/bh-<NAME>.sock)
    ↓
helpers.js (sync socket calls) ← AGENT EDITS THIS
    ↓
run.js (require helpers, ensure_daemon, eval stdin)
```

## Files to create

1. **`harnessless/daemon.js`** — async CDP relay
   - Discover Chrome via DevToolsActivePort (same profile paths as Python)
   - WebSocket connection with retry (Chrome "Allow?" dialog)
   - Unix socket server, one JSON line per request/response
   - Event buffer (deque equivalent, max 500)
   - Session management + stale session re-attach
   - ENV: `BU_NAME` for namespace, `BU_CDP_WS` for override

2. **`harnessless/helpers.js`** — browser control (the agent-editable file)
   - `_send(req)` — sync Unix socket roundtrip
   - `cdp(method, params, sessionId)` — raw CDP
   - Navigation: `goto`, `page_info`
   - Input: `click`, `type_text`, `press_key`, `scroll`, `dispatch_key`
   - Visual: `screenshot`
   - Tabs: `list_tabs`, `current_tab`, `switch_tab`, `new_tab`, `ensure_real_tab`
   - Iframe: `iframe_target`, `js`
   - Utility: `wait`, `wait_for_load`, `http_get`
   - Dialogs: `capture_dialogs`, `dialogs`
   - Files: `upload_file`
   - Daemon lifecycle: `ensure_daemon`, `kill_daemon`, `daemon_alive`

3. **`harnessless/run.js`** — entrypoint (4 lines, mirrors run.py exactly)

4. **`harnessless/package.json`** — `ws` dependency, `bin: { bh: "./run.js" }`

## What stays unchanged
- `src/main/hl/` — the Electron in-process integration stays as TS (it uses WebContents.debugger transport, not Unix sockets)
- `python/harnessless/` — the Python original stays as reference

## Verification
- Start Chrome with remote debugging
- Run `node daemon.js` — should connect and listen on socket
- Run `echo "console.log(page_info())" | node run.js` — should print page info
- Edit `helpers.js` (add a new function) → run again → new function available
