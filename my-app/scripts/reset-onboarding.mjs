#!/usr/bin/env node
/**
 * reset-onboarding.mjs
 *
 * Deletes account.json (the onboarding gate) from the default Electron userData
 * directory so that `npm start` re-triggers the onboarding flow on next launch.
 * Does NOT touch the keychain or session.json (to preserve open tabs).
 *
 * Run: node scripts/reset-onboarding.mjs
 *      (or `npm run start:reset-onboarding`)
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readProductName() {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
  );
  return pkg.productName ?? pkg.name ?? "my-app";
}

function defaultUserDataDir(productName) {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", productName);
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), productName);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), productName);
  }
}

const productName = readProductName();
const userData = defaultUserDataDir(productName);
const accountJson = join(userData, "account.json");

console.log(`[reset-onboarding] productName=${productName}`);
console.log(`[reset-onboarding] userData=${userData}`);

const sessionsDb = join(userData, "sessions.db");

for (const [label, filePath] of [["account.json", accountJson], ["sessions.db", sessionsDb]]) {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    console.log(`[reset-onboarding] deleted ${label}`);
  } else {
    console.log(`[reset-onboarding] ${label} not found (already clean)`);
  }
}

console.log(
  "[reset-onboarding] run `npm start` — the onboarding window will appear on next launch.",
);
