# Code Signing and Notarization Guide

This guide walks a non-ops person through everything needed to produce a
signed and notarized DMG for Intel (x86_64) and Apple Silicon (arm64).

---

## What you need before starting

- A **paid Apple Developer account** ($99/year) at https://developer.apple.com
- A Mac with Xcode command-line tools installed (`xcode-select --install`)
- The repo checked out locally with Node 20 and Python 3.11 available

---

## Step 1 — Get your credentials

### 1a. Apple Team ID

1. Log in to https://developer.apple.com/account
2. Click **Membership Details** in the left sidebar
3. Your **Team ID** is the 10-character alphanumeric string (e.g. `AB12CD34EF`)

### 1b. Developer ID Application certificate

1. Open **Xcode** > Settings (cmd+,) > **Accounts**
2. Select your Apple ID and click **Manage Certificates**
3. If no "Developer ID Application" certificate exists, click the **+** button
   and choose "Developer ID Application"
4. The certificate will appear in **Keychain Access** > My Certificates

Verify from terminal:
```
security find-identity -v -p codesigning
```
You should see a line like:
```
1) ABCDEF1234... "Developer ID Application: Your Name (XXXXXXXXXX)"
```
Copy the full quoted string — this is your `SIGNING_IDENTITY`.

### 1c. App-specific password

1. Go to https://appleid.apple.com/account/manage
2. Sign in with your Apple ID
3. Under **App-Specific Passwords**, click **Generate Password**
4. Name it something like "desktop-app notarization"
5. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

### 1d. Export .p12 certificate (needed for CI only)

1. Open **Keychain Access**
2. Under **My Certificates**, find your **Developer ID Application** certificate
3. Right-click > **Export "Developer ID Application: ..."**
4. Save as a `.p12` file with a strong password (remember this password)
5. Base64-encode it for GitHub secrets:
   ```
   base64 -i certificate.p12 | pbcopy
   ```

---

## Step 2 — Set environment variables locally

Create `my-app/.env` from the template (never commit this file):
```
cp my-app/.env.example my-app/.env
```

Edit `my-app/.env` and fill in your real values:
```
APPLE_TEAM_ID=AB12CD34EF
APPLE_ID=you@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
SIGNING_IDENTITY=Developer ID Application: Your Name (AB12CD34EF)
```

Load the variables in your shell:
```
set -a && source my-app/.env && set +a
```

---

## Step 3 — Activate notarization in forge.config.ts

The `osxNotarize` block in `my-app/forge.config.ts` is currently commented out.
Uncomment it when credentials are available:

```typescript
// Find this block in packagerConfig and uncomment:
...(SHOULD_SIGN && APPLE_ID && {
  osxNotarize: {
    tool: 'notarytool',
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  },
}),
```

Also ensure `@electron/notarize` is installed (it is listed in `.track-F-deps.txt`):
```
cd my-app && npm install --save-dev @electron/notarize
```

---

## Step 4 — Run a signed local build

From the repo root:
```bash
# Load credentials
set -a && source my-app/.env && set +a

# Build Python daemon, sign it, build + sign Electron app, notarize, staple
cd my-app
bash scripts/release.sh
```

Or step by step:
```bash
cd my-app

# 1. Build Python daemon
bash python/build.sh

# 2. Sign the daemon binary (must happen BEFORE forge packages the .app)
bash scripts/sign-python.sh python/dist/agent_daemon

# 3. Build + sign the Electron app (forge calls osxSign + osxNotarize internally)
npm run make

# 4. Staple notarization ticket to the DMG (for offline Gatekeeper verification)
xcrun stapler staple out/make/*.dmg

# 5. Verify
bash scripts/verify-signing.sh
```

---

## Step 5 — Set GitHub repository secrets for CI

Go to your GitHub repo > **Settings** > **Secrets and variables** > **Actions**
> **New repository secret** for each of the following:

