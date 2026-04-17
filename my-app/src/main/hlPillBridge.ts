/**
 * hlPillBridge — runs the hl in-process agent loop from a pill:submit, with
 * cancel + event forwarding.
 *
 * Pure-ish: takes a getActiveWebContents callback so tests can inject a fake.
 * Streams HlEvent → pill renderer on the `pill:hl-event` channel.
 */

import crypto from 'node:crypto';
import { getOrCreate, destroy } from './hl/runtime';
import { runAgent, type HlEvent } from './hl/agent';
import { sendToPill } from './pill';
import { mainLogger } from './logger';
import type { WebContents } from 'electron';

export interface HlSubmitOptions {
  prompt: string;
  getActiveWebContents: () => WebContents | null;
  getApiKey: () => Promise<string | null>;
}

export interface HlSubmitResult {
  task_id?: string;
  error?: string;
}

// One controller per active task so pill:cancel can abort.
const controllers = new Map<string, AbortController>();

export async function handleHlSubmit(opts: HlSubmitOptions): Promise<HlSubmitResult> {
  const task_id = crypto.randomUUID();
  mainLogger.info('hlPillBridge.handleHlSubmit', { task_id, promptLength: opts.prompt?.length ?? 0 });

  const wc = opts.getActiveWebContents();
  if (!wc) {
    mainLogger.warn('hlPillBridge.handleHlSubmit.noActiveTab', { task_id });
    return { error: 'no_active_tab', task_id };
  }

  const apiKey = await opts.getApiKey();
  if (!apiKey) {
    mainLogger.warn('hlPillBridge.handleHlSubmit.missingApiKey', { task_id });
    return { error: 'missing_api_key', task_id };
  }

  const ctx = await getOrCreate('default', { webContents: wc });
  const controller = new AbortController();
  controllers.set(task_id, controller);

  // Notify pill that the task started (matches legacy daemon's task_started event shape).
  sendToPill('pill:hl-event', { task_id, event: { type: 'task_started', iteration: 0 } });

  // Kick off async — don't await. Return task_id immediately so the pill UI can show the ack.
  void runAgent({
    ctx,
    prompt: opts.prompt,
    apiKey,
    signal: controller.signal,
    onEvent: (e: HlEvent) => {
      sendToPill('pill:hl-event', { task_id, event: e });
    },
  })
    .catch((err) => {
      mainLogger.error('hlPillBridge.runAgent.failed', { task_id, error: (err as Error).message });
      sendToPill('pill:hl-event', { task_id, event: { type: 'error', message: (err as Error).message } });
    })
    .finally(() => {
      controllers.delete(task_id);
    });

  return { task_id };
}

export async function handleHlCancel(task_id: string): Promise<{ ok: boolean }> {
  const c = controllers.get(task_id);
  mainLogger.info('hlPillBridge.handleHlCancel', { task_id, found: !!c });
  if (!c) return { ok: false };
  c.abort();
  controllers.delete(task_id);
  return { ok: true };
}

export async function teardown(): Promise<void> {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  await destroy('default');
}
