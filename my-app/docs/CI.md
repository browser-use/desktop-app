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
| `typecheck` | ubuntu | ~1m | **yes** | `npm run typecheck` — `tsc --noEmit` |
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

### `release.yml` — tag-driven GitHub Release (+ manual dry-runs)

Two entry points:

1. **Push a `v*.*.*` tag.** This is the primary way to cut a release:

   ```bash
   # make sure my-app/package.json version is what you want in the tag name
   git tag v1.2.3
   git push origin v1.2.3
   ```

   The workflow builds on macOS, produces an unsigned DMG (or a signed +
   notarized DMG if secrets are present), writes `SHA256SUMS.txt`, and
   publishes a GitHub Release at `https://github.com/<owner>/<repo>/releases/tag/v1.2.3`
   with the DMG, zip, and checksums attached. Release notes are
   auto-generated from commits since the previous tag.

2. **`workflow_dispatch`** — for iteration and tester builds. Inputs:

   - `skip-signing` (bool, default `true`) — build unsigned.
   - `tag` (string, optional) — defaults to `v0.0.0-dev-<timestamp>`.
     The workflow always creates a Release at that tag; if it contains
     `-dev`, `-rc`, `-beta`, or `-alpha`, it is marked **prerelease**.

   Example:

   ```bash
   gh workflow run release.yml --ref main \
     -f tag=v0.0.0-smoketest-$(date +%s)
   ```

**Cutting a signed release.** For tag pushes, signing activates
automatically when the secrets are set. For `workflow_dispatch`, flip
`skip-signing: false`. The required secrets:

- `SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Without those secrets, every run is unsigned. `GITHUB_TOKEN` alone is
enough to publish the Release (the workflow grants itself
`contents: write`).

**Cutting a pre-release.** Use a tag with a recognized suffix:
`v1.2.3-rc.1`, `v1.2.3-beta.2`, `v1.2.3-alpha`, `v1.2.3-dev-20260101`.
The workflow flips `prerelease: true` based on substring match.

**Where to find the DMG after release.** Two places:

- **GitHub Release page** — `https://github.com/<owner>/<repo>/releases/tag/<tag>`.
  This is the canonical user-facing download.
- **Workflow artifact** (14-day retention) — Actions → Release run →
  `agentic-browser-<sha>`. Backup path for internal use or if Release
  publishing fails partway.

The workflow does **not** publish to any update channel (no Squirrel /
autoUpdater / brew). Users download the DMG from the Release page.

**Version field.** `my-app/package.json`'s `version` is consumed by Forge
when it names the DMG (`my-app-<version>-arm64.dmg`). Keep the `version`
in sync with the tag you push — e.g. bump to `1.2.3` in a commit before
tagging `v1.2.3`. The workflow does **not** auto-bump this for you.

## Running locally

All commands run from `my-app/`:

```bash
# TS side
npm ci
npm run lint
npm run typecheck          # must be clean (hard-fail in CI)
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

## Soft-fail rollout — cleaned up

Both `tsc --noEmit` and `mypy` used to run soft-fail against pre-existing
baselines. Both have been cleaned up and now hard-fail on any new error:

- **TS (`tsc --noEmit`)** — ~104 errors cleaned up (missing `.svg` module
  declarations, stale test mock types, Vite/forge config drift, React 19
  typings, settings preload-bridge drift, API drift across electron-forge
  and PrintPreview).
- **Python (`mypy`)** — 5 errors cleaned up (`schemas.py` TypedDict
  `version` literal mismatches, `llm.py` None-vs-Anthropic assignment,
  `loop.py` `Any` returns).

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

Each PR should not **increase** the error count for the remaining
soft-fail jobs (Playwright e2e suites). Reviewers check the Actions
log — soft-fail jobs still run, still print diffs, and still produce
a red check next to the green merge status. A PR that adds a new
error in a file that was previously clean should be
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
