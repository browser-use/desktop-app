import React, { useCallback, useEffect, useRef, useState } from 'react';

type DownloadStatus = 'in-progress' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

interface DownloadItemDTO {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  status: DownloadStatus;
  startTime: number;
  endTime: number | null;
  openWhenDone: boolean;
  speed: number;
  eta: number;
}

declare const downloadsAPI: {
  getAll: () => Promise<DownloadItemDTO[]>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  openFile: (id: string) => Promise<void>;
  showInFolder: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  onStateChanged: (cb: (downloads: DownloadItemDTO[]) => void) => () => void;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return `${h}h ${m}m left`;
}

function getDateLabel(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const entryDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (entryDate.getTime() === today.getTime()) return 'Today';
  if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function groupByDate(items: DownloadItemDTO[]): Map<string, DownloadItemDTO[]> {
  const groups = new Map<string, DownloadItemDTO[]>();
  for (const item of items) {
    const label = getDateLabel(item.startTime);
    const group = groups.get(label);
    if (group) {
      group.push(item);
    } else {
      groups.set(label, [item]);
    }
  }
  return groups;
}

function matchesSearch(item: DownloadItemDTO, query: string): boolean {
  const q = query.toLowerCase();
  return (
    item.filename.toLowerCase().includes(q) ||
    item.url.toLowerCase().includes(q)
  );
}

function domainLabel(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return pageUrl;
  }
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.slice(dot + 1).toUpperCase();
}

function statusLabel(status: DownloadStatus): string {
  switch (status) {
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Interrupted';
    case 'paused': return 'Paused';
    default: return '';
  }
}

