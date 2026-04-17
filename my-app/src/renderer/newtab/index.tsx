import React from 'react';
import { createRoot } from 'react-dom/client';
import { NewTab } from './NewTab';
import '../design/theme.global.css';
import './newtab.css';

window.addEventListener('error', (e) => {
  console.error('newtab.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('newtab.unhandledrejection', { reason: String(e.reason) });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('[newtab] #root element not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <NewTab />
  </React.StrictMode>,
);
