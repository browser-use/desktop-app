/**
 * EventStream unit tests.
 *
 * Tests cover:
 *   - subscribe: global handler receives all emitted events
 *   - unsubscribe: returned function removes the handler
 *   - subscribeToType: only receives matching event type
 *   - subscribeToTask: only receives matching task_id events
 *   - emit: fans out to global, typed, and task handlers simultaneously
 *   - Handler errors are caught and don't prevent other handlers from firing
 *   - clearTaskHandlers: removes all handlers for a task
 *   - subscriberCount: reflects current global handler count
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/main/logger', () => ({
  daemonLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EventStream } from '../../../src/main/daemon/eventStream';
import type { AgentEvent, TaskStartedEvent, TaskDoneEvent, StepStartEvent } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERSION = '1.0' as const;

function makeTaskStarted(task_id: string): TaskStartedEvent {
  return { version: VERSION, event: 'task_started', task_id, started_at: '2026-01-01T00:00:00Z' };
}

function makeTaskDone(task_id: string): TaskDoneEvent {
  return { version: VERSION, event: 'task_done', task_id, result: null, steps_used: 1, tokens_used: 100 };
}

function makeStepStart(task_id: string, step = 1): StepStartEvent {
  return { version: VERSION, event: 'step_start', task_id, step, plan: 'do stuff' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventStream', () => {
  let stream: EventStream;

  beforeEach(() => {
    stream = new EventStream();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // subscribe (global)
  // ---------------------------------------------------------------------------

  describe('subscribe()', () => {
    it('handler receives emitted events', () => {
      const handler = vi.fn();
      stream.subscribe(handler);
      const event = makeTaskStarted('task-1');
      stream.emit(event);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('multiple global handlers all receive the event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      stream.subscribe(h1);
      stream.subscribe(h2);
      stream.emit(makeTaskStarted('task-1'));
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it('unsubscribe stops the handler from receiving events', () => {
      const handler = vi.fn();
      const unsub = stream.subscribe(handler);
      unsub();
      stream.emit(makeTaskStarted('task-1'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns a function that can be called multiple times without error', () => {
      const unsub = stream.subscribe(vi.fn());
      expect(() => { unsub(); unsub(); }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // subscribeToType
  // ---------------------------------------------------------------------------

  describe('subscribeToType()', () => {
    it('handler receives only matching event types', () => {
      const handler = vi.fn();
      stream.subscribeToType('task_started', handler);
      stream.emit(makeTaskStarted('task-1'));
      stream.emit(makeTaskDone('task-1'));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(makeTaskStarted('task-1'));
    });

    it('handler does not receive non-matching event types', () => {
      const handler = vi.fn();
      stream.subscribeToType('task_done', handler);
      stream.emit(makeTaskStarted('task-1'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops typed handler', () => {
      const handler = vi.fn();
      const unsub = stream.subscribeToType('task_started', handler);
      unsub();
      stream.emit(makeTaskStarted('task-1'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('multiple typed subscriptions for the same type all receive events', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      stream.subscribeToType('step_start', h1);
      stream.subscribeToType('step_start', h2);
      stream.emit(makeStepStart('task-1'));
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // subscribeToTask
  // ---------------------------------------------------------------------------

  describe('subscribeToTask()', () => {
    it('handler receives events for matching task_id', () => {
      const handler = vi.fn();
      stream.subscribeToTask('task-A', handler);
      stream.emit(makeTaskStarted('task-A'));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('handler does not receive events for different task_id', () => {
      const handler = vi.fn();
      stream.subscribeToTask('task-A', handler);
      stream.emit(makeTaskStarted('task-B'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops task handler', () => {
      const handler = vi.fn();
      const unsub = stream.subscribeToTask('task-A', handler);
      unsub();
      stream.emit(makeTaskStarted('task-A'));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // emit fanout
  // ---------------------------------------------------------------------------

  describe('emit() fanout', () => {
    it('fires global, typed, and task handlers for the same event', () => {
      const globalHandler = vi.fn();
      const typedHandler = vi.fn();
      const taskHandler = vi.fn();

      stream.subscribe(globalHandler);
      stream.subscribeToType('task_started', typedHandler);
      stream.subscribeToTask('task-1', taskHandler);

      stream.emit(makeTaskStarted('task-1'));

      expect(globalHandler).toHaveBeenCalledOnce();
      expect(typedHandler).toHaveBeenCalledOnce();
      expect(taskHandler).toHaveBeenCalledOnce();
    });

    it('does not call typed handler for non-matching event type', () => {
      const doneHandler = vi.fn();
      stream.subscribeToType('task_done', doneHandler);
      stream.emit(makeTaskStarted('task-1'));
      expect(doneHandler).not.toHaveBeenCalled();
    });

    it('emit passes the event object by reference', () => {
      let received: AgentEvent | null = null;
      stream.subscribe((e) => { received = e; });
      const event = makeTaskDone('task-99');
      stream.emit(event);
      expect(received).toBe(event);
    });
  });

  // ---------------------------------------------------------------------------
  // Error isolation
  // ---------------------------------------------------------------------------

  describe('handler error isolation', () => {
    it('throwing global handler does not prevent subsequent handlers from firing', () => {
      const h2 = vi.fn();
      stream.subscribe(() => { throw new Error('boom'); });
      stream.subscribe(h2);
      stream.emit(makeTaskStarted('task-1'));
      expect(h2).toHaveBeenCalledOnce();
    });

    it('throwing typed handler does not prevent other typed handlers from firing', () => {
      const h2 = vi.fn();
      stream.subscribeToType('task_started', () => { throw new Error('boom'); });
      stream.subscribeToType('task_started', h2);
      stream.emit(makeTaskStarted('task-1'));
      expect(h2).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // clearTaskHandlers
  // ---------------------------------------------------------------------------

  describe('clearTaskHandlers()', () => {
    it('removes all handlers for the given task_id', () => {
      const handler = vi.fn();
      stream.subscribeToTask('task-1', handler);
      stream.clearTaskHandlers('task-1');
      stream.emit(makeTaskStarted('task-1'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not affect handlers for other tasks', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      stream.subscribeToTask('task-1', h1);
      stream.subscribeToTask('task-2', h2);
      stream.clearTaskHandlers('task-1');
      stream.emit(makeTaskStarted('task-2'));
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledOnce();
    });

    it('is a no-op when no handlers exist for the task', () => {
      expect(() => stream.clearTaskHandlers('nonexistent-task')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // subscriberCount
  // ---------------------------------------------------------------------------

  describe('subscriberCount()', () => {
    it('returns 0 when no global subscribers', () => {
      expect(stream.subscriberCount()).toBe(0);
    });

    it('increments with each subscribe', () => {
      stream.subscribe(vi.fn());
      expect(stream.subscriberCount()).toBe(1);
      stream.subscribe(vi.fn());
      expect(stream.subscriberCount()).toBe(2);
    });

    it('decrements after unsubscribe', () => {
      const unsub = stream.subscribe(vi.fn());
      expect(stream.subscriberCount()).toBe(1);
      unsub();
      expect(stream.subscriberCount()).toBe(0);
    });
  });
});
