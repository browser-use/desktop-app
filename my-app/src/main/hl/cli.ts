/**
 * Standalone entrypoint for Docker-containerized agent tasks.
 *
 * Reads from env:
 *   ANTHROPIC_API_KEY  — required
 *   CDP_URL            — ws:// DevTools URL for the target page
 *   TASK_PROMPT        — the user's natural-language task
 *   TASK_ID            — unique ID for this task (used in log lines)
 *
 * Streams HlEvent as JSON lines to stdout. Exits 0 on success, 1 on error.
 * The Electron main process reads these lines and forwards them to the pill UI.
 */

import { createContext } from './context';
import { runAgent, type HlEvent } from './agent';

const CDP_URL = process.env.CDP_URL;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const PROMPT = process.env.TASK_PROMPT;
const TASK_ID = process.env.TASK_ID ?? 'anonymous';

function emit(event: HlEvent): void {
  process.stdout.write(JSON.stringify({ task_id: TASK_ID, event }) + '\n');
}

function fatal(msg: string): never {
  emit({ type: 'error', message: msg });
  process.exit(1);
}

async function main(): Promise<void> {
  if (!CDP_URL) fatal('CDP_URL env var is required');
  if (!API_KEY) fatal('ANTHROPIC_API_KEY env var is required');
  if (!PROMPT) fatal('TASK_PROMPT env var is required');

  emit({ type: 'thinking', text: `[container] connecting to ${CDP_URL}` });

  const ctx = await createContext({ name: TASK_ID, cdpUrl: CDP_URL });

  emit({ type: 'thinking', text: '[container] CDP connected, starting agent loop' });

  await runAgent({
    ctx,
    prompt: PROMPT,
    apiKey: API_KEY,
    onEvent: emit,
  });

  emit({ type: 'done', summary: 'Task completed' } as HlEvent);
  await ctx.cdp.close();
  process.exit(0);
}

main().catch((err) => {
  fatal(`Agent crashed: ${(err as Error).message}`);
});
