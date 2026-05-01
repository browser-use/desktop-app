import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import { PNG } from 'pngjs';
import WebSocket from 'ws';
import { browserLogger } from '../logger';

const GIF_FPS = 8;
const GIF_MAX_SECONDS = 8;
const CAPTURE_INTERVAL_MS = Math.round(1000 / GIF_FPS);
const MAX_FRAMES = GIF_FPS * GIF_MAX_SECONDS;

interface CapturedFrame {
  pixels: Uint8Array;
  timestamp: number;
  meta: CaptureMeta;
}

interface Recording {
  sessionId: string;
  webContents: WebContents;
  cdpPort: number;
  timer: ReturnType<typeof setInterval>;
  frames: CapturedFrame[];
  width: number;
  height: number;
  capturing: boolean;
  attempts: number;
  captured: number;
  skipped: number;
  lastUrl: string;
  diagnosticDir?: string;
  remote?: RemotePageCdp;
  finishing?: Promise<GifOutput>;
}

export interface GifOutput {
  name: string;
  path: string;
  size: number;
  mime: 'image/gif';
}

interface GifFrame {
  pixels: Uint8Array;
  delayCs: number;
}

interface CaptureMeta {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
  bytes: number;
  blankRatio: number;
  darkRatio: number;
  mode: string;
}

export class BrowserGifRecorder {
  private recordings = new Map<string, Recording>();
  private finished = new Map<string, GifOutput>();

  start(sessionId: string, webContents: WebContents, cdpPort: number): void {
    this.stop(sessionId);
    this.finished.delete(sessionId);
    const rec: Recording = {
      sessionId,
      webContents,
      cdpPort,
      timer: setInterval(() => void this.capture(rec), CAPTURE_INTERVAL_MS),
      frames: [],
      width: 0,
      height: 0,
      capturing: false,
      attempts: 0,
      captured: 0,
      skipped: 0,
      lastUrl: '',
      diagnosticDir: undefined,
    };
    rec.timer.unref();
    this.recordings.set(sessionId, rec);
    void this.capture(rec);
    browserLogger.info('GifRecorder.start', {
      sessionId,
      capture: 'remote-cdp.Page.captureScreenshot',
      cdpPort,
      fps: GIF_FPS,
      dimensions: 'native-viewport',
      maxFrames: MAX_FRAMES,
    });
  }

  stop(sessionId: string): void {
    const rec = this.recordings.get(sessionId);
    if (!rec) return;
    clearInterval(rec.timer);
    this.recordings.delete(sessionId);
    rec.remote?.close();
    browserLogger.info('GifRecorder.stop', {
      sessionId,
      frames: rec.frames.length,
      attempts: rec.attempts,
      captured: rec.captured,
      skipped: rec.skipped,
      lastUrl: rec.lastUrl,
    });
  }

  async finishToFile(sessionId: string, outputsDir: string): Promise<GifOutput> {
    const rec = this.recordings.get(sessionId);
    if (!rec) {
      const output = this.finished.get(sessionId);
      if (output) return output;
      throw new Error('No GIF recording is available for this session');
    }
    if (rec.finishing) return rec.finishing;

    rec.finishing = (async () => {
      clearInterval(rec.timer);
      rec.diagnosticDir = outputsDir;
      await waitForCaptureIdle(rec);
      await this.capture(rec);
      await waitForCaptureIdle(rec);
      if (rec.frames.length === 0 || rec.width <= 0 || rec.height <= 0) {
        this.recordings.delete(sessionId);
        throw new Error('No browser frames were captured for this session');
      }

      const buffer = encodeGif(rec.width, rec.height, buildGifFrames(rec.frames, 1));
      fs.mkdirSync(outputsDir, { recursive: true });
      const name = `agent-run-${new Date().toISOString().replace(/[:.]/g, '-')}.gif`;
      const filePath = path.join(outputsDir, name);
      fs.writeFileSync(filePath, buffer);
      this.recordings.delete(sessionId);
      const output = { name, path: filePath, size: buffer.byteLength, mime: 'image/gif' as const };
      this.finished.set(sessionId, output);
      rec.remote?.close();
      browserLogger.info('GifRecorder.finish', {
        sessionId,
        path: filePath,
        bytes: buffer.byteLength,
        frames: rec.frames.length,
        dimensions: `${rec.width}x${rec.height}`,
        attempts: rec.attempts,
        captured: rec.captured,
        skipped: rec.skipped,
        lastUrl: rec.lastUrl,
        firstFrame: summarizeFrame(rec.frames[0]),
        lastFrame: summarizeFrame(rec.frames[rec.frames.length - 1]),
      });
      return output;
    })();

    return rec.finishing;
  }

