import React from 'react';
import { createRoot } from 'react-dom/client';
import { DownloadsPage } from './DownloadsPage';
import '../design/theme.global.css';
import './downloads.css';

window.addEventListener('error', (e) => {
  console.error('downloads.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('downloads.unhandledrejection', { reason: String(e.reason) });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('[downloads] #root element not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <DownloadsPage />
  </React.StrictMode>,
);
