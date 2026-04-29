import { z } from 'zod';

// ---------------------------------------------------------------------------
// Session status
// ---------------------------------------------------------------------------

export const SessionStatusSchema = z.enum(['draft', 'running', 'stuck', 'idle', 'stopped']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// ---------------------------------------------------------------------------
// HlEvent — structured agent output events
// ---------------------------------------------------------------------------

export const HlEventThinkingSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
});

export const HlEventToolCallSchema = z.object({
  type: z.literal('tool_call'),
  name: z.string(),
  args: z.unknown(),
  iteration: z.number(),
});

export const HlEventToolResultSchema = z.object({
  type: z.literal('tool_result'),
  name: z.string(),
  ok: z.boolean(),
  preview: z.string(),
  ms: z.number(),
});

export const HlEventDoneSchema = z.object({
  type: z.literal('done'),
  summary: z.string(),
  iterations: z.number(),
});

export const HlEventErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const HlEventUserInputSchema = z.object({
  type: z.literal('user_input'),
  text: z.string(),
});

export const HlEventSkillWrittenSchema = z.object({
  type: z.literal('skill_written'),
  path: z.string(),
  domain: z.string(),
  topic: z.string(),
  bytes: z.number(),
  action: z.enum(['write', 'patch']),
});

export const HlEventNotifySchema = z.object({
  type: z.literal('notify'),
  message: z.string(),
  level: z.enum(['info', 'blocking']),
});

export const HlEventHarnessEditedSchema = z.object({
  type: z.literal('harness_edited'),
  target: z.enum(['helpers', 'tools']),
  action: z.enum(['write', 'patch']),
  path: z.string(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  changed: z.array(z.string()).optional(),
});

export const HlEventSkillUsedSchema = z.object({
  type: z.literal('skill_used'),
  path: z.string(),
  domain: z.string().optional(),
  topic: z.string(),
});

export const HlEventFileOutputSchema = z.object({
  type: z.literal('file_output'),
  name: z.string(),
  path: z.string(),
  size: z.number(),
  mime: z.string(),
});

// Emitted by adapters at turn end. Carries cumulative-for-this-turn tokens
// and the dollar cost. For Claude Code, costUsd is the CLI's own total_cost_usd
// (authoritative). For Codex, costUsd is computed from a local price table in
// main/hl/pricing.ts (estimated — may drift from OpenAI's dashboard).
export const HlEventTurnUsageSchema = z.object({
  type: z.literal('turn_usage'),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  costUsd: z.number(),
  model: z.string().optional(),
  // 'exact' for Claude's CLI-reported number; 'estimated' when we multiplied
  // token counts ourselves (Codex). Drives the `~` prefix on the UI.
  source: z.enum(['exact', 'estimated']),
});

export const HlEventSchema = z.discriminatedUnion('type', [
  HlEventThinkingSchema,
  HlEventToolCallSchema,
  HlEventToolResultSchema,
  HlEventDoneSchema,
  HlEventErrorSchema,
  HlEventUserInputSchema,
  HlEventSkillWrittenSchema,
  HlEventNotifySchema,
  HlEventHarnessEditedSchema,
  HlEventSkillUsedSchema,
  HlEventFileOutputSchema,
  HlEventTurnUsageSchema,
]);

export type HlEvent = z.infer<typeof HlEventSchema>;

// ---------------------------------------------------------------------------
// AgentSession — the core session record
// ---------------------------------------------------------------------------

export const AgentSessionSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string(),
  status: SessionStatusSchema,
  createdAt: z.number(),
  output: z.array(HlEventSchema),
  error: z.string().optional(),
  group: z.string().optional(),
  hasBrowser: z.boolean().optional(),
  originChannel: z.string().optional(),
  originConversationId: z.string().optional(),
  primarySite: z.string().nullable().optional(),
  lastActivityAt: z.number().optional(),
  engine: z.string().optional(),
  // Snapshotted at spawn — whether the run was authenticated via API key or
  // subscription OAuth. Optional on existing rows (pre-migration-v9 sessions
  // predate this field). Distinct from the live auth mode in authStore because
  // users may flip between modes, but historical sessions should still reflect
  // the mode that actually ran them (for cost attribution).
  // Cumulative usage totals, updated on each turn_usage event. For Claude Code
  // these reflect the CLI's own figures; for Codex they are computed locally
  // via main/hl/pricing.ts and may drift from OpenAI's dashboard.
  costUsd: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  costSource: z.enum(['exact', 'estimated']).optional(),
  authMode: z.enum(['apiKey', 'subscription']).optional(),
  // Subscription tier label when authMode === 'subscription'. For Claude Code
  // this is the OAuth credential's subscriptionType ("max" | "pro"). For Codex
  // we use 'chatgpt' as a generic label since the CLI does not expose the
  // plan tier locally.
  subscriptionType: z.string().optional(),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

// ---------------------------------------------------------------------------
// OutputEntry — UI-friendly flattened event for rendering
// ---------------------------------------------------------------------------

export const OutputEntryTypeSchema = z.enum(['thinking', 'tool_call', 'tool_result', 'text', 'error']);

export const OutputEntrySchema = z.object({
  id: z.string(),
  type: OutputEntryTypeSchema,
  timestamp: z.number(),
  content: z.string(),
  tool: z.string().optional(),
  duration: z.number().optional(),
});

export type OutputEntry = z.infer<typeof OutputEntrySchema>;

// ---------------------------------------------------------------------------
// TabInfo — browser tab observation
// ---------------------------------------------------------------------------

export const TabInfoSchema = z.object({
  targetId: z.string(),
  url: z.string(),
  title: z.string(),
  type: z.enum(['page', 'iframe', 'other']),
  active: z.boolean(),
});

export type TabInfo = z.infer<typeof TabInfoSchema>;

// ---------------------------------------------------------------------------
// BrowserPoolStats — monitoring data
// ---------------------------------------------------------------------------

export const PoolSessionInfoSchema = z.object({
  sessionId: z.string(),
  attached: z.boolean(),
  createdAt: z.number(),
  pid: z.number(),
});

export const BrowserPoolStatsSchema = z.object({
  active: z.number(),
  queued: z.number(),
  maxConcurrent: z.number(),
  sessions: z.array(PoolSessionInfoSchema),
});

export type BrowserPoolStats = z.infer<typeof BrowserPoolStatsSchema>;

// ---------------------------------------------------------------------------
// IPC validation helpers
// ---------------------------------------------------------------------------

export function validateSession(data: unknown): AgentSession {
  return AgentSessionSchema.parse(data);
}

export function validateSessionList(data: unknown): AgentSession[] {
  return z.array(AgentSessionSchema).parse(data);
}

export function validateHlEvent(data: unknown): HlEvent {
  return HlEventSchema.parse(data);
}

export function validateTabs(data: unknown): TabInfo[] {
  return z.array(TabInfoSchema).parse(data);
}

export function validatePoolStats(data: unknown): BrowserPoolStats {
  return BrowserPoolStatsSchema.parse(data);
}
