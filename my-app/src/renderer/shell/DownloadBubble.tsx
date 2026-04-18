/**
 * DownloadBubble: dropdown panel anchored to the download toolbar button.
 * Shows file name, progress bar, ETA, pause/resume, cancel, and
 * "open when done" checkbox per file.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import type { DownloadItemDTO } from '../../main/downloads/DownloadManager';

interface DownloadBubbleProps {
  downloads: DownloadItemDTO[];
  showOnComplete: boolean;
  onClose: () => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onOpenFile: (id: string) => void;
  onShowInFolder: (id: string) => void;
  onSetOpenWhenDone: (id: string, value: boolean) => void;
  onClearCompleted: () => void;
  onSetShowOnComplete: (value: boolean) => void;
  onDismissWarning: (id: string) => void;
}

export function DownloadBubble({
  downloads,
  showOnComplete,
  onClose,
  onPause,
  onResume,
  onCancel,
  onOpenFile,
  onShowInFolder,
  onSetOpenWhenDone,
  onClearCompleted,
  onSetShowOnComplete,
  onDismissWarning,
}: DownloadBubbleProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const btn = (e.target as HTMLElement)?.closest('.download-btn');
        if (!btn) onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const hasCompleted = downloads.some(
    (d) => d.status === 'completed' || d.status === 'cancelled',
  );

  return (
    <div className="download-bubble" ref={panelRef}>
      <div className="download-bubble__header">
        <span className="download-bubble__title">Downloads</span>
        {hasCompleted && (
          <button
            className="download-bubble__clear-btn"
            onClick={onClearCompleted}
          >
            Clear completed
          </button>
        )}
      </div>

      {downloads.length === 0 ? (
        <div className="download-bubble__empty">No downloads</div>
      ) : (
        <ul className="download-bubble__list">
          {downloads.map((dl) => (
            <DownloadRow
              key={dl.id}
              dl={dl}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              onOpenFile={onOpenFile}
              onShowInFolder={onShowInFolder}
              onSetOpenWhenDone={onSetOpenWhenDone}
              onDismissWarning={onDismissWarning}
            />
          ))}
        </ul>
      )}

      <div className="download-bubble__footer">
        <label className="download-bubble__setting">
          <input
            type="checkbox"
            checked={showOnComplete}
            onChange={(e) => onSetShowOnComplete(e.target.checked)}
          />
          <span>Show downloads when they're done</span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DownloadRow
// ---------------------------------------------------------------------------

interface DownloadRowProps {
  dl: DownloadItemDTO;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onOpenFile: (id: string) => void;
  onShowInFolder: (id: string) => void;
  onSetOpenWhenDone: (id: string, value: boolean) => void;
  onDismissWarning: (id: string) => void;
}

function DownloadRow({
  dl,
  onPause,
  onResume,
  onCancel,
  onOpenFile,
  onShowInFolder,
  onSetOpenWhenDone,
  onDismissWarning,
}: DownloadRowProps): React.ReactElement {
  const isActive = dl.status === 'in-progress' || dl.status === 'paused';
  const isCompleted = dl.status === 'completed';
  const progress =
    dl.totalBytes > 0 ? dl.receivedBytes / dl.totalBytes : 0;

  const handleOpen = useCallback(() => onOpenFile(dl.id), [dl.id, onOpenFile]);
  const handleFolder = useCallback(() => onShowInFolder(dl.id), [dl.id, onShowInFolder]);

  return (
    <li className="download-row">
      <div className="download-row__icon">
        {isCompleted ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 8l3 3 5-6" stroke="var(--color-status-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : dl.status === 'cancelled' ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 5l6 6m0-6l-6 6" stroke="var(--color-status-danger)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v7m0 0l-2.5-2.5M8 10l2.5-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 13h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </div>

      <div className="download-row__info">
        <div className="download-row__name-row">
          <span className="download-row__filename" title={dl.filename}>
            {dl.filename}
          </span>
          {isActive && (
            <span className="download-row__eta">
              {formatEta(dl.eta)}
            </span>
          )}
        </div>

        {dl.warningLevel && !dl.warningDismissed && (
          <DownloadWarningBanner
            id={dl.id}
            level={dl.warningLevel}
            onCancel={onCancel}
            onDismissWarning={onDismissWarning}
          />
        )}

        {isActive && (
          <div className="download-row__progress-wrap">
            <div className="download-row__progress-bar">
              <div
                className="download-row__progress-fill"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <span className="download-row__size">
              {formatBytes(dl.receivedBytes)}{dl.totalBytes > 0 ? ` / ${formatBytes(dl.totalBytes)}` : ''}
            </span>
          </div>
        )}

        {isCompleted && (
          <span className="download-row__size">
            {formatBytes(dl.receivedBytes)}
          </span>
        )}

        {dl.status === 'cancelled' && (
          <span className="download-row__cancelled-label">Cancelled</span>
        )}
      </div>

      <div className="download-row__actions">
        {isActive && (
          <>
            {dl.status === 'in-progress' ? (
              <button
                className="download-row__action-btn"
                title="Pause"
                onClick={() => onPause(dl.id)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="3.5" y="3" width="2.5" height="8" rx="0.5" fill="currentColor" />
                  <rect x="8" y="3" width="2.5" height="8" rx="0.5" fill="currentColor" />
                </svg>
              </button>
            ) : !(dl.warningLevel && !dl.warningDismissed) && (
              <button
                className="download-row__action-btn"
                title="Resume"
                onClick={() => onResume(dl.id)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M4 2.5l7 4.5-7 4.5V2.5z" fill="currentColor" />
                </svg>
              </button>
            )}
            <button
              className="download-row__action-btn download-row__action-btn--danger"
              title="Cancel"
              onClick={() => onCancel(dl.id)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M4 4l6 6m0-6l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}

        {isCompleted && (
          <>
            <button
              className="download-row__action-btn"
              title="Open file"
              onClick={handleOpen}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2 7.5V11a1 1 0 001 1h8a1 1 0 001-1V7.5M7 2v7m0 0L4.5 6.5M7 9l2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="download-row__action-btn"
              title="Show in folder"
              onClick={handleFolder}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M1.5 3.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v5.5a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
      </div>

      {isActive && (
        <label className="download-row__open-when-done" title="Open when done">
          <input
            type="checkbox"
            checked={dl.openWhenDone}
            onChange={(e) => onSetOpenWhenDone(dl.id, e.target.checked)}
          />
          <span>Open</span>
        </label>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// DownloadWarningBanner
// ---------------------------------------------------------------------------

interface DownloadWarningBannerProps {
  id: string;
  level: 'dangerous' | 'suspicious' | 'insecure';
  onCancel: (id: string) => void;
  onDismissWarning: (id: string) => void;
}

function DownloadWarningBanner({ id, level, onCancel, onDismissWarning }: DownloadWarningBannerProps): React.ReactElement {
  return (
    <div className={`download-warning download-warning--${level}`}>
      <div className="download-warning__text">
        {level === 'dangerous' && (
          <>
            <div>This file may be dangerous. Are you sure you want to download it?</div>
            <div className="download-warning__actions">
              <button className="download-warning__btn" onClick={() => onCancel(id)}>Cancel</button>
              <button className="download-warning__btn download-warning__btn--primary" onClick={() => onDismissWarning(id)}>
                <span>Keep anyway</span>
              </button>
            </div>
          </>
        )}
        {level === 'suspicious' && (
          <>
            <div>This file type can harm your device.</div>
            <div className="download-warning__actions">
              <button className="download-warning__btn" onClick={() => onCancel(id)}>Cancel</button>
              <button className="download-warning__btn download-warning__btn--primary" onClick={() => onDismissWarning(id)}>
                <span>Keep</span>
              </button>
            </div>
          </>
        )}
        {level === 'insecure' && (
          <div>This file was downloaded over an insecure connection.</div>
        )}
      </div>
      {level === 'insecure' && (
        <button
          className="download-warning__btn"
          title="Dismiss"
          onClick={() => onDismissWarning(id)}
          aria-label="Dismiss warning"
        >
          &#x2715;
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m left`;
}
