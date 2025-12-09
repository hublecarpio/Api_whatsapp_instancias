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
  audio?: { id: string; mime_type: string; sha256: string };
  document?: { id: string; mime_type: string; sha256: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name: string }; phones: Array<{ phone: string }> }>;
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
    
    const response = await axios.post(
      `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { body: text }
      },
      { headers: this.headers }
    );

    return response.data;
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
      const { buffer, mimeType } = await this.downloadFromUrl(audioUrl);
      const mediaId = await this.uploadMedia(buffer, mimeType, 'audio.ogg');
      
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

      return response.data;
    } catch (uploadError: any) {
      console.error('Media upload failed, trying direct URL:', uploadError.message);
      const response = await axios.post(
        `${META_API_URL}/${this.credentials.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'audio',
          audio: { link: audioUrl }
        },
        { headers: this.headers }
      );

      return response.data;
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
    const response = await axios.get(
      `${META_API_URL}/${mediaId}`,
      { headers: this.headers }
    );

    return response.data.url;
  }

  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    const response = await axios.get(mediaUrl, {
      headers: { 'Authorization': `Bearer ${this.credentials.accessToken}` },
      responseType: 'arraybuffer'
    });

    return Buffer.from(response.data);
  }

  async getPhoneNumberInfo(): Promise<any> {
    const response = await axios.get(
      `${META_API_URL}/${this.credentials.phoneNumberId}`,
      { headers: this.headers }
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

  static parseWebhookMessage(payload: MetaWebhookPayload): {
    phoneNumberId: string;
    messages: Array<{
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
    }>;
  } | null {
    if (payload.object !== 'whatsapp_business_account') {
      return null;
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata.phone_number_id;
        const contacts = value.contacts || [];
        const messages = value.messages || [];

        if (messages.length === 0) continue;

        const parsedMessages = messages.map(msg => {
          const contact = contacts.find(c => c.wa_id === msg.from);
          const pushName = contact?.profile?.name || '';

          const parsed: any = {
            from: msg.from,
            pushName,
            messageId: msg.id,
            timestamp: parseInt(msg.timestamp) * 1000,
            type: msg.type
          };

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
              break;
            case 'location':
              parsed.location = msg.location;
              break;
          }

          return parsed;
        });

        return { phoneNumberId, messages: parsedMessages };
      }
    }

    return null;
  }
}
