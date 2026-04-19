/**
 * daemonLifecycle.ts unit tests — pure handler functions only.
 *
 * Tests cover:
 *   - handlePillSubmit: returns {error:'no_active_tab', task_id} when no CDP URL
 *   - handlePillSubmit: returns {error:'missing_api_key', task_id} when getApiKey returns null
 *   - handlePillSubmit: calls daemonClient.send with correct payload on success
 *   - handlePillSubmit: returns {task_id} on success
 *   - handlePillSubmit: returns {error:'daemon_unavailable', task_id} when send throws
 *   - handlePillSubmit: task_id is always a UUID (present on success and error paths)
 *   - handlePillCancel: calls daemonClient.send with {meta:'cancel_task', task_id}
 *   - handlePillCancel: returns {ok:true} on success
 *   - handlePillCancel: returns {ok:false, error:'daemon_unavailable'} when send throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/test/app'),
    getPath: vi.fn(() => '/test/userData'),
  },
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => false) },
  existsSync: vi.fn(() => false),
}));

vi.mock('../../src/main/pill', () => ({
  forwardAgentEvent: vi.fn(),
}));

import {
  handlePillSubmit,
  handlePillCancel,
  type PillSubmitOptions,
  type PillCancelOptions,
} from '../../src/main/daemonLifecycle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeDaemonClient() {
  return {
    send: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// handlePillSubmit tests
// ---------------------------------------------------------------------------

describe('handlePillSubmit()', () => {
  let client: ReturnType<typeof makeDaemonClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeDaemonClient();
  });

  it('returns {error:"no_active_tab", task_id} when getActiveTabCdpUrl returns null', async () => {
    const opts: PillSubmitOptions = {
      prompt: 'test prompt',
      getActiveTabCdpUrl: async () => null,
      daemonClient: client as never,
      getApiKey: async () => 'key',
    };
    const result = await handlePillSubmit(opts);
    expect(result.error).toBe('no_active_tab');
    expect(result.task_id).toMatch(UUID_REGEX);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns {error:"missing_api_key", task_id} when getApiKey returns null', async () => {
    const opts: PillSubmitOptions = {
      prompt: 'test prompt',
      getActiveTabCdpUrl: async () => 'ws://localhost:9222/devtools/browser/abc',
      daemonClient: client as never,
      getApiKey: async () => null,
    };
    const result = await handlePillSubmit(opts);
    expect(result.error).toBe('missing_api_key');
    expect(result.task_id).toMatch(UUID_REGEX);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('calls daemonClient.send with the correct payload on success', async () => {
    const cdpUrl = 'ws://localhost:9222/devtools/browser/abc';
    const opts: PillSubmitOptions = {
      prompt: 'open google',
      getActiveTabCdpUrl: async () => cdpUrl,
      daemonClient: client as never,
      getApiKey: async () => 'sk-ant-test',
    };
    await handlePillSubmit(opts);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: 'agent_task',
        prompt: 'open google',
        per_target_cdp_url: cdpUrl,
      }),
    );
  });

  it('returns {task_id} without error on success', async () => {
    const opts: PillSubmitOptions = {
      prompt: 'search for cats',
      getActiveTabCdpUrl: async () => 'ws://localhost:9222',
      daemonClient: client as never,
      getApiKey: async () => 'key',
    };
    const result = await handlePillSubmit(opts);
    expect(result.error).toBeUndefined();
    expect(result.task_id).toMatch(UUID_REGEX);
  });

  it('returns {error:"daemon_unavailable", task_id} when daemonClient.send throws', async () => {
    client.send.mockRejectedValue(new Error('connection refused'));
    const opts: PillSubmitOptions = {
      prompt: 'test',
      getActiveTabCdpUrl: async () => 'ws://localhost:9222',
      daemonClient: client as never,
      getApiKey: async () => 'key',
    };
    const result = await handlePillSubmit(opts);
    expect(result.error).toBe('daemon_unavailable');
    expect(result.task_id).toMatch(UUID_REGEX);
  });

  it('task_id is a UUID on every call', async () => {
    const opts: PillSubmitOptions = {
      prompt: 'test',
      getActiveTabCdpUrl: async () => null,
      daemonClient: client as never,
      getApiKey: async () => null,
    };
    const r1 = await handlePillSubmit(opts);
    const r2 = await handlePillSubmit(opts);
    expect(r1.task_id).toMatch(UUID_REGEX);
    expect(r2.task_id).toMatch(UUID_REGEX);
    expect(r1.task_id).not.toBe(r2.task_id);
  });

  it('the sent payload includes the task_id returned', async () => {
    const opts: PillSubmitOptions = {
      prompt: 'test',
      getActiveTabCdpUrl: async () => 'ws://localhost:9222',
      daemonClient: client as never,
      getApiKey: async () => 'key',
    };
    const result = await handlePillSubmit(opts);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: result.task_id }),
    );
  });
});

// ---------------------------------------------------------------------------
// handlePillCancel tests
// ---------------------------------------------------------------------------

describe('handlePillCancel()', () => {
  let client: ReturnType<typeof makeDaemonClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeDaemonClient();
  });

  it('calls daemonClient.send with {meta:"cancel_task", task_id}', async () => {
    const opts: PillCancelOptions = {
      task_id: 'task-abc-123',
      daemonClient: client as never,
    };
    await handlePillCancel(opts);
    expect(client.send).toHaveBeenCalledWith({
      meta: 'cancel_task',
      task_id: 'task-abc-123',
    });
  });

  it('returns {ok:true} on success', async () => {
    const opts: PillCancelOptions = {
      task_id: 'task-xyz',
      daemonClient: client as never,
    };
    const result = await handlePillCancel(opts);
    expect(result).toEqual({ ok: true });
  });

  it('returns {ok:false, error:"daemon_unavailable"} when send throws', async () => {
    client.send.mockRejectedValue(new Error('broken pipe'));
    const opts: PillCancelOptions = {
      task_id: 'task-xyz',
      daemonClient: client as never,
    };
    const result = await handlePillCancel(opts);
    expect(result).toEqual({ ok: false, error: 'daemon_unavailable' });
  });

  it('does not throw when daemonClient.send throws', async () => {
    client.send.mockRejectedValue(new Error('timeout'));
    const opts: PillCancelOptions = { task_id: 't1', daemonClient: client as never };
    await expect(handlePillCancel(opts)).resolves.toBeDefined();
  });
});
