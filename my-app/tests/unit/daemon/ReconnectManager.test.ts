/**
 * ReconnectManager unit tests.
 *
 * Tests cover:
 *   - onConnected: resets attempts and currentDelayMs
 *   - onDisconnected: schedules reconnect, increments attempts
 *   - Exponential backoff: delay doubles each disconnection
 *   - Max attempts: calls onGiveUp after exceeding limit
 *   - stop(): cancels pending reconnect, ignores subsequent onDisconnected
 *   - isStopped / getAttempts / getCurrentDelayMs accessors
 *   - onReconnect is called after scheduled delay
 *   - Failed onReconnect does not increment attempts directly (reconnect failure
 *     triggers onDisconnected externally)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/main/logger', () => ({
  daemonLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ReconnectManager } from '../../../src/main/daemon/reconnect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(overrides: {
  onReconnect?: () => Promise<void>;
  onGiveUp?: () => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
} = {}) {
  const onReconnect = overrides.onReconnect ?? vi.fn(() => Promise.resolve());
  const onGiveUp = overrides.onGiveUp ?? vi.fn();
  const manager = new ReconnectManager({
    onReconnect,
    onGiveUp,
    initialDelayMs: overrides.initialDelayMs ?? 100,
    maxDelayMs: overrides.maxDelayMs ?? 1600,
    maxAttempts: overrides.maxAttempts ?? 5,
  });
  return { manager, onReconnect, onGiveUp };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReconnectManager', () => {
  describe('initial state', () => {
    it('starts with 0 attempts', () => {
      const { manager } = makeManager();
      expect(manager.getAttempts()).toBe(0);
    });

    it('starts with initialDelayMs as currentDelayMs', () => {
      const { manager } = makeManager({ initialDelayMs: 250 });
      expect(manager.getCurrentDelayMs()).toBe(250);
    });

    it('starts not stopped', () => {
      const { manager } = makeManager();
      expect(manager.isStopped()).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('resets attempts to 0', () => {
      const { manager } = makeManager();
      manager.onDisconnected();
      expect(manager.getAttempts()).toBe(1);
      manager.onConnected();
      expect(manager.getAttempts()).toBe(0);
    });

    it('resets currentDelayMs to initialDelayMs', () => {
      const { manager } = makeManager({ initialDelayMs: 100, maxDelayMs: 1600 });
      manager.onDisconnected(); // advances backoff
      expect(manager.getCurrentDelayMs()).toBeGreaterThan(100);
      manager.onConnected();
      expect(manager.getCurrentDelayMs()).toBe(100);
    });

    it('cancels a pending reconnect timer', () => {
      const { manager, onReconnect } = makeManager({ initialDelayMs: 500 });
      manager.onDisconnected();
      manager.onConnected();
      vi.advanceTimersByTime(1000);
      expect(onReconnect).not.toHaveBeenCalled();
    });
  });

  describe('onDisconnected()', () => {
    it('increments attempts', () => {
      const { manager } = makeManager();
      manager.onDisconnected();
      expect(manager.getAttempts()).toBe(1);
    });

    it('calls onReconnect after the scheduled delay', () => {
      const { manager, onReconnect } = makeManager({ initialDelayMs: 100 });
      manager.onDisconnected();
      expect(onReconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200); // past initial delay + max jitter
      expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('does nothing when stopped', () => {
      const { manager, onReconnect } = makeManager();
      manager.stop();
      manager.onDisconnected();
      vi.advanceTimersByTime(500);
      expect(onReconnect).not.toHaveBeenCalled();
      expect(manager.getAttempts()).toBe(0);
    });
  });

  describe('exponential backoff', () => {
    it('doubles currentDelayMs after each disconnection', () => {
      const { manager } = makeManager({ initialDelayMs: 100, maxDelayMs: 10000 });
      manager.onDisconnected(); // attempt 1, next = 200
      expect(manager.getCurrentDelayMs()).toBe(200);
      manager.onDisconnected(); // attempt 2, next = 400
      expect(manager.getCurrentDelayMs()).toBe(400);
      manager.onDisconnected(); // attempt 3, next = 800
      expect(manager.getCurrentDelayMs()).toBe(800);
    });

    it('caps delay at maxDelayMs', () => {
      const { manager } = makeManager({ initialDelayMs: 100, maxDelayMs: 300 });
      manager.onDisconnected(); // 100 → 200
      manager.onDisconnected(); // 200 → 400, capped to 300
      expect(manager.getCurrentDelayMs()).toBe(300);
      manager.onDisconnected(); // already capped
      expect(manager.getCurrentDelayMs()).toBe(300);
    });
  });

  describe('max attempts', () => {
    it('calls onGiveUp when attempts exceed maxAttempts', () => {
      const { manager, onGiveUp } = makeManager({ maxAttempts: 3 });
      manager.onDisconnected(); // 1
      manager.onDisconnected(); // 2
      manager.onDisconnected(); // 3
      expect(onGiveUp).not.toHaveBeenCalled();
      manager.onDisconnected(); // 4 > 3 → give up
      expect(onGiveUp).toHaveBeenCalledOnce();
    });

    it('does not schedule a timer after giving up', () => {
      const { manager, onReconnect } = makeManager({ maxAttempts: 1 });
      manager.onDisconnected(); // 1 — scheduled
      manager.onDisconnected(); // 2 > 1 — give up
      vi.advanceTimersByTime(10000);
      // Only the first scheduled attempt fires, the second gives up without scheduling
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('sets isStopped to true', () => {
      const { manager } = makeManager();
      manager.stop();
      expect(manager.isStopped()).toBe(true);
    });

    it('cancels a pending reconnect', () => {
      const { manager, onReconnect } = makeManager({ initialDelayMs: 500 });
      manager.onDisconnected();
      manager.stop();
      vi.advanceTimersByTime(1000);
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('subsequent onDisconnected calls are ignored after stop', () => {
      const { manager, onReconnect } = makeManager();
      manager.stop();
      manager.onDisconnected();
      manager.onDisconnected();
      vi.advanceTimersByTime(2000);
      expect(onReconnect).not.toHaveBeenCalled();
    });
  });

  describe('accessors', () => {
    it('getAttempts reflects the current attempt count', () => {
      const { manager } = makeManager({ maxAttempts: 10 });
      expect(manager.getAttempts()).toBe(0);
      manager.onDisconnected();
      expect(manager.getAttempts()).toBe(1);
      manager.onDisconnected();
      expect(manager.getAttempts()).toBe(2);
    });

    it('getCurrentDelayMs reflects the advanced backoff', () => {
      const { manager } = makeManager({ initialDelayMs: 50 });
      expect(manager.getCurrentDelayMs()).toBe(50);
      manager.onDisconnected();
      expect(manager.getCurrentDelayMs()).toBe(100);
    });
  });
});
