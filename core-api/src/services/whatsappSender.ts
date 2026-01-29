import { v4 as uuidv4 } from 'uuid';
import prisma from './prisma.js';
import { getOutboundMessageQueue, OutboundMessageJobData } from './queues/index.js';
import eventLogger from './eventLogger.js';

export interface SendMessageOptions {
  businessId: string;
  instanceId: string;
  to: string;
  message?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  priority?: 'high' | 'normal' | 'low';
  source?: 'external_api' | 'agent' | 'broadcast' | 'reminder';
  splitMessages?: boolean;
}

export interface QueuedMessageResult {
  success: boolean;
  jobId?: string;
  jobIds?: string[];
  queued: boolean;
  error?: string;
}

export interface InstanceWithCredentials {
  id: string;
  provider: 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST';
  instanceBackendId?: string | null;
  phoneNumber?: string | null;
  status: string;
  metaCredential?: {
    accessToken: string;
    phoneNumberId: string;
  } | null;
  metaCoexistCredential?: {
    systemAccessToken?: string | null;
    userAccessToken?: string | null;
    phoneNumberId: string;
  } | null;
}

function cleanMarkdownForWhatsApp(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/#{1,6}\s/g, '');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  cleaned = cleaned.replace(/^[-*]\s/gm, '• ');
  cleaned = cleaned.replace(/^\d+\.\s/gm, (match) => match);
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```\w*\n?/g, '').replace(/```/g, '');
  });
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

interface MediaItem {
  type: 'image' | 'video' | 'file';
  url: string;
  fileName?: string;
}

function extractMediaFromText(text: string): { mediaItems: MediaItem[]; cleanedText: string } {
  const mediaItems: MediaItem[] = [];
  let cleanedText = text;
  
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const url = match[2];
    if (url.match(/\.(jpg|jpeg|png|gif|webp)$/i) || url.includes('/image')) {
      mediaItems.push({ type: 'image', url });
    } else if (url.match(/\.(mp4|mov|avi)$/i) || url.includes('/video')) {
      mediaItems.push({ type: 'video', url });
    } else {
      mediaItems.push({ type: 'file', url, fileName: match[1] || 'document' });
    }
    cleanedText = cleanedText.replace(match[0], '');
  }
  
  const urlRegex = /(https?:\/\/[^\s<>\[\]()]+\.(jpg|jpeg|png|gif|webp|mp4|mov|pdf|doc|docx))/gi;
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[1];
    const ext = match[2].toLowerCase();
    
    const alreadyIncluded = mediaItems.some(m => m.url === url);
    if (!alreadyIncluded) {
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        mediaItems.push({ type: 'image', url });
      } else if (['mp4', 'mov'].includes(ext)) {
        mediaItems.push({ type: 'video', url });
      } else {
        mediaItems.push({ type: 'file', url, fileName: `document.${ext}` });
      }
    }
  }
  
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();
  
  return { mediaItems, cleanedText };
}

function smartSplitMessage(text: string, maxChars: number = 350): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  
  const parts: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let currentPart = '';
  
  for (const paragraph of paragraphs) {
    if (currentPart.length + paragraph.length + 2 <= maxChars) {
      currentPart += (currentPart ? '\n\n' : '') + paragraph;
    } else {
      if (currentPart) {
        parts.push(currentPart.trim());
      }
      
      if (paragraph.length <= maxChars) {
        currentPart = paragraph;
      } else {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        currentPart = '';
        
        for (const sentence of sentences) {
          if (currentPart.length + sentence.length + 1 <= maxChars) {
            currentPart += (currentPart ? ' ' : '') + sentence;
          } else {
            if (currentPart) {
              parts.push(currentPart.trim());
            }
            currentPart = sentence;
          }
        }
      }
    }
  }
  
  if (currentPart) {
    parts.push(currentPart.trim());
  }
  
  return parts.filter(p => p.length > 0);
}

