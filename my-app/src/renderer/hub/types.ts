export type SessionStatus = 'draft' | 'running' | 'stuck' | 'stopped' | 'idle';

export type HlEvent =
  | { type: 'thinking';    text: string }
  | { type: 'tool_call';   name: string; args: unknown; iteration: number }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done';        summary: string; iterations: number }
  | { type: 'error';       message: string }
  | { type: 'user_input';  text: string }
  | { type: 'skill_written'; path: string; domain: string; topic: string; bytes: number };

export interface AgentSession {
  id: string;
  prompt: string;
  status: SessionStatus;
  createdAt: number;
  output: HlEvent[];
  error?: string;
  group?: string;
}

export interface ToolResult {
  content: string;
  duration?: number;
  ok: boolean;
}

export interface OutputEntry {
  id: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'done' | 'error' | 'user_input' | 'skill_written';
  timestamp: number;
  content: string;
  tool?: string;
  duration?: number;
  result?: ToolResult;
  groupCount?: number;
  groupEntries?: OutputEntry[];
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
      return { id, type: 'skill_written', timestamp, content: `${event.domain}/${event.topic}`, tool: event.path };
  }
}

export function adaptSession(session: AgentSession): {
  entries: OutputEntry[];
  toolCallCount: number;
  elapsedMs: number;
} {
  const raw = session.output.map((e, i) => hlEventToOutputEntry(e, session.createdAt + i));

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
