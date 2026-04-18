# CI + local testing

This doc explains the CI topology, how to run each check locally, and the
ratchet plan for the remaining soft-fail job (`tsc`).

## Workflows

Three GitHub Actions workflows, all in `.github/workflows/`:

### `ci.yml` — every PR + push to `main`

Fast, parallel jobs that gate merges:

| Job | Runner | ~Time | Gates merge? | What it runs |
|---|---|---|---|---|
| `lint` | ubuntu | ~1m | **yes** | `npm run lint` — eslint on `src/`, `tests/`, config files |
| `typecheck` | ubuntu | ~1m | no (soft-fail) | `npm run typecheck` — `tsc --noEmit` |
| `unit` | ubuntu | ~2m | **yes** | `npm run test:coverage` — vitest unit + integration + coverage artifact |
| `python` | ubuntu | ~2m | **yes** | ruff check, ruff format --check, mypy, `pytest --cov` |

Triggered on `pull_request` and `push` to `main`, or via `workflow_dispatch`.

### `e2e.yml` — every PR + push to `main`

macOS-only, because Playwright-Electron needs a real display and the
build targets `out/my-app-darwin-*/my-app.app`:

| Job | Runner | ~Time | What it runs |
|---|---|---|---|
| `build` | macos | ~8m | `npm run package` (unsigned), uploads artifact |
| `regression` | macos | ~5m | downloads build artifact, runs `tests/regression/` |
| `e2e-smoke` | macos | ~10m | downloads build artifact, runs `golden-path + pill-flow + ipc` |

Both Playwright jobs depend on `build`; the build artifact is reused so
we only pay the ~8 min Forge build cost once per SHA.

### `release.yml` — manual only

`workflow_dispatch` produces a DMG as a downloadable artifact. By default
it builds unsigned (`SKIP_SIGNING=1`). To build signed, flip the input to
`skip-signing: false` and make sure these repo secrets are set:

- `SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

It does **not** publish to any update channel or create a GitHub Release —
that workflow is for producing a build you can hand to a tester.

## Running locally

All commands run from `my-app/`:

```bash
# TS side
npm ci
npm run lint
npm run typecheck          # soft-fail in CI; ~55 known errors
npm run test               # vitest
npm run test:coverage      # same + coverage/ report under tests/results/

# Python side — from my-app/python/
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
ruff check agent tests
ruff format --check agent tests
mypy agent                 # hard-fail in CI; baseline clean
pytest --cov=agent

# Playwright e2e (needs packaged app)
npm run package            # one-time per ref
npx playwright test --config=tests/setup/playwright.config.ts tests/regression/
```

The `qa` script bundles lint + typecheck + test: `npm run qa`.

## Soft-fail rollout (tsc)

`typecheck` (TS) currently runs as informational — it reports errors but
doesn't block merges. This is a deliberate Phase 1 choice because the
baseline is already red:

- **TS (`tsc --noEmit`): ~55 errors.** Surfaced after upgrading `typescript`
  4.5.5 → 5.4 to unblock `@types/node`. Categories: missing `.svg` module
  declarations, settings preload-bridge type drift (passwords handlers),
  missing `electron-updater` dep, stale test mock types, Vite config drift.

Python `mypy` was previously soft-fail but has been cleaned up (5 → 0)
and now hard-fails on any new error.

The same soft-fail treatment applies to the Playwright jobs in `e2e.yml`:

- **`regression`** — `preload-path.spec.ts` fails with
  `electron.launch: Timeout 30000ms exceeded` both on CI and locally.
  The Electron process starts and attaches the debugger, but the
  `_electron.launch()` promise never resolves. Suspected cause is a
  missing init step (perhaps daemon spawn or a renderer ready signal
  that the packaged build doesn't emit when launched outside a real
  UI session). Soft-fail until debugged.
- **`e2e-smoke`** — same launch hang, same fix.

### Flipping to hard-fail

When a baseline is clean, remove `continue-on-error: true` from its job.
The comments in each workflow mark the exact lines.

### Preventing regression while soft

Each PR should not **increase** the error count. Reviewers check the
Actions log — the soft-fail jobs still run, still print diffs, and still
produce a red check next to the green merge status. A PR that adds
a new tsc error in a file that was previously clean should be
sent back.

## Coverage

The vitest config writes `lcov` + `json-summary` to
`my-app/tests/results/coverage/`. Pytest writes `coverage.xml` to
`my-app/python/`. Both are uploaded as workflow artifacts on every `unit`
or `python` job run (names: `coverage-ts`, `coverage-python`).

Coverage is measured but not gated. See `reagan_DIRECTIVES.md` D1 for the
per-module ≥80% expectation on new code — reviewer-enforced for now,
ratchet-enforced later.

## Adding a new test

**Vitest unit** — create `tests/unit/<area>/<name>.test.ts`. It's picked
up automatically by the `include` glob in `vitest.config.ts`.

**Vitest integration** — `tests/integration/<name>.test.ts`. Same picker.
Integration tests may import from `src/main/` and rely on the electron
mock at `tests/fixtures/electron-mock.ts` (aliased via vitest config).

**Playwright e2e** — `tests/e2e/<name>.spec.ts`. Must use
`launchApp()` from `tests/setup/electron-launcher.ts`. Runs against the
packaged app, not `npm start`. Add to the e2e-smoke job in `e2e.yml` if
it's a "must-pass every PR" test; otherwise it's a heavier spec that
runs only on main via a separate workflow (not set up yet).

**Pytest** — `my-app/python/tests/test_<module>.py`. Picked up by
pyproject.toml config. `pytest --cov=agent` runs in CI.

## Dependabot

`.github/dependabot.yml` opens grouped weekly PRs for JS and pip deps
(`npm` in `/my-app`, `pip` in `/my-app/python`), plus monthly GitHub
Actions version bumps. Grouped by electron / react / testing / eslint
so we don't get 12 PRs for one ecosystem update.

## CODEOWNERS

`.github/CODEOWNERS` routes CI infrastructure, forge config, src/main,
src/shared, and python/ to `@sauravpanda` for review. Add more owners
as the team grows.
