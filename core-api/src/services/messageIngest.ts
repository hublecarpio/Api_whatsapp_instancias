import prisma from './prisma.js';
import axios from 'axios';
import { geminiService } from './gemini.js';
import { assignNextRoundRobinAdvisor } from '../routes/advisor.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';

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

export async function processIncomingMessage(message: IncomingMessage): Promise<boolean> {
  const { businessId, instanceId, provider, from, pushName, type, text, mediaUrl, caption } = message;

  const cleanPhone = from.replace(/\D/g, '');
  
  // DEDUPLICATION: Check if message already processed using providerMessageId
  const providerMessageId = message.messageId;
  if (providerMessageId) {
    const existingMessage = await prisma.messageLog.findFirst({
      where: {
        businessId,
        providerMessageId
      }
    });
    
    if (existingMessage) {
      console.log(`[DEDUP] Message ${providerMessageId} already processed, skipping`);
      return false;
    }
  }

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
    return false;
  }

  let messageText = text || caption || (type === 'location' ? `Location: ${message.location?.latitude}, ${message.location?.longitude}` : '');

  let mediaAnalysis = '';
  let mediaAnalysisRaw = '';
  if (mediaUrl && geminiService.isConfigured()) {
    const mediaTypes = ['audio', 'ptt', 'image', 'sticker', 'video'];
    if (mediaTypes.includes(type)) {
      console.log(`[GEMINI] Processing ${type} for AI context...`);
      const result = await geminiService.processMedia(mediaUrl, type, messageText);
      if (result.success && result.text) {
        mediaAnalysisRaw = result.text;
        if (type === 'audio' || type === 'ptt') {
          if (!messageText) {
            messageText = result.text;
          }
          mediaAnalysis = `\n\n[SISTEMA - Transcripción automática del audio enviado por el cliente: "${result.text}"]`;
        } else if (type === 'image' || type === 'sticker') {
          mediaAnalysis = `\n\n[SISTEMA - El cliente envió una imagen. Descripción automática: ${result.text}]`;
        } else if (type === 'video') {
          mediaAnalysis = `\n\n[SISTEMA - El cliente envió un video. Descripción automática: ${result.text}]`;
        }
        console.log(`[GEMINI] Media analysis complete for ${type}`);
      }
    }
  }

  const fullMessageForAgent = messageText + mediaAnalysis;

  await prisma.messageLog.create({
    data: {
      businessId,
      instanceId,
      direction: 'inbound',
      sender: cleanPhone,
      recipient: business.name,
      message: messageText,
      mediaUrl,
      providerMessageId: providerMessageId || undefined,
      metadata: {
        pushName,
        type,
        provider,
        messageId: message.messageId,
        timestamp: message.timestamp,
        mediaAnalysis: mediaAnalysisRaw || undefined,
        mediaType: mediaUrl ? type : undefined
      }
    }
  });

  const now = new Date();
  try {
    await prisma.contact.upsert({
      where: {
        businessId_phone: { businessId, phone: cleanPhone }
      },
      create: {
        businessId,
        phone: cleanPhone,
        name: pushName || null,
        source: provider,
        firstMessageAt: now,
        lastMessageAt: now,
        messageCount: 1
      },
      update: {
        name: pushName || undefined,
        lastMessageAt: now,
        messageCount: { increment: 1 }
      }
    });
  } catch (err) {
    console.error('[CONTACT] Failed to upsert contact:', err);
  }

  try {
    await assignNextRoundRobinAdvisor(businessId, cleanPhone);
  } catch (err) {
    console.error('[ROUND-ROBIN] Failed to assign advisor:', err);
  }

  if (!business.botEnabled) {
    console.log('Bot disabled for business:', businessId);
    return true;
  }

  const contact = await prisma.contact.findUnique({
    where: {
      businessId_phone: { businessId, phone: cleanPhone }
    }
  });

  if (contact?.botDisabled) {
    console.log('Bot disabled for contact:', cleanPhone, 'in business:', businessId);
    return true;
  }

  const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
  try {
    await axios.post(`${CORE_API_URL}/agent/think`, {
      business_id: businessId,
      instanceId,
      provider,
      phone: `${cleanPhone}@s.whatsapp.net`,
      phoneNumber: cleanPhone,
      contactName: pushName,
      user_message: fullMessageForAgent,
      mediaUrl,
      mediaAnalysis: mediaAnalysis || undefined
    }, {
      headers: { 'X-Internal-Secret': INTERNAL_AGENT_SECRET }
    });
    return true;
  } catch (error: any) {
    console.error('Failed to process with AI agent:', error.message);
    return false;
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
