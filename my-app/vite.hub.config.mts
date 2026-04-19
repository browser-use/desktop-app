import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config
// Hub renderer: agent orchestration hub — sidebar + session panel layout.
// Vite root is src/renderer/hub; HTML entry is hub.html.
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer/hub'),
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
