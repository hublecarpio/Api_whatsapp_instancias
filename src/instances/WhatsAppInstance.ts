import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  BaileysEventMap,
  ConnectionState,
  proto,
  downloadMediaMessage,
  AnyMessageContent
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import { createInstanceLogger } from '../utils/logger';
import { WebhookDispatcher } from '../core/WebhookDispatcher';
import { ConnectionStatus } from '../utils/types';

const SESSIONS_PATH = path.join(process.cwd(), 'src', 'storage', 'sessions');

export interface InstanceOptions {
  id: string;
  webhook?: string;
  createdAt?: Date;
  lastConnection?: Date | null;
}

export class WhatsAppInstance {
  public id: string;
  public webhook: string;
  public status: ConnectionStatus = 'disconnected';
  public createdAt: Date;
  public lastConnection: Date | null = null;
  
  private socket: WASocket | null = null;
  private qrCode: string | null = null;
  private logger: pino.Logger;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(options: InstanceOptions | string, webhook: string = '') {
    if (typeof options === 'string') {
      this.id = options;
      this.webhook = webhook;
      this.createdAt = new Date();
    } else {
      this.id = options.id;
      this.webhook = options.webhook || '';
      this.createdAt = options.createdAt ? new Date(options.createdAt) : new Date();
      this.lastConnection = options.lastConnection ? new Date(options.lastConnection) : null;
    }
    this.logger = createInstanceLogger(this.id);
  }

  private getSessionPath(): string {
    return path.join(SESSIONS_PATH, this.id);
  }

  async connect(): Promise<void> {
    this.status = 'connecting';
    this.logger.info('Starting WhatsApp connection...');

    const sessionPath = this.getSessionPath();
    
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const silentLogger = pino({ level: 'silent' });

    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger,
      browser: ['WhatsApp API', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      emitOwnEvents: true,
      markOnlineOnConnect: true
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(update);
    });

    this.socket.ev.on('messages.upsert', (messageInfo) => {
      this.handleMessages(messageInfo);
    });
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.handleQR(qr);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      this.logger.warn({ statusCode, shouldReconnect }, 'Connection closed');

      if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.status = 'connecting';
        this.logger.info({ attempt: this.reconnectAttempts }, 'Attempting reconnection...');
        
