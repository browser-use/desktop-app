## Summary

<!-- 1-3 bullets describing what this PR changes and why. -->

## Test plan

<!-- How did you verify this works? Check all that apply, add notes. -->

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes (unit + integration)
- [ ] New code has tests (per [D1 directive](../reagan_DIRECTIVES.md) — TDD, ≥80% coverage on new `src/main`/`src/shared` modules)
- [ ] Python changes: `pytest` + `ruff check` + `mypy` pass
- [ ] Manual QA in `npm run dev` for UI-facing changes

## Screenshots / recordings

<!-- Required for any UI change. Use macOS Cmd+Shift+5 for screen recordings. -->

## Risk + rollback

<!-- Anything scary about this change? Migration, breaking IPC contract,
     permissions model, keychain, telemetry? How to revert if it breaks prod? -->
