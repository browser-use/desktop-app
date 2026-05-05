/**
 * Cursor Agent engine adapter — wraps `agent -p --output-format stream-json`.
 * CLI: https://docs.cursor.com/en/cli/overview (binary name: `agent`).
 *
 * Stream-json shape (similar to Claude Code but distinct):
 *   system/init             → captures session_id (for --resume) and model
 *   user                    → echo of the prompt; ignored
 *   assistant (delta)       → message.content[].text — partial chunks carry
 *                             a `timestamp_ms`; emit each as `thinking`
 *   assistant (final)       → same shape but no `timestamp_ms`; ignored to
 *                             avoid duplicating the streamed deltas
 *   tool_call started       → tool_call.<name>ToolCall.args
 *   tool_call completed     → tool_call.<name>ToolCall.result.{success|error}
 *   result                  → done / error + usage (no cost field, estimated)
 */

import { spawn } from 'node:child_process';
import { mainLogger } from '../../../logger';
import { register } from '../registry';
import { enrichedEnv, resolveCliSpawn } from '../pathEnrich';
import type {
  AuthProbe,
  EngineAdapter,
  InstallProbe,
  ParseContext,
  ParseResult,
  SpawnContext,
} from '../types';
import type { HlEvent } from '../../../../shared/session-schemas';

const ID = 'cursor-agent';
const DISPLAY = 'Cursor Agent';
const BIN = 'agent';

// ── helpers ─────────────────────────────────────────────────────────────────

