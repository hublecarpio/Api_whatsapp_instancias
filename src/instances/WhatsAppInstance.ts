import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  ConnectionState,
  proto,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import { createInstanceLogger } from '../utils/logger';
import { WebhookDispatcher } from '../core/WebhookDispatcher';
import { MediaStorage } from '../core/MediaStorage';
import { ConnectionStatus } from '../utils/types';

const SESSIONS_PATH = path.join(process.cwd(), 'src', 'storage', 'sessions');

// Helper to sanitize phone numbers - returns only digit-based values, empty string otherwise
function sanitizePhone(value: string | undefined | null): string {
  if (!value) return '';
  // Remove @ suffix and device ID
  let cleaned = value.replace(/@s\.whatsapp\.net.*$/, '').replace(/@lid.*$/, '');
  // Remove device ID suffix like :0, :1
  if (cleaned.includes(':')) {
    cleaned = cleaned.split(':')[0];
  }
  // Check if it's a valid phone number (only digits, optionally starting with +)
  const digitsOnly = cleaned.replace(/[^\d]/g, '');
  // Must have at least 8 digits to be a valid phone number
  if (digitsOnly.length >= 8) {
    return digitsOnly;
  }
  return '';
}

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
  private isClosing: boolean = false;
  private isDeleted: boolean = false;
  private lidMappings: Map<string, string> = new Map();

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
    if (this.isDeleted || this.isClosing) {
      this.logger.info('Instance is closing or deleted, skipping connection');
      return;
    }

    this.status = 'connecting';
    this.logger.info('Starting WhatsApp connection...');

    const sessionPath = this.getSessionPath();
    
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const silentLogger = pino({ level: 'silent' });

    try {
      const { version } = await fetchLatestBaileysVersion();
      
      this.socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: silentLogger,
        browser: ['WhatsApp API', 'Chrome', '120.0.0'],
        version,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        emitOwnEvents: true,
        markOnlineOnConnect: true,
        qrTimeout: 60000,
        syncFullHistory: false
      });

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update);
      });

      this.socket.ev.on('messages.upsert', (messageInfo) => {
        this.logger.info({ type: messageInfo.type, count: messageInfo.messages?.length }, 'messages.upsert event received');
        this.handleMessages(messageInfo);
      });

      // Listen for LID to phone number mappings
      this.socket.ev.on('contacts.update', (contacts) => {
        for (const contact of contacts) {
          if (contact.id && contact.id.endsWith('@lid')) {
            // Only use phoneNumber field, NOT notify (which is the display name)
            const rawPhone = (contact as any).phoneNumber;
            const pn = sanitizePhone(rawPhone);
            if (pn) {
              const lid = contact.id.replace('@lid', '');
              this.lidMappings.set(lid, pn);
              this.logger.debug({ lid, phoneNumber: pn }, 'LID mapping discovered from contacts');
            }
          }
        }
      });

      // Listen for contacts.upsert for new contacts
      this.socket.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
          if (contact.id && contact.id.endsWith('@lid')) {
            // Only use phoneNumber field, NOT notify (which is the display name)
            const rawPhone = (contact as any).phoneNumber;
            const pn = sanitizePhone(rawPhone);
            if (pn) {
              const lid = contact.id.replace('@lid', '');
              this.lidMappings.set(lid, pn);
              this.logger.debug({ lid, phoneNumber: pn }, 'LID mapping discovered from contacts upsert');
            }
          }
        }
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to create socket');
      this.status = 'disconnected';
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    if (this.isDeleted || this.isClosing) {
      return;
    }

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.handleQR(qr);
    }

    if (connection === 'close') {
      if (this.isDeleted || this.isClosing) {
        this.logger.info('Connection closed (instance closing/deleted)');
        return;
      }

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !this.isClosing && !this.isDeleted;

      this.logger.warn({ statusCode, shouldReconnect }, 'Connection closed');

      if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.status = 'connecting';
        this.logger.info({ attempt: this.reconnectAttempts }, 'Attempting reconnection...');
        
        setTimeout(() => {
          if (!this.isDeleted && !this.isClosing) {
            this.connect().catch(err => {
              this.logger.error({ error: err.message }, 'Reconnection failed');
            });
          }
        }, 3000 * this.reconnectAttempts);
      } else {
        this.status = 'disconnected';
        this.qrCode = null;
        
        if (statusCode === DisconnectReason.loggedOut) {
          this.logger.info('Session logged out, clearing session data');
          this.clearSession();
        }
      }

      if (!this.isDeleted && !this.isClosing) {
        await WebhookDispatcher.dispatch(this.webhook, this.id, 'connection.close', {
          statusCode,
          shouldReconnect,
          reason: lastDisconnect?.error?.message || 'Unknown'
        });
      }

    } else if (connection === 'open') {
      this.status = 'connected';
      this.lastConnection = new Date();
      this.reconnectAttempts = 0;
      this.qrCode = null;
      this.logger.info('Connected to WhatsApp!');

      if (!this.isDeleted && !this.isClosing) {
        await WebhookDispatcher.dispatch(this.webhook, this.id, 'connection.open', {
          status: 'connected',
          timestamp: this.lastConnection.toISOString()
        });
      }
    }
  }

  private async handleQR(qr: string): Promise<void> {
    if (this.isDeleted || this.isClosing) {
      return;
    }

    this.status = 'requires_qr';
    this.logger.info('QR Code received');

    try {
      this.qrCode = await qrcode.toDataURL(qr, {
        width: 300,
        margin: 2
      });

      if (!this.isDeleted && !this.isClosing) {
        await WebhookDispatcher.dispatch(this.webhook, this.id, 'qr.update', {
          qrCode: this.qrCode
        });
      }
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to generate QR code');
    }
  }

  private async handleMessages(messageInfo: { messages: proto.IWebMessageInfo[], type: string }): Promise<void> {
    if (this.isDeleted || this.isClosing) {
      this.logger.debug('Skipping message - instance closing/deleted');
      return;
    }

    const { messages, type: upsertType } = messageInfo;

    if (upsertType !== 'notify') {
      this.logger.debug({ upsertType }, 'Skipping message - not notify type');
      return;
    }

    for (const message of messages) {
      this.logger.debug({ 
        fromMe: message.key?.fromMe, 
        hasMessage: !!message.message,
        remoteJid: message.key?.remoteJid,
        participant: message.key?.participant
      }, 'Processing message');

      if (message.key?.fromMe) {
        this.logger.debug('Skipping - message from self');
        continue;
      }

      const msg = message.message;
      if (!msg) {
        this.logger.debug('Skipping - no message content');
        continue;
      }

      const remoteJid = message.key?.remoteJid || '';
      const pushName = message.pushName || '';
      const isGroup = remoteJid.endsWith('@g.us');
      const isLid = remoteJid.endsWith('@lid');
      
      let from = remoteJid;
      let sender = isGroup ? message.key?.participant : remoteJid;
      let phoneNumber = '';
      
      if (isLid) {
        const participant = message.key?.participant;
        const participantAlt = (message.key as any)?.participantAlt;
        
        // Try participantAlt first (alternate JID with phone number)
        if (participantAlt && participantAlt.endsWith('@s.whatsapp.net')) {
          phoneNumber = participantAlt.replace('@s.whatsapp.net', '');
          sender = participantAlt;
          this.logger.debug({ participantAlt, phoneNumber }, 'Phone number from participantAlt');
        }
        // Try participant
        else if (participant && participant.endsWith('@s.whatsapp.net')) {
          phoneNumber = participant.replace('@s.whatsapp.net', '');
          sender = participant;
        }
        // Try to resolve from our cached LID mappings
        else {
          const lidNumber = remoteJid.replace('@lid', '');
          const cachedPhone = this.lidMappings.get(lidNumber);
          if (cachedPhone) {
            phoneNumber = cachedPhone;
            sender = `${cachedPhone}@s.whatsapp.net`;
            this.logger.debug({ lid: lidNumber, phoneNumber }, 'Phone number from LID cache');
          }
        }
        
        // Try to get from socket's signal repository
        if (!phoneNumber && this.socket) {
          try {
            const lidNumber = remoteJid.replace('@lid', '');
            const signalRepo = (this.socket as any).signalRepository;
            if (signalRepo?.lidMapping?.getPNForLID) {
              const pn = await signalRepo.lidMapping.getPNForLID(remoteJid);
              if (pn) {
                phoneNumber = pn.replace('@s.whatsapp.net', '');
                sender = pn;
                this.lidMappings.set(lidNumber, phoneNumber);
                this.logger.debug({ lid: lidNumber, phoneNumber }, 'Phone number from signalRepository');
              }
            }
          } catch (e) {
            // Signal repository method not available
          }
        }
        
        const verifiedBizName = (message as any).verifiedBizName;
        if (verifiedBizName) {
          this.logger.debug({ verifiedBizName }, 'Business account detected');
        }
      } else if (!isGroup) {
        phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
      }
      
      // For groups, try to resolve participant LID
      if (isGroup && sender?.endsWith('@lid')) {
        const participantAlt = (message.key as any)?.participantAlt;
        if (participantAlt && participantAlt.endsWith('@s.whatsapp.net')) {
          phoneNumber = participantAlt.replace('@s.whatsapp.net', '');
          sender = participantAlt;
        } else {
          const lidNumber = sender.replace('@lid', '');
          const cachedPhone = this.lidMappings.get(lidNumber);
          if (cachedPhone) {
            phoneNumber = cachedPhone;
            sender = `${cachedPhone}@s.whatsapp.net`;
          }
        }
      }
      
      if (sender?.endsWith('@lid') && !phoneNumber) {
        // Store the LID for future reference, phone unknown
        phoneNumber = '';
      } else if (sender && !phoneNumber) {
        phoneNumber = sanitizePhone(sender);
      }
      
      // Final sanitization - ensure phoneNumber is digits only (no names)
      phoneNumber = sanitizePhone(phoneNumber);
      
      // Clean device ID suffix (e.g., :0, :1) from sender and from
      if (sender && sender.includes(':')) {
        sender = sender.split(':')[0] + (sender.includes('@') ? '@' + sender.split('@')[1] : '');
      }
      if (from && from.includes(':') && !from.endsWith('@g.us')) {
        from = from.split(':')[0] + (from.includes('@') ? '@' + from.split('@')[1] : '');
      }
      
      let messageContent: any = {
        from,
        sender,
        pushName,
        phoneNumber,
        messageId: message.key?.id,
        timestamp: message.messageTimestamp,
        isGroup,
        isLid
      };

      const actualMessage = this.extractActualMessage(msg);
      const parsed = this.parseMessageContent(actualMessage);
      
      messageContent = { ...messageContent, ...parsed };

      if (parsed.type === 'protocol' || parsed.type === 'reaction') {
        continue;
      }

      const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
      if (mediaTypes.includes(parsed.type) && MediaStorage.isEnabled() && message.key) {
        try {
          const mediaBuffer = await downloadMediaMessage(
            message as any,
            'buffer',
            {},
            {
              logger: this.logger as any,
              reuploadRequest: this.socket!.updateMediaMessage
            }
          );

          if (mediaBuffer && Buffer.isBuffer(mediaBuffer)) {
            const stored = await MediaStorage.storeMedia(
              mediaBuffer,
              parsed.mimetype || 'application/octet-stream',
              this.id
            );

            if (stored) {
              messageContent.mediaUrl = stored.url;
              messageContent.mediaPath = stored.path;
              this.logger.info({ mediaUrl: stored.url }, 'Media stored successfully');
            }
          }
        } catch (error: any) {
          this.logger.warn({ error: error.message }, 'Failed to download/store media');
        }
      }

      this.logger.info({ 
        from, 
        sender,
        type: messageContent.type,
        hasText: !!messageContent.text,
        hasMedia: !!messageContent.mediaUrl
      }, 'Message received');

      if (!this.isDeleted && !this.isClosing) {
        await WebhookDispatcher.dispatch(this.webhook, this.id, 'message.received', messageContent);
      }
    }
  }

  private extractActualMessage(msg: proto.IMessage): proto.IMessage {
    if (msg.viewOnceMessage?.message) {
      return msg.viewOnceMessage.message;
    }
    if (msg.viewOnceMessageV2?.message) {
      return msg.viewOnceMessageV2.message;
    }
    if (msg.viewOnceMessageV2Extension?.message) {
      return msg.viewOnceMessageV2Extension.message;
    }
    if (msg.ephemeralMessage?.message) {
      return msg.ephemeralMessage.message;
    }
    if (msg.documentWithCaptionMessage?.message) {
      return msg.documentWithCaptionMessage.message;
    }
    return msg;
  }

  private parseMessageContent(msg: proto.IMessage): any {
    if (msg.conversation) {
      return {
        type: 'text',
        text: msg.conversation
      };
    }

    if (msg.extendedTextMessage) {
      return {
        type: 'text',
        text: msg.extendedTextMessage.text || '',
        quotedMessage: msg.extendedTextMessage.contextInfo?.quotedMessage ? true : false
      };
    }

    if (msg.imageMessage) {
      return {
        type: 'image',
        caption: msg.imageMessage.caption || '',
        mimetype: msg.imageMessage.mimetype || 'image/jpeg',
        url: msg.imageMessage.url || '',
        mediaKey: msg.imageMessage.mediaKey ? Buffer.from(msg.imageMessage.mediaKey).toString('base64') : ''
      };
    }

    if (msg.videoMessage) {
      return {
        type: 'video',
        caption: msg.videoMessage.caption || '',
        mimetype: msg.videoMessage.mimetype || 'video/mp4',
        seconds: msg.videoMessage.seconds || 0
      };
    }

    if (msg.audioMessage) {
      return {
        type: 'audio',
        mimetype: msg.audioMessage.mimetype || 'audio/ogg',
        seconds: msg.audioMessage.seconds || 0,
        ptt: msg.audioMessage.ptt || false
      };
    }

    if (msg.documentMessage) {
      return {
        type: 'document',
        fileName: msg.documentMessage.fileName || 'document',
        mimetype: msg.documentMessage.mimetype || 'application/octet-stream',
        pageCount: msg.documentMessage.pageCount || 0
      };
    }

    if (msg.stickerMessage) {
      return {
        type: 'sticker',
        mimetype: msg.stickerMessage.mimetype || 'image/webp',
        isAnimated: msg.stickerMessage.isAnimated || false
      };
    }

    if (msg.contactMessage) {
      return {
        type: 'contact',
        displayName: msg.contactMessage.displayName || '',
        vcard: msg.contactMessage.vcard || ''
      };
    }

    if (msg.contactsArrayMessage) {
      return {
        type: 'contacts',
        contacts: msg.contactsArrayMessage.contacts?.map(c => ({
          displayName: c.displayName || '',
          vcard: c.vcard || ''
        })) || []
      };
    }

    if (msg.locationMessage) {
      return {
        type: 'location',
        latitude: msg.locationMessage.degreesLatitude || 0,
        longitude: msg.locationMessage.degreesLongitude || 0,
        name: msg.locationMessage.name || '',
        address: msg.locationMessage.address || ''
      };
    }

    if (msg.liveLocationMessage) {
      return {
        type: 'live_location',
        latitude: msg.liveLocationMessage.degreesLatitude || 0,
        longitude: msg.liveLocationMessage.degreesLongitude || 0,
        caption: msg.liveLocationMessage.caption || ''
      };
    }

    if (msg.reactionMessage) {
      return {
        type: 'reaction',
        emoji: msg.reactionMessage.text || '',
        targetMessageId: msg.reactionMessage.key?.id || ''
      };
    }

    if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) {
      const poll = msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3;
      return {
        type: 'poll',
        name: poll?.name || '',
        options: poll?.options?.map(o => o.optionName) || []
      };
    }

    if (msg.protocolMessage) {
      return {
        type: 'protocol'
      };
    }

    if (msg.buttonsResponseMessage) {
      return {
        type: 'button_response',
        selectedButtonId: msg.buttonsResponseMessage.selectedButtonId || '',
        selectedDisplayText: msg.buttonsResponseMessage.selectedDisplayText || ''
      };
    }

    if (msg.listResponseMessage) {
      return {
        type: 'list_response',
        title: msg.listResponseMessage.title || '',
        selectedRowId: msg.listResponseMessage.singleSelectReply?.selectedRowId || ''
      };
    }

    if (msg.templateButtonReplyMessage) {
      return {
        type: 'template_button_reply',
        selectedId: msg.templateButtonReplyMessage.selectedId || '',
        selectedDisplayText: msg.templateButtonReplyMessage.selectedDisplayText || ''
      };
    }

    const messageKeys = Object.keys(msg).filter(k => !k.startsWith('_'));
    return {
      type: 'unknown',
      availableTypes: messageKeys
    };
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
    // If it's already a full JID, return as-is
    if (number.includes('@')) {
      return number;
    }
    
    // Remove non-numeric characters for phone numbers
    let formatted = number.replace(/[^0-9]/g, '');
    formatted = `${formatted}@s.whatsapp.net`;
    return formatted;
  }

  // Method to send message using LID directly
  async sendToLid(lid: string, message: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.socket || this.status !== 'connected') {
      return { success: false, error: 'Instance not connected' };
    }

    try {
      // Format as LID JID
      const jid = lid.includes('@') ? lid : `${lid}@lid`;
      const result = await this.socket.sendMessage(jid, { text: message });
      
      this.logger.info({ to: jid }, 'Text message sent to LID');
      
      await WebhookDispatcher.dispatch(this.webhook, this.id, 'message.sent', {
        to: jid,
        type: 'text',
        messageId: result?.key?.id
      });

      return { success: true, messageId: result?.key?.id || undefined };
    } catch (error: any) {
      this.logger.error({ error: error.message, lid }, 'Failed to send text message to LID');
      return { success: false, error: error.message };
    }
  }

  // Get cached LID mappings
  getLidMappings(): Map<string, string> {
    return this.lidMappings;
  }

  // Manually add a LID mapping
  addLidMapping(lid: string, phoneNumber: string): void {
    const sanitized = sanitizePhone(phoneNumber);
    if (!sanitized) {
      this.logger.warn({ lid, phoneNumber }, 'Invalid phone number, not storing LID mapping');
      return;
    }
    this.lidMappings.set(lid.replace('@lid', ''), sanitized);
    this.logger.info({ lid, phoneNumber: sanitized }, 'LID mapping added manually');
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.isClosing = true;
      this.logger.info('Disconnecting...');
      try {
        await this.socket.logout();
      } catch (error) {
        // Ignore logout errors
      }
      this.socket = null;
      this.status = 'disconnected';
      this.qrCode = null;
      this.isClosing = false;
    }
  }

  async close(): Promise<void> {
    this.isClosing = true;
    
    if (this.socket) {
      this.logger.info('Closing connection...');
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.end(undefined);
      } catch (error) {
        // Ignore close errors
      }
      this.socket = null;
    }
    
    this.status = 'disconnected';
    this.qrCode = null;
    this.isClosing = false;
  }

  async destroy(): Promise<void> {
    this.isClosing = true;
    this.isDeleted = true;
    
    if (this.socket) {
      this.logger.info('Destroying instance...');
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.end(undefined);
      } catch (error) {
        // Ignore close errors
      }
      this.socket = null;
    }
    
    this.status = 'disconnected';
    this.qrCode = null;
    this.webhook = '';
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
