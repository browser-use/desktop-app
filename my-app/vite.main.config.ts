import { defineConfig } from 'vite';

// https://vitejs.dev/config
// package.json sets "main": ".vite/build/main.js" — Forge and Electron packager
// both require that exact filename. Force output to main.js regardless of entry
// file name (index.ts, main.ts, etc.) via rollupOptions.output.entryFileNames.
export default defineConfig({
  resolve: {
    // Ensure correct resolution of node built-ins.
    // The old `browserField: false` option was removed in Vite 5; the
    // explicit `mainFields` list below already excludes `browser`, which
    // is the effective behaviour we want in the main process bundle.
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // electron-updater has a native-ish stack (fs-extra, js-yaml,
      // builder-util-runtime) that must be resolved at runtime from
      // node_modules rather than bundled into main.js — Forge copies the
      // dependency tree into the asar, and bundling it would also drop the
      // lazy macOS auto-update HTTP server.
      external: ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', 'dotenv', 'electron-updater', 'bufferutil', 'utf-8-validate', 'better-sqlite3', 'sharp'],
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});