function buildJobData(
  instance: InstanceWithCredentials,
  businessId: string,
  to: string,
  message?: string,
  mediaUrl?: string,
  mediaType?: 'image' | 'video' | 'audio' | 'document',
  priority: 'high' | 'normal' | 'low' = 'normal',
  source: 'external_api' | 'agent' | 'broadcast' | 'reminder' = 'agent'
): OutboundMessageJobData {
  const jobId = `msg_${uuidv4()}`;
  
  let metaCredential: { accessToken: string; phoneNumberId: string } | undefined;
  let metaCoexistCredential: { accessToken: string; phoneNumberId: string } | undefined;
  
  if (instance.provider === 'META_CLOUD' && instance.metaCredential) {
    metaCredential = {
      accessToken: instance.metaCredential.accessToken,
      phoneNumberId: instance.metaCredential.phoneNumberId
    };
  }
  
  if (instance.provider === 'META_COEXIST' && instance.metaCoexistCredential) {
    const accessToken = instance.metaCoexistCredential.systemAccessToken || 
                        instance.metaCoexistCredential.userAccessToken || '';
    metaCoexistCredential = {
      accessToken,
      phoneNumberId: instance.metaCoexistCredential.phoneNumberId
    };
  }
  
  return {
    jobId,
    businessId,
    instanceId: instance.id,
    to,
    message,
    mediaUrl,
    mediaType,
    provider: instance.provider,
    instanceBackendId: instance.instanceBackendId || undefined,
    metaCredential,
    metaCoexistCredential,
    phoneNumber: instance.phoneNumber || undefined,
    enqueuedAt: Date.now(),
    priority,
    source
  };
}

export async function queueMessage(options: SendMessageOptions): Promise<QueuedMessageResult> {
  const { businessId, instanceId, to, message, mediaUrl, mediaType, priority = 'normal', source = 'agent' } = options;
  
  const queue = getOutboundMessageQueue();
  if (!queue) {
    return { success: false, queued: false, error: 'Outbound message queue not available' };
  }
  
  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: instanceId },
    include: {
      metaCredential: true,
      metaCoexistCredential: true
    }
  });
  
  if (!instance) {
    return { success: false, queued: false, error: 'Instance not found' };
  }
  
  // Normalize recipient: Baileys needs digits only, Meta providers preserve original ID
  const cleanTo = instance.provider === 'BAILEYS' 
    ? to.replace(/\D/g, '') 
    : to.replace(/^\+/, ''); // Meta: remove leading + but preserve digits
  
  const jobData = buildJobData(
    instance as InstanceWithCredentials,
    businessId,
    cleanTo,
    message,
    mediaUrl,
    mediaType,
    priority,
    source
  );
  
  const priorityValue = priority === 'high' ? 1 : priority === 'low' ? 10 : 5;
  
  try {
    await queue.add(jobData.jobId, jobData, {
      jobId: jobData.jobId,
      priority: priorityValue
    });
    
    console.log(`[WhatsAppSender] Message queued: ${jobData.jobId} to ${cleanTo} via ${instance.provider}`);
    
    return { success: true, jobId: jobData.jobId, queued: true };
  } catch (error: any) {
    console.error('[WhatsAppSender] Failed to queue message:', error.message);
    return { success: false, queued: false, error: error.message };
  }
}

