import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The Forge VitePlugin sets root = projectDir and outDir = .vite/renderer/shell.
// We point to the hub renderer which replaces the old browser shell.
export default defineConfig({
  // Each renderer gets its own optimize-deps cache so the 4 concurrent
  // dev servers (shell, pill, onboarding, logs) don't race on a shared
  // node_modules/.vite/deps and serve each other 504 "Outdated Optimize
  // Dep" responses on startup.
  cacheDir: path.resolve(__dirname, 'node_modules/.vite/shell'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/hub/hub.html'),
    },
  },
});
