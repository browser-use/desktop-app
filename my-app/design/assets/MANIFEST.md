# Design Asset Manifest

This manifest lists every design asset available for Figma import. Assets are NOT duplicated here — the source paths below are canonical. Follow the import instructions in `../FIGMA_IMPORT.md`.

---

## SVG Brand Assets

Source root: `my-app/assets/brand/`

### Wordmarks

| Asset Name | Source Path | Figma Component Name | Background |
|---|---|---|---|
| Wordmark — Dark | `assets/brand/wordmarks/wordmark-dark.svg` | `Brand/Wordmark/Dark` | For `#0a0a0d` / `#1a1a1f` backgrounds |
| Wordmark — Light | `assets/brand/wordmarks/wordmark-light.svg` | `Brand/Wordmark/Light` | For light backgrounds / marketing |

### App Icon

| Asset Name | Source Path | Figma Component Name | Size |
|---|---|---|---|
| App Icon 1024 | `assets/brand/icons/app-icon-1024.svg` | `Brand/Icon/AppIcon1024` | 1024×1024 |

### Architecture Diagrams

| Asset Name | Source Path | Figma Frame Name | Description |
|---|---|---|---|
| Agent Flow | `assets/brand/diagrams/agent-flow.svg` | `Diagram/AgentFlow` | Daemon → CDP → Tab relationship |
| CDP Bridge | `assets/brand/diagrams/cdp-bridge.svg` | `Diagram/CDPBridge` | Main process ↔ daemon Unix socket bridge |
| Pill States | `assets/brand/diagrams/pill-states.svg` | `Diagram/PillStates` | Pill state machine (idle → streaming → done/error) |

---

## PNG Screen Baselines

Source root: `my-app/tests/visual/references/`

These are Playwright visual regression baselines — the current ground truth for every screen.

### Onboarding Flow

| Asset Name | Source Path | Figma Frame Name |
|---|---|---|
| Onboarding — Welcome | `tests/visual/references/onboarding-welcome.png` | `Screen/Onboarding/Welcome` |
| Onboarding — Naming | `tests/visual/references/onboarding-naming.png` | `Screen/Onboarding/Naming` |
| Onboarding — Account | `tests/visual/references/onboarding-account.png` | `Screen/Onboarding/Account` |
| Onboarding — Scopes | `tests/visual/references/onboarding-account-scopes.png` | `Screen/Onboarding/Scopes` |

### Shell

| Asset Name | Source Path | Figma Frame Name |
|---|---|---|
| Shell — Empty | `tests/visual/references/shell-empty.png` | `Screen/Shell/Empty` |
| Shell — Three Tabs | `tests/visual/references/shell-3-tabs.png` | `Screen/Shell/ThreeTabs` |

### Pill Overlay

| Asset Name | Source Path | Figma Frame Name |
|---|---|---|
| Pill — Idle | `tests/visual/references/pill-idle.png` | `Screen/Pill/Idle` |
| Pill — Streaming | `tests/visual/references/pill-streaming.png` | `Screen/Pill/Streaming` |
| Pill — Done | `tests/visual/references/pill-done.png` | `Screen/Pill/Done` |
| Pill — Error | `tests/visual/references/pill-error.png` | `Screen/Pill/Error` |

---

## Token File

| Asset Name | Source Path | Format |
|---|---|---|
| Design Tokens | `my-app/design/figma-tokens.json` | Tokens Studio (JSON) |

---

## How to Import

See `my-app/design/FIGMA_IMPORT.md` for step-by-step instructions.

For automated import via the Figma REST API, see `my-app/scripts/export-to-figma.ts`.
