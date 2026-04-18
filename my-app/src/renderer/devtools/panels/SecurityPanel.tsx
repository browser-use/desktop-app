import React, { useState, useEffect, useCallback } from 'react';

interface PanelProps {
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: any; error?: string }>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  isAttached: boolean;
}

type SecurityState = 'secure' | 'neutral' | 'insecure' | 'info' | 'unknown';

interface ConnectionInfo {
  protocol: string;
  cipher: string;
  keyExchange: string;
  certificateId?: number;
}

interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  subjectAlternativeNames: string[];
}

interface MixedContentStatus {
  displayedMixedContent: boolean;
  ranMixedContent: boolean;
  displayedMixedContentType?: string;
  ranMixedContentType?: string;
}

interface SecurityDetails {
  state: SecurityState;
  connection: ConnectionInfo | null;
  certificate: CertificateInfo | null;
  mixedContent: MixedContentStatus | null;
  explanations: Array<{ securityState: string; title: string; description: string; hasCert: boolean }>;
}

const SECURITY_STATE_COLOR: Record<SecurityState, string> = {
  secure: 'var(--color-status-success)',
  neutral: 'var(--color-fg-secondary)',
  insecure: 'var(--color-status-error)',
  info: 'var(--color-status-warning)',
  unknown: 'var(--color-fg-tertiary)',
};

const SECURITY_STATE_ICON: Record<SecurityState, string> = {
  secure: '⊡',
  neutral: '◯',
  insecure: '⊗',
  info: '⊙',
  unknown: '◌',
};

const SECTION_HEADER_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  fontWeight: 'var(--font-weight-semibold)',
  color: 'var(--color-fg-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 'var(--space-3)',
  paddingBottom: 'var(--space-2)',
  borderBottom: '1px solid var(--color-border-subtle)',
};

const FIELD_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--space-4)',
  padding: 'var(--space-2) 0',
  borderBottom: '1px solid var(--color-border-subtle)',
  fontSize: 'var(--font-size-xs)',
};

const FIELD_LABEL_STYLE: React.CSSProperties = {
  width: '160px',
  flexShrink: 0,
  color: 'var(--color-fg-tertiary)',
  fontFamily: 'var(--font-mono)',
};

const FIELD_VALUE_STYLE: React.CSSProperties = {
  flex: 1,
  color: 'var(--color-fg-primary)',
  fontFamily: 'var(--font-mono)',
  wordBreak: 'break-all',
};

