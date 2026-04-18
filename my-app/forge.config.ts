import fs from 'fs';
import path from 'path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// ---------------------------------------------------------------------------
// Signing configuration
// ---------------------------------------------------------------------------
// All signing/notarization config reads from environment variables so that:
//   - Local dev builds (no credentials) get SKIP_SIGNING=1 and run unsigned
//   - CI release builds set the real secrets via GitHub Actions secrets
//
// TODO (requires Apple Developer credentials):
//   Set these env vars (see .track-F-handoff.md for full setup guide):
//     SIGNING_IDENTITY  — "Developer ID Application: Your Name (TEAMID)"
//     APPLE_ID          — reagan@browser-use.com
//     APPLE_APP_SPECIFIC_PASSWORD — from appleid.apple.com > App-Specific Passwords
//     APPLE_TEAM_ID     — 10-char Team ID from developer.apple.com/account

const SKIP_SIGNING = process.env.SKIP_SIGNING === '1';
const SIGNING_IDENTITY = process.env.SIGNING_IDENTITY ?? '';
const APPLE_ID = process.env.APPLE_ID ?? '';
const APPLE_APP_SPECIFIC_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD ?? '';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID ?? '';

const IS_MAC = process.platform === 'darwin';
const SHOULD_SIGN = IS_MAC && !SKIP_SIGNING && SIGNING_IDENTITY !== '';

// ---------------------------------------------------------------------------
// PyInstaller binary path
// ---------------------------------------------------------------------------
// The daemon binary is placed in extraResource so Forge copies it to
// Contents/Resources/ in the .app bundle.
// asarUnpack ensures it also lands in app.asar.unpacked/python/agent_daemon
// making it accessible at runtime via process.resourcesPath.
//
// Runtime path resolution (in main process — use utilityProcess to spawn):
//   const daemonBin = app.isPackaged
//     ? path.join(process.resourcesPath, 'agent_daemon')
//     : path.join(__dirname, '../../python/dist/agent_daemon');

const DAEMON_BINARY = path.resolve(__dirname, 'python/dist/agent_daemon');

// Only include the daemon binary in extraResource if it has been built.
// This allows `npm run package` to succeed in CI lint/type-check jobs that
// run before the PyInstaller build step. The release workflow always runs
// python/build.sh before npm run make, so DAEMON_BINARY_EXISTS is true there.
const DAEMON_BINARY_EXISTS = fs.existsSync(DAEMON_BINARY);

// ---------------------------------------------------------------------------
// Forge configuration
// ---------------------------------------------------------------------------

