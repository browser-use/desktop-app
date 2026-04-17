/**
 * CDP client — two transports share one send/event surface.
 *
 * Transport A (preferred): Electron WebContents.debugger — no external socket.
 *   Attaches CDP 1.3 to a WebContents. sendCommand accepts an optional
 *   sessionId as 3rd arg, so we thread sessions through identically to the
 *   upstream Python daemon.
 *
 * Transport B (generic): raw WebSocket against a `ws://` DevTools URL.
 *   Used for remote CDP (separate Chrome / cloud browser). Tracks a request
 *   id and routes responses through a pending map. sessionId is threaded into
 *   every request object directly (flat session model).
 *
 * The send(method, params, sessionId?) + event API is identical between the
 * two so helpers.ts doesn't branch on transport.
 */

import { EventEmitter } from 'node:events';
import type { WebContents, Debugger } from 'electron';
import WebSocket from 'ws';
import { mainLogger } from '../logger';

const CDP_PROTOCOL_VERSION = '1.3';

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string | null): Promise<unknown>;
  on(event: string, listener: (params: unknown, sessionId?: string) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  close(): Promise<void>;
  readonly transport: 'webcontents' | 'websocket';
}

// ---------------------------------------------------------------------------
// Transport A — WebContents.debugger
// ---------------------------------------------------------------------------

class WebContentsCdpClient extends EventEmitter implements CdpClient {
  readonly transport = 'webcontents' as const;
  private dbg: Debugger;
  private attached = false;
  private onMessage = (_e: Electron.Event, method: string, params: unknown, sessionId?: string) => {
    this.emit(method, params, sessionId);
  };

  constructor(private wc: WebContents) {
    super();
    this.dbg = wc.debugger;
  }

  attach(): void {
    if (this.attached) return;
    try {
      this.dbg.attach(CDP_PROTOCOL_VERSION);
    } catch (err) {
      mainLogger.debug('hl.cdp.webcontents.alreadyAttached', { error: (err as Error).message });
    }
    this.dbg.on('message', this.onMessage);
    this.dbg.on('detach', (_e, reason) => {
      mainLogger.warn('hl.cdp.webcontents.detach', { reason });
      this.attached = false;
      this.emit('__detached', { reason });
    });
    this.attached = true;
  }

  // Electron's debugger.sendCommand(method, params, sessionId?) — 3rd arg is the
  // CDP sessionId when operating under a flat session (attachToTarget flatten:true).
  async send(method: string, params: Record<string, unknown> = {}, sessionId: string | null = null): Promise<unknown> {
    if (!this.attached) this.attach();
    if (sessionId) return (this.dbg as unknown as { sendCommand: (m: string, p: unknown, s: string) => Promise<unknown> })
      .sendCommand(method, params, sessionId);
    return this.dbg.sendCommand(method, params);
  }

  async close(): Promise<void> {
    if (!this.attached) return;
    try { this.dbg.detach(); } catch { /* ignore */ }
    this.dbg.removeListener('message', this.onMessage);
    this.attached = false;
  }
}

// ---------------------------------------------------------------------------
// Transport B — raw WebSocket (remote CDP, flat session model)
// ---------------------------------------------------------------------------

class WebSocketCdpClient extends EventEmitter implements CdpClient {
  readonly transport = 'websocket' as const;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

  constructor(private url: string) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', (err: Error) => reject(err));
      ws.on('message', (data: WebSocket.RawData) => this.onMessage(data.toString()));
      ws.on('close', () => this.emit('__detached', { reason: 'ws-closed' }));
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string }; sessionId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.emit(msg.method, msg.params, msg.sessionId);
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId: string | null = null): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`hl.cdp.websocket.notOpen: state=${this.ws?.readyState}`);
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function cdpForWebContents(wc: WebContents): CdpClient {
  const client = new WebContentsCdpClient(wc);
  client.attach();
  return client;
}

export async function cdpForWsUrl(url: string): Promise<CdpClient> {
  const client = new WebSocketCdpClient(url);
  await client.connect();
  return client;
}