export async function queueAgentResponse(options: {
  businessId: string;
  instanceId: string;
  to: string;
  response: string;
  splitMessages?: boolean;
  priority?: 'high' | 'normal' | 'low';
}): Promise<QueuedMessageResult> {
  const { businessId, instanceId, to, response, splitMessages = true, priority = 'normal' } = options;
  
  const queue = getOutboundMessageQueue();
  if (!queue) {
    return { success: false, queued: false, error: 'Outbound message queue not available' };
  }
  
  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: instanceId },
    include: {
      metaCredential: true,
      metaCoexistCredential: true
    }
  });
  
  if (!instance) {
    return { success: false, queued: false, error: 'Instance not found' };
  }
  
  // Normalize recipient: Baileys needs digits only, Meta providers preserve original ID
  const cleanTo = instance.provider === 'BAILEYS' 
    ? to.replace(/\D/g, '') 
    : to.replace(/^\+/, ''); // Meta: remove leading + but preserve digits
  const { cleanedText, mediaItems } = extractMediaFromText(response);
  const finalText = cleanMarkdownForWhatsApp(cleanedText);
  
  const jobIds: string[] = [];
  const priorityValue = priority === 'high' ? 1 : priority === 'low' ? 10 : 5;
  
  try {
    if (finalText) {
      if (splitMessages) {
        const parts = smartSplitMessage(finalText);
        for (const part of parts) {
          const jobData = buildJobData(
            instance as InstanceWithCredentials,
            businessId,
            cleanTo,
            part,
            undefined,
            undefined,
            priority,
            'agent'
          );
          
          await queue.add(jobData.jobId, jobData, {
            jobId: jobData.jobId,
            priority: priorityValue
          });
          
          jobIds.push(jobData.jobId);
        }
      } else {
        const jobData = buildJobData(
          instance as InstanceWithCredentials,
          businessId,
          cleanTo,
          finalText,
          undefined,
          undefined,
          priority,
          'agent'
        );
        
        await queue.add(jobData.jobId, jobData, {
          jobId: jobData.jobId,
          priority: priorityValue
        });
        
        jobIds.push(jobData.jobId);
      }
    }
    
    for (const media of mediaItems) {
      const mediaType = media.type === 'file' ? 'document' : media.type;
      
      const jobData = buildJobData(
        instance as InstanceWithCredentials,
        businessId,
        cleanTo,
        undefined,
        media.url,
        mediaType as 'image' | 'video' | 'document',
        priority,
        'agent'
      );
      
      await queue.add(jobData.jobId, jobData, {
        jobId: jobData.jobId,
        priority: priorityValue
      });
      
      jobIds.push(jobData.jobId);
    }
    
    console.log(`[WhatsAppSender] Agent response queued: ${jobIds.length} jobs to ${cleanTo} via ${instance.provider}`);
    
    await eventLogger.info('AGENT_MESSAGE_QUEUED', `Respuesta del agente encolada para ${cleanTo}`, {
      businessId,
      details: { 
        to: cleanTo, 
        jobCount: jobIds.length,
        hasMedia: mediaItems.length > 0,
        provider: instance.provider,
        splitMessages
      }
    });
    
    return { success: true, jobIds, queued: true };
  } catch (error: any) {
    console.error('[WhatsAppSender] Failed to queue agent response:', error.message);
    return { success: false, queued: false, error: error.message };
  }
}