export function SecurityPanel({ cdpSend, onCdpEvent, isAttached }: PanelProps): React.ReactElement {
  const [securityDetails, setSecurityDetails] = useState<SecurityDetails>({
    state: 'unknown',
    connection: null,
    certificate: null,
    mixedContent: null,
    explanations: [],
  });
  const [isolationStatus, setIsolationStatus] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchIsolationStatus = useCallback(async () => {
    console.log('[SecurityPanel] fetching Network.getSecurityIsolationStatus');
    try {
      const resp = await cdpSend('Network.getSecurityIsolationStatus', {});
      if (resp.success && resp.result) {
        const status = resp.result as Record<string, unknown>;
        console.log('[SecurityPanel] isolation status:', status);
        setIsolationStatus(status);
      }
    } catch (err) {
      console.warn('[SecurityPanel] getSecurityIsolationStatus failed (may not be supported):', err);
    }
  }, [cdpSend]);

  useEffect(() => {
    if (!isAttached) return;

    console.log('[SecurityPanel] enabling Security domain');
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const resp = await cdpSend('Security.enable');
        if (!resp.success) throw new Error(resp.error ?? 'Security.enable failed');
        console.log('[SecurityPanel] Security domain enabled');
        await fetchIsolationStatus();
      } catch (err) {
        console.error('[SecurityPanel] enable failed:', err);
        setError(String(err));
      } finally {
        setLoading(false);
      }
    })();

    const unsubscribe = onCdpEvent((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Security.securityStateChanged') {
        console.log('[SecurityPanel] Security.securityStateChanged:', p);

        const rawState = (p.securityState as string) ?? 'unknown';
        const state: SecurityState = (
          ['secure', 'neutral', 'insecure', 'info'].includes(rawState) ? rawState : 'unknown'
        ) as SecurityState;

        const explanations = (p.explanations as Array<{ securityState: string; title: string; description: string; hasCert: boolean }>) ?? [];

        // Extract connection details from explanations and summary
        const summary = p.summary as string | undefined;
        console.log('[SecurityPanel] security summary:', summary, 'state:', state);

        setSecurityDetails((prev) => ({
          ...prev,
          state,
          explanations,
        }));
      }

      if (method === 'Network.responseReceivedExtraInfo') {
        // Extract headers that may carry security info
        const headers = p.headers as Record<string, string> | undefined;
        console.log('[SecurityPanel] Network.responseReceivedExtraInfo headers available:', !!headers);
      }
    });

    return () => {
      unsubscribe();
      console.log('[SecurityPanel] cleanup: disabling Security domain');
      void cdpSend('Security.disable').catch(() => {});
    };
  }, [isAttached, cdpSend, onCdpEvent, fetchIsolationStatus]);

  // Listen for Network events to collect TLS info
  useEffect(() => {
    if (!isAttached) return;

    void cdpSend('Network.enable').catch(() => {});

    const unsubscribe = onCdpEvent((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Network.responseReceived') {
        const response = p.response as Record<string, unknown> | undefined;
        if (!response) return;

        const securityDetails = response.securityDetails as Record<string, unknown> | undefined;
        if (!securityDetails) return;

        console.log('[SecurityPanel] Network.responseReceived securityDetails:', securityDetails);

        const protocol = (securityDetails.protocol as string) ?? '';
        const cipher = (securityDetails.cipher as string) ?? '';
        const keyExchange = (securityDetails.keyExchange as string) ?? '';
        const certificateId = securityDetails.certificateId as number | undefined;

        const subject = (securityDetails.subjectName as string) ?? '';
        const issuer = (securityDetails.issuer as string) ?? '';
        const validFrom = securityDetails.validFrom !== undefined
          ? new Date((securityDetails.validFrom as number) * 1000).toLocaleDateString()
          : '';
        const validTo = securityDetails.validTo !== undefined
          ? new Date((securityDetails.validTo as number) * 1000).toLocaleDateString()
          : '';
        const sans = (securityDetails.sanList as string[]) ?? [];

        setSecurityDetails((prev) => ({
          ...prev,
          connection: { protocol, cipher, keyExchange, certificateId },
          certificate: { subject, issuer, validFrom, validTo, subjectAlternativeNames: sans },
        }));
      }

      if (method === 'Security.visibleSecurityStateChanged') {
        console.log('[SecurityPanel] Security.visibleSecurityStateChanged:', p);
        const visibleState = p.visibleSecurityState as Record<string, unknown> | undefined;
        if (!visibleState) return;

        const rawState = (visibleState.securityState as string) ?? 'unknown';
        const state: SecurityState = (
          ['secure', 'neutral', 'insecure', 'info'].includes(rawState) ? rawState : 'unknown'
        ) as SecurityState;

        const secDetails = visibleState.securityStateIssueIds as string[] | undefined;

        const mixedContentInfo = visibleState.certificateSecurityState as Record<string, unknown> | undefined;
        if (mixedContentInfo) {
          const protocol = (mixedContentInfo.protocol as string) ?? '';
          const cipher = (mixedContentInfo.cipher as string) ?? '';
          const keyExchange = (mixedContentInfo.keyExchange as string) ?? '';

          const subject = (mixedContentInfo.subjectName as string) ?? '';
          const issuer = (mixedContentInfo.issuer as string) ?? '';
          const validFrom = mixedContentInfo.validFrom !== undefined
            ? new Date((mixedContentInfo.validFrom as number) * 1000).toLocaleDateString()
            : '';
          const validTo = mixedContentInfo.validTo !== undefined
            ? new Date((mixedContentInfo.validTo as number) * 1000).toLocaleDateString()
            : '';
          const sans = (mixedContentInfo.sanList as string[]) ?? [];

          setSecurityDetails((prev) => ({
            ...prev,
            state,
            connection: { protocol, cipher, keyExchange },
            certificate: { subject, issuer, validFrom, validTo, subjectAlternativeNames: sans },
            mixedContent: {
              displayedMixedContent: secDetails?.includes('displayed-mixed-content') ?? false,
              ranMixedContent: secDetails?.includes('ran-mixed-content') ?? false,
            },
          }));
        } else {
          setSecurityDetails((prev) => ({ ...prev, state }));
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isAttached, cdpSend, onCdpEvent]);

  const stateColor = SECURITY_STATE_COLOR[securityDetails.state];
  const stateIcon = SECURITY_STATE_ICON[securityDetails.state];

  if (!isAttached) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Not attached</div>
        <div className="panel-placeholder-desc">Attach to a tab to view security information.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="panel-placeholder">
        <div className="panel-placeholder-title">Loading security info...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', padding: 'var(--space-6)' }}>
      {error && (
        <div style={{ color: 'var(--color-status-error)', fontSize: 'var(--font-size-xs)', marginBottom: 'var(--space-4)', fontFamily: 'var(--font-mono)' }}>
          {error}
        </div>
      )}

      {/* Overview banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: 'var(--space-4) var(--space-6)',
          borderRadius: 'var(--radius-md)',
          border: `1px solid ${stateColor}`,
          backgroundColor: 'var(--color-bg-elevated)',
          marginBottom: 'var(--space-6)',
        }}
      >
        <span style={{ fontSize: '28px', color: stateColor, lineHeight: 1 }}>{stateIcon}</span>
        <div>
          <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 'var(--font-weight-semibold)', color: stateColor, textTransform: 'capitalize' }}>
            {securityDetails.state === 'unknown' ? 'Unknown' : securityDetails.state}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-fg-secondary)', marginTop: 'var(--space-1)' }}>
            {securityDetails.state === 'secure' && 'This page is using a secure connection.'}
            {securityDetails.state === 'neutral' && 'This page has a neutral security state.'}
            {securityDetails.state === 'insecure' && 'This page is using an insecure connection.'}
            {securityDetails.state === 'info' && 'Security info available.'}
            {securityDetails.state === 'unknown' && 'Security state has not been determined yet.'}
          </div>
        </div>
      </div>

      {/* Connection section */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div style={SECTION_HEADER_STYLE}>Connection</div>
        {securityDetails.connection ? (
          <>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Protocol</span>
              <span style={{ ...FIELD_VALUE_STYLE, color: 'var(--color-status-success)' }}>{securityDetails.connection.protocol || '—'}</span>
            </div>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Cipher Suite</span>
              <span style={FIELD_VALUE_STYLE}>{securityDetails.connection.cipher || '—'}</span>
            </div>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Key Exchange</span>
              <span style={FIELD_VALUE_STYLE}>{securityDetails.connection.keyExchange || '—'}</span>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)' }}>
            No connection data — navigate to a page to populate.
          </div>
        )}
      </div>

      {/* Certificate section */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div style={SECTION_HEADER_STYLE}>Certificate</div>
        {securityDetails.certificate ? (
          <>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Subject</span>
              <span style={FIELD_VALUE_STYLE}>{securityDetails.certificate.subject || '—'}</span>
            </div>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Issuer</span>
              <span style={FIELD_VALUE_STYLE}>{securityDetails.certificate.issuer || '—'}</span>
            </div>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Valid From</span>
              <span style={FIELD_VALUE_STYLE}>{securityDetails.certificate.validFrom || '—'}</span>
            </div>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Valid To</span>
              <span style={FIELD_VALUE_STYLE}>{securityDetails.certificate.validTo || '—'}</span>
            </div>
            {securityDetails.certificate.subjectAlternativeNames.length > 0 && (
              <div style={FIELD_ROW_STYLE}>
                <span style={FIELD_LABEL_STYLE}>SANs</span>
                <span style={FIELD_VALUE_STYLE}>{securityDetails.certificate.subjectAlternativeNames.join(', ')}</span>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)' }}>
            No certificate data — navigate to an HTTPS page to populate.
          </div>
        )}
      </div>

      {/* Resources / Mixed content section */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div style={SECTION_HEADER_STYLE}>Resources</div>
        {securityDetails.mixedContent ? (
          <>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Displayed Mixed</span>
              <span
                style={{
                  ...FIELD_VALUE_STYLE,
                  color: securityDetails.mixedContent.displayedMixedContent
                    ? 'var(--color-status-warning)'
                    : 'var(--color-status-success)',
                }}
              >
                {securityDetails.mixedContent.displayedMixedContent ? 'Yes (passive)' : 'None'}
              </span>
            </div>
            <div style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>Active Mixed</span>
              <span
                style={{
                  ...FIELD_VALUE_STYLE,
                  color: securityDetails.mixedContent.ranMixedContent
                    ? 'var(--color-status-error)'
                    : 'var(--color-status-success)',
                }}
              >
                {securityDetails.mixedContent.ranMixedContent ? 'Yes (active — blocked)' : 'None'}
              </span>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)' }}>
            Mixed content analysis unavailable.
          </div>
        )}
      </div>

      {/* Isolation status (COEP/COOP) */}
      {isolationStatus && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <div style={SECTION_HEADER_STYLE}>Isolation</div>
          {Object.entries(isolationStatus).map(([key, value], i) => (
            <div key={i} style={FIELD_ROW_STYLE}>
              <span style={FIELD_LABEL_STYLE}>{key}</span>
              <span style={FIELD_VALUE_STYLE}>{JSON.stringify(value)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Explanations */}
      {securityDetails.explanations.length > 0 && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <div style={SECTION_HEADER_STYLE}>Details</div>
          {securityDetails.explanations.map((exp, i) => (
            <div
              key={i}
              style={{
                padding: 'var(--space-3)',
                marginBottom: 'var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-subtle)',
                backgroundColor: 'var(--color-bg-elevated)',
              }}
            >
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)', color: SECURITY_STATE_COLOR[(exp.securityState as SecurityState) ?? 'unknown'], marginBottom: 'var(--space-1)' }}>
                {exp.title}
              </div>
              <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-fg-secondary)', lineHeight: 'var(--line-height-relaxed)' }}>
                {exp.description}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
