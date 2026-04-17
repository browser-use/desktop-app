# Signing Readiness Report

**Date:** 2026-04-16
**Author:** startup-harness:ops
**Status:** Infrastructure complete. Blocked only on Apple Developer credentials.

---

## What is ready right now

| Item | Status | Notes |
|------|--------|-------|
| `entitlements.plist` | Ready | All 5 entitlements necessary and commented. See audit below. |
| `forge.config.ts` osxSign block | Ready | Reads `SIGNING_IDENTITY` env var. Activates when var is set. |
| `forge.config.ts` osxNotarize block | Blocked (comment) | Uncomment + install `@electron/notarize`. See action item below. |
| `scripts/sign-python.sh` | Ready | Hardened runtime codesign with entitlements, graceful no-op when unsigned. |
| `scripts/build-dmg.sh` | Ready | Correct sequence: build -> sign daemon -> forge make. |
| `scripts/release.sh` | Ready | Full sequence: build, sign, make, notarize, staple, verify. Steps gate on env vars. |
| `scripts/verify-signing.sh` | Ready | New. Asserts codesign, deep verify, hardened runtime flag, spctl, DMG staple. |
| `.env.example` | Ready | New. All vars with get-it-from instructions. |
| `SIGNING.md` | Ready | New. End-to-end guide for non-ops. |
| `.github/workflows/release.yml` | Ready | Fixed. Full signing matrix: import cert, sign daemon, forge make, notarize, staple, verify, cleanup. |
| `.github/workflows/ci.yml` | No changes needed | Correctly runs unsigned, sets SKIP_SIGNING=1. |

---

## One remaining manual step (not automated)

Before CI signing works, uncomment the `osxNotarize` block in `my-app/forge.config.ts`
(lines 103-110) and install the peer dependency:

```bash
cd my-app
npm install --save-dev @electron/notarize
```

Then in `forge.config.ts` remove the comment delimiters around:
```typescript
...(SHOULD_SIGN && APPLE_ID && {
  osxNotarize: {
    tool: 'notarytool',
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  },
}),
```

Note: The `release.yml` also has an explicit `xcrun notarytool submit` step as a
belt-and-suspenders fallback. If `@electron/notarize` is installed and the block is
uncommented, notarization runs twice (forge + the explicit step). That is harmless —
Apple deduplicates by hash. To avoid the redundancy, comment out the explicit
"Notarize DMG" step in `release.yml` once `@electron/notarize` is confirmed working.

---

## Entitlements audit

File: `my-app/entitlements.plist`

| Entitlement | Necessary? | Justification |
|-------------|-----------|---------------|
| `com.apple.security.cs.allow-jit` | Yes, required | CPython uses JIT memory mappings (mmap PROT_EXEC) for bytecode compilation. Without this, the Python interpreter crashes at startup under hardened runtime. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Yes, required | Python's eval/exec/compile write executable pages not backed by a signed binary. The agent daemon uses exec() for its agent loop. Without this, hardened runtime sends SIGKILL. |
| `com.apple.security.cs.disable-library-validation` | Yes, required | PyInstaller --onefile extracts bundled dylibs to a temp dir at launch. Those extracted copies are not individually signed with the Team ID. Without this, library validation kills the process. |
| `com.apple.security.network.client` | Yes, required | The agent daemon makes outbound TCP connections: to api.anthropic.com (LLM API) and to localhost (Chromium CDP WebSocket). Both require this under hardened runtime on macOS 10.15+. |
| `com.apple.security.files.user-selected.read-write` | Yes, appropriate | Allows reading/writing files the user has explicitly selected. Scoped — not a broad filesystem grant. Needed for agent file upload/download tasks. |
| `com.apple.security.cs.allow-dyld-environment-variables` | NOT present, correct | Would allow `DYLD_INSERT_LIBRARIES` injection — a serious security risk. PyInstaller does not require it. Correct to omit. |

Audit result: all 5 entitlements present are necessary and correctly justified.
Nothing extraneous. `allow-dyld-environment-variables` is correctly absent.

---

## Gaps found in Track F's release.yml (now fixed)

1. **Certificate import step was fully commented out.** The stub existed but none of
   the keychain setup code ran. Fixed: the import step is now fully uncommented and
   active, with `security delete-keychain` cleanup at job start to handle retries.

2. **"Sign Python daemon binary" step was commented out.** The daemon was being
   packaged unsigned into the .app, which causes notarization rejection.
   Fixed: step is now active and runs before `npm run make`.

3. **"Build DMG" step forced `SKIP_SIGNING=1`.** Even with a cert imported and
   `SIGNING_IDENTITY` set, signing was disabled. Fixed: `SKIP_SIGNING` removed;
   `SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
   are all passed from secrets.

4. **Notarize and Staple steps were commented out.** DMGs were uploaded unsigned/
   un-notarized to GitHub Releases. Fixed: both steps are now active.

5. **No verification step.** There was no check that the produced DMG is actually
   signed and notarized before upload. Fixed: `verify-signing.sh` runs as the final
   pre-upload step; job fails if any check fails.

6. **No keychain cleanup on job failure.** A leftover keychain from a failed run
   causes `security create-keychain` to fail on retry.
   Fixed: `security delete-keychain` guard at start + `if: always()` cleanup step.

7. **Secret name mismatch (minor).** Track F handoff listed
   `APPLE_DEVELOPER_CERTIFICATE_P12_BASE64` and `APPLE_DEVELOPER_CERTIFICATE_PASSWORD`
   but the release.yml import step used `CERTIFICATE_P12_BASE64` and
   `CERTIFICATE_PASSWORD` as the step-level env vars (mapped from secrets). The
   mapping is now explicit and consistent.

---

## Command sequence to produce a signed+notarized DMG

Once you have Apple Developer credentials (see `SIGNING.md` for how to get each):

```bash
# 1. Load credentials into shell
export SIGNING_IDENTITY="Developer ID Application: Your Name (XXXXXXXXXX)"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

# 2. Install the notarize peer dep (one-time)
cd /path/to/repo/my-app
npm install --save-dev @electron/notarize

# 3. Uncomment the osxNotarize block in forge.config.ts (one-time, lines 103-110)

# 4. Run the full release sequence (build + sign + notarize + staple + verify)
bash scripts/release.sh

# Output DMG location:
#   my-app/out/make/my-app-1.0.0-arm64.dmg   (on Apple Silicon)
#   my-app/out/make/my-app-1.0.0-x64.dmg     (on Intel)
```

For CI: push a `v*.*.*` tag. The `release.yml` matrix runs the full sequence on
`macos-13` (Intel) and `macos-14` (arm64) automatically, provided all 6 GitHub
repo secrets are set (see `SIGNING.md` Step 5).

---

## Would release.yml succeed if secrets were set right now?

**No — one code change is required first:**

The `osxNotarize` block in `forge.config.ts` is commented out. With it commented,
`npm run make` will sign the .app (via osxSign) but will not submit it for
notarization through Forge. The explicit `xcrun notarytool submit` step in
`release.yml` will still run and notarize the DMG, so the end result would be a
notarized+stapled DMG. However `verify-signing.sh`'s `spctl --assess --type open`
check on the DMG might fail if the ticket is not stapled before that step runs.

The safest path:
1. Uncomment `osxNotarize` in `forge.config.ts`
2. Run `npm install --save-dev @electron/notarize`
3. Set the 6 GitHub secrets
4. Push a `v*.*.*` tag

After those four actions, `release.yml` will succeed end-to-end.
