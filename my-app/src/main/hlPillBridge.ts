/**
 * hlPillBridge — spawns a Docker container per Cmd+K task.
 *
 * Each task runs as `docker run --rm agent-task:latest` with the agent loop
 * inside the container connecting to the browser's CDP via ws:// URL.
 * Container stdout streams JSON-line HlEvents which are forwarded to the
 * pill renderer via IPC.
 *
 * Cancel = docker kill. Quit = docker kill all agent-* containers.
 */

import crypto from 'node:crypto';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { sendToPill } from './pill';
import { mainLogger } from './logger';

const DOCKER_IMAGE = 'agent-task:latest';
const CONTAINER_PREFIX = 'agent-';

export interface HlSubmitOptions {
  prompt: string;
  getCdpUrl: () => Promise<string | null>;
  getApiKey: () => Promise<string | null>;
}

export interface HlSubmitResult {
  task_id?: string;
  error?: string;
}

const containers = new Map<string, ChildProcess>();

export async function handleHlSubmit(opts: HlSubmitOptions): Promise<HlSubmitResult> {
  const task_id = crypto.randomUUID();
  const containerName = `${CONTAINER_PREFIX}${task_id.slice(0, 8)}`;
  mainLogger.info('hlPillBridge.handleHlSubmit', { task_id, containerName, promptLength: opts.prompt?.length ?? 0 });

  const cdpUrl = await opts.getCdpUrl();
  if (!cdpUrl) {
    mainLogger.warn('hlPillBridge.handleHlSubmit.noCdpUrl', { task_id });
    return { error: 'no_cdp_url', task_id };
  }

  const apiKey = await opts.getApiKey();
  if (!apiKey) {
    mainLogger.warn('hlPillBridge.handleHlSubmit.missingApiKey', { task_id });
    return { error: 'missing_api_key', task_id };
  }

  // Rewrite localhost CDP URL to host.docker.internal so the container
  // can reach the host's Chrome DevTools from inside Docker Desktop.
  const dockerCdpUrl = cdpUrl.replace('localhost', 'host.docker.internal')
                              .replace('127.0.0.1', 'host.docker.internal');

  mainLogger.info('hlPillBridge.dockerRun', { task_id, containerName, dockerCdpUrl });

  sendToPill('pill:hl-event', { task_id, event: { type: 'task_started', iteration: 0 } });

  const child = spawn('docker', [
    'run', '--rm',
    '--name', containerName,
    '-e', `ANTHROPIC_API_KEY=${apiKey}`,
    '-e', `CDP_URL=${dockerCdpUrl}`,
    '-e', `TASK_PROMPT=${opts.prompt}`,
    '-e', `TASK_ID=${task_id}`,
    DOCKER_IMAGE,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  containers.set(task_id, child);

  // Stream stdout as JSON-line events to the pill renderer
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    try {
      const parsed = JSON.parse(line);
      sendToPill('pill:hl-event', parsed);
      mainLogger.debug('hlPillBridge.event', { task_id, type: parsed?.event?.type });
    } catch {
      mainLogger.debug('hlPillBridge.stdout', { task_id, line });
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) mainLogger.warn('hlPillBridge.stderr', { task_id, text });
  });

  child.on('exit', (code, signal) => {
    mainLogger.info('hlPillBridge.containerExit', { task_id, containerName, code, signal });
    containers.delete(task_id);
    if (code !== 0) {
      sendToPill('pill:hl-event', {
        task_id,
        event: { type: 'error', message: `Container exited with code ${code}` },
      });
    }
  });

  child.on('error', (err) => {
    mainLogger.error('hlPillBridge.containerError', { task_id, error: err.message });
    containers.delete(task_id);
    sendToPill('pill:hl-event', {
      task_id,
      event: { type: 'error', message: `Docker error: ${err.message}` },
    });
  });

  return { task_id };
}

export async function handleHlCancel(task_id: string): Promise<{ ok: boolean }> {
  const child = containers.get(task_id);
  mainLogger.info('hlPillBridge.handleHlCancel', { task_id, found: !!child });
  if (!child) return { ok: false };

  const containerName = `${CONTAINER_PREFIX}${task_id.slice(0, 8)}`;
  try {
    execSync(`docker kill ${containerName}`, { stdio: 'ignore' });
  } catch {
    child.kill('SIGTERM');
  }
  containers.delete(task_id);
  return { ok: true };
}

export async function teardown(): Promise<void> {
  mainLogger.info('hlPillBridge.teardown', { activeContainers: containers.size });
  for (const [task_id] of containers) {
    const containerName = `${CONTAINER_PREFIX}${task_id.slice(0, 8)}`;
    try {
      execSync(`docker kill ${containerName}`, { stdio: 'ignore' });
    } catch { /* already dead */ }
  }
  containers.clear();
}
