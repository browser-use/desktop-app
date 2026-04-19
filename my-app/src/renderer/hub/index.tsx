/**
 * Hub renderer entry point.
 * Mounts the HubApp React tree into #hub-root.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { HubApp } from './HubApp';
import '@/renderer/design/theme.global.css';
import './hub.css';

// Apply shell theme — hub uses the same dark palette
document.documentElement.dataset.theme = 'shell';

window.addEventListener('error', (e) => {
  console.error('[hub] renderer.error', { message: e.message, file: e.filename, line: e.lineno });
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[hub] renderer.unhandledrejection', { reason: String(e.reason) });
});

const rootEl = document.getElementById('hub-root');
if (!rootEl) throw new Error('[hub] #hub-root element not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <HubApp />
  </React.StrictMode>,
);
