/**
 * PictureInPictureManager unit tests.
 *
 * Tests cover:
 *   - pip:enter: returns {ok:false, error:'no_active_tab'} when getActiveWebContents() is null
 *   - pip:enter: returns {ok:false, error:'no_active_tab'} when webContents is destroyed
 *   - pip:enter: calls executeJavaScript(PIP_ENTER_SCRIPT, true) and returns result
 *   - pip:enter: returns {ok:false, error:msg} when executeJavaScript throws
 *   - pip:exit: same no-webContents guard
 *   - pip:exit: calls executeJavaScript(PIP_EXIT_SCRIPT, true) and returns result
 *   - pip:exit: returns {ok:false, error:msg} when executeJavaScript throws
 *   - pip:get-status: returns null when no active webContents
 *   - pip:get-status: returns status object from executeJavaScript
 *   - pip:get-status: returns null when executeJavaScript throws
 *   - registerPipHandlers: registers all three IPC channels
 *   - unregisterPipHandlers: removes all three channels
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  WebContents: class {},
}));

import { registerPipHandlers, unregisterPipHandlers } from '../../../src/main/pip/PictureInPictureManager';
import type { PipResult, PipStatus } from '../../../src/main/pip/PictureInPictureManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for: ${channel}`);
  return handler({} /* event */, ...args);
}

function makeWebContents(opts: { destroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    executeJavaScript: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PictureInPictureManager', () => {
  let getActiveWebContents: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    getActiveWebContents = vi.fn(() => null);
    registerPipHandlers(getActiveWebContents as () => null);
  });

  // ---------------------------------------------------------------------------
  // registerPipHandlers / unregisterPipHandlers
  // ---------------------------------------------------------------------------

  describe('registerPipHandlers()', () => {
    it('registers pip:enter, pip:exit, and pip:get-status channels', () => {
      expect(handlers.has('pip:enter')).toBe(true);
      expect(handlers.has('pip:exit')).toBe(true);
      expect(handlers.has('pip:get-status')).toBe(true);
    });
  });

  describe('unregisterPipHandlers()', () => {
    it('removes all pip channels', () => {
      unregisterPipHandlers();
      expect(handlers.has('pip:enter')).toBe(false);
      expect(handlers.has('pip:exit')).toBe(false);
      expect(handlers.has('pip:get-status')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // pip:enter
  // ---------------------------------------------------------------------------

  describe('pip:enter', () => {
    it('returns {ok:false, error:"no_active_tab"} when getActiveWebContents returns null', async () => {
      getActiveWebContents.mockReturnValue(null);
      const result = await invokeHandler('pip:enter') as PipResult;
      expect(result).toEqual({ ok: false, error: 'no_active_tab' });
    });

    it('returns {ok:false, error:"no_active_tab"} when webContents is destroyed', async () => {
      const wc = makeWebContents({ destroyed: true });
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:enter') as PipResult;
      expect(result).toEqual({ ok: false, error: 'no_active_tab' });
    });

    it('calls executeJavaScript with trustedTypes flag', async () => {
      const wc = makeWebContents();
      wc.executeJavaScript.mockResolvedValue({ ok: true, action: 'enter' });
      getActiveWebContents.mockReturnValue(wc);
      await invokeHandler('pip:enter');
      expect(wc.executeJavaScript).toHaveBeenCalledWith(expect.any(String), true);
    });

    it('returns the result from executeJavaScript', async () => {
      const wc = makeWebContents();
      const payload: PipResult = { ok: true, action: 'enter' };
      wc.executeJavaScript.mockResolvedValue(payload);
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:enter') as PipResult;
      expect(result).toEqual(payload);
    });

    it('returns {ok:false, error:msg} when executeJavaScript throws', async () => {
      const wc = makeWebContents();
      wc.executeJavaScript.mockRejectedValue(new Error('PiP not supported'));
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:enter') as PipResult;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('PiP not supported');
    });
  });

  // ---------------------------------------------------------------------------
  // pip:exit
  // ---------------------------------------------------------------------------

  describe('pip:exit', () => {
    it('returns {ok:false, error:"no_active_tab"} when getActiveWebContents returns null', async () => {
      getActiveWebContents.mockReturnValue(null);
      const result = await invokeHandler('pip:exit') as PipResult;
      expect(result).toEqual({ ok: false, error: 'no_active_tab' });
    });

    it('returns {ok:false, error:"no_active_tab"} when webContents is destroyed', async () => {
      const wc = makeWebContents({ destroyed: true });
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:exit') as PipResult;
      expect(result).toEqual({ ok: false, error: 'no_active_tab' });
    });

    it('calls executeJavaScript with trustedTypes flag', async () => {
      const wc = makeWebContents();
      wc.executeJavaScript.mockResolvedValue({ ok: true });
      getActiveWebContents.mockReturnValue(wc);
      await invokeHandler('pip:exit');
      expect(wc.executeJavaScript).toHaveBeenCalledWith(expect.any(String), true);
    });

    it('returns the result from executeJavaScript', async () => {
      const wc = makeWebContents();
      const payload: PipResult = { ok: true };
      wc.executeJavaScript.mockResolvedValue(payload);
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:exit') as PipResult;
      expect(result).toEqual(payload);
    });

    it('returns {ok:false, error:msg} when executeJavaScript throws', async () => {
      const wc = makeWebContents();
      wc.executeJavaScript.mockRejectedValue(new Error('exit failed'));
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:exit') as PipResult;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('exit failed');
    });
  });

  // ---------------------------------------------------------------------------
  // pip:get-status
  // ---------------------------------------------------------------------------

  describe('pip:get-status', () => {
    it('returns null when getActiveWebContents returns null', async () => {
      getActiveWebContents.mockReturnValue(null);
      const result = await invokeHandler('pip:get-status');
      expect(result).toBeNull();
    });

    it('returns null when webContents is destroyed', async () => {
      const wc = makeWebContents({ destroyed: true });
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:get-status');
      expect(result).toBeNull();
    });

    it('calls executeJavaScript with trustedTypes flag', async () => {
      const wc = makeWebContents();
      wc.executeJavaScript.mockResolvedValue({ supported: true, active: false, hasVideo: true });
      getActiveWebContents.mockReturnValue(wc);
      await invokeHandler('pip:get-status');
      expect(wc.executeJavaScript).toHaveBeenCalledWith(expect.any(String), true);
    });

    it('returns the status object from executeJavaScript', async () => {
      const wc = makeWebContents();
      const status: PipStatus = { supported: true, active: false, hasVideo: true };
      wc.executeJavaScript.mockResolvedValue(status);
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:get-status') as PipStatus;
      expect(result).toEqual(status);
    });

    it('returns null when executeJavaScript throws', async () => {
      const wc = makeWebContents();
      wc.executeJavaScript.mockRejectedValue(new Error('status failed'));
      getActiveWebContents.mockReturnValue(wc);
      const result = await invokeHandler('pip:get-status');
      expect(result).toBeNull();
    });
  });
});
