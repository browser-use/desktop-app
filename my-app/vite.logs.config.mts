import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Logs renderer — a small always-on-top window pinned to the hub's bottom-right
// that hosts an xterm instance for the focused session.
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer/logs'),
  cacheDir: path.resolve(__dirname, 'node_modules/.vite/logs'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/logs/logs.html'),
    },
  },
});
