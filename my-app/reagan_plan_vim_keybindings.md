# Vim Keybindings Plan — Agent Hub

## Design Philosophy

Linear's approach: **non-modal, always-on single-key shortcuts** suppressed when a text field is focused. No insert/normal mode toggle — the app detects focus state automatically. Two-key chords (`G`+key) mimic Vim's leader-key patterns with a brief timeout window.

We adopt the same pattern: all shortcuts are live when no input is focused. When CommandBar or any text input is active, single-key shortcuts are suppressed.

---

## Current State

| Shortcut | Action | Location |
|----------|--------|----------|
| `Cmd+K` | Toggle CommandBar | HubApp.tsx (keydown listener) |
| `Enter` | Submit / expand-collapse | CommandBar, TaskInput, AgentPane, SessionPanel |
| `Shift+Enter` | Newline in input | CommandBar, TaskInput, Sidebar |
| `Escape` | Close CommandBar | CommandBar |
| `Ctrl+N` | (hint only, not wired) | SessionPanel empty state |

---

## Proposed Vim Keybinding Map

### Tier 1 — Core Navigation (implement first)

| Key | Action | Linear Equivalent |
|-----|--------|-------------------|
| `j` | Move focus down (next session/agent/item) | `J` — next issue |
| `k` | Move focus up (previous session/agent/item) | `K` — previous issue |
| `gg` | Jump to first item in list | (implicit in Linear) |
| `G` | Jump to last item in list | (implicit in Linear) |
| `/` | Open search / filter | `/` — open search |
| `Escape` | Dismiss modal / clear selection / exit search | `Esc` — go back |
| `Enter` | Open/expand focused item | `Enter` / `O` — open item |
| `x` | Toggle select focused item | `X` — select issue |

### Tier 2 — Goto Navigation (G + key chords)

| Sequence | Destination | Linear Equivalent |
|----------|-------------|-------------------|
| `g` then `d` | Dashboard view | `G` then `D` — board view |
| `g` then `a` | Agents view (all agents) | `G` then `A` — active issues |
| `g` then `s` | Settings | `G` then `S` — settings |
| `g` then `i` | Inbox / notifications | `G` then `I` — inbox |
| `g` then `h` | History / past sessions | (custom) |
| `g` then `b` | Browser view (agent browser pane) | (custom) |
| `g` then `l` | Logs view | (custom) |

### Tier 3 — Actions on Focused Item

| Key | Action | Linear Equivalent |
|-----|--------|-------------------|
| `c` | Create new session (opens CommandBar) | `C` — create issue |
| `o` | Open session detail / expand pane | `O` — open item |
| `d` then `d` | Delete / stop session | (archive `#`) |
| `r` | Rename / retitle session | `R` — rename issue |
| `s` | Change status (start/stop/restart) | `S` — change status |
| `p` | Change priority | `P` — change priority |
| `l` | Add label / tag | `L` — add label |
| `a` | Assign agent / model | `A` — assign user |
| `i` | Assign to self | `I` — assign to me |
| `e` | Edit session prompt | `E` — edit issue |
| `y` then `y` | Copy session ID / URL | `Cmd+.` — copy issue ID |
| `.` | Repeat last action | `.` — repeat |
| `u` | Undo last action | `Cmd+Z` — undo |

### Tier 4 — Scroll & Viewport

| Key | Action | Vim Equivalent |
|-----|--------|----------------|
| `Ctrl+d` | Scroll down half page | `Ctrl+d` |
| `Ctrl+u` | Scroll up half page | `Ctrl+u` |
| `H` | Jump to first visible item | `H` — top of screen |
| `M` | Jump to middle visible item | `M` — middle of screen |
| `L` | Jump to last visible item | `L` — bottom of screen |
| `zz` | Center focused item in viewport | `zz` — center line |

### Tier 5 — Search Navigation

| Key | Action | Vim Equivalent |
|-----|--------|----------------|
| `/` | Open search bar (fuzzy filter) | `/` — search forward |
| `n` | Next search result | `n` — next match |
| `N` | Previous search result | `N` — prev match |
| `Escape` | Clear search / close filter | `:noh` — clear highlight |

### Tier 6 — Window/Pane Management

| Key | Action | Vim Equivalent |
|-----|--------|----------------|
| `Ctrl+w` then `h` | Focus left pane | `Ctrl+w h` |
| `Ctrl+w` then `l` | Focus right pane | `Ctrl+w l` |
| `Ctrl+w` then `j` | Focus pane below | `Ctrl+w j` |
| `Ctrl+w` then `k` | Focus pane above | `Ctrl+w k` |
| `Ctrl+w` then `w` | Cycle focus through panes | `Ctrl+w w` |
| `Ctrl+w` then `q` | Close current pane | `Ctrl+w q` |
| `Ctrl+w` then `o` | Maximize pane (close others) | `Ctrl+w o` |

### Tier 7 — Marks & History

| Key | Action | Vim Equivalent |
|-----|--------|----------------|
| `m` then `{a-z}` | Bookmark session/item | `m{a-z}` — set mark |
| `'` then `{a-z}` | Jump to bookmark | `'{mark}` — goto mark |
| `Ctrl+o` | Navigate back | `Ctrl+o` — jump back |
| `Ctrl+i` | Navigate forward | `Ctrl+i` — jump forward |

### Special — Meta

| Key | Action | Linear Equivalent |
|-----|--------|-------------------|
| `?` | Show keyboard shortcuts overlay | `?` — help overlay |
| `Cmd+K` | Command palette (already implemented) | `Cmd+K` — command palette |
| `:` | Open command palette (Vim alias) | (alias for Cmd+K) |

---

## Implementation Architecture

### KeyManager module

```
src/renderer/hub/KeyManager.ts
```

Responsibilities:
- Listen for keydown on `window`
- Detect if focus is in a text input (suppress single-key shortcuts)
- Handle chord sequences (`g`+key, `d`+key, `m`+key) with 500ms timeout
- Dispatch actions via a registry pattern
- Expose `useVimKeys()` hook for React components

### Focus tracking

- Track `activeElement` — if `input`, `textarea`, or `[contenteditable]`, suppress single-key shortcuts
- CommandBar open state also suppresses
- `Escape` always fires (to close modals/inputs first)

### Chord sequence handling

```
First key pressed → enter "pending chord" state → 500ms timeout
Second key pressed within window → dispatch chord action
Timeout → treat first key as standalone action (if it has one)
```

### Visual feedback

- `?` overlay shows all keybindings grouped by category
- Brief toast when chord completes (e.g., "Go to Dashboard")
- Bottom-left status indicator showing current chord prefix (e.g., "g...")

---

## Implementation Order

1. **KeyManager.ts** — core keybinding engine with chord support
2. **j/k/gg/G** — list navigation (highest impact)
3. **/** — search (most requested after navigation)
4. **G+key chords** — goto views
5. **c/o/dd/s** — item actions
6. **?** — help overlay
7. **Ctrl+w pane management** — multi-pane navigation
8. **m/marks** — bookmarks
9. **Ctrl+o/i** — navigation history

---

## Key Decisions

1. **Non-modal** like Linear — no normal/insert/visual modes. Text input focus = suppressed shortcuts.
2. **Chord timeout** of 500ms matches Linear's feel.
3. **`:` maps to Cmd+K** — Vim users expect `:` to open a command line, our CommandBar serves that role.
4. **`c` opens CommandBar** — "create" is the most natural first action, matching Linear's `C`.
5. **Hover-target actions** (Linear's best feature) — defer to v2. Start with keyboard-focus-only targeting.
