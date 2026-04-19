# Agent Hub — Design & UX Decisions

## What this is
An Electron app (Chromium-based) that exists for one reason: **the user works on Chrome and browser automations, and agents running in the user's local Chrome would interfere with their work.** This app is an isolated Chromium instance where agents run browser tasks without colliding with the user's real Chrome session.

The user spins up browser automation agents, lets them run, and gets notified when something is stuck. That's the entire product. It's a task launcher + status dashboard, not an IDE or chat interface.

### Why Electron / Chromium
- Browser automation agents need a real Chromium environment
- Running them in the user's daily Chrome breaks both the user's workflow and the agent's context
- This app provides isolated Chromium instances for agents to work in
- Each agent gets its own browser context — no cross-contamination

## Core UX philosophy

### Make it effortless
The user's job is simple: spin off tasks and know if they're done or not. If something is stuck, they can step in and help. Otherwise, they don't want to think about it. Every UI decision should reduce friction — make it as easy as possible to do things, find things, and understand what's happening at a glance.

### The user is an operator, not a spectator
- They fire off agents like tools — type a task, hit enter, move on
- They need to re-run prompts easily (copy, rerun)
- They need to report broken sessions back to the team (feedback flow, not MVP)
- They should never have to dig through UI to understand what's happening

### Multi-agent is the default
- Users can have hundreds of agents
- The grid view shows a handful of active panes (tmux-style)
- The list view shows all sessions in a compact table (Linear-style)
- Future: drag-to-reorder, resize, group/pin sessions spatially

### What users care about
- **Status** — is it done? is it stuck? that's the primary signal
- **Prompt** — always visible, never truncated in the pane view
- **Time elapsed** — how long has this been running
- **Token usage** — how much is this costing (when data is available)
- **Output stream** — what the agent is doing right now (secondary, only when they want to look)

### What users do NOT care about
- Tool call count — internal implementation detail, don't surface it
- Individual timestamps on every output entry — noise
- Verbose metadata — keep it minimal
- Implementation details of how the agent works — just show results

### Don't re-explain what's already obvious
Never add redundant indicators. If a status dot is green and pulsing, don't also add a "LIVE" badge — the visual already communicates it. If the column header says "Running," don't repeat it in the cell. Every label, icon, and indicator must earn its place by adding information the user doesn't already have from context. Redundancy makes the UI look template-generated.

### Every task gets its own browser
Each agent session spawns an isolated Chromium context (separate cookies, storage, history). No shared state between agents. No collision with the user's personal browsing. This is the entire reason the app exists — agents need their own browsers.

### The user must be able to see and touch the browser
Users need full observability and control over agent browsers. These are not background processes hidden behind a log stream. The user should be able to:
- **Watch** the agent's browser working in real time (one click from the pane)
- **Take over** the browser to intervene (solve a captcha, log in, click something)
- **Switch back** to the output stream view seamlessly

These transitions must be fluid and one-click — no modals, no confirmation dialogs, no multi-step process. The pane itself toggles between output view and browser view. When the user is watching the browser, they should feel like they're looking through a window, not operating a remote desktop tool.

### Surface control, don't bury it
Every action the user might need during an agent run (watch browser, intervene, stop, restart) should be visible in the pane chrome — not hidden in menus or behind keyboard shortcuts. One click away, always.

## Design language

### Inspiration
Linear, Raycast, Cursor — deep dark, generous whitespace, subtle elevation, content-first.

### Rules
- NO hex literals in components — all colors via `var(--color-*)`
- NO Inter font — use Geist / system-ui
- NO sparkles icons
- NO `!important`
- Dark theme only (for now)
- Backgrounds use `--color-bg-sunken` (deepest black) as canvas
- Cards float on the canvas with `border-radius: lg`, subtle 1px border
- Borders are nearly invisible — separation through spacing and elevation
- Output entries are borderless rows, not boxed cards
- Progress indicators are subtle (gradient sweep, not solid bar)
- Send button is white-on-dark (like Linear CTAs)
- Animations are understated — 180ms, ease-decelerate

### Typography
- Toolbar labels: xs, uppercase, tertiary color, letter-spaced
- Prompts: sm, medium weight, primary color
- Metadata: xs, tertiary color, tabular-nums
- Output content: 2xs mono for code/tool calls, xs ui font for text

### Spacing
- Grid gap: space-3 (6px)
- Pane internal padding: space-6/space-8 (12-16px)
- Toolbar height: 40px + 30px traffic light clearance

## Session states

| State   | Dot color           | Meaning                        |
|---------|---------------------|--------------------------------|
| draft   | fg-disabled (grey)  | Prompt entered, not submitted  |
| running | status-success (green) + glow + pulse | Agent executing |
| stuck   | status-warning (amber) + glow | No progress, needs attention |
| stopped | accent-default (blue-grey) | Finished or cancelled |

## View modes
- **Grid** — tmux-style split panes, auto-layout: 1→full, 2→2col, 3→3col, 4→2x2
- **List** — compact table rows: status, prompt, elapsed time

## Data model

### AgentSession
- `id` — unique session identifier
- `prompt` — the user's task description
- `status` — draft | running | stuck | stopped
- `createdAt` — timestamp
- `elapsedMs` — total runtime
- `output` — array of OutputEntry

### OutputEntry
- `type` — thinking | tool_call | tool_result | text | error
- `content` — the actual content
- `tool` — tool name (for tool_call/tool_result)
- `timestamp` — when it happened
- `duration` — how long it took (for results)

## Future (not MVP)
- Drag-to-reorder/resize panes (Figma-like spatial layout)
- Pin/group sessions together
- Feedback flow (report broken sessions to team)
- Settings panel (system prompt, model picker, API key)
- Token usage tracking per session
- Persistent/daily workflow agents
- Onboarding flow (user handles this separately)
