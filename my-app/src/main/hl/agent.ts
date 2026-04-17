/**
 * LLM-driven agent loop — Claude Opus 4.7 + tool use + streaming + prompt caching.
 *
 * Model: `claude-opus-4-7` (override via HL_MODEL env var).
 * Cache: the system prompt AND the tools block both carry cache_control: ephemeral
 *   breakpoints, so the 2nd+ iterations within a task (and across tasks in the
 *   same cache window) hit prompt cache for everything up to and including the
 *   tools block.
 * Stream: uses `client.messages.stream(...)` so partial text emits as `thinking`
 *   events while the model writes; the final Message (with tool_use blocks) is
 *   awaited via `stream.finalMessage()` before we dispatch tools.
 *
 * Loop bound: MAX_ITERATIONS (25). An AbortSignal cancels the in-flight request.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam, MessageCreateParamsNonStreaming, Tool, ContentBlock, ToolUseBlock,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { HlContext } from './context';
import { HL_TOOLS, HL_TOOL_BY_NAME } from './tools';
import { mainLogger } from '../logger';

const MAX_ITERATIONS = 25;
const DEFAULT_MODEL = process.env.HL_MODEL ?? 'claude-opus-4-7';
const MAX_TOKENS = 4096;

export type HlEvent =
  | { type: 'thinking';   text: string }
  | { type: 'tool_call';  name: string; args: unknown; iteration: number }
  | { type: 'tool_result';name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done';       summary: string; iterations: number }
  | { type: 'error';      message: string };

export interface RunAgentOptions {
  ctx: HlContext;
  prompt: string;
  apiKey: string;
  signal?: AbortSignal;
  onEvent: (e: HlEvent) => void;
  model?: string;
}

const SYSTEM_PROMPT = `You control a Chromium tab via a small set of CDP-backed tools.
You are working inside a desktop browser app; the attached tab is the user's current tab.

Operating principles:
- Coordinate clicks (click(x,y)) are the default interaction — they pass through iframes and shadow DOM.
- Before clicking, use js() with getBoundingClientRect() to get accurate coords. Do not eyeball from screenshots.
- For React-controlled inputs, type_text may be overwritten — use react_set_value instead.
- For special keys (Enter, Tab), if press_key does not trigger the DOM listener, fall back to dispatch_key.
- Call capture_dialogs BEFORE any action that might open alert/confirm/prompt — otherwise the page JS thread freezes.
- capture_dialogs stubs are lost on navigation — re-call after goto().
- For cross-origin iframes, use iframe_target then js(expr, target_id). Same-origin nested iframes are NOT CDP targets — walk contentDocument.
- Shadow DOM: querySelector does NOT pierce — walk element.shadowRoot recursively.
- For static pages or APIs, http_get is faster than loading in a browser.
- Call the \`done\` tool with a short user-facing summary when the task is complete.
- Be concise. Act, don't narrate.`;

function previewResult(r: unknown, limit = 240): string {
  try {
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  } catch { return String(r).slice(0, limit); }
}

function asTools(): Tool[] {
  const tools: Tool[] = HL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  // Prompt-caching breakpoint on the last tool — caches everything up through tools.
  const last = tools[tools.length - 1] as Tool & { cache_control?: { type: 'ephemeral' } };
  last.cache_control = { type: 'ephemeral' };
  return tools;
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { ctx, prompt, apiKey, signal, onEvent } = opts;
  const client = new Anthropic({ apiKey });
  const tools = asTools();
  const messages: MessageParam[] = [{ role: 'user', content: prompt }];
  const model = opts.model ?? DEFAULT_MODEL;

  // Cached system prompt — same text across iterations, same cache hit.
  const system: MessageCreateParamsNonStreaming['system'] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    if (signal?.aborted) { onEvent({ type: 'error', message: 'cancelled' }); return; }
    mainLogger.info('hl.agent.iter', { iter, model, ctx: ctx.name, messages: messages.length });

    let finalMsg: { content: ContentBlock[]; stop_reason: string | null; usage?: unknown };
    try {
      const stream = client.messages.stream(
        { model, max_tokens: MAX_TOKENS, system, tools, messages },
        { signal },
      );
      // Emit partial text as 'thinking' events as the model streams.
      stream.on('text', (delta: string) => {
        if (delta.trim()) onEvent({ type: 'thinking', text: delta });
      });
      finalMsg = await stream.finalMessage();
    } catch (err) {
      const msg = (err as Error).message ?? 'anthropic_error';
      mainLogger.error('hl.agent.apiError', { error: msg, iter });
      onEvent({ type: 'error', message: `api_error: ${msg}` });
      return;
    }

    // Cache-hit telemetry (not user-facing; shows the breakpoints are doing work).
    const u = finalMsg.usage as { cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
    if (u) mainLogger.info('hl.agent.cache', { iter, cache_read: u.cache_read_input_tokens ?? 0, cache_create: u.cache_creation_input_tokens ?? 0 });

    // If no tool call, model ended its turn — treat the assistant text as the summary.
    if (finalMsg.stop_reason !== 'tool_use') {
      const text = finalMsg.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n').trim();
      onEvent({ type: 'done', summary: text || '(no response)', iterations: iter });
      return;
    }

    // Execute every tool_use block; gather tool_result blocks for the next turn.
    const toolResults: ToolResultBlockParam[] = [];
    let doneSummary: string | null = null;

    for (const block of finalMsg.content) {
      if (block.type !== 'tool_use') continue;
      const tu = block as ToolUseBlock;
      const args = (tu.input ?? {}) as Record<string, unknown>;
      onEvent({ type: 'tool_call', name: tu.name, args, iteration: iter });

      const tool = HL_TOOL_BY_NAME.get(tu.name);
      const t0 = Date.now();
      if (!tool) {
        const msg = `unknown_tool: ${tu.name}`;
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true });
        onEvent({ type: 'tool_result', name: tu.name, ok: false, preview: msg, ms: Date.now() - t0 });
        continue;
      }

      try {
        const r = await tool.run(ctx, args);
        const preview = previewResult(r);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: preview });
        onEvent({ type: 'tool_result', name: tu.name, ok: true, preview, ms: Date.now() - t0 });
        if (tu.name === 'done' && r && typeof r === 'object' && 'summary' in r) {
          doneSummary = String((r as { summary: unknown }).summary);
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `error: ${msg}`, is_error: true });
        onEvent({ type: 'tool_result', name: tu.name, ok: false, preview: msg, ms: Date.now() - t0 });
      }
    }

    if (doneSummary !== null) { onEvent({ type: 'done', summary: doneSummary, iterations: iter }); return; }

    messages.push({ role: 'assistant', content: finalMsg.content });
    messages.push({ role: 'user', content: toolResults });
  }

  onEvent({ type: 'error', message: `iteration_budget_exhausted after ${MAX_ITERATIONS}` });
}
