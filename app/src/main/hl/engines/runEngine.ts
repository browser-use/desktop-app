/**
 * Engine-agnostic runner. Spawns the configured adapter's CLI, pipes
 * its NDJSON stdout through the adapter's parser, and emits HlEvents.
 *
 * Everything downstream (SessionManager, AgentPane, DB, outputs watcher)
 * speaks HlEvent only — the adapter's job is to hide engine-specific
 * spawn args, env, and NDJSON dialect behind this contract.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { engineLogger } from '../../logger';
import { resolveAuth, loadOpenAIKey, loadClaudeSubscriptionType, loadBrowserCodeConfig } from '../../identity/authStore';
import { helpersPath, toolsPath, skillPath } from '../harness';
import { get as getAdapter } from './registry';
import { resolveCliSpawn } from './pathEnrich';
import type {
  EngineAdapter,
  ParseContext,
  RunEngineOptions,
  SpawnContext,
} from './types';
import type { HlEvent } from '../../../shared/session-schemas';
import type { WebContents } from 'electron';

function envPathValue(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32' ? env.Path ?? env.PATH ?? '' : env.PATH ?? '';
}

function interestingPathEntries(env: NodeJS.ProcessEnv): string[] {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return envPathValue(env)
    .split(delimiter)
    .filter((entry) => /bcode|opencode|npm|node|bun|homebrew|\/usr\/local|\.local|\.cargo|volta|nvm/i.test(entry))
    .slice(0, 25);
}

function envFlag(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  return value ? `set(${value.length}ch)` : 'unset';
}

async function resolveTargetIdForWebContents(wc: WebContents): Promise<string> {
  const dbg = wc.debugger;
  const attachedByUs = !dbg.isAttached();
  if (attachedByUs) dbg.attach('1.3');
  try {
    const info = (await dbg.sendCommand('Target.getTargetInfo')) as {
      targetInfo?: { targetId?: string };
    };
    const id = info?.targetInfo?.targetId;
    if (!id) throw new Error('Target.getTargetInfo returned no targetId');
    return id;
  } finally {
    if (attachedByUs) {
      try { dbg.detach(); } catch { /* already detached */ }
    }
  }
}

function mimeFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', html: 'text/html', xml: 'application/xml',
    yaml: 'application/x-yaml', yml: 'application/x-yaml',
    js: 'text/javascript', ts: 'application/typescript', py: 'text/x-python',
    zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
  };
  return map[ext] ?? 'application/octet-stream';
}