  private async capture(rec: Recording): Promise<void> {
    if (rec.capturing || rec.webContents.isDestroyed()) return;
    rec.capturing = true;
    rec.attempts += 1;
    try {
      const { png, meta } = await captureViewportPng(rec);
      rec.lastUrl = meta.url;
      if (shouldSkipFrame(meta)) {
        rec.skipped += 1;
        maybeWriteDiagnosticPng(rec, png, meta, 'skipped');
        if (rec.skipped <= 8 || rec.skipped % 10 === 0) {
          browserLogger.info('GifRecorder.capture.skipped', {
            sessionId: rec.sessionId,
            reason: skipReason(meta),
            ...meta,
          });
        }
        return;
      }
      const pixels = quantizeToRgb332(png.data);
      rec.width = png.width;
      rec.height = png.height;
      rec.captured += 1;
      rec.frames.push({ pixels, timestamp: Date.now(), meta });
      while (rec.frames.length > MAX_FRAMES) rec.frames.shift();
      if (rec.captured <= 6 || rec.captured % 12 === 0) {
        browserLogger.info('GifRecorder.capture.ok', {
          sessionId: rec.sessionId,
          frame: rec.captured,
          buffered: rec.frames.length,
          ...meta,
        });
      }
    } catch (err) {
      browserLogger.warn('GifRecorder.capture.failed', {
        sessionId: rec.sessionId,
        error: (err as Error).message,
      });
    } finally {
      rec.capturing = false;
    }
  }
}

async function captureViewportPng(rec: Recording): Promise<{ png: PNG; meta: CaptureMeta }> {
  const remote = await getRemote(rec);
  await remote.send('Page.enable').catch(() => undefined);
  await remote.send('Runtime.enable').catch(() => undefined);
  await remote.send('Page.bringToFront').catch(() => undefined);
  const metrics = await remote.send('Page.getLayoutMetrics').catch(() => ({})) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const pageInfo = await remote.send('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,ready:document.readyState})',
    returnByValue: true,
  }).catch(() => null) as { result?: { value?: string } } | null;
  let info: { url?: string; title?: string; w?: number; h?: number; ready?: string } = {};
  if (typeof pageInfo?.result?.value === 'string') {
    try { info = JSON.parse(pageInfo.result.value) as typeof info; } catch { /* ignore */ }
  }
  const url = info.url ?? rec.webContents.getURL();
  const title = info.title ?? rec.webContents.getTitle();
  const viewportWidth = Math.round(info.w ?? metrics.cssVisualViewport?.clientWidth ?? metrics.cssLayoutViewport?.clientWidth ?? 0);
  const viewportHeight = Math.round(info.h ?? metrics.cssVisualViewport?.clientHeight ?? metrics.cssLayoutViewport?.clientHeight ?? 0);
  const candidates = [
    { mode: 'remote-default', params: { format: 'png', captureBeyondViewport: false } },
    { mode: 'remote-view', params: { format: 'png', fromSurface: false, captureBeyondViewport: false } },
    { mode: 'remote-surface', params: { format: 'png', fromSurface: true, captureBeyondViewport: false } },
  ];
  const captures: Array<{ png: PNG; meta: CaptureMeta }> = [];
  for (const candidate of candidates) {
    const result = await remote.send('Page.captureScreenshot', candidate.params) as { data?: string };
    if (typeof result.data !== 'string' || result.data.length === 0) continue;
    const raw = PNG.sync.read(Buffer.from(result.data, 'base64'));
    const stats = estimateFrameStats(raw.data);
    captures.push({
      png: raw,
      meta: {
        url,
        title,
        viewportWidth,
        viewportHeight,
        screenshotWidth: raw.width,
        screenshotHeight: raw.height,
        bytes: Math.round((result.data.length * 3) / 4),
        blankRatio: stats.blankRatio,
        darkRatio: stats.darkRatio,
        mode: candidate.mode,
      },
    });
  }
  const usable = captures.find((capture) => !isBlankFrame(capture.meta));
  if (usable) return usable;
  const screencast = await captureScreencastFrame(remote, {
    url,
    title,
    viewportWidth,
    viewportHeight,
  }).catch((err: Error) => {
    browserLogger.warn('GifRecorder.screencastFrame.failed', { error: err.message, url, title });
    return null;
  });
  if (screencast && !isBlankFrame(screencast.meta)) return screencast;
  if (screencast) captures.push(screencast);
  if (captures.length > 0) {
    captures.sort((a, b) => a.meta.blankRatio - b.meta.blankRatio);
    return captures[0];
  }
  throw new Error('CDP Page.captureScreenshot returned no image data');
}

