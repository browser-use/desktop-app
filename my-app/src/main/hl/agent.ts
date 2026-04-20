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

const DEFAULT_MODEL = process.env.HL_MODEL ?? 'claude-opus-4-7';
const MAX_TOKENS = 4096;

export type HlEvent =
  | { type: 'thinking';   text: string }
  | { type: 'tool_call';  name: string; args: unknown; iteration: number }
  | { type: 'tool_result';name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done';       summary: string; iterations: number }
  | { type: 'error';      message: string }
  | { type: 'user_input'; text: string }
  | { type: 'skill_written'; path: string; domain: string; topic: string; bytes: number };

export interface RunAgentOptions {
  ctx: HlContext;
  prompt: string;
  apiKey: string;
  signal?: AbortSignal;
  onEvent: (e: HlEvent) => void;
  model?: string;
}

const SYSTEM_PROMPT = `You control a Chromium tab via CDP-backed tools AND have full local filesystem + shell access.
You are working inside a desktop browser app; the attached tab is the user's current tab.

## What actually works

- **Screenshots first**: use screenshot() to understand the current page quickly, find visible targets, and decide next.
- **Clicking**: screenshot() → look → click(x, y) → screenshot() again to verify. Coordinate clicks pass through iframes/shadow/cross-origin at the compositor level.
- **Before clicking**: use js() with getBoundingClientRect() to get accurate coords. Do not eyeball from screenshots.
- **Bulk HTTP**: http_get(url) for static pages/APIs — much faster than loading in a tab.
- **After goto**: wait_for_load().
- **Wrong/stale tab**: ensure_real_tab(). Use it when the current tab is stale or internal.
- **Verification**: page_info() is the simplest "is this alive?" check, but screenshots are the default way to verify.
- **DOM reads**: use js(...) for inspection and extraction when screenshots show coordinates are the wrong tool.
- **Iframe sites**: click(x, y) passes through; only drop to iframe DOM work when coordinate clicks are the wrong tool.
- **Auth wall**: redirected to login → stop and ask the user. Don't type credentials from screenshots.
- **Raw CDP** for anything helpers don't cover: cdp("Domain.method", params).

## Browser interaction details

- For React-controlled inputs, type_text may be overwritten — use react_set_value instead.
- For special keys (Enter, Tab), if press_key does not trigger the DOM listener, fall back to dispatch_key.
- Call capture_dialogs BEFORE any action that might open alert/confirm/prompt — otherwise the page JS thread freezes.
- capture_dialogs stubs are lost on navigation — re-call after goto().
- For cross-origin iframes, use iframe_target then js(expr, target_id). Same-origin nested iframes are NOT CDP targets — walk contentDocument.
- Shadow DOM: querySelector does NOT pierce — walk element.shadowRoot recursively.
- First navigation should be new_tab(url), not goto(url) — goto runs in the user's active tab and clobbers their work.

## Skills

- When goto() returns domain_skills, read the listed skill files before proceeding — they contain site-specific selectors, APIs, and traps.
- Search domain-skills/ first for the domain you are working on before inventing a new approach.
- If you struggle with a specific mechanic, check interaction-skills/ for helpers (dialogs, dropdowns, iframes, shadow-dom, uploads, etc.).
- Use shell to search skills: shell({command: "ls domain-skills/"}) or shell({command: "cat domain-skills/github/navigation.md"}).

## Always contribute back

If you learned anything non-obvious about how a site works, write it to domain-skills/<site>/<topic>.md before calling done.
Worth capturing: private APIs, stable selectors, framework quirks, URL patterns, waits that wait_for_load() misses, traps.
Do NOT write: raw pixel coordinates, run narration, secrets/cookies, or user-specific state.

## Filesystem + shell

- You can read, write, and patch files on the local machine via read_file, write_file, patch_file.
- You can list directories via list_dir and run shell commands via shell.
- You can edit your own source code (this harness). The source lives in the project directory.
- Use patch_file for surgical edits (find-and-replace); use write_file for new files or full rewrites.
- Use shell for git, build commands, grep, or any CLI tool.

## General

- After every meaningful action, re-screenshot before assuming it worked.
- Prefer compositor-level actions over framework hacks.
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

  for (let iter = 1; ; iter++) {
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

    mainLogger.info('hl.agent.response', {
      iter,
      stop_reason: finalMsg.stop_reason,
      content_blocks: finalMsg.content.length,
      types: finalMsg.content.map((b) => b.type),
    });

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
      mainLogger.info('hl.agent.toolDispatch', { iter, tool: tu.name, id: tu.id });
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
        if ((tu.name === 'write_file' || tu.name === 'patch_file') && r && typeof r === 'object' && 'path' in r) {
          const writtenPath = String((r as { path: string }).path);
          const skillMatch = writtenPath.match(/(?:domain-skills|interaction-skills)\/([^/]+)\/([^/]+)\.md$/);
          if (skillMatch) {
            const rObj = r as Record<string, unknown>;
            const bytes = typeof rObj.bytes === 'number' ? rObj.bytes : 0;
            onEvent({ type: 'skill_written', path: writtenPath, domain: skillMatch[1], topic: skillMatch[2], bytes });
          }
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
}
