import React, { useState, useEffect, useCallback } from 'react';

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

type StorageCategory =
  | 'cookies'
  | 'localStorage'
  | 'sessionStorage'
  | 'indexedDB'
  | 'cacheStorage'
  | 'serviceWorkers'
  | 'manifest';

interface StorageEntry {
  key: string;
  value: string;
}

interface ServiceWorkerInfo {
  registrationId: string;
  scopeURL: string;
  isDeleted: boolean;
  versions: Array<{ versionId: string; registrationId: string; scriptURL: string; runningStatus: string; status: string }>;
}

interface IndexedDBDatabase {
  name: string;
  origin: string;
  objectStores: Array<{ name: string; keyPath: unknown; autoIncrement: boolean }>;
}

interface ManifestInfo {
  name?: string;
  shortName?: string;
  startUrl?: string;
  display?: string;
  themeColor?: string;
  backgroundColor?: string;
  icons?: Array<{ src: string; sizes?: string; type?: string }>;
}

const STORAGE_CATEGORIES: Array<{ id: StorageCategory; label: string }> = [
  { id: 'cookies', label: 'Cookies' },
  { id: 'localStorage', label: 'Local Storage' },
  { id: 'sessionStorage', label: 'Session Storage' },
  { id: 'indexedDB', label: 'IndexedDB' },
  { id: 'cacheStorage', label: 'Cache Storage' },
  { id: 'serviceWorkers', label: 'Service Workers' },
  { id: 'manifest', label: 'Manifest' },
];