const config: ForgeConfig = {
  packagerConfig: {
    // asar: was `true`. Newer @electron/packager moved `asarUnpack` under
    // `asar.unpack` (glob string, not array), so we now nest the unpack
    // pattern here. The PyInstaller binary MUST be outside the asar — asar
    // files are virtual archives and an executable inside one cannot be
    // directly execv'd by the OS. OnlyLoadAppFromAsar: true fuse enforces
    // that app JS loads from asar; it does NOT prevent extraResource
    // binaries from living outside asar.
    asar: {
      unpack: '**/python/agent_daemon/**',
    },
    // `productName` was removed from ForgePackagerOptions in newer
    // @electron/packager; the field is now `name`. The runtime semantics
    // are identical: the bundled .app/.exe will be named after this.
    name: 'Agentic Browser',

    // extraResource: files/dirs copied verbatim into Contents/Resources/.
    // agent_daemon ends up at: Contents/Resources/agent_daemon
    // After asarUnpack it is also at: Contents/Resources/app.asar.unpacked/python/agent_daemon
    // NOTE: run python/build.sh before npm run make to produce this binary.
    // The conditional prevents packaging failures in CI steps that run before
    // the PyInstaller build step (e.g. lint, type-check, npm run package).
    ...(DAEMON_BINARY_EXISTS && {
      extraResource: [DAEMON_BINARY],
    }),

    // macOS bundle identity — only set when credentials are available.
    ...(SHOULD_SIGN && {
      osxSign: {
        identity: SIGNING_IDENTITY,
        // Newer @electron/osx-sign moved per-file options (hardenedRuntime,
        // entitlements, etc.) behind an optionsForFile callback. Runtime
        // behaviour is equivalent: every file gets hardened runtime and
        // our entitlements.plist, which is what signing requires for
        // Apple notarization.
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: path.resolve(__dirname, 'entitlements.plist'),
        }),
      },
    }),

    // osxNotarize: submits to Apple notarization service after signing.
    // Requires @electron/notarize (listed in .track-F-deps.txt).
    // TODO: uncomment and install @electron/notarize when credentials available.
    // ...(SHOULD_SIGN && APPLE_ID && {
    //   osxNotarize: {
    //     tool: 'notarytool',
    //     appleId: APPLE_ID,
    //     appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    //     teamId: APPLE_TEAM_ID,
    //   },
    // }),

    // App metadata
    appBundleId: 'com.browser-use.agentic-browser',
    appCategoryType: 'public.app-category.productivity',
    icon: 'assets/icon',   // Forge appends .icns on macOS automatically
  },

  rebuildConfig: {},

  makers: [
    // macOS: DMG (replaces MakerZIP for darwin per Critic finding + ADR §12)
    // @electron-forge/maker-dmg must be installed — see .track-F-deps.txt
    new MakerDMG(
      {
        // background: 'assets/dmg-background.png',  // TODO: add DMG background art
        // icon: 'assets/dmg-icon.icns',              // TODO: add volume icon
        format: 'ULFO',   // ULFO = modern compressed format; smaller than UDZO
        overwrite: true,
      },
      ['darwin'],
    ),

    // Windows: Squirrel installer (unchanged from scaffold)
    new MakerSquirrel({}),

    // Linux: deb + rpm (unchanged from scaffold)
    new MakerDeb({}),
    new MakerRpm({}),
  ],

  plugins: [
    new VitePlugin({
      build: [
        {
          // Track A: nested main entry point
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          // Track A: shell preload
          entry: 'src/preload/shell.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Track B: pill preload
          entry: 'src/preload/pill.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Track C: onboarding preload
          entry: 'src/preload/onboarding.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Track 5: settings preload
          entry: 'src/preload/settings.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Issue #45: profile picker preload
          entry: 'src/preload/profilePicker.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Issue #71: extensions preload
          entry: 'src/preload/extensions.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Issue #40: history internal page preload
          entry: 'src/preload/history.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Issue #31: bookmarks manager preload
          entry: 'src/preload/bookmarks.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        // Issue #37: downloads internal page preload — disabled in CI until
        // src/preload/downloads.ts lands alongside the downloads renderer.
        // {
        //   entry: 'src/preload/downloads.ts',
        //   config: 'vite.preload.config.ts',
        //   target: 'preload',
        // },
        {
          // Issue #26: chrome:// internal pages preload
          entry: 'src/preload/chrome.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Issue #97: print preview preload
          entry: 'src/preload/printPreview.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        // Issue #105: new tab page preload — disabled until
        // src/preload/newtab.ts lands alongside the newtab renderer.
        {
          entry: 'src/preload/newtab.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Issue #77: devtools panel preload
          entry: 'src/preload/devtools.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          // Track A: shell renderer (src/renderer/shell/shell.html)
          name: 'shell',
          config: 'vite.renderer.config.ts',
        },
        {
          // Track B: pill renderer (src/renderer/pill/pill.html)
          name: 'pill',
          config: 'vite.pill.config.ts',
        },
        {
          // Track C: onboarding renderer (src/renderer/onboarding/onboarding.html)
          name: 'onboarding',
          config: 'vite.onboarding.config.ts',
        },
        {
          // Track 5: settings renderer (src/renderer/settings/settings.html)
          name: 'settings',
          config: 'vite.settings.config.ts',
        },
        {
          // Issue #45: profile picker renderer
          name: 'profile_picker',
          config: 'vite.profilePicker.config.ts',
        },
        {
          // Issue #71: extensions renderer
          name: 'extensions',
          config: 'vite.extensions.config.ts',
        },
        {
          // Issue #40: history internal page renderer
          name: 'history',
          config: 'vite.history.config.ts',
        },
        {
          // Issue #31: bookmarks manager renderer
          name: 'bookmarks',
          config: 'vite.bookmarks.config.ts',
        },
        // Issue #37: downloads internal page renderer — disabled in CI until
        // the missing vite.downloads.config.ts + src/renderer/downloads/
        // scaffold lands on main. Without this guard electron-forge fails the
        // production build. Restore once the files exist.
        // {
        //   name: 'downloads',
        //   config: 'vite.downloads.config.ts',
        // },
        {
          // Issue #26: chrome:// internal pages renderer
          name: 'chrome_pages',
          config: 'vite.chrome.config.ts',
        },
        {
          // Issue #97: print preview renderer
          name: 'print_preview',
          config: 'vite.printPreview.config.ts',
        },
        // Issue #105: new tab page renderer — disabled until
        // vite.newtab.config.ts lands.
        {
          name: 'newtab',
          config: 'vite.newtab.config.ts',
        },
        {
          // Issue #77: devtools panel renderer
          name: 'devtools_panel',
          config: 'vite.devtools.config.ts',
        },
      ],
    }),

    // ---------------------------------------------------------------------------
    // Fuses — package-time binary patches that enable/disable Electron features.
    // Documented in full at: /Users/reagan/Documents/GitHub/desktop-app/.track-F-fuse-audit.md
    // ---------------------------------------------------------------------------
    new FusesPlugin({
      version: FuseVersion.V1,

      // KEEP FALSE — security hardening. Prevents ELECTRON_RUN_AS_NODE env var
      // from turning the Electron binary into a raw Node.js process. If true,
      // any attacker who can set env vars gets arbitrary code execution as the
      // app user. The Python daemon is spawned via utilityProcess, NOT via
      // child_process.fork (which requires RunAsNode). See ADR §12.
      [FuseV1Options.RunAsNode]: false,

      // KEEP TRUE — encrypts cookies at rest using the OS keychain-backed key.
      // The browser stores session cookies for authenticated sites; encryption
      // protects them from other processes reading the profile directory.
      [FuseV1Options.EnableCookieEncryption]: true,

      // KEEP FALSE — prevents NODE_OPTIONS env var from injecting --require,
      // --inspect, etc. into the Electron process. An attacker who can set
      // NODE_OPTIONS could load arbitrary code or attach a debugger.
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,

      // KEEP FALSE — prevents --inspect and --inspect-brk CLI args from
      // enabling the Node.js inspector in production. Inspector opens a
      // network port that any local process can attach to.
      [FuseV1Options.EnableNodeCliInspectArguments]: false,

      // KEEP TRUE — validates the SHA-256 integrity of asar contents at
      // startup using hashes embedded at package time. Detects tampering
      // with the app bundle after signing/notarization.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,

      // KEEP TRUE — enforces that the Electron main process only loads JS
      // from the asar archive (not loose files). Combined with
      // EnableEmbeddedAsarIntegrityValidation, this prevents an attacker
      // from replacing asar contents with a malicious file.
      // IMPORTANT: The PyInstaller daemon binary is an extraResource placed
      // OUTSIDE the asar (in Contents/Resources/ and app.asar.unpacked/).
      // This fuse does NOT block it — it only governs JS module loading.
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
