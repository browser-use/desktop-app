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

if (debs.length === 0 || rpms.length === 0) {
  console.error(`[linux-artifacts] Missing Linux package output under ${makeDir}`);
  console.error(`[linux-artifacts] .deb count: ${debs.length}`);
  console.error(`[linux-artifacts] .rpm count: ${rpms.length}`);
  process.exit(1);
}

for (const artifact of [...debs, ...rpms]) {
  const stat = fs.statSync(artifact);
  if (stat.size <= 0) {
    console.error(`[linux-artifacts] Empty artifact: ${artifact}`);
    process.exit(1);
  }
  console.log(`[linux-artifacts] ${path.relative(repoRoot, artifact)} (${formatSize(stat.size)})`);
}