export async function runEngine(opts: RunEngineOptions): Promise<void> {
  const adapter: EngineAdapter | undefined = getAdapter(opts.engineId);
  if (!adapter) {
    opts.onEvent({ type: 'error', message: `unknown_engine: ${opts.engineId}` });
    return;
  }

  // 1. Resolve CDP target for the session's browser view.
  let targetId: string;
  try {
    targetId = await resolveTargetIdForWebContents(opts.webContents);
  } catch (err) {
    const msg = `Failed to resolve CDP target id: ${(err as Error).message}`;
    engineLogger.error('engines.run.resolveTarget.failed', { engineId: opts.engineId, error: msg });
    opts.onEvent({ type: 'error', message: msg });
    return;
  }

  // 2. Prepare uploads/ + outputs/ dirs, write attachments to disk.
  const uploadsDir = path.join(opts.harnessDir, 'uploads', opts.sessionId);
  const outputsDir = path.join(opts.harnessDir, 'outputs', opts.sessionId);
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
  } catch (err) {
    engineLogger.warn('engines.run.mkdir.failed', { engineId: opts.engineId, error: (err as Error).message });
  }

  const attachmentRefs: Array<{ relPath: string; mime: string; size: number }> = [];
  for (const a of opts.attachments ?? []) {
    const buf = a.bytes instanceof Buffer ? a.bytes : Buffer.from(a.bytes);
    const safeName = a.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'upload';
    const filePath = path.join(uploadsDir, safeName);
    try {
      fs.writeFileSync(filePath, buf);
      attachmentRefs.push({
        relPath: path.relative(opts.harnessDir, filePath),
        mime: a.mime,
        size: buf.byteLength,
      });
    } catch (err) {
      engineLogger.warn('engines.run.attachmentWrite.failed', { name: a.name, error: (err as Error).message });
    }
  }

  // 3. Resolve auth. Per-engine keychain slots: Claude reads the Anthropic
  //    key via resolveAuth(), Codex reads its OpenAI slot. Each adapter gets
  //    the key appropriate to its provider so we can't accidentally send an
  //    Anthropic key to OpenAI (or vice versa).
  let savedApiKey: string | undefined;
  let browserCodeProviderId: string | undefined;
  let browserCodeModel: string | undefined;
  let cliAuthed = false;
  try {
    if (adapter.id === 'codex') {
      const k = await loadOpenAIKey();
      if (k) savedApiKey = k;
      cliAuthed = (await adapter.probeAuthed()).authed;
    } else if (adapter.id === 'browsercode') {
      const cfg = await loadBrowserCodeConfig();
      if (cfg) {
        savedApiKey = cfg.apiKey;
        browserCodeProviderId = cfg.providerId;
        browserCodeModel = cfg.model;
      }
      cliAuthed = (await adapter.probeAuthed()).authed;
    } else {
      const auth = await resolveAuth();
      if (auth?.type === 'apiKey') savedApiKey = auth.value;
      cliAuthed = (await adapter.probeAuthed()).authed;
    }
  } catch (err) {
    engineLogger.warn('engines.run.auth.resolveFailed', { error: (err as Error).message });
  }
  // Headline auth-path log — greppable: `session.auth.path`. Tells you
  // which of the three cases this session falls into:
  //   - 'apiKey'       → using saved API key (ANTHROPIC / OPENAI env var)
  //   - 'subscription' → using the CLI's own OAuth (Claude Keychain / Codex auth.json)
  //   - 'both'         → both are available; we chose `chosen` (apiKey wins
  //                      because the adapter's buildEnv sets the env var when
  //                      savedApiKey is present)
  const authPath: 'apiKey' | 'subscription' | 'both' | 'none' =
    savedApiKey && cliAuthed ? 'both'
    : savedApiKey ? 'apiKey'
    : cliAuthed ? 'subscription'
    : 'none';
  const chosen: 'apiKey' | 'subscription' | 'none' =
    savedApiKey ? 'apiKey' : cliAuthed ? 'subscription' : 'none';
  engineLogger.info('session.auth.path', {
    sessionId: opts.sessionId,
    engineId: adapter.id,
    path: authPath,
    chosen,
    hasSavedKey: Boolean(savedApiKey),
    cliAuthed,
  });

  // Resolve the (authMode, subscriptionType) snapshot for this session. Fires
  // onAuthResolved so SessionManager can stamp the session row. This is the
  // source of truth for per-session auth attribution — the global authStore
  // mode can change later without rewriting history.
  const resolvedAuthMode: 'apiKey' | 'subscription' | null = chosen === 'none' ? null : chosen;
  let resolvedSubType: string | null = null;
  if (resolvedAuthMode === 'subscription') {
    if (adapter.id === 'codex') {
      // Codex CLI does not expose Plus vs Pro locally; use a generic label.
      resolvedSubType = 'chatgpt';
    } else {
      try {
        resolvedSubType = await loadClaudeSubscriptionType();
      } catch (err) {
        engineLogger.warn('engines.run.subType.loadFailed', { error: (err as Error).message });
      }
    }
  }
  engineLogger.info('session.auth.resolved', {
    sessionId: opts.sessionId,
    engineId: adapter.id,
    authMode: resolvedAuthMode,
    subscriptionType: resolvedSubType,
  });
  if (opts.onAuthResolved) {
    try { opts.onAuthResolved({ authMode: resolvedAuthMode, subscriptionType: resolvedSubType }); }
    catch (err) { engineLogger.warn('engines.run.onAuthResolved.threw', { error: (err as Error).message }); }
  }

  // 4. Build spawn context + let adapter compose args/env/prompt.
  const spawnCtx: SpawnContext = {
    prompt: opts.prompt,
    harnessDir: opts.harnessDir,
    sessionId: opts.sessionId,
    targetId,
    cdpPort: opts.cdpPort,
    resumeSessionId: opts.resumeSessionId,
    savedApiKey,
    browserCodeProviderId,
    browserCodeModel,
    attachmentRefs,
  };
  const wrappedPrompt = adapter.wrapPrompt(spawnCtx);
  const args = adapter.buildSpawnArgs(spawnCtx, wrappedPrompt);
  const env = adapter.buildEnv(spawnCtx, { ...process.env });

  engineLogger.info('engines.run.spawn', {
    engineId: adapter.id,
    binary: adapter.binaryName,
    sessionId: opts.sessionId,
    targetId,
    cdpPort: opts.cdpPort,
    hasResume: !!opts.resumeSessionId,
    attachmentCount: attachmentRefs.length,
    authSource: savedApiKey ? 'savedApiKey' : 'cliManaged',
    args: args.map((a) => (a.length > 120 ? `${a.slice(0, 100)}…<${a.length}ch>` : a)),
    cwd: opts.harnessDir,
    envPathLength: envPathValue(env).length,
    envPathHits: interestingPathEntries(env),
    envAuthFlags: {
      ANTHROPIC_API_KEY: envFlag('ANTHROPIC_API_KEY', env),
      ANTHROPIC_AUTH_TOKEN: envFlag('ANTHROPIC_AUTH_TOKEN', env),
      CODEX_API_KEY: envFlag('CODEX_API_KEY', env),
      OPENAI_API_KEY: envFlag('OPENAI_API_KEY', env),
      OPENCODE_AUTH_CONTENT: envFlag('OPENCODE_AUTH_CONTENT', env),
      OPENCODE_CONFIG_CONTENT: envFlag('OPENCODE_CONFIG_CONTENT', env),
      CLAUDE_CODE_USE_BEDROCK: env.CLAUDE_CODE_USE_BEDROCK ?? 'unset',
      CLAUDE_CODE_USE_VERTEX: env.CLAUDE_CODE_USE_VERTEX ?? 'unset',
    },
  });

  let child: ChildProcessWithoutNullStreams;
  let resolvedCommand = adapter.binaryName;
  let resolvedArgs = args;
  try {
    const resolved = resolveCliSpawn(adapter.binaryName, args, { env });
    resolvedCommand = resolved.command;
    resolvedArgs = resolved.args;
    engineLogger.info('engines.run.spawn.resolved', {
      engineId: adapter.id,
      binary: adapter.binaryName,
      command: resolved.command,
      viaCmdShell: resolved.viaCmdShell,
      argCount: resolved.args.length,
      firstArgs: resolved.args.slice(0, 8).map((a) => (a.length > 120 ? `${a.slice(0, 100)}…<${a.length}ch>` : a)),
      cwd: opts.harnessDir,
    });
    child = spawn(resolved.command, resolved.args, { cwd: opts.harnessDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    engineLogger.error('engines.run.spawn.syncFailed', {
      engineId: adapter.id,
      binary: adapter.binaryName,
      cwd: opts.harnessDir,
      error: (err as Error).message,
      envPathLength: envPathValue(env).length,
      envPathHits: interestingPathEntries(env),
    });
    opts.onEvent({ type: 'error', message: `spawn_failed: ${(err as Error).message}` });
    return;
  }

  child.on('spawn', () => {
    engineLogger.info('engines.run.spawn.started', {
      engineId: adapter.id,
      pid: child.pid,
      command: resolvedCommand,
      argCount: resolvedArgs.length,
    });
  });

  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  };
  opts.signal?.addEventListener('abort', onAbort);

  // 5. Outputs watcher — emits file_output events for any file written to the
  //    session's outputs dir. Deduped by (name, size).
  const seenOutputs = new Map<string, number>();
  let outputsWatcher: ReturnType<typeof fs.watch> | null = null;
  try {
    outputsWatcher = fs.watch(outputsDir, { persistent: false }, (_ev, filename) => {
      if (!filename || typeof filename !== 'string') return;
      const filePath = path.join(outputsDir, filename);
      let stat;
      try { stat = fs.statSync(filePath); } catch { return; }
      if (!stat.isFile()) return;
      if (seenOutputs.get(filename) === stat.size) return;
      seenOutputs.set(filename, stat.size);
      opts.onEvent({
        type: 'file_output',
        name: filename,
        path: filePath,
        size: stat.size,
        mime: mimeFromExt(filename),
      });
    });
  } catch (err) {
    engineLogger.warn('engines.run.outputs.watchFailed', { outputsDir, error: (err as Error).message });
  }

  // 6. Generic post-processor over tool_call events: detect harness/skill
  //    edits and reads. Keeps adapters' parsers focused on NDJSON→HlEvent.
  const skillPathRe = /(?:domain-skills|interaction-skills)\/([^/]+)\/([^/]+)\.md$/;
  const harnessHelpersAbs = path.resolve(helpersPath());
  const harnessToolsAbs = path.resolve(toolsPath());
  const harnessSkillAbs = path.resolve(skillPath());

  function postProcess(e: HlEvent): HlEvent[] {
    if (e.type !== 'tool_call') return [e];
    const args = e.args as Record<string, unknown> | undefined;
    if (!args) return [e];
    const rawPath = typeof args.file_path === 'string' ? args.file_path
                  : typeof args.path === 'string' ? args.path
                  : typeof args.target_file === 'string' ? args.target_file
                  : undefined;
    if (!rawPath) return [e];
    const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(opts.harnessDir, rawPath);
    const isWrite = /^(write|edit|apply_patch|multiedit|write_file|patch_file)$/i.test(e.name);
    const isRead = /^(read|read_file)$/i.test(e.name);
    const extra: HlEvent[] = [];
    if (isWrite) {
      const action = /edit|patch/i.test(e.name) ? 'patch' : 'write';
      if (resolved === harnessHelpersAbs) {
        extra.push({ type: 'harness_edited', target: 'helpers', action, path: resolved });
      } else if (resolved === harnessToolsAbs || resolved === harnessSkillAbs) {
        extra.push({ type: 'harness_edited', target: 'tools', action, path: resolved });
      } else {
        const m = resolved.match(skillPathRe);
        if (m) extra.push({ type: 'skill_written', path: resolved, domain: m[1], topic: m[2], bytes: 0, action });
      }
    } else if (isRead) {
      const m = resolved.match(skillPathRe);
      if (m) extra.push({ type: 'skill_used', path: resolved, domain: m[1], topic: m[2] });
    }
    return [e, ...extra];
  }

  const parseCtx: ParseContext = {
    iter: 0,
    pendingTools: new Map(),
    harnessHelpersPath: harnessHelpersAbs,
    harnessToolsPath: harnessToolsAbs,
    harnessSkillPath: harnessSkillAbs,
  };

  let buf = '';
  let stderrBuf = '';
  let stdoutBuf = ''; // tail of raw stdout for diagnostics on early exit
  // Engines (esp. Claude CLI) have been observed to exit non-zero even after
  // emitting a successful `done`. Track whether we already saw one so the
  // close handler doesn't overwrite the completed session with an error.
  let doneEmitted = false;
  const emit = (ev: Parameters<typeof opts.onEvent>[0]): void => {
    if (ev.type === 'done') {
      if (doneEmitted) {
        engineLogger.warn('engines.run.done.duplicateSuppressed', { engineId: adapter.id, sessionId: opts.sessionId });
        return;
      }
      doneEmitted = true;
    }
    opts.onEvent(ev);
  };
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (c: string) => { stderrBuf += c; if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192); });

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    stdoutBuf += chunk;
    if (stdoutBuf.length > 8192) stdoutBuf = stdoutBuf.slice(-8192);
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const result = adapter.parseLine(line, parseCtx);
        if (result.capturedSessionId && opts.onSessionId) {
          try { opts.onSessionId(result.capturedSessionId); }
          catch (err) { engineLogger.warn('engines.run.onSessionId.threw', { error: (err as Error).message }); }
        }
        for (const raw of result.events) {
          for (const out of postProcess(raw)) emit(out);
        }
      } catch (err) {
        engineLogger.warn('engines.run.parse.failed', {
          engineId: adapter.id,
          line: line.slice(0, 200),
          error: (err as Error).message,
        });
      }
    }
  });

  await new Promise<void>((resolve) => {
    child.on('close', (code, sig) => {
      opts.signal?.removeEventListener('abort', onAbort);
      try { outputsWatcher?.close(); } catch { /* already closed */ }
      engineLogger.info('engines.run.exit', {
        engineId: adapter.id,
        command: resolvedCommand,
        cwd: opts.harnessDir,
        code,
        signal: sig,
        stderrTail: stderrBuf.slice(-800),
        stdoutTail: stdoutBuf.slice(-800),
        stdoutBytes: stdoutBuf.length,
      });
      if (opts.signal?.aborted) {
        opts.onEvent({ type: 'done', summary: 'Halted by user', iterations: 0 });
      } else if (code !== 0 && !doneEmitted) {
        const stderrTrim = stderrBuf.trim();
        const stdoutTrim = stdoutBuf.trim();
        const detail = stderrTrim || stdoutTrim || `exit_code=${code} (no stderr/stdout — check main.log engines.run.spawn + engines.run.exit)`;
        opts.onEvent({ type: 'error', message: `${adapter.id}_exit: ${detail.slice(-800)}` });
      } else if (code !== 0) {
        engineLogger.warn('engines.run.exit.postDoneNonZero', { engineId: adapter.id, code, stderrTail: stderrBuf.slice(-200) });
      } else if (!doneEmitted) {
        // Clean exit (code 0) but the adapter never emitted `done`. Without
        // this fallback the session would hang in 'running' until the stuck
        // timer fires, and follow-ups would fail (need 'idle' status).
        engineLogger.info('engines.run.exit.cleanNoDone', { engineId: adapter.id, msg: 'emitting synthetic done' });
        opts.onEvent({ type: 'done', summary: 'completed', iterations: 0 });
      }
      resolve();
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      try { outputsWatcher?.close(); } catch { /* already closed */ }
      const nodeErr = err as NodeJS.ErrnoException & { path?: string; spawnargs?: string[] };
      engineLogger.error('engines.run.spawn.error', {
        engineId: adapter.id,
        binary: adapter.binaryName,
        command: resolvedCommand,
        cwd: opts.harnessDir,
        message: nodeErr.message,
        code: nodeErr.code,
        errno: nodeErr.errno,
        syscall: nodeErr.syscall,
        path: nodeErr.path,
        spawnargs: nodeErr.spawnargs?.slice(0, 8),
        envPathLength: envPathValue(env).length,
        envPathHits: interestingPathEntries(env),
      });
      opts.onEvent({ type: 'error', message: `${adapter.id}_spawn_error: ${err.message}` });
      resolve();
    });
  });
}
