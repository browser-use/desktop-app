import { describe, it, expect } from 'vitest';
import {
  SessionStatusSchema,
  HlEventSchema,
  AgentSessionSchema,
  OutputEntrySchema,
  TabInfoSchema,
  BrowserPoolStatsSchema,
  validateSession,
  validateSessionList,
  validateHlEvent,
  validateTabs,
  validatePoolStats,
} from '../../../src/shared/session-schemas';

// ---------------------------------------------------------------------------
// SessionStatus
// ---------------------------------------------------------------------------

describe('SessionStatusSchema', () => {
  it('accepts valid statuses', () => {
    expect(SessionStatusSchema.parse('draft')).toBe('draft');
    expect(SessionStatusSchema.parse('running')).toBe('running');
    expect(SessionStatusSchema.parse('stuck')).toBe('stuck');
    expect(SessionStatusSchema.parse('stopped')).toBe('stopped');
  });

  it('rejects invalid status', () => {
    expect(() => SessionStatusSchema.parse('paused')).toThrow();
    expect(() => SessionStatusSchema.parse(42)).toThrow();
    expect(() => SessionStatusSchema.parse(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// HlEvent discriminated union
// ---------------------------------------------------------------------------

describe('HlEventSchema', () => {
  it('parses thinking event', () => {
    const event = HlEventSchema.parse({ type: 'thinking', text: 'analyzing...' });
    expect(event.type).toBe('thinking');
    if (event.type === 'thinking') expect(event.text).toBe('analyzing...');
  });

  it('parses tool_call event', () => {
    const event = HlEventSchema.parse({
      type: 'tool_call',
      name: 'click',
      args: { x: 100, y: 200 },
      iteration: 1,
    });
    expect(event.type).toBe('tool_call');
  });

  it('parses tool_result event', () => {
    const event = HlEventSchema.parse({
      type: 'tool_result',
      name: 'click',
      ok: true,
      preview: 'clicked element',
      ms: 42,
    });
    expect(event.type).toBe('tool_result');
  });

  it('parses done event', () => {
    const event = HlEventSchema.parse({
      type: 'done',
      summary: 'Task completed',
      iterations: 3,
    });
    expect(event.type).toBe('done');
  });

  it('parses error event', () => {
    const event = HlEventSchema.parse({
      type: 'error',
      message: 'api_error: rate_limited',
    });
    expect(event.type).toBe('error');
  });

  it('rejects unknown event type', () => {
    expect(() => HlEventSchema.parse({ type: 'unknown_type' })).toThrow();
  });

  it('rejects event with missing required fields', () => {
    expect(() => HlEventSchema.parse({ type: 'thinking' })).toThrow();
    expect(() => HlEventSchema.parse({ type: 'tool_call', name: 'click' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentSession
// ---------------------------------------------------------------------------

describe('AgentSessionSchema', () => {
  const validSession = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    prompt: 'Find all broken links',
    status: 'running',
    createdAt: 1713484800000,
    output: [
      { type: 'thinking', text: 'Starting...' },
      { type: 'tool_call', name: 'goto', args: { url: 'https://example.com' }, iteration: 1 },
    ],
  };

  it('parses a valid session', () => {
    const session = AgentSessionSchema.parse(validSession);
    expect(session.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(session.status).toBe('running');
    expect(session.output.length).toBe(2);
  });

  it('accepts optional error field', () => {
    const session = AgentSessionSchema.parse({ ...validSession, status: 'stopped', error: 'Cancelled by user' });
    expect(session.error).toBe('Cancelled by user');
  });

  it('accepts optional group field', () => {
    const session = AgentSessionSchema.parse({ ...validSession, group: 'research' });
    expect(session.group).toBe('research');
  });

  it('rejects session with invalid status', () => {
    expect(() => AgentSessionSchema.parse({ ...validSession, status: 'paused' })).toThrow();
  });

  it('rejects session with non-uuid id', () => {
    expect(() => AgentSessionSchema.parse({ ...validSession, id: 'not-a-uuid' })).toThrow();
  });

  it('rejects session with invalid output events', () => {
    expect(() => AgentSessionSchema.parse({
      ...validSession,
      output: [{ type: 'invalid' }],
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// OutputEntry
// ---------------------------------------------------------------------------

describe('OutputEntrySchema', () => {
  it('parses a valid output entry', () => {
    const entry = OutputEntrySchema.parse({
      id: 'oe-1',
      type: 'tool_call',
      timestamp: 1713484800000,
      content: '{"x": 100}',
      tool: 'click',
    });
    expect(entry.type).toBe('tool_call');
    expect(entry.tool).toBe('click');
  });

  it('accepts optional duration', () => {
    const entry = OutputEntrySchema.parse({
      id: 'oe-2',
      type: 'tool_result',
      timestamp: 1713484800000,
      content: 'done',
      duration: 150,
    });
    expect(entry.duration).toBe(150);
  });

  it('rejects invalid type', () => {
    expect(() => OutputEntrySchema.parse({
      id: 'oe-3',
      type: 'invalid',
      timestamp: 0,
      content: '',
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TabInfo
// ---------------------------------------------------------------------------

describe('TabInfoSchema', () => {
  it('parses valid tab info', () => {
    const tab = TabInfoSchema.parse({
      targetId: 'target-1',
      url: 'https://example.com',
      title: 'Example',
      type: 'page',
      active: true,
    });
    expect(tab.url).toBe('https://example.com');
  });

  it('rejects invalid tab type', () => {
    expect(() => TabInfoSchema.parse({
      targetId: '1',
      url: '',
      title: '',
      type: 'worker',
      active: false,
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BrowserPoolStats
// ---------------------------------------------------------------------------

describe('BrowserPoolStatsSchema', () => {
  it('parses valid stats', () => {
    const stats = BrowserPoolStatsSchema.parse({
      active: 3,
      queued: 1,
      maxConcurrent: 10,
      sessions: [
        { sessionId: 's1', attached: false, createdAt: 1713484800000, pid: 12345 },
      ],
    });
    expect(stats.active).toBe(3);
    expect(stats.sessions.length).toBe(1);
  });

  it('accepts empty sessions array', () => {
    const stats = BrowserPoolStatsSchema.parse({
      active: 0,
      queued: 0,
      maxConcurrent: 10,
      sessions: [],
    });
    expect(stats.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

describe('validation helpers', () => {
  const validSession = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    prompt: 'test',
    status: 'draft',
    createdAt: Date.now(),
    output: [] as unknown[],
  };

  it('validateSession passes for valid data', () => {
    const result = validateSession(validSession);
    expect(result.id).toBe(validSession.id);
  });

  it('validateSession throws for invalid data', () => {
    expect(() => validateSession({ id: 'bad' })).toThrow();
  });

  it('validateSessionList passes for valid array', () => {
    const result = validateSessionList([validSession]);
    expect(result.length).toBe(1);
  });

  it('validateSessionList throws for non-array', () => {
    expect(() => validateSessionList('not an array')).toThrow();
  });

  it('validateHlEvent passes for valid event', () => {
    const result = validateHlEvent({ type: 'thinking', text: 'hi' });
    expect(result.type).toBe('thinking');
  });

  it('validateTabs passes for valid tab array', () => {
    const result = validateTabs([{
      targetId: '1', url: 'https://x.com', title: 'X', type: 'page', active: true,
    }]);
    expect(result.length).toBe(1);
  });

  it('validatePoolStats passes for valid stats', () => {
    const result = validatePoolStats({
      active: 0, queued: 0, maxConcurrent: 10, sessions: [],
    });
    expect(result.active).toBe(0);
  });
});
