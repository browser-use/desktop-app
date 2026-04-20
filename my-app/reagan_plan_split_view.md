# Split View Plan — Browser + Logs Side by Side

## Current State
- `showBrowser` is a boolean (true/false)
- One toggle button cycles between Output and Browser
- Browser view covers the entire output area when active
- Output div is always rendered but hidden behind the native BrowserView

## Target State
Three view modes per pane: **Output**, **Split**, **Browser**

### View Modes

| Mode | Browser | Output Log | Button State |
|------|---------|-----------|--------------|
| Output | Hidden (detached) | Full pane | Output active |
| Split | Top 60% of pane | Bottom 40% of pane, scrollable | Split active |
| Browser | Full pane | Behind browser (not visible) | Browser active |

### UI Changes

**Three buttons in pane header:**
```
[Output] [Split] [Browser]
```
- Each is a `pane__action-btn`
- Active state uses `pane__action-btn--active` (or `--primary` for emphasis)
- Split icon: horizontal split (two stacked rectangles)

### Implementation Steps

1. **Change state type** — `showBrowser: boolean` → `viewMode: 'output' | 'split' | 'browser'`

2. **Split icon** — new SVG: two stacked horizontal rectangles

3. **Three buttons** — replace the single toggle with three buttons in the actions bar

4. **Browser bounds calculation:**
   - `output` mode: detach browser view
   - `browser` mode: browser bounds = full output area rect
   - `split` mode: browser bounds = top 60% of output area rect

5. **Output div styling:**
   - `output` mode: full height, normal
   - `browser` mode: full height, behind browser (already works since we removed visibility:hidden)
   - `split` mode: needs to only show the bottom 40%. Two approaches:
     - **Option A**: Add a spacer div at the top of the output scroll area equal to the browser height, so content starts below the browser
     - **Option B**: Use CSS to position the output div to only occupy the bottom portion
     - **Option A is simpler** — just add `padding-top` equal to browser height

6. **ResizeObserver** — already watches the output div. For split mode, calculate bounds as top portion only.

7. **viewIsAttached on mount** — query browser state and set initial viewMode accordingly

### Files to Change
- `AgentPane.tsx` — state, buttons, bounds calculation, split layout
- `hub.css` — split icon, possibly output div split mode class

### Edge Cases
- Follow-up input in split mode: show at bottom of the log section (already works)
- Browser dead state: show Output and Split as disabled
- Resize/grid layout change: detach all views (existing behavior), reset to output mode