async function captureScreencastFrame(
  remote: RemotePageCdp,
  context: { url: string; title: string; viewportWidth: number; viewportHeight: number },
): Promise<{ png: PNG; meta: CaptureMeta }> {
  const framePromise = remote.waitFor<{ data?: string; sessionId?: number }>('Page.screencastFrame', 2_500);
  await remote.send('Page.startScreencast', {
    format: 'png',
    quality: 100,
    everyNthFrame: 1,
  });
  try {
    const frame = await framePromise;
    if (typeof frame.sessionId === 'number') {
      await remote.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    }
    if (typeof frame.data !== 'string' || frame.data.length === 0) {
      throw new Error('Page.screencastFrame returned no image data');
    }
    const raw = PNG.sync.read(Buffer.from(frame.data, 'base64'));
    const stats = estimateFrameStats(raw.data);
    return {
      png: raw,
      meta: {
        url: context.url,
        title: context.title,
        viewportWidth: context.viewportWidth,
        viewportHeight: context.viewportHeight,
        screenshotWidth: raw.width,
        screenshotHeight: raw.height,
        bytes: Math.round((frame.data.length * 3) / 4),
        blankRatio: stats.blankRatio,
        darkRatio: stats.darkRatio,
        mode: 'remote-screencast',
      },
    };
  } finally {
    await remote.send('Page.stopScreencast').catch(() => undefined);
  }
}

async function getRemote(rec: Recording): Promise<RemotePageCdp> {
  if (rec.remote && rec.remote.isOpen()) return rec.remote;
  const targetId = await resolveTargetId(rec.webContents);
  const wsUrl = await resolveTargetWsUrl(rec.cdpPort, targetId);
  const remote = new RemotePageCdp(wsUrl);
  await remote.connect();
  rec.remote = remote;
  browserLogger.info('GifRecorder.remote.connected', {
    sessionId: rec.sessionId,
    cdpPort: rec.cdpPort,
    targetId,
    wsUrl: redactWsUrl(wsUrl),
  });
  return remote;
}

async function resolveTargetId(webContents: WebContents): Promise<string> {
  const dbg = webContents.debugger;
  const shouldAttach = !dbg.isAttached();
  if (shouldAttach) dbg.attach('1.3');
  try {
    const info = await dbg.sendCommand('Target.getTargetInfo') as { targetInfo?: { targetId?: string } };
    const id = info.targetInfo?.targetId;
    if (!id) throw new Error('Target.getTargetInfo returned no targetId');
    return id;
  } finally {
    if (shouldAttach) {
      try { dbg.detach(); } catch { /* already detached */ }
    }
  }
}

