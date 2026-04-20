/**
 * LLM tool schema + dispatch table.
 *
 * Each entry maps an Anthropic tool name to (a) the JSON schema the model
 * sees, and (b) the TS helper call. Arguments are validated at dispatch time
 * — we don't trust the model to obey the schema.
 */

import type { HlContext } from './context';
import * as H from './helpers';

export interface HlTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (ctx: HlContext, args: Record<string, unknown>) => Promise<unknown>;
}

function str(args: Record<string, unknown>, k: string): string {
  const v = args[k];
  if (typeof v !== 'string') throw new Error(`tool arg "${k}" must be a string`);
  return v;
}
function num(args: Record<string, unknown>, k: string): number {
  const v = args[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`tool arg "${k}" must be a number`);
  return v;
}
function optNum(args: Record<string, unknown>, k: string, dflt: number): number {
  const v = args[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function optStr(args: Record<string, unknown>, k: string, dflt: string): string {
  const v = args[k];
  return typeof v === 'string' ? v : dflt;
}

export const HL_TOOLS: HlTool[] = [
  {
    name: 'goto',
    description: 'Navigate the attached tab to the given URL (does not wait for load).',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: (ctx, a) => H.goto(ctx, str(a, 'url')),
  },
  {
    name: 'page_info',
    description: 'Get {url, title, w, h, sx, sy, pw, ph}: viewport + scroll + page-size.',
    input_schema: { type: 'object', properties: {} },
    run: (ctx) => H.pageInfo(ctx),
  },
  {
    name: 'click',
    description: 'Coordinate click at (x,y) in CSS px relative to viewport. Default interaction method — passes through iframes/shadow DOM.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, clicks: { type: 'number' } },
      required: ['x', 'y'],
    },
    run: (ctx, a) => H.click(ctx, num(a, 'x'), num(a, 'y'), optStr(a, 'button', 'left') as 'left' | 'right' | 'middle', optNum(a, 'clicks', 1)),
  },
  {
    name: 'type_text',
    description: 'Insert text at the current caret (no key events). Tab focus first via js() if needed. For React-controlled inputs use react_set_value.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (ctx, a) => H.typeText(ctx, str(a, 'text')),
  },
  {
    name: 'press_key',
    description: 'CDP key event: "Enter", "Tab", "ArrowDown", "Escape", single chars, etc. Modifiers bitfield: 1=Alt 2=Ctrl 4=Cmd 8=Shift.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, modifiers: { type: 'number' } },
      required: ['key'],
    },
    run: (ctx, a) => H.pressKey(ctx, str(a, 'key'), optNum(a, 'modifiers', 0)),
  },
  {
    name: 'dispatch_key',
    description: 'Dispatch a DOM KeyboardEvent on a selector. Use when CDP press_key does not trigger the listener (e.g. keypress for Enter on <input type=search>).',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, key: { type: 'string' }, event: { type: 'string' } },
      required: ['selector'],
    },
    run: (ctx, a) => H.dispatchKey(ctx, str(a, 'selector'), optStr(a, 'key', 'Enter'), optStr(a, 'event', 'keypress')),
  },
  {
    name: 'scroll',
    description: 'Mouse-wheel scroll at (x,y). dy<0 scrolls down. Used for virtual/scroll-wheel pickers (e.g. TikTok time picker) where dy=32 steps +1 unit.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' }, dx: { type: 'number' } },
      required: ['x', 'y'],
    },
    run: (ctx, a) => H.scroll(ctx, num(a, 'x'), num(a, 'y'), optNum(a, 'dy', -300), optNum(a, 'dx', 0)),
  },
  {
    name: 'js',
    description: 'Run a JS expression in the attached tab. Optional target_id to run inside a cross-origin iframe (from iframe_target).',
    input_schema: {
      type: 'object',
      properties: { expr: { type: 'string' }, target_id: { type: 'string' } },
      required: ['expr'],
    },
    run: (ctx, a) => H.js(ctx, str(a, 'expr'), (a.target_id as string | undefined) ?? null),
  },
  {
    name: 'react_set_value',
    description: 'Set a React-controlled input value via the native setter + dispatch "input"+"change". Use when type_text is overwritten by React.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, value: { type: 'string' } },
      required: ['selector', 'value'],
    },
    run: (ctx, a) => H.reactSetValue(ctx, str(a, 'selector'), str(a, 'value')),
  },
  {
    name: 'screenshot',
    description: 'Capture a PNG screenshot. full=true passes captureBeyondViewport. Returns byte length + a short preview only (LLM cannot reliably click from the image — use js+getBoundingClientRect for coords).',
    input_schema: { type: 'object', properties: { full: { type: 'boolean' } } },
    run: async (ctx, a) => {
      const r = await H.screenshot(ctx, undefined, a.full === true);
      return { bytes: r.data.length, preview: r.data.slice(0, 40) + '…' };
    },
  },
  {
    name: 'wait',
    description: 'Sleep for N seconds. Prefer wait_for_load; use wait only for truly fixed delays.',
    input_schema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
    run: (ctx, a) => H.wait(ctx, num(a, 'seconds')),
  },
  {
    name: 'wait_for_load',
    description: 'Poll document.readyState === "complete" up to timeout seconds (default 15).',
    input_schema: { type: 'object', properties: { timeout: { type: 'number' } } },
    run: (ctx, a) => H.waitForLoad(ctx, optNum(a, 'timeout', 15)),
  },
  {
    name: 'http_get',
    description: 'HTTP GET (no browser). Use for static pages / APIs — much faster than loading in a tab.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: (ctx, a) => H.httpGet(ctx, str(a, 'url')),
  },
  {
    name: 'list_tabs',
    description: 'List pages currently open. include_chrome=true to include chrome://, devtools://, about:blank etc.',
    input_schema: { type: 'object', properties: { include_chrome: { type: 'boolean' } } },
    run: (ctx, a) => H.listTabs(ctx, a.include_chrome === true),
  },
  {
    name: 'current_tab',
    description: 'Return {targetId, url, title} for the attached tab.',
    input_schema: { type: 'object', properties: {} },
    run: (ctx) => H.currentTab(ctx),
  },
  {
    name: 'switch_tab',
    description: 'Attach to another target (via targetId from list_tabs) and make it the current session.',
    input_schema: { type: 'object', properties: { target_id: { type: 'string' } }, required: ['target_id'] },
    run: (ctx, a) => H.switchTab(ctx, str(a, 'target_id')),
  },
  {
    name: 'new_tab',
    description: 'Open a new tab and attach. Returns the new targetId.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } } },
    run: (ctx, a) => H.newTab(ctx, optStr(a, 'url', 'about:blank')),
  },
  {
    name: 'ensure_real_tab',
    description: 'Switch to a real user tab if current is chrome:// / internal / stale. Returns {targetId, url, title} or null.',
    input_schema: { type: 'object', properties: {} },
    run: (ctx) => H.ensureRealTab(ctx),
  },
  {
    name: 'iframe_target',
    description: 'Find cross-origin iframe target whose URL contains substr. Returns targetId string or null; pass to js(expr, target_id=...).',
    input_schema: { type: 'object', properties: { substr: { type: 'string' } }, required: ['substr'] },
    run: (ctx, a) => H.iframeTarget(ctx, str(a, 'substr')),
  },
  {
    name: 'upload_file',
    description: 'Set files on <input type="file"> via CDP DOM.setFileInputFiles. paths is absolute filepath or list of filepaths.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        paths: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      },
      required: ['selector', 'paths'],
    },
    run: (ctx, a) => H.uploadFile(ctx, str(a, 'selector'), (a.paths as string | string[])),
  },
  {
    name: 'capture_dialogs',
    description: 'JS stub: replace window.alert/confirm/prompt so messages stash in window.__dialogs__. Call BEFORE the triggering action. Stubs are lost on navigation — re-call after goto.',
    input_schema: { type: 'object', properties: {} },
    run: (ctx) => H.captureDialogs(ctx),
  },
  {
    name: 'dialogs',
    description: 'Read the JS-stub dialog buffer. Returns list of dialog message strings since last capture_dialogs.',
    input_schema: { type: 'object', properties: {} },
    run: (ctx) => H.dialogs(ctx),
  },
  {
    name: 'drain_events',
    description: 'Flush the CDP event ring-buffer (max 500) and clear. Returns events in FIFO order.',
    input_schema: { type: 'object', properties: {} },
    run: async (ctx) => H.drainEvents(ctx),
  },
  {
    name: 'cdp',
    description: 'Escape hatch: raw CDP send. Use for methods not covered by a typed helper (e.g. Page.handleJavaScriptDialog). Returns the CDP result object.',
    input_schema: {
      type: 'object',
      properties: { method: { type: 'string' }, params: { type: 'object' } },
      required: ['method'],
    },
    run: (ctx, a) => H.cdp(ctx, str(a, 'method'), (a.params as Record<string, unknown>) ?? {}),
  },
  // ── Filesystem + Shell tools ──────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read a file from the local filesystem. Returns {path, content, size}. Large files are truncated at 256 KB.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (ctx, a) => H.readFile(ctx, str(a, 'path')),
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates parent dirs if needed). Returns {path, bytes}.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    run: (ctx, a) => H.writeFile(ctx, str(a, 'path'), str(a, 'content')),
  },
  {
    name: 'patch_file',
    description: 'Replace the first occurrence of old_str with new_str in a file. Returns {path, replaced: bool}.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } },
      required: ['path', 'old_str', 'new_str'],
    },
    run: (ctx, a) => H.patchFile(ctx, str(a, 'path'), str(a, 'old_str'), str(a, 'new_str')),
  },
  {
    name: 'list_dir',
    description: 'List directory entries. Returns {path, entries: [{name, type}]}.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (ctx, a) => H.listDir(ctx, str(a, 'path')),
  },
  {
    name: 'shell',
    description: 'Execute a shell command. Returns {exitCode, stdout, stderr}. Timeout: 30s. Optional cwd.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, cwd: { type: 'string' } },
      required: ['command'],
    },
    run: (ctx, a) => H.shellExec(ctx, str(a, 'command'), (a.cwd as string | undefined)),
  },
  {
    name: 'done',
    description: 'Call this when the task is complete. Pass a short user-facing summary of the outcome.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    run: async (_ctx, a) => ({ done: true, summary: str(a, 'summary') }),
  },
];

export const HL_TOOL_BY_NAME: Map<string, HlTool> = new Map(HL_TOOLS.map((t) => [t.name, t]));