export async function markMessageAsRead(options: {
  instanceId: string;
  providerMessageId: string;
}): Promise<boolean> {
  const { instanceId, providerMessageId } = options;
  
  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: instanceId },
    include: {
      metaCredential: true,
      metaCoexistCredential: true
    }
  });
  
  if (!instance) {
    console.error('[WhatsAppSender] Instance not found for markAsRead');
    return false;
  }
  
  try {
    if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
      const { MetaCloudService } = await import('./metaCloud.js');
      
      const isCoexist = instance.provider === 'META_COEXIST';
      const accessToken = isCoexist 
        ? (instance.metaCoexistCredential?.systemAccessToken || instance.metaCoexistCredential?.userAccessToken)
        : instance.metaCredential?.accessToken;
      const phoneNumberId = isCoexist 
        ? instance.metaCoexistCredential?.phoneNumberId 
        : instance.metaCredential?.phoneNumberId;
      
      if (!accessToken || !phoneNumberId) {
        console.error('[WhatsAppSender] Missing credentials for markAsRead');
        return false;
      }
      
      const metaService = new MetaCloudService({
        accessToken,
        phoneNumberId,
        businessId: ''
      });
      
      await metaService.markMessageAsRead(providerMessageId);
      return true;
    } else if (instance.provider === 'BAILEYS' && instance.instanceBackendId) {
      const axios = (await import('axios')).default;
      const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
      
      await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/markAsRead`, {
        messageId: providerMessageId
      });
      return true;
    }
    
    return false;
  } catch (error: any) {
    console.error('[WhatsAppSender] Failed to mark message as read:', error.message);
    return false;
  }
}

export function isQueueAvailable(): boolean {
  return getOutboundMessageQueue() !== null;
}

export async function sendAgentResponseDirect(options: {
  businessId: string;
  instanceId: string;
  to: string;
  response: string;
  contactName?: string;
  contactJid?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { businessId, instanceId, to, response, contactName, contactJid } = options;
  
  const instance = await prisma.whatsAppInstance.findUnique({
    where: { id: instanceId },
    include: {
      metaCredential: true,
      metaCoexistCredential: true
    }
  });
  
  if (!instance) {
    console.error('[WhatsAppSender] Instance not found for direct send');
    return { success: false, error: 'Instance not found' };
  }
  
  const cleanTo = instance.provider === 'BAILEYS' 
    ? to.replace(/\D/g, '') 
    : to.replace(/^\+/, '');
  
  const { cleanedText, mediaItems } = extractMediaFromText(response);
  const finalText = cleanMarkdownForWhatsApp(cleanedText);
  
  console.log(`[WhatsAppSender] Direct send (no Redis) to ${cleanTo} via ${instance.provider}, hasText=${!!finalText}, mediaCount=${mediaItems.length}`);
  
  try {
    let metaService: any = null;
    let axios: any = null;
    const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
    
    if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
      const { MetaCloudService } = await import('./metaCloud.js');
      
      const isCoexist = instance.provider === 'META_COEXIST';
      const accessToken = isCoexist 
        ? (instance.metaCoexistCredential?.systemAccessToken || instance.metaCoexistCredential?.userAccessToken)
        : instance.metaCredential?.accessToken;
      const phoneNumberId = isCoexist 
        ? instance.metaCoexistCredential?.phoneNumberId 
        : instance.metaCredential?.phoneNumberId;
      const metaBusinessId = isCoexist
        ? instance.metaCoexistCredential?.metaBusinessId
        : instance.metaCredential?.businessId;
      
      if (!accessToken || !phoneNumberId) {
        console.error('[WhatsAppSender] Missing Meta credentials for direct send');
        return { success: false, error: 'Missing Meta credentials' };
      }
      
      metaService = new MetaCloudService({
        accessToken,
        phoneNumberId,
        businessId: metaBusinessId || businessId
      });
    } else if (instance.provider === 'BAILEYS' && instance.instanceBackendId) {
      axios = (await import('axios')).default;
    } else {
      console.error('[WhatsAppSender] No valid send method for instance');
      return { success: false, error: 'No valid send method' };
    }
    
    const parts = finalText ? smartSplitMessage(finalText) : [];
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(part.length * 30, 2000)));
      }
      
      if (metaService) {
        await metaService.sendTextMessage(cleanTo, part);
      } else if (axios) {
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: cleanTo,
          message: part
        }, { timeout: 30000 });
      }
      
      await prisma.messageLog.create({
        data: {
          businessId,
          instanceId,
          direction: 'outbound',
          sender: instance.phoneNumber || 'bot',
          recipient: cleanTo,
          message: part,
          deliveryStatus: 'sent',
          deliveryAttempts: 1,
          metadata: { 
            source: 'agent_direct',
            provider: instance.provider,
            contactJid: contactJid || cleanTo,
            contactName: contactName || 'Cliente',
            partIndex: i,
            totalParts: parts.length
          }
        }
      });
    }
    
    for (const media of mediaItems) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const mediaType = media.type === 'file' ? 'document' : media.type;
      
      if (metaService) {
        if (media.type === 'image') {
          await metaService.sendImageMessage(cleanTo, media.url);
        } else if (media.type === 'video') {
          await metaService.sendVideoMessage(cleanTo, media.url);
        } else {
          await metaService.sendDocumentMessage(cleanTo, media.url, media.fileName);
        }
      } else if (axios) {
        const endpoint = media.type === 'image' ? 'sendImage' : media.type === 'video' ? 'sendVideo' : 'sendFile';
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/${endpoint}`, {
          to: cleanTo,
          url: media.url,
          filename: media.fileName
        }, { timeout: 30000 });
      }
      
      await prisma.messageLog.create({
        data: {
          businessId,
          instanceId,
          direction: 'outbound',
          sender: instance.phoneNumber || 'bot',
          recipient: cleanTo,
          message: null,
          mediaUrl: media.url,
          deliveryStatus: 'sent',
          deliveryAttempts: 1,
          metadata: { 
            source: 'agent_direct',
            provider: instance.provider,
            mediaType,
            fileName: media.fileName
          }
        }
      });
    }
    
    console.log(`[WhatsAppSender] Direct send SUCCESS to ${cleanTo}: ${parts.length} text parts, ${mediaItems.length} media items`);
    return { success: true };
    
  } catch (error: any) {
    console.error('[WhatsAppSender] Direct send FAILED:', error.message);
    return { success: false, error: error.message };
  }
}

export { extractMediaFromText, cleanMarkdownForWhatsApp, smartSplitMessage };
