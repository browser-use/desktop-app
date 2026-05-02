#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makeDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'my-app', 'out', 'make'));

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const files = walk(makeDir);
const debs = files.filter((file) => file.endsWith('.deb'));
const rpms = files.filter((file) => file.endsWith('.rpm'));
const appImages = files.filter((file) => file.endsWith('.AppImage'));
const updateFeeds = files.filter((file) => path.basename(file) === 'latest-linux.yml');

if (debs.length === 0 || rpms.length === 0 || appImages.length === 0 || updateFeeds.length === 0) {
  console.error(`[linux-artifacts] Missing Linux package output under ${makeDir}`);
  console.error(`[linux-artifacts] .deb count: ${debs.length}`);
  console.error(`[linux-artifacts] .rpm count: ${rpms.length}`);
  console.error(`[linux-artifacts] .AppImage count: ${appImages.length}`);
  console.error(`[linux-artifacts] latest-linux.yml count: ${updateFeeds.length}`);
  process.exit(1);
}

for (const artifact of [...debs, ...rpms, ...appImages, ...updateFeeds]) {
  const stat = fs.statSync(artifact);
  if (stat.size <= 0) {
    console.error(`[linux-artifacts] Empty artifact: ${artifact}`);
    process.exit(1);
  }
  console.log(`[linux-artifacts] ${path.relative(repoRoot, artifact)} (${formatSize(stat.size)})`);
}

const updateFeed = updateFeeds[0];
const manifest = fs.readFileSync(updateFeed, 'utf8');
const pathMatch = manifest.match(/^path:\s*['"]?([^'"\n]+)['"]?/m);
if (!pathMatch || !pathMatch[1].endsWith('.AppImage')) {
  console.error('[linux-artifacts] latest-linux.yml must use an AppImage as its primary path');
  process.exit(1);
}

const referencedAppImage = pathMatch[1];
if (!appImages.some((appImage) => path.basename(appImage) === referencedAppImage)) {
  console.error(`[linux-artifacts] latest-linux.yml references missing AppImage: ${referencedAppImage}`);
  process.exit(1);
}
