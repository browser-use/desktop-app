import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';
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
// Forge configuration
// ---------------------------------------------------------------------------

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // `productName` was removed from ForgePackagerOptions in newer
    // @electron/packager; the field is now `name`. The runtime semantics
    // are identical: the bundled .app/.exe will be named after this.
    name: 'Browser Use',

    // Exclude dev-only files from the packaged app.asar. Without this,
    // Forge ships src/, tests/, personal planning .md files, Vite
    // source configs, CI configs, README, etc. — the DMG balloons and
    // users get dev notes. Paths arrive with a leading slash.
    ignore: [
      /^\/src($|\/)/,                             // TS source; compiled output is in .vite/build
      /^\/tests($|\/)/,
      /^\/scripts($|\/)/,
      /^\/python($|\/)/,                          // daemon removed; defensive
      /^\/harnessless($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.claude($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/coverage($|\/)/,
      /^\/reagan_.*$/,                            // personal planning docs
      /^\/.*\.md$/,                               // all markdown (README, docs, etc.)
      /^\/tsconfig.*\.json$/,
      /^\/eslint\.config\.(ts|mts|js|mjs|cjs)$/,
      /^\/vite\..*\.(ts|mts)$/,                   // dev-time vite configs
      /^\/forge\.config\.(ts|js)$/,
      /^\/playwright\.config\.(ts|js)$/,
      /^\/knip\.json$/,
      /^\/\.env(\..+)?$/,                         // never ship .env to users
      /^\/Taskfile\.ya?ml$/,
      /^\/.+\.map$/,                              // sourcemaps
    ],

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
    appBundleId: 'com.browser-use.desktop',
    appCategoryType: 'public.app-category.productivity',
    icon: 'assets/icon',   // Forge appends .icns on macOS automatically
  },

  rebuildConfig: {},

  hooks: {
    // @electron-forge/plugin-vite excludes node_modules from the packaged app,
    // so externals listed in vite.main.config.ts (dotenv, electron-updater,
    // better-sqlite3, keytar, etc.) are missing at runtime and main.js
    // crashes on first require('dotenv'). Re-install production deps into
    // the packaged dir so externals resolve.
    packageAfterPrune: async (_config, buildPath, electronVersion) => {
      const pkgPath = path.join(buildPath, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const prodDeps = Object.keys(pkg.dependencies ?? {});
      if (prodDeps.length === 0) return;
      execSync(
        `npm install --omit=dev --no-package-lock --no-save --legacy-peer-deps ${prodDeps.map((d) => `"${d}"`).join(' ')}`,
        { cwd: buildPath, stdio: 'inherit' },
      );
      // npm install just built native modules against the host Node ABI.
      // Electron uses a different NODE_MODULE_VERSION, so rebuild them
      // against Electron's headers before asar packaging.
      const { rebuild } = await import('@electron/rebuild');
      await rebuild({ buildPath, electronVersion, arch: process.arch });
    },
  },

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
          // Main process entry point
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          // Shell preload
          entry: 'src/preload/shell.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Pill preload
          entry: 'src/preload/pill.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Onboarding preload
          entry: 'src/preload/onboarding.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Logs preload (small overlay window hosting xterm for focused session)
          entry: 'src/preload/logs.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          // Shell renderer (src/renderer/shell/shell.html)
          name: 'shell',
          config: 'vite.renderer.config.mts',
        },
        {
          // Pill renderer (src/renderer/pill/pill.html)
          name: 'pill',
          config: 'vite.pill.config.mts',
        },
        {
          // Onboarding renderer
          name: 'onboarding',
          config: 'vite.onboarding.config.mts',
        },
        {
          // Logs renderer (src/renderer/logs/logs.html)
          name: 'logs',
          config: 'vite.logs.config.mts',
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
      // app user.
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
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
