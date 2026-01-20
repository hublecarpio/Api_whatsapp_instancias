import axios from 'axios';
import FormData from 'form-data';

const META_API_URL = 'https://graph.facebook.com/v21.0';

export interface MetaCredentials {
  accessToken: string;
  phoneNumberId: string;
  businessId: string;
}

export interface MetaMessagePayload {
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  filename?: string;
}

export interface MetaWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  video?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string; sha256: string; voice?: boolean };
  document?: { id: string; mime_type: string; sha256: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type: string; animated?: boolean };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name: string }; phones: Array<{ phone: string; type?: string }> }>;
  button?: { text: string; payload: string };
  interactive?: { 
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  reaction?: { message_id: string; emoji: string };
  context?: { from: string; id: string; referred_product?: any };
  referral?: { source_url: string; source_type: string; source_id: string; headline?: string; body?: string };
  order?: { catalog_id: string; product_items: Array<{ product_retailer_id: string; quantity: number; item_price: number; currency: string }> };
}

export interface MetaWebhookStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  conversation?: { id: string; origin?: { type: string } };
  pricing?: { billable: boolean; pricing_model: string; category: string };
  errors?: Array<{ code: number; title: string; message?: string; error_data?: { details: string } }>;
}

export interface ParsedStatus {
  messageId: string;
  status: string;
  timestamp: number;
  recipientId: string;
  conversationId?: string;
  originType?: string;
  isBillable?: boolean;
  errorCode?: number;
  errorTitle?: string;
  errorMessage?: string;
}

export interface ParsedWebhookResult {
  phoneNumberId: string;
  displayPhoneNumber: string;
  messages: ParsedMessage[];
  statuses: ParsedStatus[];
}

export interface ParsedMessage {
  from: string;
  pushName: string;
  messageId: string;
  timestamp: number;
  type: string;
  text?: string;
  mediaId?: string;
  mimetype?: string;
  caption?: string;
  filename?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: string; phones: string[] }>;
  buttonPayload?: string;
  buttonText?: string;
  interactiveType?: string;
  interactiveId?: string;
  interactiveTitle?: string;
  reaction?: { messageId: string; emoji: string };
  contextMessageId?: string;
  contextFrom?: string;
  isVoiceNote?: boolean;
  isAnimatedSticker?: boolean;
  order?: { catalogId: string; items: Array<{ productId: string; quantity: number; price: number; currency: string }> };
}

export interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: MetaWebhookMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

export class MetaCloudService {
  private credentials: MetaCredentials;

