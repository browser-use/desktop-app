/**
 * harnessless helpers — full TS port of helpers.py.
 *
 * INVARIANTS (preserved from upstream):
 *   • Each helper ≤15 lines, no classes — plain module-level functions.
 *   • Every helper takes `ctx: HlContext` as the first arg (replaces Python NAME).
 *   • Raw CDP via `cdp(ctx, method, params, sessionId?)` — no typed wrappers.
 *   • Coordinate clicks are the default interaction method (Input.dispatchMouseEvent).
 *   • Helpers are EDITABLE at runtime — the LLM can patch them.
 *   • `INTERNAL_URL_PREFIXES` is duplicated from context.ts intentionally.
 *
 * GOTCHAS (preserved verbatim from the upstream gotchas checklist):
 *   • Chrome 144+ does NOT serve /json/version on chrome://inspect — use DevToolsActivePort.
 *   • Daemon's default session goes stale if user closes the attached tab — ensureRealTab re-attaches.
 *   • Target.* CDP calls at browser level must NOT use a session (neither stale nor current).
 *   • React-controlled inputs ignore `el.value=...` — use the native setter + dispatch 'input'.
 *     See reactSetValue() below.
 *   • Radio/checkbox via React: prefer `el.click()` over `el.checked = true`.
 *   • UI-library dropdowns (MUI etc.): JS .click() on [role=button] often fails — use coord click.
 *   • CDP `char` event doesn't fire DOM keypress for specials (Enter/Tab) — use dispatchKey.
 *   • alert()/confirm() block the page JS thread — captureDialogs BEFORE the triggering action.
 *     Stubs are lost on navigation — must re-call captureDialogs after goto().
 *   • Same-origin nested iframes don't appear as CDP targets — walk contentDocument.
 *   • Cross-origin iframes DO appear as CDP targets — use iframeTarget() + js(expr, targetId).
 *   • Shadow DOM: querySelector does NOT pierce — walk element.shadowRoot recursively.
 *   • `wait(5)` after goto is fragile — use waitForLoad which polls document.readyState.
 *   • Screenshots render at ~half viewport width in LLM transcripts — don't eyeball coords.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { INTERNAL_URL_PREFIXES, type HlContext, type BufferedCdpEvent } from './context';

function skillsRoot(): string {
  return path.resolve(app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../..'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: cdp() + meta helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Raw CDP. Browser-level Target.* calls go sessionless; everything else uses ctx.session. */
export async function cdp(ctx: HlContext, method: string, params: Record<string, unknown> = {}, sessionId?: string | null): Promise<unknown> {
  const sid = method.startsWith('Target.') ? null : (sessionId !== undefined ? sessionId : ctx.session);
  return ctx.cdp.send(method, params, sid ?? null);
}

/** Flush the event buffer. Matches daemon.py meta="drain_events". */
export function drainEvents(ctx: HlContext): BufferedCdpEvent[] {
  const out = ctx.events.slice();
  ctx.events.length = 0;
  return out;
}

export function getSession(ctx: HlContext): string | null { return ctx.session; }
export function setSession(ctx: HlContext, s: string | null): void { ctx.session = s; }

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

/** Navigate the attached tab. Does NOT wait for load — call waitForLoad after. Returns domain_skills if any exist for the hostname. */
export async function goto(ctx: HlContext, url: string): Promise<unknown> {
  const r = await cdp(ctx, 'Page.navigate', { url });
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    const skillDir = path.join(skillsRoot(), 'domain-skills', hostname);
    const stat = await fs.stat(skillDir).catch(() => null);
    if (stat?.isDirectory()) {
      const files = await fs.readdir(skillDir);
      const skills = files.filter((f) => f.endsWith('.md')).slice(0, 10);
      return { ...(r as object), domain_skills: skills };
    }
  } catch { /* no skills for this domain */ }
  return r;
}

/** Full viewport+scroll+page info. If a native dialog is open, returns {dialog: {...}} instead — the JS thread is frozen until handled. */
export async function pageInfo(ctx: HlContext): Promise<Record<string, unknown>> {
  const pendingDialog = ctx.events.find((e) => e.method === 'Page.javascriptDialogOpening');
  if (pendingDialog) {
    return { dialog: pendingDialog.params };
  }
  const expr = 'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})';
  const r = (await cdp(ctx, 'Runtime.evaluate', { expression: expr, returnByValue: true })) as { result: { value: string } };
  return JSON.parse(r.result.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/** Coordinate click — passes through iframes/shadow at the compositor level. */
export async function click(ctx: HlContext, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clicks = 1): Promise<void> {
  await cdp(ctx, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: clicks });
  await cdp(ctx, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: clicks });
}

