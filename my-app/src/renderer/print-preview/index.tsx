/**
 * Print preview renderer entry point.
 * Sets data-theme="onboarding" and mounts <PrintPreviewApp />.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import { loadFonts } from '../design/fonts';
import '../design/theme.global.css';
import '../design/theme.onboarding.css';
import '../components/base/components.css';
import './print-preview.css';

import { PrintPreviewApp } from './PrintPreviewApp';

document.documentElement.dataset.theme = 'onboarding';
loadFonts();

window.addEventListener('error', (e) => {
  console.error('renderer.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('renderer.unhandledrejection', { reason: String(e.reason) });
});

const container = document.getElementById('print-preview-root');
if (!container) {
  throw new Error('[print-preview] #print-preview-root element not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <PrintPreviewApp />
  </React.StrictMode>,
);
