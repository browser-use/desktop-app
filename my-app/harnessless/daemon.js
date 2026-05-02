#!/usr/bin/env node
/**
 * Long-running CDP WebSocket holder + local IPC relay.
 *
 * Chrome 144+: reads ws URL from <profile>/DevToolsActivePort (written when user
 * enables chrome://inspect/#remote-debugging). Avoids the per-connect "Allow?"
 * dialog that the classic /json/version endpoint would trigger.
 *
 * 1-1 port of daemon.py.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const NAME = process.env.BU_NAME || 'default';
const SAFE_NAME = NAME.replace(/[^a-zA-Z0-9_.-]/g, '_');
const RUN_DIR = process.env.BU_RUN_DIR || os.tmpdir();
const SOCK = process.platform === 'win32'
  ? `\\\\.\\pipe\\browser-use-bh-${SAFE_NAME}`
  : path.join(RUN_DIR, `bh-${SAFE_NAME}.sock`);
const LOG = path.join(RUN_DIR, `bh-${SAFE_NAME}.log`);
const PID = path.join(RUN_DIR, `bh-${SAFE_NAME}.pid`);
const BUF = 500;

function chromeProfileCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
      path.join(localAppData, 'Chromium', 'User Data'),
    ];
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(configHome, 'google-chrome'),
    path.join(configHome, 'google-chrome-beta'),
    path.join(configHome, 'google-chrome-unstable'),
    path.join(configHome, 'chromium'),
  ];
}

const INTERNAL = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];

function log(msg) {
  fs.appendFileSync(LOG, msg + '\n');
}

function getWsUrl() {
  const override = process.env.BU_CDP_WS;
  if (override) return override;
  const profiles = chromeProfileCandidates();
  for (const base of profiles) {
    try {
      const raw = fs.readFileSync(path.join(base, 'DevToolsActivePort'), 'utf-8').trim();
      const [port, wsPath] = raw.split('\n', 2);
      return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch { continue; }
  }
  throw new Error(`DevToolsActivePort not found in ${JSON.stringify(profiles)} — enable chrome://inspect/#remote-debugging`);
}

function isRealPage(t) {
  return t.type === 'page' && !INTERNAL.some(p => (t.url || '').startsWith(p));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class CdpWs {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('close', () => log('ws closed'));
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result || {});
        } else if (msg.method && this.onEvent) {
          this.onEvent(msg.method, msg.params || {}, msg.sessionId || null);
        }
      });
    });
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
    });
  }

  close() { if (this.ws) this.ws.close(); }
}

class Daemon {
  constructor() {
    this.cdp = null;
    this.session = null;
    this.events = [];
  }

  async attachFirstPage() {
    const r = await this.cdp.send('Target.getTargets');
    const targets = r.targetInfos || [];
    let pages = targets.filter(isRealPage);
    if (!pages.length) pages = targets.filter(t => t.type === 'page');
    if (!pages.length) { this.session = null; return null; }

    const a = await this.cdp.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
    this.session = a.sessionId;
    log(`attached ${pages[0].targetId} (${(pages[0].url || '').slice(0, 80)}) session=${this.session}`);

    for (const d of ['Page', 'DOM', 'Runtime', 'Network']) {
      try { await this.cdp.send(`${d}.enable`, {}, this.session); }
      catch (e) { log(`enable ${d}: ${e.message}`); }
    }
    return pages[0];
  }

  async start() {
    const url = getWsUrl();
    log(`connecting to ${url}`);
    this.cdp = new CdpWs(url);

    for (let attempt = 0; attempt < 12; attempt++) {
      try { await this.cdp.connect(); break; }
      catch (e) {
        log(`ws handshake attempt ${attempt + 1} failed: ${e.message} — retrying`);
        this.cdp = new CdpWs(url);
        await sleep(5000);
        if (attempt === 11) throw new Error("CDP WS handshake never succeeded — did you accept Chrome's Allow dialog?");
      }
    }

    await this.attachFirstPage();

    this.cdp.onEvent = (method, params, sessionId) => {
      this.events.push({ method, params, session_id: sessionId });
      if (this.events.length > BUF) this.events.shift();
    };
  }

  async handle(req) {
    const meta = req.meta;
    if (meta === 'drain_events') { const out = this.events.slice(); this.events.length = 0; return { events: out }; }
    if (meta === 'session')      return { session_id: this.session };
    if (meta === 'set_session')  { this.session = req.session_id || null; return { session_id: this.session }; }
    if (meta === 'shutdown')     return { ok: true, _shutdown: true };

    const method = req.method;
    const params = req.params || {};
    const sid = method.startsWith('Target.') ? null : (req.session_id || this.session);

    try {
      return { result: await this.cdp.send(method, params, sid) };
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('Session with given id not found') && sid === this.session && sid) {
        log(`stale session ${sid}, re-attaching`);
        if (await this.attachFirstPage()) {
          return { result: await this.cdp.send(method, params, this.session) };
        }
      }
      return { error: msg };
    }
  }
}

function alreadyRunning() {
  return new Promise(resolve => {
    const s = net.createConnection(SOCK, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

async function serve(daemon) {
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCK); } catch {}
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      (async () => {
        try {
          const req = JSON.parse(line);
          const resp = await daemon.handle(req);
          conn.end(JSON.stringify(resp) + '\n');
          if (resp._shutdown) { server.close(); process.exit(0); }
        } catch (e) {
          log(`conn error: ${e.message}`);
          try { conn.end(JSON.stringify({ error: String(e) }) + '\n'); } catch {}
        }
      })();
    });
  });

  server.listen(SOCK, () => {
    if (process.platform !== 'win32') fs.chmodSync(SOCK, 0o600);
    log(`listening on ${SOCK}`);
  });
}

async function main() {
  if (await alreadyRunning()) {
    process.stderr.write(`daemon already running on ${SOCK}\n`);
    process.exit(0);
  }
  fs.writeFileSync(LOG, '');
  fs.writeFileSync(PID, String(process.pid));

  const d = new Daemon();
  await d.start();
  await serve(d);
}

main().catch(e => {
  log(`fatal: ${e.message}`);
  console.error(e.message);
  process.exit(1);
});

function cleanup() {
  try { fs.unlinkSync(PID); } catch {}
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCK); } catch {}
  }
}

process.on('exit', cleanup);

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
