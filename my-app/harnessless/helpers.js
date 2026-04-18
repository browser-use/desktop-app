/**
 * Browser control via CDP. Read, edit, extend — this file is yours.
 *
 * 1-1 port of helpers.py. Every function is async (JS has no sync sockets).
 * The agent writes: await goto("https://example.com")
 */

const net = require('net');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const path = require('path');

const NAME = process.env.BU_NAME || 'default';
const SOCK = `/tmp/bh-${NAME}.sock`;
const PID = `/tmp/bh-${NAME}.pid`;
const INTERNAL = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];

function _send(req) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK, () => {
      client.write(JSON.stringify(req) + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => {
      try {
        const r = JSON.parse(data);
        if (r.error) reject(new Error(r.error));
        else resolve(r);
      } catch (e) { reject(e); }
    });
    client.on('error', reject);
  });
}

async function cdp(method, params = {}, session_id = undefined) {
  const req = { method, params };
  if (session_id !== undefined) req.session_id = session_id;
  const r = await _send(req);
  return r.result || {};
}

async function drain_events()   { return (await _send({ meta: 'drain_events' })).events; }
async function get_session()    { return (await _send({ meta: 'session' })).session_id; }
async function set_session(s)   { return _send({ meta: 'set_session', session_id: s }); }
async function shutdown()       { return _send({ meta: 'shutdown' }); }
// --- daemon lifecycle (socket IS the lock) ---

function daemon_alive() {
  return new Promise(resolve => {
    const s = net.createConnection(SOCK, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

async function ensure_daemon(wait = 60.0) {
  if (await daemon_alive()) return;
  const here = path.dirname(path.resolve(__filename));
  spawn('node', [path.join(here, 'daemon.js')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  }).unref();

  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    if (await daemon_alive()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`daemon didn't come up — check /tmp/bh-${NAME}.log`);
}

async function kill_daemon() {
  try { await shutdown(); } catch {}
  try {
    const pid = parseInt(fs.readFileSync(PID, 'utf-8'));
    process.kill(pid, 'SIGTERM');
  } catch {}
  for (const f of [SOCK, PID]) {
    try { fs.unlinkSync(f); } catch {}
  }
}
// --- navigation / page ---

async function goto(url) { return cdp('Page.navigate', { url }); }

async function page_info() {
  const r = await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})',
    returnByValue: true,
  });
  return JSON.parse(r.result.value);
}
// --- input ---

async function click(x, y, button = 'left', clicks = 1) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: clicks });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: clicks });
}

async function type_text(text) {
  await cdp('Input.insertText', { text });
}

const _KEYS = {
  'Enter': [13, 'Enter', '\r'], 'Tab': [9, 'Tab', '\t'], 'Backspace': [8, 'Backspace', ''],
  'Escape': [27, 'Escape', ''], 'Delete': [46, 'Delete', ''], ' ': [32, 'Space', ' '],
  'ArrowLeft': [37, 'ArrowLeft', ''], 'ArrowUp': [38, 'ArrowUp', ''],
  'ArrowRight': [39, 'ArrowRight', ''], 'ArrowDown': [40, 'ArrowDown', ''],
  'Home': [36, 'Home', ''], 'End': [35, 'End', ''],
  'PageUp': [33, 'PageUp', ''], 'PageDown': [34, 'PageDown', ''],
};

