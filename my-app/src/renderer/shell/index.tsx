/**
 * Shell renderer entry point.
 * Mounts the WindowChrome React tree into #root.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { WindowChrome } from './WindowChrome';

// Design tokens MUST load before any component CSS. shell.css + components.css
// reference semantic vars (--color-bg-base, --slate-*, etc.) defined in
// theme.global.css :root. Without this, every var() resolves to nothing →
// transparent surfaces → black renderer. theme.shell.css is intentionally NOT
// imported: its component-scoped [data-theme="shell"] .tab-strip rules would
// override components.css layout. The :root in theme.global.css already ships
// shell-theme defaults (slate ramp is the shell palette).
import '../design/theme.global.css';
import './shell.css';
import './components.css';
import './downloads.css';
import './sidepanel.css';
import './share.css';

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