async function resolveTargetWsUrl(port: number, targetId: string): Promise<string> {
  if (port <= 0) throw new Error(`Invalid CDP port for GIF capture: ${port}`);
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list failed: ${res.status} ${res.statusText}`);
  const targets = await res.json() as Array<{ id?: string; webSocketDebuggerUrl?: string; url?: string; title?: string; type?: string }>;
  const match = targets.find((target) => target.id === targetId);
  if (!match?.webSocketDebuggerUrl) {
    throw new Error(`CDP target ${targetId} has no websocket; available=${targets.map((target) => `${target.id}:${target.type}:${target.url}`).join(',')}`);
  }
  return match.webSocketDebuggerUrl;
}

function redactWsUrl(url: string): string {
  return url.replace(/\/devtools\/page\/.+$/, '/devtools/page/<target>');
}

class RemotePageCdp {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private eventWaiters = new Map<string, Array<{ resolve: (params: unknown) => void; timer: ReturnType<typeof setTimeout> }>>();

  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
      ws.on('message', (raw) => this.onMessage(raw.toString()));
      ws.on('close', () => {
        for (const [id, pending] of this.pending) {
          pending.reject(new Error(`CDP websocket closed before response ${id}`));
        }
        this.pending.clear();
      });
    });
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP websocket is not open');
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws!.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async waitFor<T>(method: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) ?? [];
        this.eventWaiters.set(method, waiters.filter((waiter) => waiter.timer !== timer));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push({
        timer,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params as T);
        },
      });
      this.eventWaiters.set(method, waiters);
    });
  }

  close(): void {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(raw) as typeof msg; } catch { return; }
    if (typeof msg.method === 'string') {
      const waiters = this.eventWaiters.get(msg.method);
      const waiter = waiters?.shift();
      if (waiter) {
        if (waiters && waiters.length > 0) this.eventWaiters.set(msg.method, waiters);
        else this.eventWaiters.delete(msg.method);
        waiter.resolve(msg.params ?? {});
      }
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? 'CDP command failed'));
    else pending.resolve(msg.result ?? {});
  }
}

function shouldSkipFrame(meta: CaptureMeta): boolean {
  if (meta.url.startsWith('about:') || meta.url.startsWith('chrome:') || meta.url.startsWith('devtools:')) return true;
  return isBlankFrame(meta);
}

function isBlankFrame(meta: CaptureMeta): boolean {
  return meta.blankRatio > 0.965 && meta.darkRatio < 0.015;
}

function skipReason(meta: CaptureMeta): string {
  if (meta.url.startsWith('about:') || meta.url.startsWith('chrome:') || meta.url.startsWith('devtools:')) return 'internal-url';
  if (meta.blankRatio > 0.965 && meta.darkRatio < 0.015) return 'white-blank-frame';
  return 'blank-frame';
}

function quantizeToRgb332(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    const r = rgba[i] & 0xe0;
    const g = (rgba[i + 1] & 0xe0) >> 3;
    const b = rgba[i + 2] >> 6;
    out[j] = r | g | b;
  }
  return out;
}

function estimateFrameStats(rgba: Uint8Array): { blankRatio: number; darkRatio: number } {
  if (rgba.length === 0) return { blankRatio: 1, darkRatio: 0 };
  const buckets = new Map<number, number>();
  const stride = Math.max(4, Math.floor(rgba.length / 4 / 4000) * 4);
  let samples = 0;
  let most = 0;
  let dark = 0;
  for (let i = 0; i < rgba.length; i += stride) {
    const rv = rgba[i];
    const gv = rgba[i + 1];
    const bv = rgba[i + 2];
    const r = rv >> 4;
    const g = gv >> 4;
    const b = bv >> 4;
    const key = (r << 8) | (g << 4) | b;
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    if (count > most) most = count;
    if ((rv + gv + bv) / 3 < 32) dark += 1;
    samples += 1;
  }
  return samples === 0
    ? { blankRatio: 1, darkRatio: 0 }
    : { blankRatio: most / samples, darkRatio: dark / samples };
}

function maybeWriteDiagnosticPng(rec: Recording, png: PNG, meta: CaptureMeta, label: string): void {
  if (!rec.diagnosticDir) return;
  if (rec.captured > 0) return;
  try {
    fs.mkdirSync(rec.diagnosticDir, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-');
    const outPath = path.join(rec.diagnosticDir, `gif-capture-diagnostic-${safeLabel}-${Date.now()}.png`);
    fs.writeFileSync(outPath, PNG.sync.write(png));
    browserLogger.warn('GifRecorder.capture.diagnosticWritten', {
      sessionId: rec.sessionId,
      path: outPath,
      ...meta,
    });
  } catch (err) {
    browserLogger.warn('GifRecorder.capture.diagnosticFailed', {
      sessionId: rec.sessionId,
      error: (err as Error).message,
    });
  }
}

async function waitForCaptureIdle(rec: Recording): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    if (!rec.capturing) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function summarizeFrame(frame: CapturedFrame | undefined): Record<string, unknown> | null {
  if (!frame) return null;
  return {
    url: frame.meta.url,
    title: frame.meta.title,
    viewport: `${frame.meta.viewportWidth}x${frame.meta.viewportHeight}`,
    screenshot: `${frame.meta.screenshotWidth}x${frame.meta.screenshotHeight}`,
    blankRatio: frame.meta.blankRatio,
    darkRatio: frame.meta.darkRatio,
    mode: frame.meta.mode,
    bytes: frame.meta.bytes,
  };
}

function buildGifFrames(frames: CapturedFrame[], stride: number): GifFrame[] {
  const out: GifFrame[] = [];
  for (let i = 0; i < frames.length; i += stride) {
    let ms = 0;
    const end = Math.min(frames.length - 1, i + stride);
    for (let j = i; j < end; j += 1) {
      ms += Math.max(80, frames[j + 1].timestamp - frames[j].timestamp);
    }
    if (ms === 0) ms = CAPTURE_INTERVAL_MS * stride;
    out.push({
      pixels: frames[i].pixels,
      delayCs: Math.max(2, Math.min(100, Math.round(ms / 10))),
    });
  }
  return out;
}

function encodeGif(width: number, height: number, frames: GifFrame[]): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from('GIF89a', 'ascii'));
  chunks.push(u16(width), u16(height));
  chunks.push(Buffer.from([0xf7, 0x00, 0x00]));
  chunks.push(rgb332Palette());
  chunks.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'));
  chunks.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  for (const frame of frames) {
    chunks.push(Buffer.from([0x21, 0xf9, 0x04, 0x00]), u16(frame.delayCs), Buffer.from([0x00, 0x00]));
    chunks.push(Buffer.from([0x2c]), u16(0), u16(0), u16(width), u16(height), Buffer.from([0x00]));
    chunks.push(lzwImageData(frame.pixels, 8));
  }

  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

function rgb332Palette(): Buffer {
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const r = (i >> 5) & 0x07;
    const g = (i >> 2) & 0x07;
    const b = i & 0x03;
    palette[i * 3] = Math.round((r * 255) / 7);
    palette[i * 3 + 1] = Math.round((g * 255) / 7);
    palette[i * 3 + 2] = Math.round((b * 255) / 3);
  }
  return palette;
}

function lzwImageData(indices: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const writeCode = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const reset = (): void => {
    codeSize = minCodeSize + 1;
  };

  writeCode(clearCode);
  let literalsSinceClear = 0;
  for (const index of indices) {
    if (literalsSinceClear >= 240) {
      writeCode(clearCode);
      reset();
      literalsSinceClear = 0;
    }
    writeCode(index);
    literalsSinceClear += 1;
  }
  writeCode(endCode);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);

  const blocks: Buffer[] = [Buffer.from([minCodeSize])];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = Buffer.from(bytes.slice(i, i + 255));
    blocks.push(Buffer.from([block.length]), block);
  }
  blocks.push(Buffer.from([0x00]));
  return Buffer.concat(blocks);
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}
