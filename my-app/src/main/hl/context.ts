/**
 * HlContext — runtime state carried by every helper call.
 *
 * Mirrors the Python daemon's per-NAME state:
 *   - a CDP client
 *   - a current `session` ID (default null = attached webcontents' own session,
 *     or the current remote tab session)
 *   - an event ring buffer capped at 500 (matches daemon.py `deque(maxlen=500)`)
 */

import type { WebContents } from 'electron';
import { cdpForWebContents, cdpForWsUrl, type CdpClient } from './cdp';

export const EVENT_BUFFER_SIZE = 500;

// Match helpers.py + daemon.py INTERNAL tuple. Duplicated intentionally (cross-process).
export const INTERNAL_URL_PREFIXES: readonly string[] = [
  'chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:',
];

export interface BufferedCdpEvent {
  method: string;
  params: unknown;
  session_id?: string;
}

export interface HlContext {
  name: string;
  cdp: CdpClient;
  session: string | null;                  // current CDP session (flat session model)
  events: BufferedCdpEvent[];              // ring buffer, FIFO, max EVENT_BUFFER_SIZE
  _source: { webContents?: WebContents; cdpUrl?: string };
}

export interface CreateContextOptions {
  name?: string;
  webContents?: WebContents;
  cdpUrl?: string;
}

export async function createContext(opts: CreateContextOptions): Promise<HlContext> {
  if (!opts.webContents && !opts.cdpUrl) {
    throw new Error('hl.createContext: must provide webContents or cdpUrl');
  }
  const cdp: CdpClient = opts.webContents
    ? cdpForWebContents(opts.webContents)
    : await cdpForWsUrl(opts.cdpUrl!);

  const ctx: HlContext = {
    name: opts.name ?? 'default',
    cdp,
    session: null,
    events: [],
    _source: { webContents: opts.webContents, cdpUrl: opts.cdpUrl },
  };

  // The daemon's event tap taps EVERY incoming CDP message. We approximate with
  // a broad allow-list of the domains harnessless actually reads — this keeps
  // the buffer focused and avoids noise (e.g. Runtime.executionContextCreated
  // floods during page loads).
  const domainEvents = [
    'Page.frameNavigated', 'Page.loadEventFired', 'Page.lifecycleEvent',
    'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed',
    'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed',
    'Runtime.consoleAPICalled', 'Target.attachedToTarget', 'Target.detachedFromTarget',
    'Target.targetCreated', 'Target.targetDestroyed', 'Target.targetInfoChanged',
  ];
  const push = (method: string) => (params: unknown, sessionId?: string) => {
    const ev: BufferedCdpEvent = { method, params };
    if (sessionId) ev.session_id = sessionId;
    ctx.events.push(ev);
    if (ctx.events.length > EVENT_BUFFER_SIZE) ctx.events.shift();
  };
  for (const e of domainEvents) cdp.on(e, push(e));

  return ctx;
}
