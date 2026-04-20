import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';
import type { WASocket, ConnectionState, BaileysEventMap } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import QRCode from 'qrcode';
import { app } from 'electron';
import { mainLogger } from '../logger';
import type { ChannelAdapter, ChannelStatus, InboundMessage } from './types';

const AUTH_DIR = path.join(app.getPath('userData'), 'whatsapp-auth');

const BACKOFF = {
  initialMs: 2000,
  maxMs: 30000,
  factor: 1.8,
  jitter: 0.25,
};

const MAX_SEEN_MESSAGES = 1000;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp' as const;
  status: ChannelStatus = 'disconnected';

  private sock: WASocket | null = null;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private statusHandler: ((status: ChannelStatus, detail?: string) => void) | null = null;
  private qrHandler: ((qrDataUrl: string) => void) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seenMessages = new Set<string>();
  private identity: string | null = null;
  private selfLid: string | null = null;
  private msgRetryCounterCache = new NodeCache();
  private intentionalDisconnect = false;

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: (status: ChannelStatus, detail?: string) => void): void {
    this.statusHandler = handler;
  }

  onQr(handler: (qrDataUrl: string) => void): void {
    this.qrHandler = handler;
  }

  getIdentity(): string | null {
    return this.identity;
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    await this.startSocket();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.identity = null;
    this.seenMessages.clear();
    this.setStatus('disconnected');
    mainLogger.info('whatsapp.disconnect');
  }

  async clearAuth(): Promise<void> {
    await this.disconnect();
    try {
      await fsPromises.rm(AUTH_DIR, { recursive: true, force: true });
      mainLogger.info('whatsapp.clearAuth');
    } catch {}
  }

  async send(conversationId: string, text: string): Promise<string | null> {
    if (!this.sock || !this.sock.user) {
      mainLogger.warn('whatsapp.send.notConnected', { conversationId });
      return null;
    }
    const sent = await this.sock.sendMessage(conversationId, { text });
    const sentId = sent?.key?.id ?? null;
    mainLogger.info('whatsapp.send', { conversationId, textLength: text.length, sentId });
    return sentId;
  }

  private async startSocket(): Promise<void> {
    try {
      await fsPromises.mkdir(AUTH_DIR, { recursive: true });

      await this.restoreCredsFromBackupIfNeeded();

      const { version } = await fetchLatestBaileysVersion();
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

      mainLogger.info('whatsapp.startSocket', {
        version,
        hasExistingCreds: !!state.creds.me,
      });

      const silentLogger = { level: 'silent', info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => silentLogger } as unknown as Parameters<typeof makeWASocket>[0]['logger'];
      this.sock = makeWASocket({
        version,
        logger: silentLogger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
        },
        browser: Browsers.ubuntu('AgentHub'),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: this.msgRetryCounterCache,
        printQRInTerminal: false,
      });

      const safeSaveCreds = async () => {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        const backupPath = path.join(AUTH_DIR, 'creds.json.bak');
        try {
          const existing = fs.readFileSync(credsPath, 'utf-8');
          JSON.parse(existing);
          fs.copyFileSync(credsPath, backupPath);
        } catch {}
        await saveCreds();
      };

      this.sock.ev.process(async (events: Partial<BaileysEventMap>) => {
        if (events['creds.update']) {
          await safeSaveCreds();
        }

        if (events['connection.update']) {
          await this.handleConnectionUpdate(events['connection.update'] as Partial<ConnectionState>);
        }

        if (events['messages.upsert']) {
          this.handleMessagesUpsert(events['messages.upsert'] as BaileysEventMap['messages.upsert']);
        }
      });
    } catch (err) {
      mainLogger.error('whatsapp.startSocket.failed', {
        error: (err as Error).message,
      });
      this.setStatus('error', (err as Error).message);
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        this.qrHandler?.(dataUrl);
        this.setStatus('qr_ready');
        mainLogger.info('whatsapp.qr.generated');
      } catch (err) {
        mainLogger.error('whatsapp.qr.failed', { error: (err as Error).message });
      }
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.identity = this.sock?.user?.id?.replace(/:.*$/, '') ?? null;
      this.selfLid = this.sock?.user?.lid ?? null;
      this.setStatus('connected', this.identity ?? undefined);
      mainLogger.info('whatsapp.connected', { identity: this.identity });
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      mainLogger.info('whatsapp.connection.close', { code });

      if (this.intentionalDisconnect) return;

      switch (code) {
        case DisconnectReason.loggedOut:
        case DisconnectReason.badSession:
          mainLogger.warn('whatsapp.authInvalid', { code });
          try {
            await fsPromises.rm(AUTH_DIR, { recursive: true, force: true });
          } catch {}
          this.identity = null;
          this.setStatus('disconnected', 'Session expired — reconnect to scan QR');
          break;

        case 403:
          mainLogger.error('whatsapp.banned');
          this.identity = null;
          this.setStatus('error', 'Account banned by WhatsApp');
          break;

        case DisconnectReason.connectionReplaced:
          this.identity = null;
          this.setStatus('error', 'Replaced by another session');
          break;

        case DisconnectReason.restartRequired:
          mainLogger.info('whatsapp.restartRequired');
          await this.startSocket();
          break;

        default: {
          const delay = Math.min(
            BACKOFF.initialMs * Math.pow(BACKOFF.factor, this.reconnectAttempts),
            BACKOFF.maxMs,
          ) * (1 + (Math.random() - 0.5) * BACKOFF.jitter);
          this.reconnectAttempts++;
          mainLogger.info('whatsapp.reconnecting', {
            attempt: this.reconnectAttempts,
            delayMs: Math.round(delay),
          });
          this.setStatus('connecting');
          this.reconnectTimer = setTimeout(() => this.startSocket(), delay);
        }
      }
    }
  }

  private handleMessagesUpsert(upsert: BaileysEventMap['messages.upsert']): void {
    const { messages, type } = upsert;

    if (type === 'append') return;

    for (const msg of messages) {
      mainLogger.info('whatsapp.msg.received', {
        remoteJid: msg.key.remoteJid,
        fromMe: msg.key.fromMe,
        participant: msg.key.participant,
        selfLid: this.selfLid,
        ownJid: this.sock?.user?.id,
      });

      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (!msg.key.remoteJid || !msg.key.id) continue;
      if (!msg.key.fromMe) {
        mainLogger.info('whatsapp.msg.skipNotFromMe', { remoteJid: msg.key.remoteJid });
        continue;
      }

      const stripDevice = (jid: string | null | undefined): string | null => jid ? jid.replace(/:.*@/, '@') : null;
      const ownJid = stripDevice(this.sock?.user?.id);
      const ownLid = stripDevice(this.selfLid);
      const isSelfChat =
        msg.key.remoteJid === ownLid ||
        msg.key.remoteJid === ownJid;
      if (!isSelfChat) {
        mainLogger.info('whatsapp.msg.skipNotSelfChat', {
          remoteJid: msg.key.remoteJid,
          selfLid: this.selfLid,
          ownJid,
        });
        continue;
      }

      const dedupKey = `${msg.key.remoteJid}:${msg.key.id}`;
      if (this.seenMessages.has(dedupKey)) continue;

      if (this.seenMessages.size >= MAX_SEEN_MESSAGES) {
        const first = this.seenMessages.values().next().value;
        if (first) this.seenMessages.delete(first);
      }
      this.seenMessages.add(dedupKey);

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text;

      if (!text) {
        this.sock?.sendMessage(msg.key.remoteJid, { text: 'Text messages only for now' })
          .catch(() => {});
        continue;
      }

      const replyToMessageId =
        msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined;

      const inboundTs = Date.now();
      mainLogger.info('whatsapp.inbound', {
        from: msg.key.remoteJid,
        fromName: msg.pushName,
        textLength: text.length,
        replyToMessageId: replyToMessageId ?? null,
        inboundTs,
      });

      this.messageHandler?.({
        channelId: 'whatsapp',
        from: msg.key.remoteJid,
        fromName: msg.pushName ?? msg.key.remoteJid,
        text,
        timestamp: (msg.messageTimestamp as number) * 1000,
        conversationId: msg.key.remoteJid,
        messageId: msg.key.id,
        replyToMessageId,
      });
    }
  }

  private async restoreCredsFromBackupIfNeeded(): Promise<void> {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    const backupPath = path.join(AUTH_DIR, 'creds.json.bak');
    try {
      const raw = fs.readFileSync(credsPath, 'utf-8');
      JSON.parse(raw);
    } catch {
      try {
        const backupRaw = fs.readFileSync(backupPath, 'utf-8');
        JSON.parse(backupRaw);
        fs.copyFileSync(backupPath, credsPath);
        mainLogger.info('whatsapp.creds.restoredFromBackup');
      } catch {}
    }
  }

  private setStatus(status: ChannelStatus, detail?: string): void {
    this.status = status;
    this.statusHandler?.(status, detail);
  }
}
