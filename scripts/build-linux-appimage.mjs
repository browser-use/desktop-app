#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  console.error(
    'Usage: node scripts/build-linux-appimage.mjs --package-dir <linux-package-dir> --output-dir <dir> [--version <semver>] [--appimagetool <path>]',
  );
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(repoRoot, 'my-app');
const args = process.argv.slice(2);

let packageDir = '';
let outputDir = '';
let version = '';
let appimagetool = process.env.APPIMAGETOOL ?? 'appimagetool';

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--package-dir') {
    packageDir = path.resolve(args[++i] ?? '');
  } else if (arg === '--output-dir') {
    outputDir = path.resolve(args[++i] ?? '');
  } else if (arg === '--version') {
    version = args[++i] ?? '';
  } else if (arg === '--appimagetool') {
    appimagetool = args[++i] ?? '';
  } else {
    console.error(`Unknown option: ${arg}`);
    usage();
    process.exit(2);
  }
}

if (!packageDir || !outputDir) {
  usage();
  process.exit(2);
}

if (!fs.existsSync(packageDir)) {
  console.error(`[linux-appimage] Packaged Linux app not found: ${packageDir}`);
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const appVersion = version || packageJson.version;
const appId = 'browser-use-desktop';
const appName = 'Browser Use';
const executablePath = path.join(packageDir, appId);

if (!fs.existsSync(executablePath)) {
  console.error(`[linux-appimage] Expected Linux executable not found: ${executablePath}`);
  process.exit(1);
}

const workDir = path.join(appRoot, 'out', 'appimage');
const appDir = path.join(workDir, `${appId}.AppDir`);
const appPayloadDir = path.join(appDir, 'usr', 'lib', appId);
const iconSource = path.join(appRoot, 'assets', 'icon.png');
const iconTargetName = `${appId}.png`;

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appPayloadDir, { recursive: true });
fs.cpSync(packageDir, appPayloadDir, { recursive: true, preserveTimestamps: true });

fs.copyFileSync(iconSource, path.join(appDir, iconTargetName));
const hicolorDir = path.join(appDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
fs.mkdirSync(hicolorDir, { recursive: true });
fs.copyFileSync(iconSource, path.join(hicolorDir, iconTargetName));

const appRun = `#!/bin/sh
set -eu
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/lib/${appId}/${appId}" "$@"
`;
fs.writeFileSync(path.join(appDir, 'AppRun'), appRun, { mode: 0o755 });
fs.chmodSync(path.join(appDir, 'AppRun'), 0o755);

const desktopFile = `[Desktop Entry]
Type=Application
Name=${appName}
Comment=Desktop agent hub for Claude Code and Codex
Exec=${appId} %U
Icon=${appId}
Terminal=false
Categories=Utility;Network;
StartupWMClass=${appName}
`;
fs.writeFileSync(path.join(appDir, `${appId}.desktop`), desktopFile);

fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, `Browser-Use-${appVersion}-x64.AppImage`);
fs.rmSync(output, { force: true });

execFileSync(
  appimagetool,
  [appDir, output],
  {
    cwd: appRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ARCH: 'x86_64',
      APPIMAGE_EXTRACT_AND_RUN: '1',
    },
  },
);

const stat = fs.statSync(output);
if (stat.size <= 0) {
  console.error(`[linux-appimage] Empty AppImage output: ${output}`);
  process.exit(1);
}
fs.chmodSync(output, 0o755);
console.log(`[linux-appimage] ${path.relative(repoRoot, output)} (${(stat.size / 1024 / 1024).toFixed(1)} MiB)`);
