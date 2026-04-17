/**
 * Shell renderer entry point.
 * Mounts the WindowChrome React tree into #root.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { WindowChrome } from './WindowChrome';
import './shell.css';
import './components.css';

window.addEventListener('error', (e) => {
  console.error('renderer.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('renderer.unhandledrejection', { reason: String(e.reason) });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('[shell] #root element not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <WindowChrome />
  </React.StrictMode>,
);
