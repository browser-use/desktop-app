/**
 * Vite config for the bookmarks renderer (chrome://bookmarks).
 * Follows the same pattern as vite.history.config.ts.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/bookmarks/bookmarks.html'),
    },
  },
});
