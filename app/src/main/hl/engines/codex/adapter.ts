/**
 * Codex engine adapter — wraps `codex exec --json`.
 * Docs: https://developers.openai.com/codex/noninteractive
 *
 * Event shape differs from Claude Code:
 *   thread.started      → captures thread_id (for resume)
 *   turn.started        → (ignored; could bump iteration)
 *   item.started        → if item.type looks tool-like, emit tool_call
 *   item.completed      → if reasoning/agent_message, emit thinking;
 *                         otherwise pair tool_result with the tool_call
 *   turn.completed      → (ignored; usage telemetry)
 *   turn.failed / error → error
 *
 * Resume uses a sub-subcommand: `codex exec resume <id> <prompt>` rather
 * than a `--resume <id>` flag, so buildSpawnArgs branches on it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mainLogger } from '../../../logger';
import { register } from '../registry';
import { enrichedEnv, resolveCliSpawn } from '../pathEnrich';
import { runCodexDeviceLogin } from '../../../identity/codexLogin';
import type {
  AuthProbe,
  EngineAdapter,
  InstallProbe,
  ParseContext,
  ParseResult,
  SpawnContext,
} from '../types';
import type { HlEvent } from '../../../../shared/session-schemas';
import { estimateCostUsd } from '../../pricing';

const ID = 'codex';
const DISPLAY = 'Codex';
const BIN = 'codex';

function runCli(args: string[], timeoutMs = 5000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      const env = enrichedEnv();
      const resolved = resolveCliSpawn(BIN, args, { env });
      child = spawn(resolved.command, resolved.args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    }
    catch { resolve({ ok: false, stdout: '', stderr: 'spawn failed' }); return; }
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
  });
}

function codexAuthFilePath(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

/** Codex's command items put the command in different keys across versions.
 *  Normalize to a Record matching the tool-call args shape our UI expects. */
function normalizeItemArgs(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof item.command === 'string') out.command = item.command;
  if (Array.isArray(item.command)) out.command = (item.command as string[]).join(' ');
  if (typeof item.path === 'string') out.path = item.path;
  if (typeof item.file_path === 'string') out.file_path = item.file_path;
  if (typeof item.text === 'string' && !out.command) out.text = (item.text as string).slice(0, 500);
  if (typeof item.url === 'string') out.url = item.url;
  return out;
}

/** Classify an item.type as a human-readable "tool name" for UI rendering. */
function itemTypeToToolName(t: string): string {
  if (!t) return 'unknown';
  // Normalize a handful of known item types; pass others through as-is.
  if (t === 'command_execution' || t === 'local_shell_call') return 'Bash';
  if (t === 'file_change' || t === 'patch_apply') return 'Edit';
  if (t === 'mcp_tool_call') return 'MCP';
  if (t === 'web_search') return 'WebSearch';
  return t;
}

function isNarrativeItem(t: string | undefined): boolean {
  // These represent the model's own thinking/message output, not tool use.
  return t === 'reasoning' || t === 'agent_message' || t === 'assistant_message';
}