function runCli(args: string[], timeoutMs = 5000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      const env = enrichedEnv();
      const resolved = resolveCliSpawn(BIN, args, { env });
      child = spawn(resolved.command, resolved.args, { stdio: ['ignore', 'pipe', 'pipe'], env, ...resolved.spawnOptions });
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

/** Map cursor's `<name>ToolCall` wrapper key to a Claude-Code-style tool name
 *  the rest of the UI/postprocessor already understands. Unknown wrappers fall
 *  through with the `ToolCall` suffix stripped. */
function wrapperToToolName(wrapperKey: string): string {
  if (wrapperKey === 'shellToolCall') return 'Bash';
  if (wrapperKey === 'readToolCall') return 'Read';
  if (wrapperKey === 'writeToolCall') return 'Write';
  if (wrapperKey === 'editToolCall' || wrapperKey === 'patchToolCall') return 'Edit';
  if (wrapperKey === 'lsToolCall') return 'LS';
  if (wrapperKey === 'globToolCall') return 'Glob';
  if (wrapperKey === 'grepToolCall') return 'Grep';
  if (wrapperKey === 'webSearchToolCall') return 'WebSearch';
  if (wrapperKey === 'webFetchToolCall') return 'WebFetch';
  // Fallback: drop trailing "ToolCall", capitalize first letter so it renders
  // nicely in the agent pane (e.g. `taskToolCall` → `Task`).
  const stripped = wrapperKey.replace(/ToolCall$/, '');
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : wrapperKey;
}

/** Pull a meaningful args object out of cursor's wrapped tool_call payload.
 *  Different tools nest things differently — shell puts the command at
 *  `args.command`, read at `args.path`, etc. Forward the raw `args` plus a
 *  `preview` string so the renderer can show something inline. */
function extractToolArgs(name: string, raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const args = (raw?.args as Record<string, unknown> | undefined) ?? {};
  const out: Record<string, unknown> = { ...args };
  let preview: string;
  if (name === 'Bash' && typeof args.command === 'string') {
    preview = args.command as string;
  } else if (typeof args.path === 'string') {
    preview = args.path as string;
  } else if (typeof args.file_path === 'string') {
    preview = args.file_path as string;
  } else {
    preview = JSON.stringify(args);
  }
  out.preview = preview;
  // Surface `path`/`file_path` interchangeably so the harness post-processor
  // (which detects helpers.js / AGENTS.md edits) catches cursor reads/writes.
  if (typeof args.path === 'string' && typeof out.file_path !== 'string') {
    out.file_path = args.path;
  }
  return out;
}

function extractToolResult(raw: Record<string, unknown> | undefined): { text: string; ok: boolean } {
  const result = raw?.result as Record<string, unknown> | undefined;
  if (!result) return { text: '', ok: true };
  if (result.error) {
    const err = result.error as Record<string, unknown> | string;
    if (typeof err === 'string') return { text: err, ok: false };
    return { text: JSON.stringify(err), ok: false };
  }
  const success = result.success as Record<string, unknown> | undefined;
  if (!success) return { text: JSON.stringify(result), ok: true };
  // Shell tools: prefer stdout, fall back to stderr.
  if (typeof success.stdout === 'string' || typeof success.stderr === 'string') {
    const stdout = (success.stdout as string | undefined) ?? '';
    const stderr = (success.stderr as string | undefined) ?? '';
    const exitCode = typeof success.exitCode === 'number' ? (success.exitCode as number) : 0;
    return { text: stdout || stderr, ok: exitCode === 0 };
  }
  // File tools: `content` for read, `path`/`bytesWritten` for write.
  if (typeof success.content === 'string') return { text: success.content as string, ok: true };
  return { text: JSON.stringify(success), ok: true };
}

// ── adapter ─────────────────────────────────────────────────────────────────

const cursorAgentAdapter: EngineAdapter = {
  id: ID,
  displayName: DISPLAY,
  binaryName: BIN,

  async probeInstalled(): Promise<InstallProbe> {
    const r = await runCli(['--version']);
    if (!r.ok) return { installed: false, error: r.stderr || 'agent not found on PATH' };
    const m = r.stdout.match(/(\d{4}\.\d{2}\.\d{2}[\w.-]*)/) ?? r.stdout.match(/(\d+\.\d+\.\d+)/);
    return { installed: true, version: m?.[1] };
  },

  async probeAuthed(): Promise<AuthProbe> {
    // `agent status` exits 0 in both states; discriminate on output text.
    const r = await runCli(['status']);
    const text = `${r.stdout}\n${r.stderr}`;
    if (/logged in as/i.test(text)) return { authed: true };
    if (/not logged in/i.test(text)) return { authed: false, error: 'not logged in' };
    if (!r.ok) return { authed: false, error: r.stderr || r.stdout || 'agent status failed' };
    return { authed: false, error: 'unknown auth state' };
  },

  async openLoginInTerminal(): Promise<{ opened: boolean; error?: string }> {
    // `agent login` opens the system browser to the OAuth flow and waits for
    // the callback. We spawn with stdio pipes so the child stays alive after
    // this Promise resolves; the EnginePicker polls probeAuthed() to detect
    // completion.
    return new Promise((resolve) => {
      let child;
      try {
        const env = enrichedEnv();
        const resolved = resolveCliSpawn(BIN, ['login'], { env });
        child = spawn(resolved.command, resolved.args, { stdio: ['ignore', 'pipe', 'pipe'], env, ...resolved.spawnOptions });
      } catch (err) {
        resolve({ opened: false, error: (err as Error).message });
        return;
      }
      let stderrBuf = '';
      let stdoutBuf = '';
      let settled = false;
      const finish = (result: { opened: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        mainLogger.warn('cursor-agent.login.timeout');
        try { child.kill('SIGTERM'); } catch { /* already closed */ }
      }, 5 * 60 * 1000);

      child.stdout.on('data', (d) => { stdoutBuf += String(d); if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-4096); });
      child.stderr.on('data', (d) => { stderrBuf += String(d); if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096); });
      child.on('spawn', () => {
        mainLogger.info('cursor-agent.login.spawn');
        finish({ opened: true });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        mainLogger.warn('cursor-agent.login.error', { error: err.message });
        finish({ opened: false, error: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        mainLogger.info('cursor-agent.login.close', { code, stderr: stderrBuf.slice(-400) });
        if (code !== 0 && !settled) {
          finish({ opened: false, error: stderrBuf.trim() || stdoutBuf.trim() || `agent login exit ${code}` });
        }
      });
    });
  },

  wrapPrompt(ctx: SpawnContext): string {
    const lines: string[] = [
      'You are driving a specific Chromium browser view on this machine.',
      `Your target is CDP target_id=${ctx.targetId} on port ${ctx.cdpPort} (env BU_TARGET_ID / BU_CDP_PORT).`,
      'Read `./AGENTS.md` for how to drive the browser in this harness.',
      'Always read `./helpers.js` before writing scripts — that is where the functions live. Edit it if a helper is missing.',
    ];
    if (ctx.attachmentRefs.length > 0) {
      lines.push('', 'The user attached these files for this task. Read each with your Read tool before acting:');
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

  buildSpawnArgs(ctx: SpawnContext, wrappedPrompt: string): string[] {
    // --print: headless mode; --output-format stream-json: NDJSON we parse;
    // --stream-partial-output: emit text deltas as separate events so the UI
    //   streams thinking instead of dumping the final message at the end;
    // --force / --yolo: skip approvals (browser is already scoped by env);
    // --trust: trust the harness cwd without prompting (only valid with -p);
    // --sandbox disabled: helpers.js makes outbound CDP/network calls; the
    //   default sandbox can break those in headless mode.
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--force',
      '--trust',
      '--sandbox', 'disabled',
    ];
    if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
    args.push(wrappedPrompt);
    return args;
  },

  buildEnv(ctx: SpawnContext, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = enrichedEnv(baseEnv);
    // Strip any pre-existing CURSOR_API_KEY so OAuth (`agent login`) wins by
    // default. If the user saved an explicit API key in the app, inject it.
    delete env.CURSOR_API_KEY;
    if (ctx.savedApiKey) env.CURSOR_API_KEY = ctx.savedApiKey;
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

    if (type === 'system') {
      const subtype = e.subtype as string | undefined;
      if (subtype === 'init') {
        mainLogger.info('cursor-agent.init', { model: e.model, session_id: e.session_id, apiKeySource: e.apiKeySource });
        if (typeof e.session_id === 'string') capturedSessionId = e.session_id;
        if (typeof e.model === 'string') ctx.currentModel = e.model;
      }
      return { events, capturedSessionId };
    }

    if (type === 'user') {
      // Echo of the user's own prompt — nothing to surface.
      return { events };
    }

    if (type === 'assistant') {
      // Cursor emits two flavors of assistant message:
      //   - streamed deltas (have `timestamp_ms`) — small text fragments that
      //     should each become a `thinking` event so the UI streams them.
      //   - one final consolidated message (no `timestamp_ms`) — duplicates
      //     the concatenated deltas; skip to avoid double-rendering.
      const isDelta = typeof e.timestamp_ms === 'number';
      if (!isDelta) return { events };
      const msg = e.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return { events };
      for (const block of content) {
        if (block?.type !== 'text') continue;
        const txt = typeof block.text === 'string' ? (block.text as string) : '';
        if (txt.trim()) {
          events.push({ type: 'thinking', text: txt });
          ctx.lastNarrative = txt;
        }
      }
      return { events };
    }

    if (type === 'tool_call') {
      const subtype = e.subtype as string | undefined;
      const callId = e.call_id as string | undefined;
      const wrapper = e.tool_call as Record<string, unknown> | undefined;
      if (!callId || !wrapper) return { events };
      const wrapperKeys = Object.keys(wrapper);
      const wrapperKey = wrapperKeys[0];
      if (!wrapperKey) return { events };
      const inner = wrapper[wrapperKey] as Record<string, unknown> | undefined;
      const name = wrapperToToolName(wrapperKey);

      if (subtype === 'started') {
        ctx.iter++;
        const args = extractToolArgs(name, inner);
        ctx.pendingTools.set(callId, { name, startedAt: Date.now(), iter: ctx.iter });
        events.push({ type: 'tool_call', name, args, iteration: ctx.iter });
        return { events };
      }
      if (subtype === 'completed') {
        const match = ctx.pendingTools.get(callId);
        const { text, ok } = extractToolResult(inner);
        const ms = match ? Date.now() - match.startedAt : 0;
        const resolvedName = match?.name ?? name;
        events.push({ type: 'tool_result', name: resolvedName, ok, preview: text.slice(0, 2000), ms });
        ctx.pendingTools.delete(callId);
        return { events };
      }
      return { events };
    }

    if (type === 'result') {
      // Cursor's result has `usage` but no cost field — surface the tokens
      // with cost=0 so the session totals at least reflect token consumption.
      const usage = e.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inputTokens = typeof usage.inputTokens === 'number' ? (usage.inputTokens as number) : 0;
        const outputTokens = typeof usage.outputTokens === 'number' ? (usage.outputTokens as number) : 0;
        const cacheRead = typeof usage.cacheReadTokens === 'number' ? (usage.cacheReadTokens as number) : 0;
        const cacheWrite = typeof usage.cacheWriteTokens === 'number' ? (usage.cacheWriteTokens as number) : 0;
        events.push({
          type: 'turn_usage',
          inputTokens,
          outputTokens,
          cachedInputTokens: cacheRead + cacheWrite,
          costUsd: 0,
          model: ctx.currentModel,
          source: 'estimated',
        });
        mainLogger.info('cursor-agent.turnUsage', { inputTokens, outputTokens, cacheRead, cacheWrite, model: ctx.currentModel });
      }

      const isError = e.is_error === true;
      const subtype = e.subtype as string | undefined;
      const resultText = (e.result as string | undefined) ?? '';
      if (isError || (subtype && subtype !== 'success')) {
        terminalError = `cursor_agent_error: ${subtype ?? 'error'} ${resultText}`.trim();
        events.push({ type: 'error', message: terminalError });
      } else {
        terminalDone = true;
        events.push({ type: 'done', summary: resultText || ctx.lastNarrative || '(done)', iterations: ctx.iter });
      }
    }

    return { events, capturedSessionId, terminalDone, terminalError };
  },
};

register(cursorAgentAdapter);
