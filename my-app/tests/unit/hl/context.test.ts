/**
 * hl/context.ts unit tests.
 *
 * Tests cover:
 *   - createContext throws when neither webContents nor cdpUrl is provided
 *   - createContext uses cdpForWebContents when webContents is provided
 *   - createContext uses cdpForWsUrl when cdpUrl is provided
 *   - createContext returns HlContext with session=null and empty events
 *   - createContext sets ctx.name from opts.name (defaults to 'default')
 *   - Event buffer: each domainEvent listener pushes to ctx.events
 *   - Event buffer: session_id is included when CDP callback provides sessionId
 *   - Event buffer: overflow — oldest events are removed when > EVENT_BUFFER_SIZE
 *   - INTERNAL_URL_PREFIXES is a readonly array with expected prefixes
 *   - EVENT_BUFFER_SIZE is 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('electron', () => ({}));

// Capture listeners registered via cdp.on so tests can fire them
type CdpListener = (params: unknown, sessionId?: string) => void;

const { mockCdpForWebContents, mockCdpForWsUrl, makeMockCdp } = vi.hoisted(() => {
  function makeMockCdp() {
    const listeners = new Map<string, CdpListener[]>();
    return {
      send: vi.fn(() => Promise.resolve({})),
      on: vi.fn((event: string, listener: CdpListener) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(listener);
      }),
      off: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
      transport: 'webcontents' as const,
      _emit: (event: string, params: unknown, sessionId?: string) => {
        listeners.get(event)?.forEach((l) => l(params, sessionId));
      },
    };
  }

  const mockCdpForWebContents = vi.fn(() => makeMockCdp());
  const mockCdpForWsUrl = vi.fn(async () => makeMockCdp());

  return { mockCdpForWebContents, mockCdpForWsUrl, makeMockCdp };
});

vi.mock('../../../src/main/hl/cdp', () => ({
  cdpForWebContents: mockCdpForWebContents,
  cdpForWsUrl: mockCdpForWsUrl,
}));

import {
  createContext,
  EVENT_BUFFER_SIZE,
  INTERNAL_URL_PREFIXES,
} from '../../../src/main/hl/context';
import type { HlContext } from '../../../src/main/hl/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebContents() {
  return { id: 1 } as unknown as Electron.WebContents;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hl/context.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCdpForWebContents.mockImplementation(() => makeMockCdp());
    mockCdpForWsUrl.mockImplementation(async () => makeMockCdp());
  });

  // ---------------------------------------------------------------------------
  // createContext — validation
  // ---------------------------------------------------------------------------

  describe('createContext() — validation', () => {
    it('throws when neither webContents nor cdpUrl is provided', async () => {
      await expect(createContext({})).rejects.toThrow(
        'hl.createContext: must provide webContents or cdpUrl',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // createContext — transport selection
  // ---------------------------------------------------------------------------

  describe('createContext() — transport selection', () => {
    it('calls cdpForWebContents when webContents is provided', async () => {
      const wc = makeWebContents();
      await createContext({ webContents: wc });
      expect(mockCdpForWebContents).toHaveBeenCalledWith(wc);
      expect(mockCdpForWsUrl).not.toHaveBeenCalled();
    });

    it('calls cdpForWsUrl when cdpUrl is provided', async () => {
      await createContext({ cdpUrl: 'ws://localhost:9222/devtools/browser/abc' });
      expect(mockCdpForWsUrl).toHaveBeenCalledWith('ws://localhost:9222/devtools/browser/abc');
      expect(mockCdpForWebContents).not.toHaveBeenCalled();
    });

    it('prefers webContents over cdpUrl when both are provided', async () => {
      const wc = makeWebContents();
      await createContext({ webContents: wc, cdpUrl: 'ws://localhost:9222' });
      expect(mockCdpForWebContents).toHaveBeenCalled();
      expect(mockCdpForWsUrl).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // createContext — returned HlContext shape
  // ---------------------------------------------------------------------------

  describe('createContext() — returned HlContext', () => {
    it('returns ctx.session = null', async () => {
      const ctx = await createContext({ webContents: makeWebContents() });
      expect(ctx.session).toBeNull();
    });

    it('returns ctx.events as an empty array', async () => {
      const ctx = await createContext({ webContents: makeWebContents() });
      expect(ctx.events).toEqual([]);
    });

    it('sets ctx.name from opts.name', async () => {
      const ctx = await createContext({ webContents: makeWebContents(), name: 'my-context' });
      expect(ctx.name).toBe('my-context');
    });

    it('defaults ctx.name to "default" when opts.name is omitted', async () => {
      const ctx = await createContext({ webContents: makeWebContents() });
      expect(ctx.name).toBe('default');
    });

    it('stores cdp client on ctx.cdp', async () => {
      const ctx = await createContext({ webContents: makeWebContents() });
      expect(ctx.cdp).toBeDefined();
      expect(typeof ctx.cdp.send).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Event buffer — listener registration
  // ---------------------------------------------------------------------------

  describe('event buffer', () => {
    let ctx: HlContext;
    let cdpMock: ReturnType<typeof makeMockCdp>;

    beforeEach(async () => {
      cdpMock = makeMockCdp();
      mockCdpForWebContents.mockReturnValue(cdpMock);
      ctx = await createContext({ webContents: makeWebContents() });
    });

    it('registers listeners for domain events on the CDP client', () => {
      // At least Page.frameNavigated and Network.requestWillBeSent should be registered
      expect(cdpMock.on).toHaveBeenCalledWith('Page.frameNavigated', expect.any(Function));
      expect(cdpMock.on).toHaveBeenCalledWith('Network.requestWillBeSent', expect.any(Function));
    });

    it('pushes events to ctx.events when a CDP event fires', () => {
      cdpMock._emit('Page.frameNavigated', { url: 'https://example.com' });
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]).toEqual({ method: 'Page.frameNavigated', params: { url: 'https://example.com' } });
    });

    it('includes session_id in the event when CDP callback provides sessionId', () => {
      cdpMock._emit('Target.attachedToTarget', { sessionId: 'sess-123' }, 'sess-123');
      expect(ctx.events[0].session_id).toBe('sess-123');
    });

    it('does not include session_id when CDP callback has no sessionId', () => {
      cdpMock._emit('Page.loadEventFired', { timestamp: 1 });
      expect('session_id' in ctx.events[0]).toBe(false);
    });

    it('accumulates multiple events in order', () => {
      cdpMock._emit('Page.frameNavigated', { url: 'https://a.com' });
      cdpMock._emit('Page.loadEventFired', { timestamp: 2 });
      cdpMock._emit('Network.requestWillBeSent', { requestId: '1' });
      expect(ctx.events).toHaveLength(3);
      expect(ctx.events[0].method).toBe('Page.frameNavigated');
      expect(ctx.events[1].method).toBe('Page.loadEventFired');
      expect(ctx.events[2].method).toBe('Network.requestWillBeSent');
    });

    it('drops the oldest event when buffer exceeds EVENT_BUFFER_SIZE', () => {
      // Fill buffer to exactly EVENT_BUFFER_SIZE
      for (let i = 0; i < EVENT_BUFFER_SIZE; i++) {
        cdpMock._emit('Page.loadEventFired', { index: i });
      }
      expect(ctx.events).toHaveLength(EVENT_BUFFER_SIZE);

      // One more event — oldest (index:0) should be dropped
      cdpMock._emit('Page.loadEventFired', { index: EVENT_BUFFER_SIZE });
      expect(ctx.events).toHaveLength(EVENT_BUFFER_SIZE);
      expect((ctx.events[0].params as { index: number }).index).toBe(1);
      expect((ctx.events[EVENT_BUFFER_SIZE - 1].params as { index: number }).index).toBe(EVENT_BUFFER_SIZE);
    });

    it('buffer cap stays at EVENT_BUFFER_SIZE after many overflows', () => {
      for (let i = 0; i < EVENT_BUFFER_SIZE * 2; i++) {
        cdpMock._emit('Page.loadEventFired', { index: i });
      }
      expect(ctx.events.length).toBe(EVENT_BUFFER_SIZE);
    });
  });

  // ---------------------------------------------------------------------------
  // Exported constants
  // ---------------------------------------------------------------------------

  describe('exported constants', () => {
    it('EVENT_BUFFER_SIZE is 500', () => {
      expect(EVENT_BUFFER_SIZE).toBe(500);
    });

    it('INTERNAL_URL_PREFIXES includes "chrome://"', () => {
      expect(INTERNAL_URL_PREFIXES).toContain('chrome://');
    });

    it('INTERNAL_URL_PREFIXES includes "about:"', () => {
      expect(INTERNAL_URL_PREFIXES).toContain('about:');
    });

    it('INTERNAL_URL_PREFIXES includes "devtools://"', () => {
      expect(INTERNAL_URL_PREFIXES).toContain('devtools://');
    });

    it('INTERNAL_URL_PREFIXES includes "chrome-extension://"', () => {
      expect(INTERNAL_URL_PREFIXES).toContain('chrome-extension://');
    });

    it('INTERNAL_URL_PREFIXES is an array', () => {
      expect(Array.isArray(INTERNAL_URL_PREFIXES)).toBe(true);
    });
  });
});