  constructor(credentials: MetaCredentials) {
    this.credentials = credentials;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.credentials.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async sendTextMessage(to: string, text: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');
    console.log(`[META] sendTextMessage: to=${cleanPhone}, phoneNumberId=${this.credentials.phoneNumberId}, textLen=${text?.length}`);
    
    try {
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'text',
          text: { body: text }
        },
        { headers: this.headers, timeout: 30000 }
      );

      const messageId = response.data?.messages?.[0]?.id;
      console.log(`[META] sendTextMessage SUCCESS: messageId=${messageId}`);
      return response.data;
    } catch (error: any) {
      console.error(`[META] sendTextMessage FAILED:`, {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
        to: cleanPhone
      });
      throw error;
    }
  }

  async sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(imageUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, 'image.jpg');
      
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'image',
          image: {
            id: mediaId,
            caption: caption || ''
          }
        },
        { headers: this.headers }
      );

      return response.data;
    } catch (uploadError: any) {
      console.error('Image upload failed, trying direct URL:', uploadError.message);
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption || ''
          }
        },
        { headers: this.headers }
      );

      return response.data;
    }
  }

  async sendVideoMessage(to: string, videoUrl: string, caption?: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(videoUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, 'video.mp4');
      
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'video',
          video: {
            id: mediaId,
            caption: caption || ''
          }
        },
        { headers: this.headers }
      );

      return response.data;
    } catch (uploadError: any) {
      console.error('Video upload failed, trying direct URL:', uploadError.message);
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'video',
          video: {
            link: videoUrl,
            caption: caption || ''
          }
        },
        { headers: this.headers }
      );

      return response.data;
    }
  }

  async uploadMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', buffer, {
      filename,
      contentType: mimeType
    });
    formData.append('type', mimeType);

    const response = await axios.post(
      `${META_API_URL}/${this.credentials.phoneNumberId}/media`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${this.credentials.accessToken}`,
          ...formData.getHeaders()
        }
      }
    );

    return response.data.id;
  }

  private async downloadFromUrl(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const mimeType = response.headers['content-type'] || 'application/octet-stream';
    return { buffer: Buffer.from(response.data), mimeType };
  }

  async sendAudioMessage(to: string, audioUrl: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');

    try {
      console.log('[META] sendAudioMessage called');
      console.log('[META] Target phone:', cleanPhone);
      console.log('[META] Downloading audio from:', audioUrl);
      
      const { buffer, mimeType } = await this.downloadFromUrl(audioUrl);
      console.log(`[META] Audio downloaded: ${buffer.length} bytes, Content-Type: ${mimeType}`);
      
      // Meta Cloud soporta: audio/aac, audio/amr, audio/mpeg, audio/mp4, audio/ogg (OPUS)
      // Para notas de voz nativas, OGG con OPUS es ideal
      let actualMimeType = 'audio/mpeg'; // default a MP3
      let extension = 'mp3';
      
      if (mimeType.includes('ogg') || mimeType.includes('opus')) {
        actualMimeType = 'audio/ogg; codecs=opus';
        extension = 'ogg';
      } else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
        actualMimeType = 'audio/mpeg';
        extension = 'mp3';
      } else if (mimeType.includes('aac')) {
        actualMimeType = 'audio/aac';
        extension = 'aac';
      } else if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
        actualMimeType = 'audio/mp4';
        extension = 'm4a';
      } else if (mimeType.includes('amr')) {
        actualMimeType = 'audio/amr';
        extension = 'amr';
      }
      
      console.log(`[META] Uploading audio to Meta as ${actualMimeType} (voice.${extension})`);
      const mediaId = await this.uploadMedia(buffer, actualMimeType, `voice.${extension}`);
      console.log('[META] Audio uploaded to Meta, media_id:', mediaId);
      console.log('[META] Sending audio message to', cleanPhone);
      
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'audio',
          audio: { id: mediaId }
        },
        { headers: this.headers }
      );

      console.log('[META] Audio message sent successfully as voice note');
      return response.data;
    } catch (uploadError: any) {
      console.error('[META] Audio upload/send failed:', uploadError.response?.data || uploadError.message);
      throw uploadError;
    }
  }

  async sendDocumentMessage(to: string, documentUrl: string, filename?: string, caption?: string): Promise<any> {
    const cleanPhone = to.replace(/\D/g, '');

    try {
      const { buffer, mimeType } = await this.downloadFromUrl(documentUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, filename || 'document');
      
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'document',
          document: {
            id: mediaId,
            filename: filename || 'document',
            caption: caption || ''
          }
        },
        { headers: this.headers }
      );

      return response.data;
    } catch (uploadError: any) {
      console.error('Document upload failed, trying direct URL:', uploadError.message);
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'document',
          document: {
            link: documentUrl,
            filename: filename || 'document',
            caption: caption || ''
          }
        },
        { headers: this.headers }
      );

      return response.data;
    }
  }

  async sendMessage(payload: MetaMessagePayload): Promise<any> {
    if (payload.mediaUrl && payload.mediaType) {
      switch (payload.mediaType) {
        case 'image':
          return this.sendImageMessage(payload.to, payload.mediaUrl, payload.caption);
        case 'video':
          return this.sendVideoMessage(payload.to, payload.mediaUrl, payload.caption);
        case 'audio':
          return this.sendAudioMessage(payload.to, payload.mediaUrl);
        case 'document':
          return this.sendDocumentMessage(payload.to, payload.mediaUrl, payload.filename, payload.caption);
      }
    }

    if (payload.text) {
      return this.sendTextMessage(payload.to, payload.text);
    }

    throw new Error('Invalid message payload: must include text or media');
  }

  async getMediaUrl(mediaId: string): Promise<string> {
    console.log(`[META] getMediaUrl: fetching URL for mediaId=${mediaId}, phoneNumberId=${this.credentials.phoneNumberId}`);
    try {
      const response = await axios.get(
        `${META_API_URL}/${mediaId}`,
        { headers: this.headers, timeout: 30000 }
      );
      console.log(`[META] getMediaUrl: success for ${mediaId}`);
      return response.data.url;
    } catch (error: any) {
      console.error(`[META] getMediaUrl FAILED for ${mediaId}:`, {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message
      });
      throw error;
    }
  }

  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    console.log(`[META] downloadMedia: downloading from ${mediaUrl?.substring(0, 80)}...`);
    try {
      const response = await axios.get(mediaUrl, {
        headers: { 'Authorization': `Bearer ${this.credentials.accessToken}` },
        responseType: 'arraybuffer',
        timeout: 60000
      });
      console.log(`[META] downloadMedia: success, size=${response.data.byteLength} bytes`);
      return Buffer.from(response.data);
    } catch (error: any) {
      console.error(`[META] downloadMedia FAILED:`, {
        status: error?.response?.status,
        message: error?.message,
        code: error?.code
      });
      throw error;
    }
  }

  async getPhoneNumberInfo(): Promise<any> {
    const response = await axios.get(
      `${META_API_URL}/${this.credentials.phoneNumberId}`,
      { headers: this.headers, timeout: 5000 }
    );

    return response.data;
  }

  async markMessageAsRead(messageId: string): Promise<any> {
    const response = await axios.post(
      `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      },
      { headers: this.headers }
    );

    return response.data;
  }

  async sendTemplate(options: {
    to: string;
    templateName: string;
    language: string;
    components?: Array<{
      type: 'header' | 'body' | 'button';
      parameters?: Array<{ type: string; text?: string; image?: { link: string }; document?: { link: string } }>;
    }>;
  }): Promise<any> {
    const cleanPhone = options.to.replace(/\D/g, '');

    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: {
        name: options.templateName,
        language: { code: options.language }
      }
    };

    if (options.components && options.components.length > 0) {
      payload.template.components = options.components;
    }

    const response = await axios.post(
      `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
      payload,
      { headers: this.headers }
    );

    return response.data;
  }

  async getTemplates(): Promise<any[]> {
    const response = await axios.get(
      `${META_API_URL}/${this.credentials.businessId}/message_templates`,
      { headers: this.headers }
    );

    return response.data.data || [];
  }

  static parseWebhookMessage(payload: MetaWebhookPayload): ParsedWebhookResult | null {
    if (payload.object !== 'whatsapp_business_account') {
      return null;
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata.phone_number_id;
        const displayPhoneNumber = value.metadata.display_phone_number;
        const contacts = value.contacts || [];
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        const parsedMessages: ParsedMessage[] = messages.map(msg => {
          const contact = contacts.find(c => c.wa_id === msg.from);
          const pushName = contact?.profile?.name || '';

          const parsed: ParsedMessage = {
            from: msg.from,
            pushName,
            messageId: msg.id,
            timestamp: parseInt(msg.timestamp) * 1000,
            type: msg.type
          };

          if (msg.context) {
            parsed.contextMessageId = msg.context.id;
            parsed.contextFrom = msg.context.from;
          }

          switch (msg.type) {
            case 'text':
              parsed.text = msg.text?.body;
              break;
            case 'image':
              parsed.mediaId = msg.image?.id;
              parsed.mimetype = msg.image?.mime_type;
              parsed.caption = msg.image?.caption;
              break;
            case 'video':
              parsed.mediaId = msg.video?.id;
              parsed.mimetype = msg.video?.mime_type;
              parsed.caption = msg.video?.caption;
              break;
            case 'audio':
              parsed.mediaId = msg.audio?.id;
              parsed.mimetype = msg.audio?.mime_type;
              parsed.isVoiceNote = msg.audio?.voice === true;
              break;
            case 'document':
              parsed.mediaId = msg.document?.id;
              parsed.mimetype = msg.document?.mime_type;
              parsed.filename = msg.document?.filename;
              parsed.caption = msg.document?.caption;
              break;
            case 'sticker':
              parsed.mediaId = msg.sticker?.id;
              parsed.mimetype = msg.sticker?.mime_type;
              parsed.isAnimatedSticker = msg.sticker?.animated === true;
              break;
            case 'location':
              parsed.location = msg.location;
              break;
            case 'contacts':
              if (msg.contacts) {
                parsed.contacts = msg.contacts.map(c => ({
                  name: c.name.formatted_name,
                  phones: c.phones.map(p => p.phone)
                }));
              }
              break;
            case 'button':
              parsed.buttonText = msg.button?.text;
              parsed.buttonPayload = msg.button?.payload;
              parsed.text = msg.button?.text;
              break;
            case 'interactive':
              parsed.interactiveType = msg.interactive?.type;
              if (msg.interactive?.button_reply) {
                parsed.interactiveId = msg.interactive.button_reply.id;
                parsed.interactiveTitle = msg.interactive.button_reply.title;
                parsed.text = msg.interactive.button_reply.title;
              } else if (msg.interactive?.list_reply) {
                parsed.interactiveId = msg.interactive.list_reply.id;
                parsed.interactiveTitle = msg.interactive.list_reply.title;
                parsed.text = msg.interactive.list_reply.title;
              }
              break;
            case 'reaction':
              if (msg.reaction) {
                parsed.reaction = {
                  messageId: msg.reaction.message_id,
                  emoji: msg.reaction.emoji
                };
              }
              break;
            case 'order':
              if (msg.order) {
                parsed.order = {
                  catalogId: msg.order.catalog_id,
                  items: msg.order.product_items.map(item => ({
                    productId: item.product_retailer_id,
                    quantity: item.quantity,
                    price: item.item_price,
                    currency: item.currency
                  }))
                };
              }
              break;
          }

          return parsed;
        });

        const parsedStatuses: ParsedStatus[] = statuses.map((s: any) => ({
          messageId: s.id,
          status: s.status,
          timestamp: parseInt(s.timestamp) * 1000,
          recipientId: s.recipient_id,
          conversationId: s.conversation?.id,
          originType: s.conversation?.origin?.type,
          isBillable: s.pricing?.billable,
          errorCode: s.errors?.[0]?.code,
          errorTitle: s.errors?.[0]?.title,
          errorMessage: s.errors?.[0]?.message || s.errors?.[0]?.error_data?.details
        }));

        return { 
          phoneNumberId, 
          displayPhoneNumber,
          messages: parsedMessages, 
          statuses: parsedStatuses 
        };
      }
    }

    return null;
  }
}
