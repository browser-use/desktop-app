#!/usr/bin/env node
const h = require('./helpers');
Object.assign(globalThis, h);
(async () => {
  await ensure_daemon();
  const code = require('fs').readFileSync(0, 'utf-8');
  await eval(`(async()=>{\n${code}\n})()`);
})().catch(e => { console.error(e.message); process.exit(1); });