/** Insert text at the current caret (no key events). For React-controlled inputs, see reactSetValue. */
export async function typeText(ctx: HlContext, text: string): Promise<void> {
  await cdp(ctx, 'Input.insertText', { text });
}

// _KEYS mirror — key → [windowsVirtualKeyCode, code, text]
const _KEYS: Record<string, [number, string, string]> = {
  'Enter': [13, 'Enter', '\r'], 'Tab': [9, 'Tab', '\t'], 'Backspace': [8, 'Backspace', ''],
  'Escape': [27, 'Escape', ''], 'Delete': [46, 'Delete', ''], ' ': [32, 'Space', ' '],
  'ArrowLeft': [37, 'ArrowLeft', ''], 'ArrowUp': [38, 'ArrowUp', ''],
  'ArrowRight': [39, 'ArrowRight', ''], 'ArrowDown': [40, 'ArrowDown', ''],
  'Home': [36, 'Home', ''], 'End': [35, 'End', ''],
  'PageUp': [33, 'PageUp', ''], 'PageDown': [34, 'PageDown', ''],
};

/** CDP keypress with virtual key codes. Modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift. */
export async function pressKey(ctx: HlContext, key: string, modifiers = 0): Promise<void> {
  const [vk, code, text] = _KEYS[key] ?? [key.length === 1 ? key.charCodeAt(0) : 0, key, key.length === 1 ? key : ''];
  const base: Record<string, unknown> = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp(ctx, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  if (text && text.length === 1) await cdp(ctx, 'Input.dispatchKeyEvent', { type: 'char', text, ...base });
  await cdp(ctx, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Mouse wheel scroll. dy < 0 scrolls down in CDP convention (upstream default is dy=-300). */
export async function scroll(ctx: HlContext, x: number, y: number, dy = -300, dx = 0): Promise<void> {
  await cdp(ctx, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual
// ─────────────────────────────────────────────────────────────────────────────

/** Capture PNG. `full=true` passes captureBeyondViewport for full-page. */
export async function screenshot(ctx: HlContext, outPath?: string, full = false): Promise<{ data: string; path?: string }> {
  const r = (await cdp(ctx, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: full })) as { data: string };
  if (outPath) { await fs.writeFile(outPath, Buffer.from(r.data, 'base64')); return { data: r.data, path: outPath }; }
  return { data: r.data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs (CDP-level; for in-process Electron the WebContents debugger scope limits these)
// ─────────────────────────────────────────────────────────────────────────────

export interface TabInfo { targetId: string; title: string; url: string }

function isWebContents(ctx: HlContext): boolean {
  return ctx.cdp.transport === 'webcontents';
}

async function webContentsTabInfo(ctx: HlContext): Promise<TabInfo> {
  try {
    const info = await Promise.race([
      pageInfo(ctx),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return { targetId: 'webcontents', title: String(info.title ?? ''), url: String(info.url ?? '') };
  } catch {
    return { targetId: 'webcontents', title: '', url: 'about:blank' };
  }
}

export async function listTabs(ctx: HlContext, includeChrome = false): Promise<TabInfo[]> {
  if (isWebContents(ctx)) return [{ targetId: 'webcontents', title: 'active', url: 'webcontents' }];
  const r = (await cdp(ctx, 'Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }> };
  const out: TabInfo[] = [];
  for (const t of r.targetInfos) {
    if (t.type !== 'page') continue;
    const url = t.url ?? '';
    if (!includeChrome && INTERNAL_URL_PREFIXES.some((p) => url.startsWith(p))) continue;
    out.push({ targetId: t.targetId, title: t.title ?? '', url });
  }
  return out;
}

export async function currentTab(ctx: HlContext): Promise<TabInfo> {
  if (isWebContents(ctx)) return { targetId: 'webcontents', title: 'active', url: 'webcontents' };
  const r = (await cdp(ctx, 'Target.getTargetInfo')) as { targetInfo?: { targetId: string; url?: string; title?: string } };
  const t = r.targetInfo ?? { targetId: '', url: '', title: '' };
  return { targetId: t.targetId ?? '', title: t.title ?? '', url: t.url ?? '' };
}

export async function switchTab(ctx: HlContext, targetId: string): Promise<string> {
  if (isWebContents(ctx)) return 'webcontents';
  try { await cdp(ctx, 'Runtime.evaluate', { expression: "if(document.title.startsWith('\\u{1F7E2} '))document.title=document.title.slice(2)" }); } catch { /* old tab gone */ }
  try {
    await Promise.race([
      cdp(ctx, 'Target.activateTarget', { targetId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('activateTarget timeout')), 2000)),
    ]);
  } catch { /* not supported or timed out */ }
  const r = (await cdp(ctx, 'Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
  setSession(ctx, r.sessionId);
  try { await cdp(ctx, 'Runtime.evaluate', { expression: "if(!document.title.startsWith('\\u{1F7E2}'))document.title='\\u{1F7E2} '+document.title" }); } catch { /* e.g. about:blank */ }
  return r.sessionId;
}

export async function newTab(ctx: HlContext, url = 'about:blank'): Promise<string> {
  if (isWebContents(ctx)) {
    if (url !== 'about:blank') await goto(ctx, url);
    return 'webcontents';
  }
  const r = (await cdp(ctx, 'Target.createTarget', { url: 'about:blank' })) as { targetId: string };
  await switchTab(ctx, r.targetId);
  if (url !== 'about:blank') await goto(ctx, url);
  return r.targetId;
}

export async function ensureRealTab(ctx: HlContext): Promise<TabInfo | null> {
  if (isWebContents(ctx)) return { targetId: 'webcontents', title: 'active', url: 'webcontents' };
  const tabs = await listTabs(ctx);
  if (tabs.length === 0) return null;
  try {
    const cur = await currentTab(ctx);
    if (cur.url && !INTERNAL_URL_PREFIXES.some((p) => cur.url.startsWith(p))) return cur;
  } catch { /* fall through to switch */ }
  await switchTab(ctx, tabs[0].targetId);
  return tabs[0];
}

export async function iframeTarget(ctx: HlContext, urlSubstr: string): Promise<string | null> {
  if (isWebContents(ctx)) return null;
  const r = (await cdp(ctx, 'Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; url?: string }> };
  const t = r.targetInfos.find((i) => i.type === 'iframe' && (i.url ?? '').includes(urlSubstr));
  return t ? t.targetId : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

export async function wait(_ctx: HlContext, seconds = 1.0): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
}

/** Poll document.readyState === 'complete' with 300ms interval, up to timeout seconds. */
export async function waitForLoad(ctx: HlContext, timeoutSec = 15.0): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if ((await js(ctx, "document.readyState")) === 'complete') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Run JS in the attached tab (default) or inside an iframe target (via iframeTarget()). */
export async function js(ctx: HlContext, expression: string, targetId?: string | null): Promise<unknown> {
  let sid: string | null = null;
  if (targetId) {
    const a = (await cdp(ctx, 'Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    sid = a.sessionId;
  }
  const r = (await cdp(ctx, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)) as
    { result?: { value: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

// _KC mirror for dispatchKey (DOM KeyboardEvent)
const _KC: Record<string, number> = {
  'Enter': 13, 'Tab': 9, 'Escape': 27, 'Backspace': 8, ' ': 32,
  'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,
};

/**
 * Dispatch a DOM KeyboardEvent on the selector. Use when CDP pressKey doesn't
 * trigger the listener — e.g. `keypress` for Enter on <input type=search>
 * (CDP's `char` event quirk for specials).
 */
export async function dispatchKey(ctx: HlContext, selector: string, key = 'Enter', event = 'keypress'): Promise<void> {
  const kc = _KC[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0);
  const sel = JSON.stringify(selector); const ek = JSON.stringify(key); const ev = JSON.stringify(event);
  await js(ctx, `(()=>{const e=document.querySelector(${sel});if(e){e.focus();e.dispatchEvent(new KeyboardEvent(${ev},{key:${ek},code:${ek},keyCode:${kc},which:${kc},bubbles:true}));}})()`);
}

/** Set files on <input type="file"> via CDP. `paths` is one or more absolute filepaths. */
export async function uploadFile(ctx: HlContext, selector: string, paths: string | string[]): Promise<void> {
  const doc = (await cdp(ctx, 'DOM.getDocument', { depth: -1 })) as { root: { nodeId: number } };
  const q = (await cdp(ctx, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector })) as { nodeId: number };
  if (!q.nodeId) throw new Error(`no element for ${selector}`);
  const files = Array.isArray(paths) ? paths : [paths];
  await cdp(ctx, 'DOM.setFileInputFiles', { files, nodeId: q.nodeId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialogs (JS stub — matches helpers.py; see skills/dialogs.md for CDP approach)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub window.alert/confirm/prompt so messages stash in window.__dialogs__.
 * Call BEFORE the triggering action; read via dialogs() after. Stubs are lost
 * on page navigation — must re-call captureDialogs() after goto().
 */
export async function captureDialogs(ctx: HlContext): Promise<void> {
  await js(ctx, "window.__dialogs__=[];window.alert=m=>window.__dialogs__.push(String(m));window.confirm=m=>{window.__dialogs__.push(String(m));return true;};window.prompt=(m,d)=>{window.__dialogs__.push(String(m));return d||''}");
}

export async function dialogs(ctx: HlContext): Promise<string[]> {
  const raw = (await js(ctx, "JSON.stringify(window.__dialogs__||[])")) as string | null;
  return JSON.parse(raw || '[]');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP (no browser)
// ─────────────────────────────────────────────────────────────────────────────

/** Pure HTTP — no browser. Use for static pages / APIs. */
export async function httpGet(_ctx: HlContext, url: string, headers?: Record<string, string>, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const h: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip', ...(headers ?? {}) };
  try {
    const r = await fetch(url, { headers: h, signal: ctl.signal });
    return { status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
}

// ─────────────────────────────────────────────────────────────────────────────
// React-aware value setter (addition, not a port — addresses the React gotcha)
// Distinct from dropped `type_in` helper; this only sets .value + dispatches input.
// ─────────────────────────────────────────────────────────────────────────────

/** Set a React-controlled input's value via the native setter + input event. */
export async function reactSetValue(ctx: HlContext, selector: string, value: string): Promise<void> {
  const sel = JSON.stringify(selector); const v = JSON.stringify(value);
  await js(ctx, `(()=>{const el=document.querySelector(${sel});if(!el)throw new Error('no element for '+${sel});const d=Object.getOwnPropertyDescriptor(el.__proto__,'value');if(d&&d.set){d.set.call(el,${v});}else{el.value=${v};}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem + Shell — local machine access for self-editing harness
// ─────────────────────────────────────────────────────────────────────────────

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);

const MAX_READ_BYTES = 256 * 1024; // 256 KB
const MAX_EXEC_TIMEOUT = 30_000;   // 30 seconds
const MAX_OUTPUT_CHARS = 64_000;   // truncate shell output

export async function readFile(_ctx: HlContext, filePath: string): Promise<{ path: string; content: string; size: number }> {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (stat.size > MAX_READ_BYTES) {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const fh = await fs.open(resolved, 'r');
    await fh.read(buf, 0, MAX_READ_BYTES, 0);
    await fh.close();
    return { path: resolved, content: buf.toString('utf-8') + `\n…[truncated at ${MAX_READ_BYTES} bytes, total ${stat.size}]`, size: stat.size };
  }
  const content = await fs.readFile(resolved, 'utf-8');
  return { path: resolved, content, size: stat.size };
}

export async function writeFile(_ctx: HlContext, filePath: string, content: string): Promise<{ path: string; bytes: number }> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf-8');
  return { path: resolved, bytes: Buffer.byteLength(content, 'utf-8') };
}

export async function listDir(_ctx: HlContext, dirPath: string): Promise<{ path: string; entries: Array<{ name: string; type: string }> }> {
  const resolved = path.resolve(dirPath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return {
    path: resolved,
    entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other' })),
  };
}

export async function shellExec(_ctx: HlContext, command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const opts = { timeout: MAX_EXEC_TIMEOUT, maxBuffer: 10 * 1024 * 1024, cwd: cwd ? path.resolve(cwd) : undefined };
  try {
    const { stdout, stderr } = await execAsync(command, opts);
    const out = stdout.length > MAX_OUTPUT_CHARS ? stdout.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]' : stdout;
    const err = stderr.length > MAX_OUTPUT_CHARS ? stderr.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]' : stderr;
    return { exitCode: 0, stdout: out, stderr: err };
  } catch (e: any) {
    return { exitCode: e.code ?? 1, stdout: (e.stdout ?? '').slice(0, MAX_OUTPUT_CHARS), stderr: (e.stderr ?? e.message ?? '').slice(0, MAX_OUTPUT_CHARS) };
  }
}

export async function patchFile(_ctx: HlContext, filePath: string, oldStr: string, newStr: string): Promise<{ path: string; replaced: boolean }> {
  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, 'utf-8');
  if (!content.includes(oldStr)) return { path: resolved, replaced: false };
  await fs.writeFile(resolved, content.replace(oldStr, newStr), 'utf-8');
  return { path: resolved, replaced: true };
}
