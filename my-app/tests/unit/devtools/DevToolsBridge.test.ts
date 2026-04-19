/**
 * DevToolsBridge unit tests.
 *
 * Tests cover:
 *   - attach: calls debugger.attach, registers message+detach listeners
 *   - attach to same target: no-op (idempotent)
 *   - attach to different target: detaches first, then re-attaches
 *   - attach fails (debugger.attach throws): leaves bridge unattached
 *   - detach: when not attached is a no-op
 *   - detach: removes listeners, calls debugger.detach(), resets state
 *   - detach: debugger.detach() throws → warns but still resets state
 *   - send: throws when not attached
 *   - send: calls debugger.sendCommand with method and params
 *   - send: tracks enabled/disabled domains via .enable/.disable suffixes
 *   - send: propagates errors from sendCommand
 *   - isAttached: reflects attach/detach state
 *   - getEnabledDomains: returns tracked domains
 *   - message event: forwards CDP events to devtoolsWindow via IPC
 *   - message event: skips forward when devtoolsWindow is destroyed
 *   - detach event: resets attached state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContents: class {},
}));

import { DevToolsBridge } from '../../../src/main/devtools/DevToolsBridge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventName = 'message' | 'detach';
type DebuggerMessageHandler = (event: object, method: string, params: unknown) => void;
type DebuggerDetachHandler = (event: object, reason: string) => void;

function makeDebugger() {
  const handlers: Partial<Record<EventName, ((...args: unknown[]) => void)[]>> = {};
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(() => Promise.resolve({})),
    on: vi.fn((event: EventName, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event]!.push(handler);
    }),
    removeListener: vi.fn((event: EventName, handler: (...args: unknown[]) => void) => {
      if (handlers[event]) {
        handlers[event] = handlers[event]!.filter((h) => h !== handler);
      }
    }),
    emit: (event: EventName, ...args: unknown[]) => {
      handlers[event]?.forEach((h) => h(...args));
    },
    handlerCount: (event: EventName) => handlers[event]?.length ?? 0,
  };
}

function makeWebContents(id = 1) {
  const dbg = makeDebugger();
  return {
    id,
    debugger: dbg,
  };
}

function makeDevtoolsWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DevToolsBridge', () => {
  let bridge: DevToolsBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new DevToolsBridge();
  });

  // ---------------------------------------------------------------------------
  // isAttached / initial state
  // ---------------------------------------------------------------------------

  it('is not attached initially', () => {
    expect(bridge.isAttached()).toBe(false);
  });

  it('getEnabledDomains returns empty array initially', () => {
    expect(bridge.getEnabledDomains()).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // attach()
  // ---------------------------------------------------------------------------

  describe('attach()', () => {
    it('calls debugger.attach with CDP version', () => {
      const wc = makeWebContents();
      const win = makeDevtoolsWindow();
      bridge.attach(wc as never, win as never);
      expect(wc.debugger.attach).toHaveBeenCalledWith('1.3');
    });

    it('sets isAttached to true on success', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      expect(bridge.isAttached()).toBe(true);
    });

    it('registers message and detach listeners on the debugger', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      expect(wc.debugger.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(wc.debugger.on).toHaveBeenCalledWith('detach', expect.any(Function));
    });

    it('is a no-op when already attached to the same webContents', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      expect(wc.debugger.attach).toHaveBeenCalledOnce();
    });

    it('detaches from old target before attaching to new target', () => {
      const wc1 = makeWebContents(1);
      const wc2 = makeWebContents(2);
      bridge.attach(wc1 as never, makeDevtoolsWindow() as never);
      bridge.attach(wc2 as never, makeDevtoolsWindow() as never);
      expect(wc1.debugger.detach).toHaveBeenCalledOnce();
      expect(wc2.debugger.attach).toHaveBeenCalledOnce();
    });

    it('leaves bridge unattached when debugger.attach throws', () => {
      const wc = makeWebContents();
      wc.debugger.attach.mockImplementation(() => { throw new Error('already attached'); });
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      expect(bridge.isAttached()).toBe(false);
    });

    it('logs an error when debugger.attach throws', () => {
      const wc = makeWebContents();
      wc.debugger.attach.mockImplementation(() => { throw new Error('fail'); });
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      expect(loggerSpy.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // detach()
  // ---------------------------------------------------------------------------

  describe('detach()', () => {
    it('is a no-op when not attached', () => {
      expect(() => bridge.detach()).not.toThrow();
    });

    it('removes message and detach listeners', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      bridge.detach();
      expect(wc.debugger.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(wc.debugger.removeListener).toHaveBeenCalledWith('detach', expect.any(Function));
    });

    it('calls debugger.detach()', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      bridge.detach();
      expect(wc.debugger.detach).toHaveBeenCalledOnce();
    });

    it('sets isAttached to false', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      bridge.detach();
      expect(bridge.isAttached()).toBe(false);
    });

    it('clears enabled domains', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('CSS.enable');
      bridge.detach();
      expect(bridge.getEnabledDomains()).toEqual([]);
    });

    it('warns but still resets state when debugger.detach throws', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      wc.debugger.detach.mockImplementation(() => { throw new Error('not attached'); });
      bridge.detach();
      expect(bridge.isAttached()).toBe(false);
      expect(loggerSpy.warn).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // send()
  // ---------------------------------------------------------------------------

  describe('send()', () => {
    it('throws when not attached', async () => {
      await expect(bridge.send('DOM.enable')).rejects.toThrow('not attached');
    });

    it('calls debugger.sendCommand with method and params', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('DOM.getDocument', { depth: 1 });
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith('DOM.getDocument', { depth: 1 });
    });

    it('calls debugger.sendCommand with undefined params when omitted', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('CSS.enable');
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith('CSS.enable', undefined);
    });

    it('adds domain to enabledDomains on *.enable', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('CSS.enable');
      expect(bridge.getEnabledDomains()).toContain('CSS');
    });

    it('removes domain from enabledDomains on *.disable', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('CSS.enable');
      await bridge.send('CSS.disable');
      expect(bridge.getEnabledDomains()).not.toContain('CSS');
    });

    it('does not track domain for non-enable/disable methods', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('DOM.getDocument');
      expect(bridge.getEnabledDomains()).toEqual([]);
    });

    it('propagates errors from sendCommand', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      wc.debugger.sendCommand.mockRejectedValue(new Error('CDP error'));
      await expect(bridge.send('DOM.enable')).rejects.toThrow('CDP error');
    });

    it('returns the result from sendCommand', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      const payload = { root: { nodeId: 1 } };
      wc.debugger.sendCommand.mockResolvedValue(payload);
      const result = await bridge.send('DOM.getDocument');
      expect(result).toBe(payload);
    });
  });

  // ---------------------------------------------------------------------------
  // CDP event forwarding (message handler)
  // ---------------------------------------------------------------------------

  describe('message event forwarding', () => {
    it('forwards CDP events to devtoolsWindow via IPC', () => {
      const wc = makeWebContents();
      const win = makeDevtoolsWindow();
      bridge.attach(wc as never, win as never);

      const params = { nodeId: 42 };
      wc.debugger.emit('message', {}, 'DOM.setChildNodes', params);

      expect(win.webContents.send).toHaveBeenCalledWith(
        'devtools:cdp-event',
        'DOM.setChildNodes',
        params,
      );
    });

    it('does not forward when devtoolsWindow is destroyed', () => {
      const wc = makeWebContents();
      const win = makeDevtoolsWindow(true); // isDestroyed() = true
      bridge.attach(wc as never, win as never);

      wc.debugger.emit('message', {}, 'DOM.setChildNodes', {});

      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // debugger detach event
  // ---------------------------------------------------------------------------

  describe('debugger detach event', () => {
    it('resets isAttached to false when debugger fires detach', () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      expect(bridge.isAttached()).toBe(true);

      wc.debugger.emit('detach', {}, 'target_closed');

      expect(bridge.isAttached()).toBe(false);
    });

    it('clears enabledDomains when debugger fires detach', async () => {
      const wc = makeWebContents();
      bridge.attach(wc as never, makeDevtoolsWindow() as never);
      await bridge.send('CSS.enable');

      wc.debugger.emit('detach', {}, 'target_closed');

      expect(bridge.getEnabledDomains()).toEqual([]);
    });
  });
});
