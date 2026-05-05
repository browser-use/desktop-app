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
// Subtle slate background for user_input rows. Paired with `\x1b[K` to fill
// the rest of the row with the same bg so the highlight reads as a banded row
// rather than a colored span behind text.
const BG_USER_INPUT = '\x1b[48;2;28;38;52m';
const ERASE_EOL = '\x1b[K';
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
  /** Has anything been emitted yet? Used to skip the leading newline on
   *  the first user_input so the initial prompt doesn't start on a blank
   *  row. */
  hasEmitted: boolean;
  /** When the most recent tool_call targeted a domain-skills file, we
   *  suppressed its row in favor of the synthetic skill_used / skill_written
   *  event. Stash the tool name so we can also suppress the matching
   *  tool_result row that follows. */
  pendingSkillToolName: string | null;
}

export function createTermTranslatorState(): TermTranslatorState {
  return { inThinking: false, hasEmitted: false, pendingSkillToolName: null };
}

const SKILL_PATH_RE = /(?:domain-skills|interaction-skills)\/[^/]+\/[^/]+\.md$/;

function extractSkillPath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const candidates = [a.file_path, a.path, a.target_file];
  for (const c of candidates) {
    if (typeof c === 'string' && SKILL_PATH_RE.test(c)) return c;
  }
  return null;
}

/**
 * Convert one HlEvent into the terminal bytes that should follow. May return
 * '' for events we decide not to render (e.g. `done` is already visible via
 * the status badge).
 */
export function hlEventToTermBytes(event: HlEvent, state: TermTranslatorState): string {
  const out: string[] = [];
  // Mark state.hasEmitted true whenever we actually produce bytes, so the
  // next user_input knows whether a leading newline is needed. Cases use
  // `return finish()` in place of `return out.join('')`.
  const finish = (): string => {
    const result = out.join('');
    if (result) state.hasEmitted = true;
    return result;
  };

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
      return finish();
    }

    case 'user_input': {
      // Follow-up prompts need a leading newline so they start on their
      // own line — previous events (`done`, summaries) suppress their
      // trailing newline to avoid a blank row. But the very first prompt
      // is the top of the stream; a leading newline there would leave an
      // empty first row.
      const leading = state.hasEmitted ? '\r\n' : '';
      // Order matters: BG before FG/BOLD; ERASE_EOL after the text fills the
      // rest of the row with the bg color; RESET clears all SGR before the
      // trailing CRLF so the next row starts on a clean slate.
      // White (rather than brightCyan) reads more naturally against the slate
      // bg highlight — the cyan-on-blue contrast looked like a syntax error.
      const FG_WHITE = '\x1b[38;2;230;234;238m';
      // Multi-line prompts: re-apply the bg + ERASE_EOL on every line so the
      // highlight reads as a banded block. First line gets the `›` prefix;
      // continuation lines get a 2-space indent so wrapped prose aligns under
      // the prompt text.
      const lines = event.text.split(/\r?\n/);
      const formatted = lines
        .map((line, i) => {
          const prefix = i === 0 ? '› ' : '  ';
          return `${BG_USER_INPUT}${BOLD}${FG_WHITE}${prefix}${line}${ERASE_EOL}${RESET}`;
        })
        .join('\r\n');
      out.push(`${leading}${formatted}\r\n`);
      return finish();
    }

    case 'tool_call': {
      // Suppress reads/writes of domain-skills files — the synthetic
      // skill_used / skill_written event renders a cleaner labeled row.
      // Stash the tool name so we also drop the matching tool_result.
      if (extractSkillPath(event.args)) {
        state.pendingSkillToolName = event.name;
        return finish();
      }
      state.pendingSkillToolName = null;
      const args = truncate(stringifyArgs(event.args), 160);
      out.push(`${FG.cyan}⏺ ${event.name}${RESET}`);
      if (args) out.push(` ${FG.grey}${args}${RESET}`);
      out.push('\r\n');
      return finish();
    }

    case 'tool_result': {
      // Drop the result row paired with a suppressed skill tool_call.
      if (state.pendingSkillToolName === event.name) {
        state.pendingSkillToolName = null;
        return finish();
      }
      const glyph = event.ok ? `${FG.green}✓` : `${FG.red}✗`;
      const preview = firstLine(event.preview || '', 160);
      out.push(`${glyph} ${event.name}${RESET}`);
      if (preview) out.push(` ${FG.grey}${preview}${RESET}`);
      if (event.ms > 0) out.push(` ${FG.grey}(${formatDurationMs(event.ms)})${RESET}`);
      out.push('\r\n');
      return finish();
    }

    case 'skill_written': {
      const verb = event.action === 'patch' ? 'Edited skill' : 'Wrote skill';
      out.push(`${FG.magenta}★ ${verb} ${event.domain}/${event.topic}${RESET}\r\n`);
      return finish();
    }

    case 'skill_used':
      out.push(`${FG.magenta}★ Read skill ${event.domain ?? ''}${event.domain ? '/' : ''}${event.topic}${RESET}\r\n`);
      return finish();

    case 'harness_edited': {
      const verb = event.action === 'patch' ? 'patched' : 'updated';
      const target = event.target === 'helpers' ? 'helpers.js' : 'TOOLS.json';
      out.push(`${FG.yellow}✎ ${verb} harness ${target}${RESET}\r\n`);
      return finish();
    }

    case 'file_output':
      out.push(`${FG.yellow}⬇ ${event.name}${RESET} ${FG.grey}(${event.size} bytes)${RESET}\r\n`);
      return finish();

    case 'notify': {
      const color = event.level === 'blocking' ? FG.brightRed : FG.blue;
      out.push(`${color}! ${event.message}${RESET}\r\n`);
      return finish();
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
      return finish();
    }

    case 'error':
      out.push(`${BOLD}${FG.brightRed}✗ ${event.message}${RESET}\r\n`);
      return finish();

    case 'turn_usage':
      // Cost telemetry — rolled up into the session header; no terminal row.
      return finish();
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