| Secret name | Value |
|---|---|
| `APPLE_TEAM_ID` | Your 10-char Team ID |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The `xxxx-xxxx-xxxx-xxxx` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (XXXXXXXXXX)` |
| `APPLE_DEVELOPER_CERTIFICATE_P12_BASE64` | Output of `base64 -i cert.p12` |
| `APPLE_DEVELOPER_CERTIFICATE_PASSWORD` | The .p12 export password |

---

## Step 6 — Trigger a signed CI release

1. Commit and push your changes to a feature branch and merge to `main`
2. Tag the commit:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. GitHub Actions `release.yml` triggers automatically on the `v*.*.*` tag
4. The matrix runs two jobs: `macos-13` (Intel) and `macos-14` (arm64)
5. Each job imports the certificate, signs the daemon, builds the DMG,
   notarizes it, staples it, and attaches it to the GitHub Release

Monitor the run at:
```
https://github.com/<org>/<repo>/actions
```

---

## Step 7 — Verify a signed DMG

After a local or CI build, run:
```bash
cd my-app
bash scripts/verify-signing.sh
```

Or manually:

```bash
# 1. Check the .app bundle signature
codesign -dvvv "out/My App-darwin-arm64/My App.app"

# 2. Check the nested daemon binary
codesign -dvvv "out/My App-darwin-arm64/My App.app/Contents/Resources/agent_daemon"

# 3. Gatekeeper assessment (requires notarization to pass)
spctl --assess --type execute --verbose "out/My App-darwin-arm64/My App.app"

# 4. Check notarization status of the DMG
xcrun stapler validate out/make/*.dmg

# 5. Query notarization history (uses notarytool)
xcrun notarytool history \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id  "$APPLE_TEAM_ID"
```

A fully notarized DMG will show:
```
source=Notarized Developer ID
```
in the `spctl` output.

---

## Common failures and fixes

### "resource fork, Finder information, or similar detritus not allowed"

Cause: Extended attributes on files in the bundle.
Fix: Strip extended attributes before signing.
```bash
xattr -cr "out/My App-darwin-arm64/My App.app"
```
Electron Forge does this automatically, but PyInstaller output sometimes
carries xattrs from the build machine. Run `xattr -cr python/dist/agent_daemon`
before calling `sign-python.sh`.

### "CSSMERR_TP_NOT_TRUSTED" or "certificate not trusted"

Cause: Developer ID Application certificate is not in the system trust store,
or the certificate is expired.
Fix: Open Keychain Access, find the certificate, and verify it shows a green
checkmark. Re-download from developer.apple.com if needed.

### notarytool: "The software asset has already been uploaded"

This is not an error. Apple deduplicates submissions by hash. If the DMG is
identical to a prior submission, Apple returns the cached result immediately.

### notarytool: "The signature of the binary is invalid"

Cause: The binary was modified after signing (e.g., UPX compression, stripping
symbols). PyInstaller's spec already sets `upx=False` for this reason.
Fix: Verify `pyinstaller.spec` has `upx=False` and `strip=False`.

### "hardened runtime: library validation failed" at launch

Cause: The PyInstaller binary loads a `.dylib` that is not signed with the same
Team ID, and `disable-library-validation` is not in the entitlements.
Fix: `com.apple.security.cs.disable-library-validation` is already present in
`entitlements.plist`. Verify it is passed via `--entitlements` in `sign-python.sh`.

### "allow-unsigned-executable-memory" rejected by notarization

Cause: Apple's notarization scanner flags `allow-unsigned-executable-memory` in
some code paths. This entitlement is required for CPython. The app will still
notarize — Apple's automated scan may emit a warning but will not reject the
submission for this entitlement on a daemon binary.
If Apple rejects it, open a ticket with Apple DTS (Developer Technical Support).

### Gatekeeper quarantine on downloaded DMG

After downloading from a browser, macOS quarantines the DMG. This is expected.
After notarization and stapling, the quarantine flag is cleared automatically
when the user opens the DMG in Finder. If testing from the command line:
```bash
xattr -d com.apple.quarantine my-app.dmg
```

### CI keychain import fails: "The specified item already exists"

Cause: A prior run left the keychain in place.
Fix: Add a cleanup step at the start of the job:
```bash
security delete-keychain $RUNNER_TEMP/signing.keychain-db 2>/dev/null || true
```
This is already handled in the recommended keychain setup block in `release.yml`.

### Python binary fails notarization with "executable with altered code"

Cause: The binary was codesigned, then modified (e.g., by Forge's re-packing).
Fix: The `sign-python.sh` step must run AFTER `python/build.sh` produces the
final binary and BEFORE `npm run make` packages it into the .app. The sequence
in `scripts/release.sh` and `release.yml` enforces this order.
