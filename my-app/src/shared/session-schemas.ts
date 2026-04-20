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
});

export const HlEventSchema = z.discriminatedUnion('type', [
  HlEventThinkingSchema,
  HlEventToolCallSchema,
  HlEventToolResultSchema,
  HlEventDoneSchema,
  HlEventErrorSchema,
  HlEventUserInputSchema,
  HlEventSkillWrittenSchema,
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
  hidden: z.boolean().optional(),
  originChannel: z.string().optional(),
  originConversationId: z.string().optional(),
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
