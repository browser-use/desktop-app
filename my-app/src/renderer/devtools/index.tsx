import React from 'react';
import { createRoot } from 'react-dom/client';

import { loadFonts } from '../design/fonts';
import '../design/theme.global.css';
import '../components/base/components.css';
import './devtools.css';

import { DevToolsApp } from './DevToolsApp';

loadFonts();

window.addEventListener('error', (e) => {
  console.error('[devtools] renderer.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[devtools] renderer.unhandledrejection', { reason: String(e.reason) });
});

const container = document.getElementById('devtools-root');
if (!container) {
  throw new Error('[devtools] #devtools-root element not found in devtools.html');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <DevToolsApp />
  </React.StrictMode>,
);