async function press_key(key, modifiers = 0) {
  const [vk, code, text] = _KEYS[key] || [key.length === 1 ? key.charCodeAt(0) : 0, key, key.length === 1 ? key : ''];
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  if (text && text.length === 1) await cdp('Input.dispatchKeyEvent', { type: 'char', text, ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function scroll(x, y, dy = -300, dx = 0) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
}
// --- visual ---

async function screenshot(filepath = '/tmp/shot.png', full = false) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(filepath, Buffer.from(r.data, 'base64'));
  return filepath;
}
// --- tabs ---

async function list_tabs(include_chrome = false) {
  const out = [];
  const r = await cdp('Target.getTargets');
  for (const t of (r.targetInfos || [])) {
    if (t.type !== 'page') continue;
    const url = t.url || '';
    if (!include_chrome && INTERNAL.some(p => url.startsWith(p))) continue;
    out.push({ targetId: t.targetId, title: t.title || '', url });
  }
  return out;
}

async function current_tab() {
  const t = (await cdp('Target.getTargetInfo')).targetInfo || {};
  return { targetId: t.targetId, url: t.url || '', title: t.title || '' };
}

async function switch_tab(target_id) {
  const sid = (await cdp('Target.attachToTarget', { targetId: target_id, flatten: true })).sessionId;
  await set_session(sid);
  return sid;
}

async function new_tab(url = 'about:blank') {
  const tid = (await cdp('Target.createTarget', { url })).targetId;
  await switch_tab(tid);
  return tid;
}

async function ensure_real_tab() {
  const tabs = await list_tabs();
  if (!tabs.length) return null;
  try {
    const cur = await current_tab();
    if (cur.url && !INTERNAL.some(p => cur.url.startsWith(p))) return cur;
  } catch {}
  await switch_tab(tabs[0].targetId);
  return tabs[0];
}

async function iframe_target(url_substr) {
  const r = await cdp('Target.getTargets');
  const t = (r.targetInfos || []).find(i => i.type === 'iframe' && (i.url || '').includes(url_substr));
  return t ? t.targetId : null;
}
// --- utility ---

async function wait(seconds = 1.0) {
  return new Promise(r => setTimeout(r, Math.max(0, seconds) * 1000));
}

async function wait_for_load(timeout = 15.0) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if ((await js('document.readyState')) === 'complete') return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function js(expression, target_id = null) {
  let sid = null;
  if (target_id) {
    const a = await cdp('Target.attachToTarget', { targetId: target_id, flatten: true });
    sid = a.sessionId;
  }
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

const _KC = { 'Enter': 13, 'Tab': 9, 'Escape': 27, 'Backspace': 8, ' ': 32, 'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40 };

async function dispatch_key(selector, key = 'Enter', event = 'keypress') {
  const kc = _KC[key] || (key.length === 1 ? key.charCodeAt(0) : 0);
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e){e.focus();e.dispatchEvent(new KeyboardEvent(${JSON.stringify(event)},{key:${JSON.stringify(key)},code:${JSON.stringify(key)},keyCode:${kc},which:${kc},bubbles:true}));}})()`);
}

async function upload_file(selector, filepath) {
  const doc = await cdp('DOM.getDocument', { depth: -1 });
  const q = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) throw new Error(`no element for ${selector}`);
  const files = Array.isArray(filepath) ? filepath : [filepath];
  await cdp('DOM.setFileInputFiles', { files, nodeId: q.nodeId });
}

async function capture_dialogs() {
  await js("window.__dialogs__=[];window.alert=m=>window.__dialogs__.push(String(m));window.confirm=m=>{window.__dialogs__.push(String(m));return true;};window.prompt=(m,d)=>{window.__dialogs__.push(String(m));return d||''}");
}

async function dialogs() {
  const raw = await js("JSON.stringify(window.__dialogs__||[])");
  return JSON.parse(raw || '[]');
}

async function http_get(url, headers = null, timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const h = { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip', ...(headers || {}) };
  try {
    const r = await fetch(url, { headers: h, signal: ctl.signal });
    return { status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
}
// --- exports (all functions available via `from helpers import *` equivalent) ---

module.exports = {
  cdp, drain_events, get_session, set_session, shutdown,
  daemon_alive, ensure_daemon, kill_daemon,
  goto, page_info,
  click, type_text, press_key, scroll,
  screenshot,
  list_tabs, current_tab, switch_tab, new_tab, ensure_real_tab, iframe_target,
  wait, wait_for_load, js, dispatch_key, upload_file,
  capture_dialogs, dialogs, http_get,
  SOCK, PID, NAME, INTERNAL,
};
