export type SessionStatus = 'draft' | 'running' | 'stuck' | 'stopped' | 'idle';

export type HlEvent =
  | { type: 'thinking';    text: string }
  | { type: 'tool_call';   name: string; args: unknown; iteration: number }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done';        summary: string; iterations: number }
  | { type: 'error';       message: string }
  | { type: 'user_input';  text: string }
  | { type: 'skill_written'; path: string; domain: string; topic: string; bytes: number; action: 'write' | 'patch' }
  | { type: 'skill_used'; path: string; domain?: string; topic: string }
  | { type: 'harness_edited'; target: 'helpers' | 'tools'; action: 'write' | 'patch'; path: string; added?: string[]; removed?: string[]; changed?: string[] }
  | { type: 'file_output'; name: string; path: string; size: number; mime: string }
  | { type: 'notify'; message: string; level: 'info' | 'blocking' }
  | { type: 'turn_usage'; inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; model?: string; source: 'exact' | 'estimated' };

export interface AgentSession {
  id: string;
  prompt: string;
  status: SessionStatus;
  createdAt: number;
  output: HlEvent[];
  error?: string;
  group?: string;
  hasBrowser?: boolean;
  primarySite?: string | null;
  lastActivityAt?: number;
  engine?: string;
  model?: string;
  authMode?: 'apiKey' | 'subscription';
  subscriptionType?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costSource?: 'exact' | 'estimated';
}

export interface ToolResult {
  content: string;
  duration?: number;
  ok: boolean;
}

export interface OutputEntry {
  id: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'done' | 'error' | 'user_input' | 'skill_written' | 'skill_used' | 'harness_edited' | 'file_output' | 'notify';
  timestamp: number;
  content: string;
  tool?: string;
  duration?: number;
  result?: ToolResult;
  level?: 'info' | 'blocking';
  groupCount?: number;
  groupEntries?: OutputEntry[];
  // harness_edited metadata
  harnessTarget?: 'helpers' | 'tools';
  harnessAction?: 'write' | 'patch';
  added?: string[];
  removed?: string[];
  changed?: string[];
  // file_output metadata
  fileSize?: number;
  fileMime?: string;
}

let _adapterId = 0;

export function hlEventToOutputEntry(event: HlEvent, timestamp: number): OutputEntry {
  const id = `oe-${++_adapterId}`;

  switch (event.type) {
    case 'thinking':
      return { id, type: 'thinking', timestamp, content: event.text };
    case 'tool_call':
      return {
        id, type: 'tool_call', timestamp,
        tool: event.name,
        content: typeof event.args === 'string' ? event.args : JSON.stringify(event.args, null, 2),
      };
    case 'tool_result':
      return {
        id, type: 'tool_result', timestamp,
        tool: event.name,
        content: event.preview,
        duration: event.ms,
      };
    case 'done':
      return { id, type: 'done', timestamp, content: event.summary };
    case 'error':
      return { id, type: 'error', timestamp, content: event.message };
    case 'user_input':
      return { id, type: 'user_input', timestamp, content: event.text };
    case 'skill_written':
      return { id, type: 'skill_written', timestamp, content: `${event.domain}/${event.topic}`, tool: event.path, harnessAction: event.action };
    case 'skill_used':
      return { id, type: 'skill_used', timestamp, content: event.domain ? `${event.domain}/${event.topic}` : event.topic, tool: event.path };
    case 'harness_edited':
      return {
        id, type: 'harness_edited', timestamp,
        content: event.target === 'helpers' ? 'helpers.js' : 'TOOLS.json',
        tool: event.path,
        harnessTarget: event.target,
        harnessAction: event.action,
        added: event.added,
        removed: event.removed,
        changed: event.changed,
      };
    case 'file_output':
      return {
        id, type: 'file_output', timestamp,
        content: event.name,
        tool: event.path,
        fileSize: event.size,
        fileMime: event.mime,
      };
    case 'notify':
      return { id, type: 'notify', timestamp, content: event.message, level: event.level };
  }
}

export function adaptSession(session: AgentSession): {
  entries: OutputEntry[];
  toolCallCount: number;
  elapsedMs: number;
} {
  // turn_usage events are persisted for audit + session-total roll-up in the
  // main process; they have no row in the UI log so we drop them here.
  const visibleOutput = session.output.filter(
    (e): e is Exclude<HlEvent, { type: 'turn_usage' }> => e.type !== 'turn_usage',
  );

  // When the agent reads/writes a domain-skills/interaction-skills .md file,
  // postProcess (runEngine) emits BOTH the original tool_call (e.g. Read with
  // /path/to/domain-skills/github/repo.md) AND a synthetic skill_used /
  // skill_written event. The synthetic row carries a clean "Read skill /
  // Wrote skill / Edited skill" label with domain/topic — render only that,
  // and suppress the noisy bare path row plus its paired tool_result.
  const skillPathRe = /(?:domain-skills|interaction-skills)\/[^/]+\/[^/]+\.md$/;
  const skipIdx = new Set<number>();
  for (let i = 0; i < visibleOutput.length; i++) {
    const e = visibleOutput[i];
    if (e.type !== 'tool_call') continue;
    const args = e.args as Record<string, unknown> | undefined;
    const rawPath =
      typeof args?.file_path === 'string' ? args.file_path
      : typeof args?.path === 'string' ? args.path
      : typeof args?.target_file === 'string' ? args.target_file
      : undefined;
    if (!rawPath || !skillPathRe.test(rawPath)) continue;
    skipIdx.add(i);
    for (let j = i + 1; j < visibleOutput.length; j++) {
      const next = visibleOutput[j];
      if (next.type === 'tool_call') break;
      if (next.type === 'tool_result' && next.name === e.name) {
        skipIdx.add(j);
        break;
      }
    }
  }
  const filteredOutput = visibleOutput.filter((_, i) => !skipIdx.has(i));
  const raw = filteredOutput.map((e, i) => hlEventToOutputEntry(e, session.createdAt + i));

  const merged: OutputEntry[] = [];
  for (const entry of raw) {
    const prev = merged[merged.length - 1];
    if (entry.type === 'thinking' && prev?.type === 'thinking') {
      prev.content += entry.content;
      continue;
    }
    merged.push(entry);
  }

  const paired: OutputEntry[] = [];
  for (let i = 0; i < merged.length; i++) {
    const entry = merged[i];
    if (entry.type === 'tool_call') {
      const next = merged[i + 1];
      if (next && next.type === 'tool_result' && next.tool === entry.tool) {
        paired.push({
          ...entry,
          result: { content: next.content, duration: next.duration, ok: true },
        });
        i++;
      } else {
        paired.push(entry);
      }
    } else if (entry.type === 'tool_result') {
      paired.push(entry);
    } else {
      paired.push(entry);
    }
  }

  const entries: OutputEntry[] = [];
  for (let i = 0; i < paired.length; i++) {
    const entry = paired[i];
    if (entry.type === 'tool_call' && entry.tool) {
      const group: OutputEntry[] = [entry];
      while (i + 1 < paired.length && paired[i + 1].type === 'tool_call' && paired[i + 1].tool === entry.tool) {
        i++;
        group.push(paired[i]);
      }
      if (group.length > 1) {
        entries.push({ ...entry, groupCount: group.length, groupEntries: group });
      } else {
        entries.push(entry);
      }
    } else {
      entries.push(entry);
    }
  }

  const toolCallCount = session.output.filter((e) => e.type === 'tool_call').length;
  const elapsedMs = Date.now() - session.createdAt;
  return { entries, toolCallCount, elapsedMs };
}
