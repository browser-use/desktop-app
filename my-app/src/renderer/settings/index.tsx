/**
 * Settings renderer entry point.
 *
 * Sets data-theme="onboarding" on <html> before React mounts.
 * Mounts <SettingsApp /> into #settings-root.
 *
 * Window: 720×560, resizable: false, titleBarStyle: 'hiddenInset'
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import { loadFonts } from '../design/fonts';
import '../design/theme.global.css';
import '../design/theme.onboarding.css';
import '../components/base/components.css';
import './settings.css';

import { SettingsApp } from './SettingsApp';

// ---------------------------------------------------------------------------
// Theme activation — must happen before React mounts
// ---------------------------------------------------------------------------

document.documentElement.dataset.theme = 'onboarding';
loadFonts();

window.addEventListener('error', (e) => {
  console.error('renderer.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('renderer.unhandledrejection', { reason: String(e.reason) });
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const container = document.getElementById('settings-root');
if (!container) {
  throw new Error('[settings] #settings-root element not found in settings.html');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