function DownloadEntry({
  item,
  onPause,
  onResume,
  onCancel,
  onOpenFile,
  onShowInFolder,
  onCopyLink,
  onRemove,
}: {
  item: DownloadItemDTO;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onOpenFile: (id: string) => void;
  onShowInFolder: (id: string) => void;
  onCopyLink: (url: string) => void;
  onRemove: (id: string) => void;
}): React.ReactElement {
  const isActive = item.status === 'in-progress' || item.status === 'paused';
  const isCompleted = item.status === 'completed';
  const progress = item.totalBytes > 0
    ? Math.round((item.receivedBytes / item.totalBytes) * 100)
    : 0;

  const ext = fileExtension(item.filename);

  return (
    <div className={`dl__entry dl__entry--${item.status}`}>
      <div className="dl__entry-icon">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <rect x="6" y="4" width="20" height="24" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M12 4V10H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {ext && <span className="dl__entry-ext">{ext}</span>}
      </div>

      <div className="dl__entry-info">
        <div className="dl__entry-name-row">
          {isCompleted ? (
            <button
              type="button"
              className="dl__entry-name dl__entry-name--link"
              onClick={() => onOpenFile(item.id)}
              title={item.savePath}
            >
              {item.filename}
            </button>
          ) : (
            <span className="dl__entry-name" title={item.savePath || item.filename}>
              {item.filename}
            </span>
          )}
        </div>

        <div className="dl__entry-meta">
          {isActive && (
            <>
              <span className="dl__entry-progress-text">
                {formatBytes(item.receivedBytes)}
                {item.totalBytes > 0 && ` / ${formatBytes(item.totalBytes)}`}
              </span>
              {item.status === 'in-progress' && item.speed > 0 && (
                <span className="dl__entry-speed">{formatSpeed(item.speed)}</span>
              )}
              {item.status === 'in-progress' && item.eta > 0 && (
                <span className="dl__entry-eta">{formatEta(item.eta)}</span>
              )}
              {item.status === 'paused' && (
                <span className="dl__entry-status-label">Paused</span>
              )}
            </>
          )}
          {!isActive && (
            <>
              {item.totalBytes > 0 && (
                <span className="dl__entry-size">{formatBytes(item.totalBytes)}</span>
              )}
              <span className="dl__entry-source">{domainLabel(item.url)}</span>
              {(item.status === 'cancelled' || item.status === 'interrupted') && (
                <span className="dl__entry-status-label dl__entry-status-label--warn">
                  {statusLabel(item.status)}
                </span>
              )}
            </>
          )}
        </div>

        {isActive && item.totalBytes > 0 && (
          <div className="dl__progress-bar">
            <div
              className={`dl__progress-fill ${item.status === 'paused' ? 'dl__progress-fill--paused' : ''}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      <div className="dl__entry-actions">
        {item.status === 'in-progress' && (
          <>
            <button type="button" className="dl__action-btn" onClick={() => onPause(item.id)} title="Pause">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="4" y="3" width="3" height="10" rx="0.5" fill="currentColor" />
                <rect x="9" y="3" width="3" height="10" rx="0.5" fill="currentColor" />
              </svg>
            </button>
            <button type="button" className="dl__action-btn dl__action-btn--danger" onClick={() => onCancel(item.id)} title="Cancel">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
        {item.status === 'paused' && (
          <>
            <button type="button" className="dl__action-btn" onClick={() => onResume(item.id)} title="Resume">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <polygon points="5,3 13,8 5,13" fill="currentColor" />
              </svg>
            </button>
            <button type="button" className="dl__action-btn dl__action-btn--danger" onClick={() => onCancel(item.id)} title="Cancel">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
        {isCompleted && (
          <button type="button" className="dl__action-btn" onClick={() => onShowInFolder(item.id)} title="Show in Finder">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
          </button>
        )}
        <button type="button" className="dl__action-btn" onClick={() => onCopyLink(item.url)} title="Copy download link">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
            <path d="M3 11V3.5C3 3.22 3.22 3 3.5 3H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="dl__action-btn dl__action-btn--danger" onClick={() => onRemove(item.id)} title="Remove from list">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function DownloadsPage(): React.ReactElement {
  const [downloads, setDownloads] = useState<DownloadItemDTO[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchDownloads = useCallback(async () => {
    try {
      const items = await downloadsAPI.getAll();
      items.sort((a, b) => b.startTime - a.startTime);
      setDownloads(items);
    } catch (err) {
      console.error('DownloadsPage.fetchDownloads.failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDownloads();
  }, [fetchDownloads]);

  useEffect(() => {
    const unsub = downloadsAPI.onStateChanged((items) => {
      items.sort((a, b) => b.startTime - a.startTime);
      setDownloads(items);
    });
    return unsub;
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(val);
    }, 200);
  }, []);

  const handlePause = useCallback(async (id: string) => {
    console.log('DownloadsPage.pause', { id });
    await downloadsAPI.pause(id);
  }, []);

  const handleResume = useCallback(async (id: string) => {
    console.log('DownloadsPage.resume', { id });
    await downloadsAPI.resume(id);
  }, []);

  const handleCancel = useCallback(async (id: string) => {
    console.log('DownloadsPage.cancel', { id });
    await downloadsAPI.cancel(id);
  }, []);

  const handleOpenFile = useCallback(async (id: string) => {
    console.log('DownloadsPage.openFile', { id });
    await downloadsAPI.openFile(id);
  }, []);

  const handleShowInFolder = useCallback(async (id: string) => {
    console.log('DownloadsPage.showInFolder', { id });
    await downloadsAPI.showInFolder(id);
  }, []);

  const handleCopyLink = useCallback(async (url: string) => {
    console.log('DownloadsPage.copyLink', { url: url.slice(0, 100) });
    await navigator.clipboard.writeText(url);
    setCopiedId(url);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const handleRemove = useCallback(async (id: string) => {
    console.log('DownloadsPage.remove', { id });
    await downloadsAPI.remove(id);
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const handleClearAll = useCallback(async () => {
    console.log('DownloadsPage.clearAll');
    await downloadsAPI.clearAll();
    setDownloads([]);
  }, []);

  const filtered = debouncedQuery
    ? downloads.filter((d) => matchesSearch(d, debouncedQuery))
    : downloads;
  const groups = groupByDate(filtered);

  return (
    <div className="dl">
      <header className="dl__header">
        <h1 className="dl__title">Downloads</h1>
        {downloads.length > 0 && (
          <button
            type="button"
            className="dl__clear-btn"
            onClick={handleClearAll}
          >
            Clear all
          </button>
        )}
      </header>

      <div className="dl__search-container">
        <svg className="dl__search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          className="dl__search"
          type="text"
          value={query}
          onChange={handleQueryChange}
          placeholder="Search downloads"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Search downloads"
        />
      </div>

      <div className="dl__content">
        {loading ? (
          <div className="dl__empty">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="dl__empty">
            {debouncedQuery ? 'No results found' : 'No downloads'}
          </div>
        ) : (
          Array.from(groups.entries()).map(([dateLabel, groupItems]) => (
            <div key={dateLabel} className="dl__group">
              <h2 className="dl__date-label">{dateLabel}</h2>
              <div className="dl__entries">
                {groupItems.map((item) => (
                  <DownloadEntry
                    key={item.id}
                    item={item}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onOpenFile={handleOpenFile}
                    onShowInFolder={handleShowInFolder}
                    onCopyLink={handleCopyLink}
                    onRemove={handleRemove}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {copiedId && <div className="dl__toast">Link copied</div>}
    </div>
  );
}
