/**
 * Translate structured HlEvents into ANSI-colored terminal bytes for xterm.js.
 *
 * Keeps the structured event pipeline intact (for the sidebar rail), while
 * producing a live, terminal-grade stream the xterm view can render with
 * colors, clickable paths, copy/paste, and scrollback.
 */
import type { HlEvent } from '../../shared/session-schemas';

// SGR constants. Kept short — xterm parses these natively.
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const FG = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightRed: '\x1b[91m',
};

function truncate(text: string, max: number): string {
  const clean = text.replace(/\r?\n/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function firstLine(text: string, max: number): string {
  const line = (text.split(/\r?\n/, 1)[0] ?? '').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stringifyArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  if (typeof args !== 'object') return String(args);
  const a = args as Record<string, unknown>;
  if (typeof a.preview === 'string' && a.preview.length > 0) return a.preview;
  if (typeof a.command === 'string') return a.command;
  if (typeof a.file_path === 'string') return a.file_path;
  if (typeof a.path === 'string') return a.path;
  if (typeof a.url === 'string') return a.url;
  try { return JSON.stringify(a); } catch { return ''; }
}

/**
 * State the translator keeps per session so consecutive `thinking` deltas
 * stream token-by-token on the same line, and the next non-thinking event
 * closes the run with a newline.
 */
export interface TermTranslatorState {
  inThinking: boolean;
}

export function createTermTranslatorState(): TermTranslatorState {
  return { inThinking: false };
}

/**
 * Convert one HlEvent into the terminal bytes that should follow. May return
 * '' for events we decide not to render (e.g. `done` is already visible via
 * the status badge).
 */
export function hlEventToTermBytes(event: HlEvent, state: TermTranslatorState): string {
  const out: string[] = [];

  // Close an active `thinking` run when any other event arrives.
  if (state.inThinking && event.type !== 'thinking') {
    out.push(RESET + '\r\n');
    state.inThinking = false;
  }

  switch (event.type) {
    case 'thinking': {
      const first = !state.inThinking;
      state.inThinking = true;
      if (first) out.push(DIM);
      // Thinking deltas may contain \n; convert to CRLF for correct line feeds in xterm.
      out.push(event.text.replace(/\r?\n/g, '\r\n'));
      return out.join('');
    }

    case 'user_input':
      out.push(`${BOLD}${FG.brightCyan}› ${event.text}${RESET}\r\n`);
      return out.join('');

    case 'tool_call': {
      const args = truncate(stringifyArgs(event.args), 160);
      out.push(`${FG.cyan}⏺ ${event.name}${RESET}`);
      if (args) out.push(` ${FG.grey}${args}${RESET}`);
      out.push('\r\n');
      return out.join('');
    }

    case 'tool_result': {
      const glyph = event.ok ? `${FG.green}✓` : `${FG.red}✗`;
      const preview = firstLine(event.preview || '', 160);
      out.push(`${glyph} ${event.name}${RESET}`);
      if (preview) out.push(` ${FG.grey}${preview}${RESET}`);
      if (event.ms > 0) out.push(` ${FG.grey}(${formatDurationMs(event.ms)})${RESET}`);
      out.push('\r\n');
      return out.join('');
    }

    case 'skill_written':
      out.push(`${FG.magenta}★ learned ${event.domain}/${event.topic}${RESET}\r\n`);
      return out.join('');

    case 'skill_used':
      out.push(`${FG.magenta}☆ skill ${event.domain ?? ''}${event.domain ? '/' : ''}${event.topic}${RESET}\r\n`);
      return out.join('');

    case 'harness_edited': {
      const verb = event.action === 'patch' ? 'patched' : 'updated';
      const target = event.target === 'helpers' ? 'helpers.js' : 'TOOLS.json';
      out.push(`${FG.yellow}✎ ${verb} harness ${target}${RESET}\r\n`);
      return out.join('');
    }

    case 'file_output':
      out.push(`${FG.yellow}⬇ ${event.name}${RESET} ${FG.grey}(${event.size} bytes)${RESET}\r\n`);
      return out.join('');

    case 'notify': {
      const color = event.level === 'blocking' ? FG.brightRed : FG.blue;
      out.push(`${color}! ${event.message}${RESET}\r\n`);
      return out.join('');
    }

    case 'done': {
      out.push(`${DIM}${FG.green}● done${RESET}`);
      // Print the summary below the done marker when it's a real message
      // (not the "(done)" placeholder used when an engine like Claude
      // already streamed its final text via `thinking` deltas). Plain
      // white (no color code) so long-form summaries read as body copy.
      const summary = event.summary?.trim();
      if (summary && summary !== '(done)') {
        const formatted = summary.replace(/\r?\n/g, '\r\n');
        out.push(`\r\n${formatted}`);
      }
      return out.join('');
    }

    case 'error':
      out.push(`${BOLD}${FG.brightRed}✗ ${event.message}${RESET}\r\n`);
      return out.join('');
  }

  return out.join('');
}

/** Translate a whole event history (for replay on rehydrate). */
export function eventsToTermBytes(events: HlEvent[]): string {
  const state = createTermTranslatorState();
  const parts: string[] = [];
  for (const e of events) parts.push(hlEventToTermBytes(e, state));
  if (state.inThinking) parts.push(RESET + '\r\n');
  return parts.join('');
}