        setTimeout(() => {
          this.connect().catch(err => {
            this.logger.error({ error: err.message }, 'Reconnection failed');
          });
        }, 3000 * this.reconnectAttempts);
      } else {
        this.status = 'disconnected';
        this.qrCode = null;
        
        if (statusCode === DisconnectReason.loggedOut) {
          this.logger.info('Session logged out, clearing session data');
          this.clearSession();
        }
      }

      await WebhookDispatcher.dispatch(this.webhook, this.id, 'connection.close', {
        statusCode,
        shouldReconnect,
        reason: lastDisconnect?.error?.message || 'Unknown'
      });

    } else if (connection === 'open') {
      this.status = 'connected';
      this.lastConnection = new Date();
      this.reconnectAttempts = 0;
      this.qrCode = null;
      this.logger.info('Connected to WhatsApp!');

      await WebhookDispatcher.dispatch(this.webhook, this.id, 'connection.open', {
        status: 'connected',
        timestamp: this.lastConnection.toISOString()
      });
    }
  }

  private async handleQR(qr: string): Promise<void> {
    this.status = 'requires_qr';
    this.logger.info('QR Code received');

    try {
      this.qrCode = await qrcode.toDataURL(qr, {
        width: 300,
        margin: 2
      });

      await WebhookDispatcher.dispatch(this.webhook, this.id, 'qr.update', {
        qrCode: this.qrCode
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to generate QR code');
    }
  }

  private async handleMessages(messageInfo: { messages: proto.IWebMessageInfo[], type: string }): Promise<void> {
    const { messages, type } = messageInfo;

    for (const message of messages) {
      if (!message.key?.fromMe && message.message) {
        const from = message.key?.remoteJid;
        const pushName = message.pushName || 'Unknown';
        
        let messageContent: any = {
          from,
          pushName,
          messageId: message.key?.id,
          timestamp: message.messageTimestamp
        };

        if (message.message.conversation) {
          messageContent.type = 'text';
          messageContent.text = message.message.conversation;
        } else if (message.message.extendedTextMessage) {
          messageContent.type = 'text';
          messageContent.text = message.message.extendedTextMessage.text;
        } else if (message.message.imageMessage) {
          messageContent.type = 'image';
          messageContent.caption = message.message.imageMessage.caption || '';
          messageContent.mimetype = message.message.imageMessage.mimetype;
        } else if (message.message.videoMessage) {
          messageContent.type = 'video';
          messageContent.caption = message.message.videoMessage.caption || '';
          messageContent.mimetype = message.message.videoMessage.mimetype;
        } else if (message.message.audioMessage) {
          messageContent.type = 'audio';
          messageContent.mimetype = message.message.audioMessage.mimetype;
        } else if (message.message.documentMessage) {
          messageContent.type = 'document';
          messageContent.fileName = message.message.documentMessage.fileName;
          messageContent.mimetype = message.message.documentMessage.mimetype;
        } else {
          messageContent.type = 'unknown';
        }

        this.logger.info({ from, type: messageContent.type }, 'Message received');

        await WebhookDispatcher.dispatch(this.webhook, this.id, 'message.received', messageContent);
      }
    }
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  async sendText(to: string, message: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.socket || this.status !== 'connected') {
      return { success: false, error: 'Instance not connected' };
    }

    try {
      const jid = this.formatJid(to);
      const result = await this.socket.sendMessage(jid, { text: message });
      
      this.logger.info({ to: jid }, 'Text message sent');
      
      await WebhookDispatcher.dispatch(this.webhook, this.id, 'message.sent', {
        to: jid,
        type: 'text',
        messageId: result?.key?.id
      });

      return { success: true, messageId: result?.key?.id || undefined };
    } catch (error: any) {
      this.logger.error({ error: error.message, to }, 'Failed to send text message');
      return { success: false, error: error.message };
    }
  }

  async sendImage(to: string, url: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.socket || this.status !== 'connected') {
      return { success: false, error: 'Instance not connected' };
    }

    try {
      const jid = this.formatJid(to);
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      const result = await this.socket.sendMessage(jid, {
        image: buffer,
        caption: caption || ''
      });

      this.logger.info({ to: jid }, 'Image sent');

      await WebhookDispatcher.dispatch(this.webhook, this.id, 'message.sent', {
        to: jid,
        type: 'image',
        messageId: result?.key?.id
      });

      return { success: true, messageId: result?.key?.id || undefined };
    } catch (error: any) {
      this.logger.error({ error: error.message, to }, 'Failed to send image');
      return { success: false, error: error.message };
    }
  }

  async sendFile(to: string, url: string, fileName: string, mimeType: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.socket || this.status !== 'connected') {
      return { success: false, error: 'Instance not connected' };
    }

    try {
      const jid = this.formatJid(to);
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      const result = await this.socket.sendMessage(jid, {
        document: buffer,
        mimetype: mimeType,
        fileName: fileName
      });

      this.logger.info({ to: jid, fileName }, 'File sent');

      await WebhookDispatcher.dispatch(this.webhook, this.id, 'message.sent', {
        to: jid,
        type: 'document',
        fileName,
        messageId: result?.key?.id
      });

      return { success: true, messageId: result?.key?.id || undefined };
    } catch (error: any) {
      this.logger.error({ error: error.message, to }, 'Failed to send file');
      return { success: false, error: error.message };
    }
  }

  private formatJid(number: string): string {
    let formatted = number.replace(/[^0-9]/g, '');
    if (!formatted.includes('@')) {
      formatted = `${formatted}@s.whatsapp.net`;
    }
    return formatted;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.logger.info('Disconnecting...');
      await this.socket.logout();
      this.socket = null;
      this.status = 'disconnected';
      this.qrCode = null;
    }
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.logger.info('Closing connection...');
      this.socket.end(undefined);
      this.socket = null;
      this.status = 'disconnected';
      this.qrCode = null;
    }
  }

  clearSession(): void {
    const sessionPath = this.getSessionPath();
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      this.logger.info('Session data cleared');
    }
  }

  getMetadata() {
    return {
      id: this.id,
      webhook: this.webhook,
      status: this.status,
      createdAt: this.createdAt,
      lastConnection: this.lastConnection
    };
  }
}