const codexAdapter: EngineAdapter = {
  id: ID,
  displayName: DISPLAY,
  binaryName: BIN,

  async probeInstalled(): Promise<InstallProbe> {
    const r = await runCli(['--version']);
    if (!r.ok) return { installed: false, error: r.stderr || 'codex not found on PATH' };
    const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
    return { installed: true, version: m?.[1] };
  },

  async probeAuthed(): Promise<AuthProbe> {
    // Codex has no `codex auth status`; check the credentials file directly.
    try {
      const raw = fs.readFileSync(codexAuthFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as { tokens?: { access_token?: string } };
      const token = parsed?.tokens?.access_token;
      if (typeof token === 'string' && token.length > 0) return { authed: true };
      return { authed: false, error: 'auth.json has no access_token' };
    } catch (err) {
      return { authed: false, error: (err as Error).message };
    }
  },

  async openLoginInTerminal(opts?: { deviceAuth?: boolean }) {
    // Cross-platform OAuth via node-pty. Default is plain `codex login`
    // (localhost-callback); `deviceAuth: true` switches to the remote/headless
    // fallback which requires the ChatGPT security-settings toggle server-side.
    return runCodexDeviceLogin(opts);
  },

  wrapPrompt(ctx: SpawnContext): string {
    const lines: string[] = [
      'You are driving a specific Chromium browser view on this machine.',
      `Your target is CDP target_id=${ctx.targetId} on port ${ctx.cdpPort} (env BU_TARGET_ID / BU_CDP_PORT).`,
      'Read `./AGENTS.md` for how to drive the browser in this harness.',
      'Always read `./helpers.js` before writing scripts — that is where the functions live. Edit it if a helper is missing.',
    ];
    if (ctx.attachmentRefs.length > 0) {
      lines.push('', 'The user attached these files for this task. Read each one before acting:');
      for (const a of ctx.attachmentRefs) lines.push(`  - ${a.relPath} (${a.mime}, ${a.size} bytes)`);
    }
    lines.push(
      '',
      `When the user asks you to produce a file (a report, CSV, screenshot, transcript, etc.), save it to \`./outputs/${ctx.sessionId}/\`. Mention the filename in your final answer.`,
      '',
      `Task: ${ctx.prompt}`,
    );
    return lines.join('\n');
  },

  buildSpawnArgs(ctx: SpawnContext): string[] {
    // `codex exec resume <id> -` for continuation; otherwise plain exec.
    // The trailing `-` tells codex to read the prompt from stdin — see
    // getStdinPayload below for why we never pass the prompt via argv.
    // --yolo skips sandbox + approvals — acceptable because the agent is
    //   already scoped by env BU_TARGET_ID and cwd. Equivalent to Claude Code's
    //   --dangerously-skip-permissions.
    if (ctx.resumeSessionId) {
      return ['exec', 'resume', ctx.resumeSessionId, '--json', '--yolo', '-'];
    }
    return ['exec', '--json', '--yolo', '-'];
  },

  getStdinPayload(_ctx: SpawnContext, wrappedPrompt: string): string {
    // Pass the prompt via stdin to dodge a Windows-specific bug: codex on
    // Windows installs as `codex.cmd` (an npm batch shim), which we route
    // through `cmd.exe /d /s /c`. cmd.exe terminates argument parsing at any
    // raw newline inside a quoted arg, so a multi-line wrappedPrompt gets
    // truncated and word-split — codex then sees the second word ("are") as
    // an unexpected positional and exits with a clap parse error. Stdin
    // sidesteps argv quoting entirely on every platform.
    return wrappedPrompt;
  },

  buildEnv(ctx: SpawnContext, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = enrichedEnv(baseEnv);
    // `OPENAI_API_KEY` silently overrides OAuth auth.json per upstream issue
    // #15151 — strip it unless the user has explicitly saved a key.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    if (ctx.savedApiKey) {
      // Prefer CODEX_API_KEY — the docs recommend it for `codex exec` mode.
      env.CODEX_API_KEY = ctx.savedApiKey;
    }
    env.BU_TARGET_ID = ctx.targetId;
    env.BU_CDP_PORT = String(ctx.cdpPort);
    return env;
  },

  parseLine(line: string, ctx: ParseContext): ParseResult {
    let evt: unknown;
    try { evt = JSON.parse(line); } catch { return { events: [] }; }
    if (!evt || typeof evt !== 'object') return { events: [] };
    const e = evt as Record<string, unknown>;
    const type = e.type as string | undefined;
    const events: HlEvent[] = [];
    let capturedSessionId: string | undefined;
    let terminalDone = false;
    let terminalError: string | undefined;

    if (type === 'thread.started') {
      const tid = e.thread_id as string | undefined;
      if (typeof tid === 'string') {
        capturedSessionId = tid;
        mainLogger.info('codex.threadStarted', { thread_id: tid });
      }
      if (typeof e.model === 'string') ctx.currentModel = e.model;
      return { events, capturedSessionId };
    }

    if (type === 'turn.started') {
      ctx.iter++;
      // Some codex versions report model on turn.started instead of thread.started.
      if (typeof e.model === 'string') ctx.currentModel = e.model;
      return { events };
    }

    if (type === 'item.started') {
      const item = e.item as Record<string, unknown> | undefined;
      if (!item) return { events };
      const itype = item.type as string | undefined;
      const id = item.id as string | undefined;
      if (!id || isNarrativeItem(itype)) return { events };
      const name = itemTypeToToolName(itype ?? 'unknown');
      const args = normalizeItemArgs(item);
      ctx.pendingTools.set(id, { name, startedAt: Date.now(), iter: ctx.iter });
      events.push({
        type: 'tool_call',
        name,
        args: { preview: typeof args.command === 'string' ? args.command : JSON.stringify(args), ...args },
        iteration: ctx.iter,
      });
      return { events };
    }

    if (type === 'item.completed') {
      const item = e.item as Record<string, unknown> | undefined;
      if (!item) return { events };
      const itype = item.type as string | undefined;
      const id = item.id as string | undefined;

      // Narrative output — emit as thinking so it streams into the UI text.
      if (isNarrativeItem(itype)) {
        const text = typeof item.text === 'string' ? (item.text as string)
                   : typeof item.content === 'string' ? (item.content as string)
                   : '';
        if (text.trim()) {
          events.push({ type: 'thinking', text });
          // Only track user-facing messages (agent_message) as the turn
          // summary — internal reasoning is too verbose to surface.
          if (itype === 'agent_message' || itype === 'assistant_message') {
            ctx.lastNarrative = text;
          }
        }
        return { events };
      }

      // Tool completion — pair with the tool_call we emitted on item.started.
      if (id) {
        const match = ctx.pendingTools.get(id);
        const resultText = typeof item.output === 'string' ? (item.output as string)
                         : typeof item.text === 'string' ? (item.text as string)
                         : typeof item.result === 'string' ? (item.result as string)
                         : JSON.stringify(item);
        const status = item.status as string | undefined;
        const ok = status !== 'failed' && status !== 'error';
        const ms = match ? Date.now() - match.startedAt : 0;
        const name = match?.name ?? itemTypeToToolName(itype ?? 'unknown');
        events.push({ type: 'tool_result', name, ok, preview: String(resultText).slice(0, 2000), ms });
        ctx.pendingTools.delete(id);
      }
      return { events };
    }

    if (type === 'turn.completed') {
      // Codex has no dedicated "done" tool the way Claude does — `turn.completed`
      // is the closest signal. Emit `done` here so SessionManager flips the
      // session to 'idle' (enabling follow-ups) instead of waiting for the
      // 2-minute stuck timer to fire after process exit. Use the latest
      // agent_message text as the summary so the UI shows a real sentence,
      // not token telemetry.
      const usage = e.usage as Record<string, unknown> | undefined;
      const inputTokens = typeof usage?.input_tokens === 'number' ? (usage.input_tokens as number) : 0;
      const outputTokens = typeof usage?.output_tokens === 'number' ? (usage.output_tokens as number) : 0;
      const cachedInputTokens = typeof usage?.cached_input_tokens === 'number' ? (usage.cached_input_tokens as number)
                              : typeof usage?.cache_read_input_tokens === 'number' ? (usage.cache_read_input_tokens as number)
                              : 0;
      if (inputTokens > 0 || outputTokens > 0) {
        const costUsd = estimateCostUsd(ctx.currentModel, { inputTokens, outputTokens, cachedInputTokens });
        events.push({
          type: 'turn_usage',
          inputTokens,
          outputTokens,
          cachedInputTokens,
          costUsd,
          model: ctx.currentModel,
          source: 'estimated',
        });
        mainLogger.info('codex.turnUsage', { inputTokens, outputTokens, cachedInputTokens, costUsd, model: ctx.currentModel });
      }

      const summary = (ctx.lastNarrative ?? '').trim() || 'Task completed';
      events.push({ type: 'done', summary, iterations: ctx.iter });
      mainLogger.info('codex.turnCompleted.done', { outputTokens, iter: ctx.iter, summaryLen: summary.length });
      // Reset for the next turn so a follow-up doesn't reuse the old text
      // before the new turn has produced any narrative.
      ctx.lastNarrative = undefined;
      return { events, terminalDone: true };
    }

    if (type === 'turn.failed' || type === 'error') {
      const msg = typeof e.message === 'string' ? (e.message as string)
                : typeof (e.error as Record<string, unknown>)?.message === 'string'
                  ? String((e.error as Record<string, unknown>).message) : 'codex_error';
      terminalError = `codex_error: ${msg}`;
      events.push({ type: 'error', message: terminalError });
      return { events, terminalError };
    }

    // Unknown type — ignore but log at debug level.
    return { events };
  },
};

register(codexAdapter);
