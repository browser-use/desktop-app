import React from 'react';
import { createRoot } from 'react-dom/client';
import { BookmarkManager } from './BookmarkManager';
import '../design/theme.global.css';
import './bookmarks.css';

window.addEventListener('error', (e) => {
  console.error('bookmarks.error', { message: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('bookmarks.unhandledrejection', { reason: String(e.reason) });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('[bookmarks] #root element not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <BookmarkManager />
  </React.StrictMode>,
);
