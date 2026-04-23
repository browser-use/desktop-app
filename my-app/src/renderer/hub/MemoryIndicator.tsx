import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface ProcessInfo {
  label: string;
  type: string;
  mb: number;
  sessionId?: string;
}

interface MemoryData {
  totalMb: number;
  sessions: Array<{ id: string; mb: number; status: string }>;
  processes: ProcessInfo[];
  processCount: number;
}

function formatGb(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'mem__dot--running';
    case 'stuck': return 'mem__dot--stuck';
    case 'idle': return 'mem__dot--idle';
    default: return 'mem__dot--stopped';
  }
}

interface MemoryIndicatorProps {
  onOpenSettings?: () => void;
}

export function MemoryIndicator({ onOpenSettings }: MemoryIndicatorProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<MemoryData>({
    queryKey: ['memory'],
    queryFn: async () => {
      const api = window.electronAPI;
      if (!api) return { totalMb: 0, sessions: [], processes: [], processCount: 0 };
      return api.sessions.memory();
    },
    refetchInterval: 5000,
    staleTime: 4000,
  });

  if (!data) return null;

  return (
    <div className="mem-indicator">
      <button
        className="mem-indicator__btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="4" y="7" width="2" height="3.5" rx="0.5" fill="currentColor" opacity="0.5" />
          <rect x="7.5" y="4.5" width="2" height="6" rx="0.5" fill="currentColor" opacity="0.7" />
        </svg>
        <span>{formatGb(data.totalMb)}</span>
      </button>
      <button
        className="mem-indicator__settings-btn"
        onClick={onOpenSettings}
        title="Settings (⌘,)"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M5.73 1.68a1.25 1.25 0 0 1 2.54 0l.1.44a1.25 1.25 0 0 0 1.63.8l.42-.16a1.25 1.25 0 0 1 1.58 1.73l-.2.4a1.25 1.25 0 0 0 .37 1.55l.35.27a1.25 1.25 0 0 1-.44 2.2l-.43.13a1.25 1.25 0 0 0-.86 1.46l.08.44a1.25 1.25 0 0 1-1.97 1.27l-.33-.3a1.25 1.25 0 0 0-1.6-.06l-.36.27a1.25 1.25 0 0 1-2.03-1.17l.05-.44a1.25 1.25 0 0 0-.92-1.42l-.43-.12a1.25 1.25 0 0 1-.33-2.22l.37-.26a1.25 1.25 0 0 0 .44-1.53l-.18-.41A1.25 1.25 0 0 1 4.7 2.93l.42.17a1.25 1.25 0 0 0 1.6-.86l.11-.44Z" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="7" cy="7" r="1.75" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span>Settings</span>
      </button>
      {open && (
        <>
          <div className="mem-indicator__scrim" onClick={() => setOpen(false)} />
          <div className="mem-indicator__dropdown">
            <div className="mem__header">
              <span className="mem__title">Memory usage</span>
              <span className="mem__total">{formatGb(data.totalMb)}</span>
            </div>
            <div className="mem__processes">
              {(data.processes ?? [])
                .sort((a, b) => {
                  if (a.sessionId && !b.sessionId) return -1;
                  if (!a.sessionId && b.sessionId) return 1;
                  return b.mb - a.mb;
                })
                .map((p, i) => (
                  <div key={i} className="mem__session-row">
                    <span className={`mem__dot ${p.sessionId ? statusDotClass(data.sessions.find((s) => s.id === p.sessionId)?.status ?? 'stopped') : 'mem__dot--system'}`} />
                    <span className="mem__session-id">
                      {p.label}
                    </span>
                    <span className="mem__session-mb">{Math.round(p.mb)} MB</span>
                    {p.sessionId && (
                      <button
                        className="mem__kill-btn"
                        onClick={() => {
                          const api = window.electronAPI;
                          if (!api || !p.sessionId) return;
                          api.sessions.cancel(p.sessionId).catch(() => {});
                        }}
                        aria-label="Stop session"
                      >
                        <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
