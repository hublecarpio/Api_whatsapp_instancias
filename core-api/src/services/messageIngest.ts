import prisma from './prisma.js';
import axios from 'axios';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

export interface IncomingMessage {
  businessId: string;
  instanceId: string;
  provider: 'BAILEYS' | 'META_CLOUD';
  from: string;
  pushName: string;
  messageId: string;
  timestamp: number;
  type: string;
  text?: string;
  mediaUrl?: string;
  mimetype?: string;
  caption?: string;
  filename?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export async function processIncomingMessage(message: IncomingMessage): Promise<void> {
  const { businessId, instanceId, provider, from, pushName, type, text, mediaUrl, caption } = message;

  const cleanPhone = from.replace(/\D/g, '');

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      promptMaster: {
        include: { tools: { where: { enabled: true } } }
      },
      policy: true,
      products: true
    }
  });

  if (!business) {
    console.error('Business not found:', businessId);
    return;
  }

  const messageText = text || caption || (type === 'location' ? `Location: ${message.location?.latitude}, ${message.location?.longitude}` : '');

  await prisma.messageLog.create({
    data: {
      businessId,
      instanceId,
      direction: 'inbound',
      sender: cleanPhone,
      recipient: business.name,
      message: messageText,
      mediaUrl,
      metadata: {
        pushName,
        type,
        provider,
        messageId: message.messageId,
        timestamp: message.timestamp
      }
    }
  });

  if (!business.botEnabled) {
    console.log('Bot disabled for business:', businessId);
    return;
  }

  const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
  try {
    await axios.post(`${CORE_API_URL}/agent/think`, {
      businessId,
      instanceId,
      provider,
      contactPhone: cleanPhone,
      contactName: pushName,
      message: messageText,
      mediaUrl
    });
  } catch (error: any) {
    console.error('Failed to process with AI agent:', error.message);
  }
}

export async function sendProviderMessage(options: {
  businessId: string;
  instanceId: string;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  filename?: string;
}): Promise<boolean> {
  const { businessId, instanceId, to, text, mediaUrl, mediaType, caption, filename } = options;

  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: instanceId },
    include: { metaCredential: true }
  });

  if (!instance) {
    console.error('Instance not found:', instanceId);
    return false;
  }

  const cleanPhone = to.replace(/\D/g, '');

  try {
    if (instance.provider === 'META_CLOUD') {
      if (!instance.metaCredential) {
        console.error('Meta credentials not found for instance:', instanceId);
        return false;
      }

      const { MetaCloudService } = await import('./metaCloud.js');
      const metaService = new MetaCloudService({
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId,
        businessId: instance.metaCredential.businessId
      });

      await metaService.sendMessage({
        to: cleanPhone,
        text,
        mediaUrl,
        mediaType,
        caption,
        filename
      });
    } else {
      const recipient = `${cleanPhone}@s.whatsapp.net`;

      if (mediaUrl && mediaType) {
        const endpoint = mediaType === 'image' ? 'sendImage' 
          : mediaType === 'video' ? 'sendVideo'
          : mediaType === 'audio' ? 'sendAudio'
          : 'sendFile';

        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/${endpoint}`, {
          to: recipient,
          url: mediaUrl,
          caption: caption || text
        });
      } else if (text) {
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: recipient,
          message: text
        });
      }
    }

    await prisma.messageLog.create({
      data: {
        businessId,
        instanceId,
        direction: 'outbound',
        sender: 'bot',
        recipient: cleanPhone,
        message: text || caption || '',
        mediaUrl,
        metadata: { provider: instance.provider }
      }
    });

    return true;
  } catch (error: any) {
    console.error('Failed to send message via provider:', error.message);
    return false;
  }
}
