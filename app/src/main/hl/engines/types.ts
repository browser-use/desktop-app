/**
 * EngineAdapter — pluggable interface for CLI-agent backends (Claude Code,
 * Codex, etc.). Each adapter knows how to detect install/auth, build spawn
 * args, and translate its NDJSON event stream into universal HlEvent shapes.
 */

import type { WebContents } from 'electron';
import type { HlEvent } from '../../../shared/session-schemas';

// ── run-time context passed to adapters ─────────────────────────────────────

export interface SpawnContext {
  /** User prompt to feed to the CLI. Adapters may wrap with seed/system text. */
  prompt: string;
  /** Absolute path to <userData>/harness/ (AGENTS.md + helpers.js live here). */
  harnessDir: string;
  /** App session id (used for naming uploads/outputs dirs + env injection). */
  sessionId: string;
  /** CDP target id for the browser view the agent must drive. */
  targetId: string;
  /** Port Electron exposes CDP on. */
  cdpPort: number;
  /** If set, ask the CLI to continue a prior conversation with this id. */
  resumeSessionId?: string;
  /** Optional user-supplied API key; adapter decides how to inject. */
  savedApiKey?: string;
  /** BrowserCode/opencode provider id used to build OPENCODE_AUTH_CONTENT. */
  browserCodeProviderId?: string;
  /** BrowserCode/opencode model id in provider/model format. */
  browserCodeModel?: string;
  /** List of attachment paths (relative to harnessDir) the adapter may mention in wrappedPrompt. */
  attachmentRefs: Array<{ relPath: string; mime: string; size: number }>;
}

export interface ParseContext {
  /** Incrementing iteration counter; adapter bumps this on new agent turns. */
  iter: number;
  /** In-flight tool calls keyed by engine-specific tool id for pairing with results. */
  pendingTools: Map<string, { name: string; startedAt: number; iter: number }>;
  /** Harness file paths, for harness_edited / skill_used detection. */
  harnessHelpersPath: string;
  harnessToolsPath: string;
  harnessSkillPath: string;
  /** Last agent-facing narrative text seen this turn; adapters that don't
   *  emit a proper summary (codex) use this as the `done.summary` so users
   *  see a meaningful sentence instead of token telemetry. */
  lastNarrative?: string;
  /** Model id reported by the engine (e.g. 'gpt-5-codex', 'claude-sonnet-4-5').
   *  Adapters capture this from their init/thread-started event so cost
   *  estimation and future per-turn UI can cite the model that ran. */
  currentModel?: string;
}

/** Result of parsing one NDJSON line. */
export interface ParseResult {
  /** Zero or more HlEvents to emit downstream. */
  events: HlEvent[];
  /** Engine-reported session id (e.g. Claude `system/init.session_id`, Codex `thread.started.thread_id`). */
  capturedSessionId?: string;
  /** The agent signaled completion in this event; runner may early-exit wait. */
  terminalDone?: boolean;
  /** The agent signaled a hard error in this event. */
  terminalError?: string;
}

// ── probes ──────────────────────────────────────────────────────────────────

export interface InstallProbe {
  installed: boolean;
  version?: string;
  error?: string;
}

export interface AuthProbe {
  authed: boolean;
  error?: string;
}

// ── adapter ─────────────────────────────────────────────────────────────────

export interface EngineAdapter {
  /** Stable identifier (stored on sessions.engine). */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** CLI binary on PATH. */
  readonly binaryName: string;

  // Onboarding probes
  probeInstalled(): Promise<InstallProbe>;
  probeAuthed(): Promise<AuthProbe>;
  /** Kick off the engine's login flow. `opened` means "the flow is now
   *  underway" — for Claude Code that's the OAuth browser handoff, for Codex
   *  it's the URL (+ optional device code) returned in this result. Codex
   *  supports a `deviceAuth` escape hatch for remote/headless machines that
   *  can't use the default localhost-callback OAuth. Callers should poll
   *  `probeAuthed()` to detect when auth.json / OAuth creds appear. */
  openLoginInTerminal(opts?: { deviceAuth?: boolean }): Promise<{ opened: boolean; error?: string; verificationUrl?: string; deviceCode?: string }>;

  // Execution
  /** Produce the argv for spawning this engine in headless mode. */
  buildSpawnArgs(ctx: SpawnContext, wrappedPrompt: string): string[];
  /** Produce the env for the spawned process (add auth, strip conflicting vars). */
  buildEnv(ctx: SpawnContext, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Build the seed/wrapper prompt the CLI will receive. */
  wrapPrompt(ctx: SpawnContext): string;
  /** Translate one NDJSON line from stdout into HlEvents. */
  parseLine(line: string, ctx: ParseContext): ParseResult;
}

// ── runEngine input ─────────────────────────────────────────────────────────

export interface RunEngineOptions {
  engineId: string;
  prompt: string;
  sessionId: string;
  webContents: WebContents;
  cdpPort: number;
  harnessDir: string;
  attachments?: Array<{ name: string; mime: string; bytes: Buffer | Uint8Array }>;
  resumeSessionId?: string;
  signal?: AbortSignal;
  onEvent: (e: HlEvent) => void;
  onSessionId?: (id: string) => void;
  /** Fired when the runner can identify the model that this spawn is using. */
  onModelResolved?: (info: { model: string; source: 'config' | 'engine' }) => void;
  /** Fired once per run with the resolved auth for this spawn, so the caller
   *  can stamp the session with the mode that actually ran it. */
  onAuthResolved?: (info: { authMode: 'apiKey' | 'subscription' | null; subscriptionType: string | null }) => void;
}
