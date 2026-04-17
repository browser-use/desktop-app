/**
 * Unix socket client for the Python agent daemon.
 *
 * Responsibilities:
 * - Connect to the PID-scoped socket path
 * - Send JSON-line requests and await responses
 * - Deliver push events to registered subscribers
 * - Delegate reconnection to reconnect.ts
 *
 * Socket path: ${app.getPath('userData')}/daemon-${process.pid}.sock
 */

import * as net from "net";
import * as path from "path";
import { EventEmitter } from "events";
import { app } from "electron";
import {
  PROTOCOL_VERSION,
  DaemonRequest,
  DaemonResponse,
  AgentEvent,
  isAgentEvent,
  isDaemonResponse,
  makeRequest,
  parseSocketLine,
} from "../../shared/types";
import { ReconnectManager } from "./reconnect";
import { EventStream } from "./eventStream";
import { daemonLogger } from "../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024; // 4 MB
const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 30000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonClientOptions {
  /** Override socket path (useful in tests) */
  socketPath?: string;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  pingIntervalMs?: number;
}

type PendingRequest = {
  resolve: (resp: DaemonResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

export class DaemonClient extends EventEmitter {
  private socketPath: string;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly pingIntervalMs: number;

  private socket: net.Socket | null = null;
  private connected = false;
  private destroyed = false;

  /** Pending request queue: keyed by sequence number */
  private pendingRequests = new Map<number, PendingRequest>();
  private sequence = 0;

  private lineBuffer = "";
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  readonly reconnect: ReconnectManager;
  readonly events: EventStream;

  constructor(opts: DaemonClientOptions = {}) {
    super();

    // PID-scoped socket path — multi-instance safe (Critic C10)
    this.socketPath =
      opts.socketPath ??
      path.join(app.getPath("userData"), `daemon-${process.pid}.sock`);

    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;

    this.events = new EventStream();
    this.reconnect = new ReconnectManager({
      onReconnect: () => this._connect(),
      onGiveUp: () => {
        daemonLogger.error("DaemonClient.reconnect.giveUp", {
          socketPath: this.socketPath,
          msg: "Reconnect gave up. Daemon unavailable.",
        });
        this.emit("daemon-unavailable");
      },
    });

    daemonLogger.debug("DaemonClient.init", { socketPath: this.socketPath });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Connect to the daemon socket. Resolves when connection is established. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.destroyed) throw new Error("DaemonClient: Client has been destroyed");
    return this._connect();
  }

  /**
   * Send a request to the daemon and wait for its response.
   * Stamps version automatically.
   */
  async send<T extends Omit<DaemonRequest, "version">>(
    req: T
  ): Promise<DaemonResponse> {
    if (!this.connected || !this.socket) {
      throw new Error("DaemonClient: Not connected to daemon");
    }

    const seq = ++this.sequence;
    const message = makeRequest(req);
    const line = JSON.stringify({ ...message, _seq: seq }) + "\n";

    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
      throw new Error(`DaemonClient: Message exceeds max size of ${MAX_MESSAGE_BYTES} bytes`);
    }

    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(seq);
        reject(new Error(`DaemonClient: Request timed out (seq=${seq}, meta=${String((req as { meta?: string }).meta)})`));
      }, this.responseTimeoutMs);

      this.pendingRequests.set(seq, { resolve, reject, timer });

      daemonLogger.debug("DaemonClient.send", {
        seq,
        meta: String((req as { meta?: string }).meta),
        socketPath: this.socketPath,
        pendingCount: this.pendingRequests.size,
      });
      this.socket!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(seq);
          reject(new Error(`DaemonClient: Socket write failed: ${err.message}`));
        }
      });
    });
  }

  /**
   * Register a handler for push events from the daemon.
   * Returns an unsubscribe function.
   */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    return this.events.subscribe(handler);
  }

  /** Gracefully shut down: send shutdown request, then destroy socket. */
  async shutdown(): Promise<void> {
    if (!this.connected) {
      this._destroy();
      return;
    }
    daemonLogger.debug("DaemonClient.shutdown", { socketPath: this.socketPath });
    try {
      await this.send({ meta: "shutdown" });
    } catch {
      // Ignore errors during shutdown
    }
    this._destroy();
  }

  /** Expose socket path for tests / diagnostics */
  getSocketPath(): string {
    return this.socketPath;
  }

  setSocketPath(newPath: string): void {
    daemonLogger.info("DaemonClient.setSocketPath", {
      oldPath: this.socketPath,
      newPath,
    });
    this.socketPath = newPath;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      daemonLogger.debug("DaemonClient.connect", { socketPath: this.socketPath });

      const socket = net.createConnection({ path: this.socketPath });
      const connectTimer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`DaemonClient: Connection timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        clearTimeout(connectTimer);
        daemonLogger.debug("DaemonClient.connect.success", { socketPath: this.socketPath });
        this.socket = socket;
        this.connected = true;
        this.lineBuffer = "";
        this.reconnect.onConnected();
        this._startPing();
        this.emit("connected");
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        this._onData(chunk);
      });

      socket.once("error", (err: Error) => {
        clearTimeout(connectTimer);
        daemonLogger.error("DaemonClient.socket.error", {
          error: err.message,
          stack: err.stack,
          socketPath: this.socketPath,
          connected: this.connected,
          pendingCount: this.pendingRequests.size,
        });
        this._onDisconnect(err);
        reject(err);
      });

      socket.once("close", () => {
        clearTimeout(connectTimer);
        daemonLogger.warn("DaemonClient.socket.close", {
          socketPath: this.socketPath,
          connected: this.connected,
          pendingCount: this.pendingRequests.size,
        });
        this._onDisconnect(new Error("Socket closed"));
      });
    });
  }

  private _onData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString("utf8");

    // Guard against runaway buffers
    if (this.lineBuffer.length > MAX_MESSAGE_BYTES) {
      daemonLogger.error("DaemonClient.onData.overflow", {
        bufferLength: this.lineBuffer.length,
        maxBytes: MAX_MESSAGE_BYTES,
        socketPath: this.socketPath,
      });
      this.lineBuffer = "";
      return;
    }

    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        this._dispatchLine(line);
      } catch (err) {
        daemonLogger.error("DaemonClient.onData.dispatchFailed", {
          error: (err as Error).message,
          stack: (err as Error).stack,
          socketPath: this.socketPath,
          linePreview: line.slice(0, 200),
        });
      }
    }
  }

  private _dispatchLine(line: string): void {
    const parsed = parseSocketLine(line);

    // Check if this is a response to a pending request (has _seq)
    const withSeq = parsed as unknown as Record<string, unknown>;
    const seq = typeof withSeq["_seq"] === "number" ? withSeq["_seq"] : null;

    if (seq !== null && isDaemonResponse(parsed)) {
      const pending = this.pendingRequests.get(seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(seq);
        daemonLogger.debug("DaemonClient.dispatchLine.response", {
          seq,
          ok: parsed.ok,
          socketPath: this.socketPath,
        });
        pending.resolve(parsed);
        return;
      }
    }

    // Otherwise treat as a push event
    if (isAgentEvent(parsed)) {
      daemonLogger.debug("DaemonClient.dispatchLine.pushEvent", {
        event: parsed.event,
        task_id: parsed.task_id,
        socketPath: this.socketPath,
      });
      this.events.emit(parsed);
      return;
    }

    daemonLogger.warn("DaemonClient.dispatchLine.unhandled", {
      linePreview: line.slice(0, 200),
      socketPath: this.socketPath,
    });
  }

  private _onDisconnect(err: Error): void {
    if (this.destroyed) return;

    this.connected = false;
    this._stopPing();
    this._rejectAllPending(err);

    this.emit("disconnected", err);
    this.reconnect.onDisconnected();
  }

  private _rejectAllPending(err: Error): void {
    for (const [seq, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`DaemonClient: Connection lost (seq=${seq}): ${err.message}`));
    }
    this.pendingRequests.clear();
  }

  private _startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(async () => {
      if (!this.connected) {
        this._stopPing();
        return;
      }
      try {
        await this.send({ meta: "ping" });
        daemonLogger.debug("DaemonClient.ping.ok", { socketPath: this.socketPath });
      } catch (err) {
        daemonLogger.warn("DaemonClient.ping.failed", {
          error: (err as Error).message,
          socketPath: this.socketPath,
          connected: this.connected,
        });
      }
    }, this.pingIntervalMs);
  }

  private _stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private _destroy(): void {
    this.destroyed = true;
    this._stopPing();
    this._rejectAllPending(new Error("Client destroyed"));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }
}
