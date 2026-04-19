import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../../../src/main/sessions/SessionManager';
import type { AgentSession, SessionStatus } from '../../../src/main/sessions/SessionManager';
import type { HlEvent } from '../../../src/main/hl/agent';

const thinkingEvent: HlEvent = { type: 'thinking', text: 'hello' };
const toolCallEvent: HlEvent = { type: 'tool_call', name: 'click', args: { x: 10, y: 20 }, iteration: 1 };
const toolResultEvent: HlEvent = { type: 'tool_result', name: 'click', ok: true, preview: 'done', ms: 50 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectEvents(mgr: SessionManager, event: string): unknown[] {
  const collected: unknown[] = [];
  mgr.on(event, (...args: unknown[]) => collected.push(args));
  return collected;
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('SessionManager — createSession', () => {
  let mgr: SessionManager;

  beforeEach(() => { mgr = new SessionManager(); });
  afterEach(() => { mgr.destroy(); });

  it('returns a UUID string', () => {
    const id = mgr.createSession('test prompt');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('creates session in draft status', () => {
    const id = mgr.createSession('hello');
    const session = mgr.getSession(id);
    expect(session).toBeDefined();
    expect(session!.status).toBe('draft');
    expect(session!.prompt).toBe('hello');
    expect(session!.output).toEqual([]);
    expect(session!.error).toBeUndefined();
  });

  it('emits session-created event', () => {
    const events = collectEvents(mgr, 'session-created');
    const id = mgr.createSession('prompt');
    expect(events.length).toBe(1);
    const [session] = events[0] as [AgentSession];
    expect(session.id).toBe(id);
    expect(session.status).toBe('draft');
  });

  it('assigns unique IDs to each session', () => {
    const id1 = mgr.createSession('a');
    const id2 = mgr.createSession('b');
    const id3 = mgr.createSession('c');
    expect(new Set([id1, id2, id3]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

describe('SessionManager — startSession', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('transitions draft -> running', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    expect(mgr.getSession(id)!.status).toBe('running');
  });

  it('returns an AbortController', () => {
    const id = mgr.createSession('prompt');
    const ctrl = mgr.startSession(id);
    expect(ctrl).toBeInstanceOf(AbortController);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('emits session-updated on start', () => {
    const events = collectEvents(mgr, 'session-updated');
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    expect(events.length).toBe(1);
    const [session] = events[0] as [AgentSession];
    expect(session.status).toBe('running');
  });

  it('throws if session not found', () => {
    expect(() => mgr.startSession('nonexistent')).toThrow('Session not found');
  });

  it('throws if session is not draft', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    expect(() => mgr.startSession(id)).toThrow('expected draft');
  });
});

// ---------------------------------------------------------------------------
// cancelSession
// ---------------------------------------------------------------------------

describe('SessionManager — cancelSession', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('transitions running -> stopped', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.cancelSession(id);
    const session = mgr.getSession(id)!;
    expect(session.status).toBe('stopped');
    expect(session.error).toBe('Cancelled by user');
  });

  it('aborts the AbortController signal', () => {
    const id = mgr.createSession('prompt');
    const ctrl = mgr.startSession(id);
    mgr.cancelSession(id);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('transitions stuck -> stopped', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    vi.advanceTimersByTime(31_000);
    expect(mgr.getSession(id)!.status).toBe('stuck');
    mgr.cancelSession(id);
    expect(mgr.getSession(id)!.status).toBe('stopped');
  });

  it('ignores cancel on draft session', () => {
    const id = mgr.createSession('prompt');
    mgr.cancelSession(id);
    expect(mgr.getSession(id)!.status).toBe('draft');
  });

  it('ignores cancel on already stopped session', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.cancelSession(id);
    mgr.cancelSession(id);
    expect(mgr.getSession(id)!.status).toBe('stopped');
  });

  it('ignores cancel on nonexistent session', () => {
    expect(() => mgr.cancelSession('nonexistent')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// appendOutput
// ---------------------------------------------------------------------------

describe('SessionManager — appendOutput', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('appends lines to session output', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.appendOutput(id, thinkingEvent);
    mgr.appendOutput(id, toolCallEvent);
    expect(mgr.getSession(id)!.output).toEqual([thinkingEvent, toolCallEvent]);
  });

  it('emits session-output event', () => {
    const events = collectEvents(mgr, 'session-output');
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.appendOutput(id, thinkingEvent);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual([id, thinkingEvent]);
  });

  it('recovers from stuck to running on output', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    vi.advanceTimersByTime(31_000);
    expect(mgr.getSession(id)!.status).toBe('stuck');

    const events = collectEvents(mgr, 'session-updated');
    mgr.appendOutput(id, thinkingEvent);
    expect(mgr.getSession(id)!.status).toBe('running');
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// completeSession
// ---------------------------------------------------------------------------

describe('SessionManager — completeSession', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('transitions to stopped and emits session-completed', () => {
    const events = collectEvents(mgr, 'session-completed');
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.completeSession(id);
    expect(mgr.getSession(id)!.status).toBe('stopped');
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// failSession
// ---------------------------------------------------------------------------

describe('SessionManager — failSession', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('transitions to stopped with error and emits session-error', () => {
    const events = collectEvents(mgr, 'session-error');
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.failSession(id, 'something broke');
    const session = mgr.getSession(id)!;
    expect(session.status).toBe('stopped');
    expect(session.error).toBe('something broke');
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stuck detection
// ---------------------------------------------------------------------------

describe('SessionManager — stuck detection', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('marks session as stuck after 30s of no output', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    expect(mgr.getSession(id)!.status).toBe('running');

    vi.advanceTimersByTime(29_999);
    expect(mgr.getSession(id)!.status).toBe('running');

    vi.advanceTimersByTime(2);
    expect(mgr.getSession(id)!.status).toBe('stuck');
  });

  it('emits session-updated when stuck', () => {
    const events = collectEvents(mgr, 'session-updated');
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    events.length = 0;

    vi.advanceTimersByTime(30_001);
    expect(events.length).toBe(1);
    const [session] = events[0] as [AgentSession];
    expect(session.status).toBe('stuck');
  });

  it('resets stuck timer on appendOutput', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);

    vi.advanceTimersByTime(20_000);
    mgr.appendOutput(id, toolResultEvent);

    vi.advanceTimersByTime(20_000);
    expect(mgr.getSession(id)!.status).toBe('running');

    vi.advanceTimersByTime(11_000);
    expect(mgr.getSession(id)!.status).toBe('stuck');
  });

  it('does not fire stuck timer after completion', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.completeSession(id);

    vi.advanceTimersByTime(60_000);
    expect(mgr.getSession(id)!.status).toBe('stopped');
  });

  it('does not fire stuck timer after cancel', () => {
    const id = mgr.createSession('prompt');
    mgr.startSession(id);
    mgr.cancelSession(id);

    vi.advanceTimersByTime(60_000);
    expect(mgr.getSession(id)!.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('SessionManager — listSessions', () => {
  let mgr: SessionManager;

  beforeEach(() => { mgr = new SessionManager(); });
  afterEach(() => { mgr.destroy(); });

  it('returns empty array when no sessions', () => {
    expect(mgr.listSessions()).toEqual([]);
  });

  it('returns sessions sorted newest first', () => {
    vi.useFakeTimers({ now: 1000 });
    const id1 = mgr.createSession('first');
    vi.advanceTimersByTime(10);
    const id2 = mgr.createSession('second');
    vi.advanceTimersByTime(10);
    const id3 = mgr.createSession('third');

    const list = mgr.listSessions();
    expect(list.length).toBe(3);
    expect(list[0].id).toBe(id3);
    expect(list[1].id).toBe(id2);
    expect(list[2].id).toBe(id1);
    vi.useRealTimers();
  });

  it('returns defensive copies (mutations do not leak)', () => {
    const id = mgr.createSession('prompt');
    const list = mgr.listSessions();
    list[0].prompt = 'mutated';
    expect(mgr.getSession(id)!.prompt).toBe('prompt');
  });
});

// ---------------------------------------------------------------------------
// getSession — defensive copies
// ---------------------------------------------------------------------------

describe('SessionManager — getSession', () => {
  let mgr: SessionManager;

  beforeEach(() => { mgr = new SessionManager(); });
  afterEach(() => { mgr.destroy(); });

  it('returns undefined for nonexistent session', () => {
    expect(mgr.getSession('nonexistent')).toBeUndefined();
  });

  it('returns a copy — mutations do not affect internal state', () => {
    const id = mgr.createSession('prompt');
    const session = mgr.getSession(id)!;
    session.status = 'stopped' as SessionStatus;
    expect(mgr.getSession(id)!.status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// Concurrent sessions
// ---------------------------------------------------------------------------

describe('SessionManager — concurrent sessions', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SessionManager();
  });
  afterEach(() => {
    mgr.destroy();
    vi.useRealTimers();
  });

  it('manages multiple sessions independently', () => {
    const id1 = mgr.createSession('task 1');
    const id2 = mgr.createSession('task 2');
    const id3 = mgr.createSession('task 3');

    mgr.startSession(id1);
    mgr.startSession(id2);

    expect(mgr.getSession(id1)!.status).toBe('running');
    expect(mgr.getSession(id2)!.status).toBe('running');
    expect(mgr.getSession(id3)!.status).toBe('draft');

    mgr.cancelSession(id1);
    expect(mgr.getSession(id1)!.status).toBe('stopped');
    expect(mgr.getSession(id2)!.status).toBe('running');

    mgr.appendOutput(id2, toolResultEvent);
    mgr.completeSession(id2);
    expect(mgr.getSession(id2)!.status).toBe('stopped');
    expect(mgr.getSession(id2)!.output).toEqual([toolResultEvent]);
  });

  it('stuck detection fires independently per session', () => {
    const id1 = mgr.createSession('task 1');
    const id2 = mgr.createSession('task 2');

    mgr.startSession(id1);
    mgr.startSession(id2);

    vi.advanceTimersByTime(15_000);
    mgr.appendOutput(id1, 'alive');

    vi.advanceTimersByTime(16_000);
    expect(mgr.getSession(id1)!.status).toBe('running');
    expect(mgr.getSession(id2)!.status).toBe('stuck');
  });
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe('SessionManager — destroy', () => {
  it('aborts all active controllers', () => {
    vi.useFakeTimers();
    const mgr = new SessionManager();
    const id1 = mgr.createSession('a');
    const id2 = mgr.createSession('b');
    const ctrl1 = mgr.startSession(id1);
    const ctrl2 = mgr.startSession(id2);

    mgr.destroy();
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    vi.useRealTimers();
  });
});
