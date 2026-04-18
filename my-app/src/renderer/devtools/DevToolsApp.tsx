import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ConsolePanel } from './panels/ConsolePanel';
import { ElementsPanel } from './panels/ElementsPanel';
import { NetworkPanel } from './panels/NetworkPanel';
import { SourcesPanel } from './panels/SourcesPanel';
import { PerformancePanel } from './panels/PerformancePanel';
import { MemoryPanel } from './panels/MemoryPanel';
import { ApplicationPanel } from './panels/ApplicationPanel';
import { SecurityPanel } from './panels/SecurityPanel';
import { LighthousePanel } from './panels/LighthousePanel';
import { RecorderPanel } from './panels/RecorderPanel';

declare const devtoolsAPI: {
  attach: () => Promise<{ success: boolean; error?: string }>;
  detach: () => Promise<{ success: boolean }>;
  send: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  isAttached: () => Promise<boolean>;
  getActiveTabInfo: () => Promise<{ id: string; url: string; title: string; favicon: string | null; isLoading: boolean } | null>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  onTabChanged: (cb: (tabId: string) => void) => () => void;
};

type PanelId =
  | 'elements'
  | 'console'
  | 'sources'
  | 'network'
  | 'performance'
  | 'memory'
  | 'application'
  | 'security'
  | 'lighthouse'
  | 'recorder';

interface PanelDef {
  id: PanelId;
  label: string;
  icon: string;
}

const PANELS: PanelDef[] = [
  { id: 'elements', label: 'Elements', icon: '◇' },
  { id: 'console', label: 'Console', icon: '▸' },
  { id: 'sources', label: 'Sources', icon: '{ }' },
  { id: 'network', label: 'Network', icon: '⇄' },
  { id: 'performance', label: 'Performance', icon: '◔' },
  { id: 'memory', label: 'Memory', icon: '▦' },
  { id: 'application', label: 'Application', icon: '⊞' },
  { id: 'security', label: 'Security', icon: '⊡' },
  { id: 'lighthouse', label: 'Lighthouse', icon: '☆' },
  { id: 'recorder', label: 'Recorder', icon: '●' },
];

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
}

export function DevToolsApp(): React.ReactElement {
  const [activePanel, setActivePanel] = useState<PanelId>('console');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cdpListenersRef = useRef<Array<(method: string, params: unknown) => void>>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  const subscribeCdp = useCallback((listener: (method: string, params: unknown) => void) => {
    cdpListenersRef.current.push(listener);
    return () => {
      cdpListenersRef.current = cdpListenersRef.current.filter((l) => l !== listener);
    };
  }, []);

  const sendCdp = useCallback(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const resp = await devtoolsAPI.send(method, params);
    if (!resp.success) throw new Error(resp.error ?? 'CDP command failed');
    return resp.result;
  }, []);

  const cdpSend = useCallback(
    async (method: string, params?: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> => {
      return devtoolsAPI.send(method, params);
    },
    [],
  );

  const connect = useCallback(async () => {
    console.log('[DevToolsApp] connecting...');
    setConnectionState('connecting');
    setError(null);

    try {
      const info = await devtoolsAPI.getActiveTabInfo();
      if (!info) {
        setError('No active tab found');
        setConnectionState('disconnected');
        return;
      }
      setTabInfo(info);

      const resp = await devtoolsAPI.attach();
      if (!resp.success) {
        console.error('[DevToolsApp] attach failed:', resp.error);
        setError(resp.error ?? 'Failed to attach debugger');
        setConnectionState('disconnected');
        return;
      }

      const cleanup = devtoolsAPI.onCdpEvent((method, params) => {
        for (const listener of cdpListenersRef.current) {
          try {
            listener(method, params);
          } catch (err) {
            console.error('[DevToolsApp] cdp listener error:', err);
          }
        }
      });
      cleanupRef.current = cleanup;

      setConnectionState('connected');
      console.log('[DevToolsApp] connected to tab:', info.title);
    } catch (err) {
      console.error('[DevToolsApp] connect failed:', err);
      setError(String(err));
      setConnectionState('disconnected');
    }
  }, []);

  useEffect(() => {
    void connect();
    return () => {
      cleanupRef.current?.();
      void devtoolsAPI.detach();
    };
  }, [connect]);

  const isAttached = connectionState === 'connected';

  const renderPanel = (): React.ReactElement | null => {
    if (connectionState !== 'connected') {
      return (
        <div className="devtools-connect-overlay">
          <div className="panel-placeholder-icon">⚡</div>
          <div className="panel-placeholder-title">
            {connectionState === 'connecting' ? 'Connecting...' : 'DevTools'}
          </div>
          {error && (
            <div style={{ color: 'var(--color-status-error)', fontSize: 'var(--font-size-sm)' }}>
              {error}
            </div>
          )}
          <button
            className="devtools-connect-btn"
            onClick={() => void connect()}
            disabled={connectionState === 'connecting'}
          >
            {connectionState === 'connecting' ? 'Connecting...' : 'Connect to Active Tab'}
          </button>
        </div>
      );
    }

    switch (activePanel) {
      case 'console':
        return <ConsolePanel sendCdp={sendCdp} subscribeCdp={subscribeCdp} />;
      case 'elements':
        return <ElementsPanel sendCdp={sendCdp} subscribeCdp={subscribeCdp} />;
      case 'network':
        return <NetworkPanel sendCdp={sendCdp} subscribeCdp={subscribeCdp} />;
      case 'sources':
        return <SourcesPanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      case 'performance':
        return <PerformancePanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      case 'memory':
        return <MemoryPanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      case 'application':
        return <ApplicationPanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      case 'security':
        return <SecurityPanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      case 'lighthouse':
        return <LighthousePanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      case 'recorder':
        return <RecorderPanel cdpSend={cdpSend} onCdpEvent={subscribeCdp} isAttached={isAttached} />;
      default:
        return null;
    }
  };

  return (
    <div className="devtools-layout">
      <div className="devtools-titlebar">
        <div className="devtools-target-info">
          {tabInfo?.favicon && (
            <img className="devtools-target-favicon" src={tabInfo.favicon} alt="" />
          )}
          {tabInfo && (
            <>
              <span className="devtools-target-title">{tabInfo.title || 'Untitled'}</span>
              <span className="devtools-target-url">{tabInfo.url}</span>
            </>
          )}
        </div>
        <div className="devtools-status">
          <span
            className="devtools-status-dot"
            data-state={connectionState}
          />
          <span>{connectionState}</span>
        </div>
      </div>

      <div className="devtools-tabs">
        {PANELS.map((panel) => (
          <button
            key={panel.id}
            className="devtools-tab"
            data-active={activePanel === panel.id ? 'true' : 'false'}
            onClick={() => setActivePanel(panel.id)}
          >
            <span className="devtools-tab-icon">{panel.icon}</span>
            {panel.label}
          </button>
        ))}
      </div>

      <div className="devtools-content">
        {renderPanel()}
      </div>
    </div>
  );
}
