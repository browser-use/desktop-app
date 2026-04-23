import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config
// Pill renderer: transparent frameless overlay for the Cmd+K agent UX.
// Vite root is src/renderer/pill; HTML entry is pill.html.
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer/pill'),
  cacheDir: path.resolve(__dirname, 'node_modules/.vite/pill'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/pill/pill.html'),
    },
  },
});