export function ApplicationPanel({ cdpSend, onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [activeCategory, setActiveCategory] = useState<StorageCategory>('cookies');
  const [cookieEntries, setCookieEntries] = useState<StorageEntry[]>([]);
  const [localStorageEntries, setLocalStorageEntries] = useState<StorageEntry[]>([]);
  const [sessionStorageEntries, setSessionStorageEntries] = useState<StorageEntry[]>([]);
  const [indexedDBDatabases, setIndexedDBDatabases] = useState<IndexedDBDatabase[]>([]);
  const [cacheNames, setCacheNames] = useState<string[]>([]);
  const [serviceWorkers, setServiceWorkers] = useState<ServiceWorkerInfo[]>([]);
  const [manifestInfo, setManifestInfo] = useState<ManifestInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── helpers ──────────────────────────────────────────────────────────────

  const evalExpr = useCallback(
    async (expression: string): Promise<unknown> => {
      console.log('[ApplicationPanel] Runtime.evaluate:', expression.slice(0, 80));
      const resp = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (!resp.success) throw new Error(resp.error ?? 'Runtime.evaluate failed');
      const evalResult = resp.result as { result?: { value?: unknown }; exceptionDetails?: { text?: string } } | undefined;
      if (evalResult?.exceptionDetails) {
        throw new Error(evalResult.exceptionDetails.text ?? 'JS exception');
      }
      return evalResult?.result?.value;
    },
    [cdpSend],
  );

  // ── loaders ──────────────────────────────────────────────────────────────

  const loadCookies = useCallback(async () => {
    console.log('[ApplicationPanel] loading cookies via Runtime.evaluate');
    setLoading(true);
    setError(null);
    try {
      const raw = (await evalExpr('document.cookie')) as string;
      const entries: StorageEntry[] = raw
        ? raw.split(';').map((pair) => {
            const idx = pair.indexOf('=');
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            return { key, value };
          })
        : [];
      console.log('[ApplicationPanel] cookies loaded, count:', entries.length);
      setCookieEntries(entries);
    } catch (err) {
      console.error('[ApplicationPanel] loadCookies error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [evalExpr]);

  const loadLocalStorage = useCallback(async () => {
    console.log('[ApplicationPanel] loading localStorage');
    setLoading(true);
    setError(null);
    try {
      const raw = (await evalExpr('JSON.stringify(Object.entries(localStorage))')) as string;
      const pairs: Array<[string, string]> = raw ? JSON.parse(raw) : [];
      const entries: StorageEntry[] = pairs.map(([key, value]) => ({ key, value }));
      console.log('[ApplicationPanel] localStorage loaded, count:', entries.length);
      setLocalStorageEntries(entries);
    } catch (err) {
      console.error('[ApplicationPanel] loadLocalStorage error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [evalExpr]);

  const loadSessionStorage = useCallback(async () => {
    console.log('[ApplicationPanel] loading sessionStorage');
    setLoading(true);
    setError(null);
    try {
      const raw = (await evalExpr('JSON.stringify(Object.entries(sessionStorage))')) as string;
      const pairs: Array<[string, string]> = raw ? JSON.parse(raw) : [];
      const entries: StorageEntry[] = pairs.map(([key, value]) => ({ key, value }));
      console.log('[ApplicationPanel] sessionStorage loaded, count:', entries.length);
      setSessionStorageEntries(entries);
    } catch (err) {
      console.error('[ApplicationPanel] loadSessionStorage error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [evalExpr]);

  const loadIndexedDB = useCallback(async () => {
    console.log('[ApplicationPanel] loading IndexedDB database names');
    setLoading(true);
    setError(null);
    try {
      const securityOriginResp = await cdpSend('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      });
      const securityOrigin = (securityOriginResp.result as any)?.result?.value as string ?? 'null';
      console.log('[ApplicationPanel] securityOrigin:', securityOrigin);

      const namesResp = await cdpSend('IndexedDB.requestDatabaseNames', { securityOrigin });
      if (!namesResp.success) throw new Error(namesResp.error ?? 'IndexedDB.requestDatabaseNames failed');

      const dbNames = (namesResp.result as { databaseNames?: string[] })?.databaseNames ?? [];
      console.log('[ApplicationPanel] IndexedDB names:', dbNames);

      const databases: IndexedDBDatabase[] = [];
      for (const dbName of dbNames) {
        const dbResp = await cdpSend('IndexedDB.requestDatabase', { securityOrigin, databaseName: dbName });
        if (dbResp.success) {
          const dbInfo = dbResp.result as { databaseWithObjectStores?: { name: string; version: number; objectStores: Array<{ name: string; keyPath: unknown; autoIncrement: boolean }> } };
          if (dbInfo?.databaseWithObjectStores) {
            databases.push({
              name: dbInfo.databaseWithObjectStores.name,
              origin: securityOrigin,
              objectStores: dbInfo.databaseWithObjectStores.objectStores,
            });
          }
        }
      }

      console.log('[ApplicationPanel] IndexedDB databases loaded:', databases.length);
      setIndexedDBDatabases(databases);
    } catch (err) {
      console.error('[ApplicationPanel] loadIndexedDB error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [cdpSend]);

  const loadCacheStorage = useCallback(async () => {
    console.log('[ApplicationPanel] loading CacheStorage names');
    setLoading(true);
    setError(null);
    try {
      const securityOriginResp = await cdpSend('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      });
      const securityOrigin = (securityOriginResp.result as any)?.result?.value as string ?? 'null';

      const resp = await cdpSend('CacheStorage.requestCacheNames', { securityOrigin });
      if (!resp.success) throw new Error(resp.error ?? 'CacheStorage.requestCacheNames failed');

      const caches = (resp.result as { caches?: Array<{ cacheName: string }> })?.caches ?? [];
      const names = caches.map((c) => c.cacheName);
      console.log('[ApplicationPanel] CacheStorage names:', names);
      setCacheNames(names);
    } catch (err) {
      console.error('[ApplicationPanel] loadCacheStorage error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [cdpSend]);

  const loadServiceWorkers = useCallback(async () => {
    console.log('[ApplicationPanel] enabling ServiceWorker domain');
    setLoading(true);
    setError(null);
    try {
      await cdpSend('ServiceWorker.enable');
      // Service worker registrations come via events; trigger a list via workerRegistrationUpdated
      // We collect any registrations already fired and display them
      console.log('[ApplicationPanel] ServiceWorker domain enabled');
    } catch (err) {
      console.error('[ApplicationPanel] loadServiceWorkers error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [cdpSend]);

  const loadManifest = useCallback(async () => {
    console.log('[ApplicationPanel] loading manifest info');
    setLoading(true);
    setError(null);
    try {
      const manifestUrl = (await evalExpr(
        'document.querySelector(\'link[rel="manifest"]\')?.href ?? null',
      )) as string | null;
      console.log('[ApplicationPanel] manifest href:', manifestUrl);

      if (!manifestUrl) {
        setManifestInfo(null);
        return;
      }

      const manifestJson = (await evalExpr(
        `fetch(${JSON.stringify(manifestUrl)}).then(r => r.text())`,
      )) as string;

      const parsed: ManifestInfo = JSON.parse(manifestJson);
      console.log('[ApplicationPanel] manifest parsed:', parsed);
      setManifestInfo(parsed);
    } catch (err) {
      console.error('[ApplicationPanel] loadManifest error:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [evalExpr]);

  // ── category switching ────────────────────────────────────────────────────

  useEffect(() => {
    if (!isAttached) return;
    console.log('[ApplicationPanel] category changed to:', activeCategory);

    switch (activeCategory) {
      case 'cookies':
        void loadCookies();
        break;
      case 'localStorage':
        void loadLocalStorage();
        break;
      case 'sessionStorage':
        void loadSessionStorage();
        break;
      case 'indexedDB':
        void loadIndexedDB();
        break;
      case 'cacheStorage':
        void loadCacheStorage();
        break;
      case 'serviceWorkers':
        void loadServiceWorkers();
        break;
      case 'manifest':
        void loadManifest();
        break;
    }
  }, [
    activeCategory,
    isAttached,
    loadCookies,
    loadLocalStorage,
    loadSessionStorage,
    loadIndexedDB,
    loadCacheStorage,
    loadServiceWorkers,
    loadManifest,
  ]);

  // ── listen for ServiceWorker events ──────────────────────────────────────

  useEffect(() => {
    if (!isAttached) return;

    const unsubscribe = onCdpEvent((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'ServiceWorker.workerRegistrationUpdated') {
        const registrations = p.registrations as ServiceWorkerInfo[] | undefined;
        console.log('[ApplicationPanel] ServiceWorker.workerRegistrationUpdated, count:', registrations?.length ?? 0);
        if (registrations) {
          setServiceWorkers(registrations);
        }
      }

      if (method === 'ServiceWorker.workerVersionUpdated') {
        const versions = p.versions as Array<{ versionId: string; registrationId: string; scriptURL: string; runningStatus: string; status: string }> | undefined;
        console.log('[ApplicationPanel] ServiceWorker.workerVersionUpdated, count:', versions?.length ?? 0);
        if (versions) {
          setServiceWorkers((prev) =>
            prev.map((sw) => ({
              ...sw,
              versions: versions.filter((v) => v.registrationId === sw.registrationId),
            })),
          );
        }
      }
    });

    return () => {
      unsubscribe();
      console.log('[ApplicationPanel] unsubscribed from CDP events');
    };
  }, [isAttached, onCdpEvent]);

  // ── clear handlers ────────────────────────────────────────────────────────

  const handleClear = useCallback(async () => {
    console.log('[ApplicationPanel] clearing storage category:', activeCategory);
    try {
      switch (activeCategory) {
        case 'cookies':
          await evalExpr(
            'document.cookie.split(";").forEach(c => { const e = c.trim().split("=")[0]; document.cookie = e + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/"; })',
          );
          void loadCookies();
          break;
        case 'localStorage':
          await evalExpr('localStorage.clear()');
          void loadLocalStorage();
          break;
        case 'sessionStorage':
          await evalExpr('sessionStorage.clear()');
          void loadSessionStorage();
          break;
        case 'indexedDB': {
          const securityOriginResp = await cdpSend('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
          const origin = (securityOriginResp.result as any)?.result?.value as string ?? 'null';
          for (const db of indexedDBDatabases) {
            await cdpSend('IndexedDB.deleteDatabase', { securityOrigin: origin, databaseName: db.name });
          }
          void loadIndexedDB();
          break;
        }
        case 'cacheStorage':
          await evalExpr('caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))');
          void loadCacheStorage();
          break;
      }
    } catch (err) {
      console.error('[ApplicationPanel] clear failed:', err);
      setError(String(err));
    }
  }, [activeCategory, evalExpr, cdpSend, indexedDBDatabases, loadCookies, loadLocalStorage, loadSessionStorage, loadIndexedDB, loadCacheStorage]);

  // ── render helpers ────────────────────────────────────────────────────────

  const renderStorageTable = (entries: StorageEntry[]): React.ReactElement => {
    if (entries.length === 0) {
      return (
        <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center' }}>
          No data
        </div>
      );
    }
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)' }}>
        <thead>
          <tr>
            <th style={thStyle}>Key</th>
            <th style={thStyle}>Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
              <td style={tdKeyStyle}>{entry.key}</td>
              <td style={tdValueStyle}>{entry.value.length > 200 ? entry.value.slice(0, 200) + '…' : entry.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderContent = (): React.ReactElement => {
    if (!isAttached) {
      return (
        <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-sm)', textAlign: 'center' }}>
          Not attached to a tab
        </div>
      );
    }

    if (loading) {
      return (
        <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center' }}>
          Loading...
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ padding: 'var(--space-6)', color: 'var(--color-status-error)', fontSize: 'var(--font-size-xs)' }}>
          {error}
        </div>
      );
    }

    switch (activeCategory) {
      case 'cookies':
        return renderStorageTable(cookieEntries);

      case 'localStorage':
        return renderStorageTable(localStorageEntries);

      case 'sessionStorage':
        return renderStorageTable(sessionStorageEntries);

      case 'indexedDB':
        if (indexedDBDatabases.length === 0) {
          return (
            <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center' }}>
              No IndexedDB databases
            </div>
          );
        }
        return (
          <div style={{ padding: 'var(--space-4)' }}>
            {indexedDBDatabases.map((db, i) => (
              <div key={i} style={{ marginBottom: 'var(--space-6)' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-primary)', marginBottom: 'var(--space-2)' }}>
                  {db.name}
                </div>
                {db.objectStores.length === 0 ? (
                  <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)' }}>No object stores</div>
                ) : (
                  db.objectStores.map((store, j) => (
                    <div key={j} style={{ paddingLeft: 'var(--space-4)', fontSize: 'var(--font-size-xs)', color: 'var(--color-fg-secondary)', borderBottom: '1px solid var(--color-border-subtle)', padding: 'var(--space-1) var(--space-4)' }}>
                      {store.name} {store.autoIncrement ? '(auto-increment)' : ''}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        );

      case 'cacheStorage':
        if (cacheNames.length === 0) {
          return (
            <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center' }}>
              No caches
            </div>
          );
        }
        return (
          <div style={{ padding: 'var(--space-4)' }}>
            {cacheNames.map((name, i) => (
              <div
                key={i}
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  fontSize: 'var(--font-size-xs)',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-fg-primary)',
                }}
              >
                {name}
              </div>
            ))}
          </div>
        );

      case 'serviceWorkers':
        if (serviceWorkers.length === 0) {
          return (
            <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center' }}>
              No service workers registered
            </div>
          );
        }
        return (
          <div style={{ padding: 'var(--space-4)' }}>
            {serviceWorkers.map((sw, i) => (
              <div key={i} style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-3)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-primary)', marginBottom: 'var(--space-1)' }}>
                  {sw.scopeURL}
                </div>
                <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  ID: {sw.registrationId}
                </div>
                {sw.versions?.map((v, j) => (
                  <div key={j} style={{ marginTop: 'var(--space-2)', fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-secondary)' }}>
                    <span style={{ color: 'var(--color-fg-primary)', fontFamily: 'var(--font-mono)' }}>{v.scriptURL}</span>
                    {' — '}
                    <span style={{ color: v.runningStatus === 'running' ? 'var(--color-status-success)' : 'var(--color-fg-tertiary)' }}>
                      {v.runningStatus}
                    </span>
                    {' / '}
                    <span>{v.status}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );

      case 'manifest':
        if (!manifestInfo) {
          return (
            <div style={{ padding: 'var(--space-8)', color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center' }}>
              No web app manifest found
            </div>
          );
        }
        return (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr>
                <th style={thStyle}>Property</th>
                <th style={thStyle}>Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(manifestInfo)
                .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
                .map(([key, value], i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <td style={tdKeyStyle}>{key}</td>
                    <td style={tdValueStyle}>{String(value)}</td>
                  </tr>
                ))}
              {manifestInfo.icons && manifestInfo.icons.length > 0 && (
                <tr style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                  <td style={tdKeyStyle}>icons</td>
                  <td style={tdValueStyle}>{manifestInfo.icons.map((ic) => `${ic.src} (${ic.sizes ?? '?'})`).join(', ')}</td>
                </tr>
              )}
            </tbody>
          </table>
        );
    }
  };

  const showClearButton = ['cookies', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'].includes(activeCategory);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div
        style={{
          width: '200px',
          flexShrink: 0,
          borderRight: '1px solid var(--color-border-default)',
          overflowY: 'auto',
          backgroundColor: 'var(--color-bg-sunken)',
        }}
      >
        {STORAGE_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: 'var(--space-2) var(--space-4)',
              fontSize: 'var(--font-size-xs)',
              color: activeCategory === cat.id ? 'var(--color-accent-default)' : 'var(--color-fg-secondary)',
              backgroundColor: activeCategory === cat.id ? 'var(--color-accent-muted)' : 'transparent',
              borderLeft: activeCategory === cat.id ? '2px solid var(--color-accent-default)' : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--space-2) var(--space-4)',
            borderBottom: '1px solid var(--color-border-subtle)',
            flexShrink: 0,
            backgroundColor: 'var(--color-bg-elevated)',
          }}
        >
          <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-fg-secondary)' }}>
            {STORAGE_CATEGORIES.find((c) => c.id === activeCategory)?.label}
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button
              className="console-clear-btn"
              onClick={() => {
                console.log('[ApplicationPanel] refresh clicked for:', activeCategory);
                switch (activeCategory) {
                  case 'cookies': void loadCookies(); break;
                  case 'localStorage': void loadLocalStorage(); break;
                  case 'sessionStorage': void loadSessionStorage(); break;
                  case 'indexedDB': void loadIndexedDB(); break;
                  case 'cacheStorage': void loadCacheStorage(); break;
                  case 'serviceWorkers': void loadServiceWorkers(); break;
                  case 'manifest': void loadManifest(); break;
                }
              }}
            >
              Refresh
            </button>
            {showClearButton && (
              <button className="console-clear-btn" onClick={() => void handleClear()}>
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Data */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

// ── shared inline style constants ─────────────────────────────────────────

const thStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  padding: 'var(--space-2) var(--space-4)',
  textAlign: 'left',
  fontWeight: 'var(--font-weight-medium)',
  color: 'var(--color-fg-secondary)',
  backgroundColor: 'var(--color-bg-elevated)',
  borderBottom: '1px solid var(--color-border-default)',
  whiteSpace: 'nowrap',
  userSelect: 'none',
};

const tdKeyStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-4)',
  color: '#c792ea',
  whiteSpace: 'nowrap',
  width: '200px',
  maxWidth: '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const tdValueStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-4)',
  color: 'var(--color-fg-primary)',
  wordBreak: 'break-all',
};
