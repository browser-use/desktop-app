# Docker-per-task agent architecture

## Goal
Each Cmd+K task runs as an isolated Docker container. `docker ps` shows active tasks,
`docker logs` gives per-task streams, `docker kill` cancels stuck tasks.

## Components

### 1. `my-app/src/main/hl/cli.ts` — standalone Node.js entrypoint
- Reads from env: `ANTHROPIC_API_KEY`, `CDP_URL`, `TASK_PROMPT`, `TASK_ID`
- Creates context via `cdpForWsUrl(CDP_URL)` (no Electron dependency at runtime)
- Runs `runAgent()` loop
- Streams HlEvent as JSON lines to stdout
- Exits 0 on success, 1 on error

### 2. `my-app/docker/agent/Dockerfile`
- FROM node:22-slim
- Install only production deps (@anthropic-ai/sdk, ws)
- Copy compiled hl/ code (pre-built via esbuild into a single bundle)
- CMD ["node", "agent-bundle.js"]

### 3. Build step: `my-app/docker/agent/build.ts`
- Uses esbuild to bundle cli.ts + all hl/ deps into one JS file
- Excludes Electron types (they're import-type-only, compiled away)
- Replaces `mainLogger` with console.log (no Electron logger in container)
- Output: `my-app/docker/agent/dist/agent-bundle.js`

### 4. `hlPillBridge.ts` changes
- Instead of `runAgent()` in-process, spawn:
  ```
  docker run --rm --name agent-{taskId}
    -e ANTHROPIC_API_KEY
    -e CDP_URL=ws://host.docker.internal:{cdpPort}/devtools/page/{targetId}
    -e TASK_PROMPT={prompt}
    -e TASK_ID={taskId}
    agent-task:latest
  ```
- Stream container stdout line-by-line, parse JSON, forward to pill renderer
- On cancel: `docker kill agent-{taskId}`
- On app quit: `docker kill` all `agent-*` containers

### 5. Taskfile additions
- `task agent:build` — esbuild bundle + docker build
- `task agent:logs TASK=<id>` — docker logs -f agent-<id>

## CDP URL discovery
- Electron already starts with `--remote-debugging-port=0` (OS-assigned)
- TabManager.discoverCdpPort() finds the port
- TabManager.getActiveTabTargetId() gives the page target ID
- Full URL: `ws://host.docker.internal:{cdpPort}/devtools/page/{targetId}`

## Logger replacement
- In-process: `mainLogger` from `../logger`
- Container: needs a standalone logger that writes JSON lines to stdout
- Solution: `cli.ts` patches the logger before importing agent.ts, OR
  agent.ts accepts an `onEvent` callback (already does!) which cli.ts
  wires to `process.stdout.write(JSON.stringify(event) + '\n')`

## Risks
- CDP port is on localhost; container uses `host.docker.internal` (macOS Docker Desktop)
- First `docker run` is slow (image pull/build). Mitigate with `task agent:build` at dev start.
- Container can't use `webContents.debugger` — pure ws:// only. This is by design.
