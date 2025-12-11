import { Router, Request, Response, NextFunction } from 'express';
import OpenAI from 'openai';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';
import { isOpenAIConfigured, getOpenAIClient, getDefaultModel, logTokenUsage } from '../services/openaiService.js';
import { replacePromptVariables } from '../services/promptVariables.js';
import { generateWithAgentV2, buildBusinessContext, buildConversationHistory, isAgentV2Available, getAgentMemory, clearAgentMemory, getMemoryStats } from '../services/agentV2Service.js';
import { MetaCloudService } from '../services/metaCloud.js';
import { createProductPaymentLink } from '../services/stripePayments.js';
import { searchProductsIntelligent } from '../services/productSearch.js';
import { queueAIResponse, getAIQueueStats } from '../services/queues/aiResponseProcessor.js';
import { getAIResponseQueue } from '../services/queues/index.js';

const router = Router();

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';
const USE_AI_QUEUE = process.env.USE_AI_QUEUE !== 'false';

async function processWithAgentQueued(
  businessId: string,
  messages: string[],
  phone: string,
  contactPhone: string,
  contactName: string,
  instanceId?: string,
  instanceBackendId?: string
): Promise<{ response: string; tokensUsed?: number; queued?: boolean }> {
  const queue = getAIResponseQueue();
  
  if (USE_AI_QUEUE && queue) {
    const jobId = await queueAIResponse({
      businessId,
      contactPhone,
      contactName,
      messages,
      phone,
      instanceId,
      instanceBackendId,
      priority: 'normal'
    });
    
    if (jobId) {
      console.log(`[Agent] Message queued for parallel processing: ${jobId}`);
      return { response: '', queued: true };
    }
  }
  
  return await processWithAgent(businessId, messages, phone, contactPhone, contactName, instanceId, instanceBackendId);
}

interface InternalRequest extends Request {
  isInternal?: boolean;
  userId?: string;
}

async function internalOrAuthMiddleware(req: InternalRequest, res: Response, next: NextFunction) {
  const internalSecret = req.headers['x-internal-secret'];
  
  if (internalSecret === INTERNAL_AGENT_SECRET) {
    const { business_id } = req.body;
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required for internal calls' });
    }
    
    const business = await prisma.business.findUnique({
      where: { id: business_id },
      include: { user: true }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!business.botEnabled) {
      return res.json({ action: 'manual', message: 'Bot is disabled', botEnabled: false });
    }
    
    const subscriptionStatus = business.user.subscriptionStatus;
    if (!['TRIAL', 'ACTIVE'].includes(subscriptionStatus)) {
      return res.status(403).json({ error: 'Active subscription required for AI agent' });
    }
    
    req.isInternal = true;
    req.userId = business.userId;
    return next();
  }
  
  authMiddleware(req as AuthRequest, res, (err?: any) => {
    if (err) return next(err);
    requireActiveSubscription(req as AuthRequest, res, next);
  });
}

import { isBufferActive, setBufferActive, clearBufferActive } from '../services/bufferStateService.js';

const activeBuffers = new Map<string, NodeJS.Timeout>();

async function processExpiredBuffersLegacy() {
  try {
    const now = new Date();
    const lockUntil = new Date(Date.now() + 7200000);
    
    const expiredBuffers = await prisma.messageBuffer.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          { processingUntil: null },
          { processingUntil: { lt: now } }
        ]
      }
    });
    
    for (const buffer of expiredBuffers) {
      const bufferKey = `${buffer.businessId}:${buffer.contactPhone}`;
      
      if (activeBuffers.has(bufferKey)) {
        continue;
      }
      
      const claimed = await prisma.messageBuffer.updateMany({
        where: {
          id: buffer.id,
          OR: [
            { processingUntil: null },
            { processingUntil: { lt: now } }
          ]
        },
        data: {
          processingUntil: lockUntil
        }
      });
      
      if (claimed.count === 0) {
        continue;
      }
      
      try {
        console.log(`[BUFFER-WORKER] Processing expired buffer for ${bufferKey}`);
        const messages = buffer.messages as string[];
        
        const business = await prisma.business.findUnique({
          where: { id: buffer.businessId }
        });
        
        const instance = await prisma.whatsAppInstance.findFirst({
          where: { businessId: buffer.businessId }
        });
        
        if (!business || !business.botEnabled) {
          await prisma.messageBuffer.delete({ where: { id: buffer.id } });
          continue;
        }
        
        const contactJid = `${buffer.contactPhone}@s.whatsapp.net`;
        const resolvedBackendId = instance?.instanceBackendId || `biz_${buffer.businessId.substring(0, 8)}`;
        
        await processWithAgentQueued(
          buffer.businessId,
          messages,
          contactJid,
          buffer.contactPhone,
          '',
          instance?.id,
          resolvedBackendId
        );
        
        await prisma.messageBuffer.delete({ where: { id: buffer.id } });
      } catch (error) {
        console.error(`[BUFFER-WORKER] Error processing buffer ${bufferKey}:`, error);
        await prisma.messageBuffer.update({
          where: { id: buffer.id },
          data: { processingUntil: null }
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[BUFFER-WORKER] Error in buffer worker:', error);
  }
}

let legacyBufferInterval: NodeJS.Timeout | null = null;

export function startLegacyBufferProcessor(): void {
  if (legacyBufferInterval) return;
  legacyBufferInterval = setInterval(processExpiredBuffersLegacy, 5000);
  console.log('[Agent] Legacy buffer processor started');
}

export function stopLegacyBufferProcessor(): void {
  if (legacyBufferInterval) {
    clearInterval(legacyBufferInterval);
    legacyBufferInterval = null;
    console.log('[Agent] Legacy buffer processor stopped');
  }
}

const S3_BASE_URL = process.env.MINIO_PUBLIC_URL || 'https://memoriaback.iamhuble.space/n8nback';

interface MediaItem {
  type: 'image' | 'file' | 'video';
  url: string;
  fileName?: string;
  mimeType?: string;
  originalMatch: string;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'webm'];
const FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar'];

const MIME_TYPES: Record<string, string> = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'avi': 'video/x-msvideo',
  'webm': 'video/webm',
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'zip': 'application/zip',
  'rar': 'application/vnd.rar'
};

function cleanMarkdownForWhatsApp(text: string): string {
  let cleaned = text;
  // Remove image markdown syntax ![text](url) - extract just the URL
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2');
  // Remove link markdown syntax [text](url) - extract just the URL
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/\*+/g, '');
  cleaned = cleaned.replace(/^#+\s*/gm, '');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function extractMediaFromText(text: string): { mediaItems: MediaItem[]; cleanedText: string } {
  const mediaItems: MediaItem[] = [];
  let cleanedText = text;
  const seenUrls = new Set<string>();
  
  const allExtensions = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...FILE_EXTENSIONS].join('|');
  const urlPattern = new RegExp(`(https?:\\/\\/[^\\s]+\\.(${allExtensions}))(?:\\s|$|[)\\]"'])`, 'gi');
  
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[1];
    const ext = url.split('.').pop()?.toLowerCase() || '';
    
    // Skip duplicates
    if (seenUrls.has(url)) {
      cleanedText = cleanedText.replace(match[1], '').trim();
      continue;
    }
    seenUrls.add(url);
    
    let type: 'image' | 'file' | 'video' = 'file';
    if (IMAGE_EXTENSIONS.includes(ext)) type = 'image';
    else if (VIDEO_EXTENSIONS.includes(ext)) type = 'video';
    
    mediaItems.push({
      type,
      url,
      fileName: url.split('/').pop() || `file.${ext}`,
      mimeType: MIME_TYPES[ext] || 'application/octet-stream',
      originalMatch: match[1]
    });
    
    cleanedText = cleanedText.replace(match[1], '').trim();
  }
  
  const s3CodePattern = /\b([a-z0-9]{6})\.(png|jpg|jpeg|gif|webp|pdf|mp4|mov)\b/gi;
  while ((match = s3CodePattern.exec(text)) !== null) {
    const code = match[1].toLowerCase();
    const ext = match[2].toLowerCase();
    
    let type: 'image' | 'file' | 'video' = 'file';
    if (IMAGE_EXTENSIONS.includes(ext)) type = 'image';
    else if (VIDEO_EXTENSIONS.includes(ext)) type = 'video';
    
    mediaItems.push({
      type,
      url: `${S3_BASE_URL}/${code}.${ext}`,
      fileName: `${code}.${ext}`,
      mimeType: MIME_TYPES[ext] || 'application/octet-stream',
      originalMatch: match[0]
    });
    
    cleanedText = cleanedText.replace(match[0], '').trim();
  }
  
  const bareCodePattern = /\b([a-z0-9]{6})\b/gi;
  const existingCodes = new Set(mediaItems.map(m => m.url));
  
  while ((match = bareCodePattern.exec(text)) !== null) {
    const code = match[1];
    if (/^[a-z0-9]{6}$/i.test(code) && /[a-z]/i.test(code) && /[0-9]/.test(code)) {
      const url = `${S3_BASE_URL}/${code.toLowerCase()}`;
      if (!existingCodes.has(url) && !existingCodes.has(`${url}.png`)) {
        mediaItems.push({
          type: 'image',
          url,
          fileName: `${code.toLowerCase()}.png`,
          mimeType: 'image/png',
          originalMatch: match[0]
        });
        existingCodes.add(url);
        cleanedText = cleanedText.replace(new RegExp(`\\b${code}\\b`, 'g'), '').trim();
      }
    }
  }
  
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
  
  return { mediaItems, cleanedText };
}

async function sendMedia(
  instanceBackendId: string,
  to: string,
  media: MediaItem
): Promise<boolean> {
  try {
    if (media.type === 'image') {
      await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendImage`, {
        to,
        url: media.url,
        caption: ''
      });
      console.log(`Image sent: ${media.url}`);
      return true;
    }
    
    if (media.type === 'video') {
      await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendVideo`, {
        to,
        url: media.url,
        caption: ''
      });
      console.log(`Video sent: ${media.url}`);
      return true;
    }
    
    if (media.type === 'file') {
      await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendFile`, {
        to,
        url: media.url,
        fileName: media.fileName || 'document.pdf',
        mimeType: media.mimeType || 'application/pdf'
      });
      console.log(`File sent: ${media.url}`);
      return true;
    }
    
    return false;
  } catch (error: any) {
    console.error(`Failed to send media ${media.url}:`, error.message);
    return false;
  }
}

function interpolateString(template: string, args: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = args[key];
    return value !== undefined ? String(value) : '';
  });
}

function interpolateValue(value: any, args: Record<string, any>): any {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
      const key = trimmed.slice(2, -2);
      return args[key] !== undefined ? args[key] : value;
    }
    return interpolateString(value, args);
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolateValue(item, args));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateValue(v, args);
    }
    return result;
  }
  return value;
}

async function executeExternalTool(tool: any, args: any): Promise<string> {
  try {
    const url = interpolateString(tool.url, args);
    
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tool.headers) {
      const rawHeaders = tool.headers as Record<string, string>;
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key] = interpolateString(String(value), args);
      }
    }
    
    let body = args;
    if (tool.bodyTemplate) {
      body = interpolateValue(tool.bodyTemplate, args);
    }
    
    const fetchOptions: RequestInit = {
      method: tool.method || 'POST',
      headers
    };
    
    if (tool.method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, fetchOptions);
    
    const data = await response.text();
    try {
      return JSON.stringify(JSON.parse(data));
    } catch {
      return data;
    }
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
}

function chunkByMaxChars(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > maxChars) {
    let cutPoint = remaining.lastIndexOf(' ', maxChars);
    if (cutPoint <= 0) cutPoint = maxChars;
    chunks.push(remaining.substring(0, cutPoint).trim());
    remaining = remaining.substring(cutPoint).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function smartSplitMessage(text: string, maxChars: number = 350): string[] {
  if (text.length <= maxChars) return [text];
  
  const byParagraphs = text.split(/\n{2,}/).filter(p => p.trim());
  if (byParagraphs.length > 1) {
    const result: string[] = [];
    for (const para of byParagraphs) {
      if (para.length > maxChars) {
        result.push(...chunkByMaxChars(para, maxChars));
      } else {
        result.push(para.trim());
      }
    }
    return result;
  }
  
  const bySingleNewline = text.split(/\n/).filter(p => p.trim());
  if (bySingleNewline.length > 1) {
    const merged: string[] = [];
    let current = '';
    for (const line of bySingleNewline) {
      if ((current + '\n' + line).length > maxChars && current) {
        if (current.length > maxChars) {
          merged.push(...chunkByMaxChars(current, maxChars));
        } else {
          merged.push(current.trim());
        }
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) {
      if (current.length > maxChars) {
        merged.push(...chunkByMaxChars(current, maxChars));
      } else {
        merged.push(current.trim());
      }
    }
    return merged;
  }
  
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 1) {
    const parts: string[] = [];
    let current = '';
    
    for (const sentence of sentences) {
      if ((current + sentence).length > maxChars && current) {
        if (current.length > maxChars) {
          parts.push(...chunkByMaxChars(current, maxChars));
        } else {
          parts.push(current.trim());
        }
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) {
      if (current.length > maxChars) {
        parts.push(...chunkByMaxChars(current, maxChars));
      } else {
        parts.push(current.trim());
      }
    }
    return parts;
  }
  
  return chunkByMaxChars(text, maxChars);
}

function calculateTypingDelay(text: string): number {
  const baseDelay = 300;
  const charsPerSecond = 25;
  const calculated = baseDelay + (text.length / charsPerSecond) * 1000;
  const randomFactor = 0.8 + Math.random() * 0.4;
  return Math.min(Math.max(calculated * randomFactor, 500), 3000);
}

async function sendMessageInParts(
  instanceBackendId: string,
  to: string,
  message: string,
  splitMessages: boolean
): Promise<{ sentMedia: MediaItem[] }> {
  const { mediaItems, cleanedText } = extractMediaFromText(message);
  const finalText = cleanMarkdownForWhatsApp(cleanedText);
  const sentMedia: MediaItem[] = [];
  
  if (finalText) {
    if (!splitMessages) {
      await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
        to,
        message: finalText
      });
    } else {
      const parts = smartSplitMessage(finalText);
      
      for (let i = 0; i < parts.length; i++) {
        const delay = calculateTypingDelay(parts[i]);
        
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
          to,
          message: parts[i]
        });
      }
    }
  }
  
  for (const media of mediaItems) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const sent = await sendMedia(instanceBackendId, to, media);
    if (sent) {
      sentMedia.push(media);
    }
  }
  
  return { sentMedia };
}

async function processWithAgentV2(
  business: any,
  messages: string[],
  contactPhone: string,
  contactName: string,
  phone: string,
  instanceBackendId?: string
): Promise<{ response: string; tokensUsed?: number }> {
  const historyLimit = business.promptMaster?.historyLimit || 10;
  const splitMessages = business.promptMaster?.splitMessages ?? true;
  
  const recentMessages = await prisma.messageLog.findMany({
    where: { 
      businessId: business.id,
      OR: [
        { sender: contactPhone },
        { recipient: contactPhone }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: historyLimit
  });
  
  const userTools = business.promptMaster?.tools || [];
  const toolsConfig = userTools.map((t: any) => ({
    name: t.name,
    description: t.description,
    url: t.url,
    method: t.method || 'POST',
    headers: t.headers,
    bodyTemplate: t.bodyTemplate,
    parameters: t.parameters,
    enabled: t.enabled ?? true
  }));
  
  const conversationHistory = buildConversationHistory(recentMessages.reverse());
  const businessContext = buildBusinessContext(
    business, 
    business.promptMaster?.prompt,
    toolsConfig
  );
  
  const combinedMessage = messages.join('\n');
  
  const result = await generateWithAgentV2({
    business_context: businessContext,
    conversation_history: conversationHistory,
    current_message: combinedMessage,
    sender_phone: contactPhone,
    sender_name: contactName || undefined
  });
  
  if (!result.success) {
    console.error('Agent V2 failed:', result.error);
    throw new Error(result.error || 'Agent V2 failed to generate response');
  }
  
  if (result.tokens_used) {
    await logTokenUsage({
      businessId: business.id,
      userId: business.userId,
      feature: 'agent_v2',
      model: result.model || 'gpt-4o-mini',
      promptTokens: Math.floor(result.tokens_used * 0.7),
      completionTokens: Math.floor(result.tokens_used * 0.3),
      totalTokens: result.tokens_used
    });
  }
  
  const aiResponse = result.response || '';
  
  // Send response to WhatsApp
  const instance = business.instances?.[0];
  const backendId = instanceBackendId || instance?.instanceBackendId;
  
  if (backendId && aiResponse) {
    try {
      // Mark messages as read before responding
      try {
        await axios.post(`${WA_API_URL}/instances/${backendId}/markAsRead`, {
          from: phone
        });
      } catch (readError: any) {
        console.log('Could not mark messages as read:', readError.message);
      }
      
      // Send the message
      const { sentMedia } = await sendMessageInParts(backendId, phone, aiResponse, splitMessages);
      
      // Log the outbound message
      await prisma.messageLog.create({
        data: {
          businessId: business.id,
          instanceId: instance?.id,
          direction: 'outbound',
          recipient: contactPhone,
          message: aiResponse,
          metadata: {
            contactJid: phone,
            contactPhone,
            contactName: contactName || '',
            agentVersion: 'v2',
            splitMessages,
            sentMedia: sentMedia.length > 0 ? sentMedia.map((m: any) => ({ type: m.type, url: m.url })) : undefined
          }
        }
      });
      
      console.log(`[Agent V2] Response sent to ${contactPhone}:`, aiResponse.substring(0, 100));
    } catch (sendError: any) {
      console.error('Failed to send WhatsApp message (V2):', sendError.response?.data || sendError.message);
    }
  }
  
  return { 
    response: aiResponse, 
    tokensUsed: result.tokens_used 
  };
}

async function processWithAgent(
  businessId: string,
  messages: string[],
  phone: string,
  contactPhone: string,
  contactName: string,
  instanceId?: string,
  instanceBackendIdParam?: string
): Promise<{ response: string; tokensUsed?: number }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      policy: true,
      promptMaster: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: { include: { metaCredential: true } },
      user: { select: { isPro: true, paymentLinkEnabled: true } }
    }
  });
  
  if (!business) {
    throw new Error('Business not found');
  }
  
  if (!business.botEnabled) {
    return { response: '' };
  }
  
  if (business.agentVersion === 'v2') {
    let instance = business.instances?.[0];
    let backendId = instanceBackendIdParam || instance?.instanceBackendId;
    
    // Fallback: generate backendId dynamically if still null
    if (!backendId && instanceId) {
      const foundInstance = business.instances?.find((i: any) => i.id === instanceId);
      if (foundInstance) {
        instance = foundInstance;
        backendId = foundInstance.instanceBackendId;
      } else {
        const dbInstance = await prisma.whatsAppInstance.findUnique({
          where: { id: instanceId }
        });
        if (dbInstance && dbInstance.instanceBackendId) {
          backendId = dbInstance.instanceBackendId;
          console.log(`[Agent V2] Instance loaded from DB: ${instanceId} -> backendId: ${backendId}`);
        }
      }
    }
    
    // Ultimate fallback: generate from businessId
    if (!backendId) {
      backendId = `biz_${businessId.substring(0, 8)}`;
      console.log(`[Agent V2] Generated fallback backendId: ${backendId}`);
    }
    
    console.log(`[Agent V2] Using backendId: ${backendId} (from param: ${!!instanceBackendIdParam}, fallback: ${!instanceBackendIdParam && !instance?.instanceBackendId})`);
    
    try {
      const v2Available = await isAgentV2Available();
      if (!v2Available) {
        console.log('[Agent V2] Service unavailable, falling back to V1');
      } else {
        return await processWithAgentV2(business, messages, contactPhone, contactName, phone, backendId || undefined);
      }
    } catch (v2Error: any) {
      console.error('[Agent V2] Error, falling back to V1:', v2Error.message);
    }
  }
  
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured. Contact administrator.');
  }
  
  const openai = getOpenAIClient();
  const promptConfig = business.promptMaster;
  const historyLimit = promptConfig?.historyLimit || 10;
  const splitMessages = promptConfig?.splitMessages ?? true;
  const tools = promptConfig?.tools || [];
  
  let systemPrompt = promptConfig?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
  
  if (business.policy) {
    systemPrompt += `\n\n## Políticas del negocio:`;
    if (business.policy.shippingPolicy) {
      systemPrompt += `\n- Envíos: ${business.policy.shippingPolicy}`;
    }
    if (business.policy.refundPolicy) {
      systemPrompt += `\n- Devoluciones: ${business.policy.refundPolicy}`;
    }
    if (business.policy.brandVoice) {
      systemPrompt += `\n- Tono de marca: ${business.policy.brandVoice}`;
    }
  }
  
  const currencySymbol = business.currencySymbol || 'S/.';
  const productCount = business.products?.length || 0;
  
  if (productCount > 0 && productCount <= 20) {
    systemPrompt += `\n\n## Catálogo de productos:`;
    business.products.forEach((product: any) => {
      systemPrompt += `\n- [ID:${product.id}] ${product.title}: ${currencySymbol}${product.price}`;
      if (product.stock !== undefined) {
        systemPrompt += ` (Stock: ${product.stock})`;
      }
      if (product.description) {
        systemPrompt += ` - ${product.description}`;
      }
      if (product.imageUrl) {
        systemPrompt += ` [IMG:${product.imageUrl}]`;
      }
    });
    systemPrompt += `\n\n## Reglas para responder sobre productos:`;
    systemPrompt += `\n- Si el cliente pregunta de forma general (ej: "precio de motos", "qué KTM tienen"), PRIMERO pregunta qué modelo específico le interesa antes de mostrar todo el catálogo.`;
    systemPrompt += `\n- Solo cuando el cliente especifique un modelo concreto, muestra los detalles de ese producto.`;
    systemPrompt += `\n- Para enviar imagen de UN producto específico, incluye SOLO la URL completa (https://...) al final de tu mensaje. NO uses sintaxis Markdown como ![texto](url).`;
    systemPrompt += `\n- NUNCA incluyas más de UNA URL de imagen por mensaje.`;
    systemPrompt += `\n- Si un producto tiene stock 0, indica que está agotado y ofrece alternativas.`;
    systemPrompt += `\n- IMPORTANTE: Para generar enlaces de pago, SIEMPRE usa el ID del producto (el valor después de "ID:"), NO el nombre.`;
  } else if (productCount > 20) {
    systemPrompt += `\n\n## Catálogo de productos:`;
    systemPrompt += `\nTienes acceso a un catálogo extenso de ${productCount} productos con BÚSQUEDA INTELIGENTE.`;
    systemPrompt += `\nLos precios están en ${business.currencyCode || 'PEN'} (${currencySymbol}).`;
    systemPrompt += `\n\n## Reglas para responder sobre productos:`;
    systemPrompt += `\n- Cuando el cliente mencione un producto (aunque no sea exactamente igual), usa buscar_producto inmediatamente.`;
    systemPrompt += `\n- La búsqueda es inteligente: encontrará productos similares aunque el cliente escriba con errores o use términos parciales.`;
    systemPrompt += `\n- CONFÍA en el resultado "mejor_coincidencia" - es el producto más parecido a lo que busca el cliente.`;
    systemPrompt += `\n- Si la similitud es alta (>70%), puedes asumir que es el producto correcto.`;
    systemPrompt += `\n- Para enviar imagen de UN producto específico, incluye SOLO la URL completa (https://...) al final. NO uses sintaxis Markdown.`;
    systemPrompt += `\n- NUNCA incluyas más de UNA URL de imagen por mensaje.`;
    systemPrompt += `\n- Si un producto tiene stock 0, indica que está agotado y sugiere productos similares del resultado.`;
  }
  
  const contactAssignment = await prisma.tagAssignment.findUnique({
    where: {
      businessId_contactPhone: {
        businessId,
        contactPhone: contactPhone
      }
    },
    include: {
      tag: {
        include: {
          stagePrompt: true
        }
      }
    }
  });
  
  if (contactAssignment?.tag) {
    const tag = contactAssignment.tag;
    systemPrompt += `\n\n## Estado actual del cliente:`;
    systemPrompt += `\n- Etapa: ${tag.name}`;
    if (tag.description) {
      systemPrompt += `\n- Contexto de etapa: ${tag.description}`;
    }
    
    if (tag.stagePrompt) {
      if (tag.stagePrompt.systemContext) {
        systemPrompt += `\n\n## Instrucciones especiales para esta etapa:\n${tag.stagePrompt.systemContext}`;
      }
      if (tag.stagePrompt.promptOverride) {
        systemPrompt = tag.stagePrompt.promptOverride + `\n\n${systemPrompt}`;
      }
    }
  }
  
  const pendingVoucherOrder = await prisma.order.findFirst({
    where: {
      businessId,
      contactPhone: contactPhone.replace(/\D/g, ''),
      status: 'AWAITING_VOUCHER'
    },
    orderBy: { createdAt: 'desc' },
    include: { items: true }
  });
  
  if (pendingVoucherOrder) {
    const productNames = pendingVoucherOrder.items.map(i => i.productTitle).join(', ');
    systemPrompt += `\n\n## PEDIDO PENDIENTE DE PAGO:`;
    systemPrompt += `\n- El cliente tiene un pedido pendiente de comprobante de pago`;
    systemPrompt += `\n- Productos: ${productNames}`;
    systemPrompt += `\n- Total: ${pendingVoucherOrder.currencySymbol}${pendingVoucherOrder.totalAmount.toFixed(2)}`;
    
    if (pendingVoucherOrder.voucherImageUrl) {
      systemPrompt += `\n- COMPROBANTE RECIBIDO: El cliente ya envió su comprobante de pago. Agradécele y confirma que el equipo revisará el pago pronto.`;
    } else {
      systemPrompt += `\n- Recuerda pedirle amablemente que envíe el comprobante de pago (foto del voucher/transferencia) para confirmar su pedido.`;
    }
  }
  
  systemPrompt = replacePromptVariables(systemPrompt, business.timezone || 'America/Lima');
  
  // Load agent files for file library feature
  const agentFiles = await prisma.agentFile.findMany({
    where: { 
      prompt: { businessId },
      enabled: true 
    },
    orderBy: { order: 'asc' }
  });
  
  if (agentFiles.length > 0) {
    systemPrompt += `\n\n## Archivos disponibles para enviar:`;
    systemPrompt += `\nTienes acceso a ${agentFiles.length} archivos que puedes enviar al cliente cuando sea relevante.`;
    systemPrompt += `\nUsa la función enviar_archivo cuando el cliente pregunte por alguno de estos temas o cuando sea apropiado según el contexto:`;
    agentFiles.forEach((file, idx) => {
      systemPrompt += `\n- [ID:${file.id}] ${file.name}`;
      if (file.description) systemPrompt += `: ${file.description}`;
      if (file.triggerKeywords) systemPrompt += ` (keywords: ${file.triggerKeywords})`;
      if (file.triggerContext) systemPrompt += ` | Enviar cuando: ${file.triggerContext}`;
    });
    systemPrompt += `\n\nIMPORTANTE: Cuando detectes que el cliente pregunta por algo relacionado a estos archivos (por keywords o contexto), usa enviar_archivo con el ID correspondiente.`;
  }
  
  const recentMessages = await prisma.messageLog.findMany({
    where: { 
      businessId,
      OR: [
        { sender: contactPhone },
        { recipient: contactPhone },
        { sender: phone },
        { recipient: phone }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: historyLimit
  });
  
  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = 
    recentMessages.reverse().map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant' as const,
      content: msg.message || ''
    }));
  
  const combinedUserMessage = messages.join('\n');
  conversationHistory.push({ role: 'user', content: combinedUserMessage });
  
  const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map(tool => {
    const toolParams = (tool.parameters as any[]) || [];
    const properties: Record<string, any> = {};
    const required: string[] = [];
    
    if (toolParams.length > 0) {
      toolParams.forEach((param: any) => {
        properties[param.name] = {
          type: param.type || 'string',
          description: param.description || `Parameter ${param.name}`
        };
        if (param.required) {
          required.push(param.name);
        }
      });
    } else {
      properties['query'] = { type: 'string', description: 'The query or data to send to the external service' };
      required.push('query');
    }
    
    return {
      type: 'function' as const,
      function: {
        name: tool.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required
        }
      }
    };
  });
  
  if (productCount > 20) {
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: 'buscar_producto',
        description: 'Busca productos en el catálogo por nombre o descripción. Usa esta función cuando el cliente pregunte por un producto específico.',
        parameters: {
          type: 'object',
          properties: {
            consulta: {
              type: 'string',
              description: 'Término de búsqueda: nombre del producto o palabras clave de la descripción'
            }
          },
          required: ['consulta']
        }
      }
    });
  }
  
  if (productCount > 0) {
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: 'crear_enlace_pago',
        description: 'Genera un enlace de pago para que el cliente complete su compra. Usa esta función cuando el cliente confirme que quiere comprar un producto y tengas todos sus datos de envío.',
        parameters: {
          type: 'object',
          properties: {
            producto_id: {
              type: 'string',
              description: 'ID del producto que el cliente quiere comprar'
            },
            cantidad: {
              type: 'integer',
              description: 'Cantidad de unidades a comprar (por defecto 1)'
            },
            nombre_cliente: {
              type: 'string',
              description: 'Nombre completo del cliente'
            },
            direccion_envio: {
              type: 'string',
              description: 'Dirección completa de envío'
            },
            ciudad: {
              type: 'string',
              description: 'Ciudad de envío'
            },
            pais: {
              type: 'string',
              description: 'País de envío'
            }
          },
          required: ['producto_id', 'nombre_cliente', 'direccion_envio']
        }
      }
    });
  }
  
  if (business.businessObjective === 'APPOINTMENTS') {
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: 'consultar_disponibilidad',
        description: 'Consulta los horarios disponibles para agendar una cita en una fecha específica.',
        parameters: {
          type: 'object',
          properties: {
            fecha: {
              type: 'string',
              description: 'Fecha para consultar disponibilidad en formato YYYY-MM-DD'
            }
          },
          required: ['fecha']
        }
      }
    });
    
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: 'agendar_cita',
        description: 'Agenda una cita con el cliente en la fecha y hora especificada. Usa esta función cuando el cliente confirme que quiere agendar una cita y hayas verificado disponibilidad.',
        parameters: {
          type: 'object',
          properties: {
            fecha_hora: {
              type: 'string',
              description: 'Fecha y hora de la cita en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss)'
            },
            nombre_cliente: {
              type: 'string',
              description: 'Nombre completo del cliente'
            },
            servicio: {
              type: 'string',
              description: 'Tipo de servicio o motivo de la cita'
            },
            duracion_minutos: {
              type: 'integer',
              description: 'Duración de la cita en minutos (por defecto 60)'
            },
            notas: {
              type: 'string',
              description: 'Notas adicionales sobre la cita'
            }
          },
          required: ['fecha_hora', 'nombre_cliente']
        }
      }
    });
  }
  
  // Add file sending tool if agent files exist
  if (agentFiles.length > 0) {
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: 'enviar_archivo',
        description: 'Envía un archivo (documento, imagen, catálogo, plano, etc.) al cliente. Usa esta función cuando el cliente pregunte por información que está disponible en los archivos del negocio.',
        parameters: {
          type: 'object',
          properties: {
            archivo_id: {
              type: 'string',
              description: 'ID del archivo a enviar (obtenido de la lista de archivos disponibles)'
            },
            mensaje_acompanante: {
              type: 'string',
              description: 'Mensaje breve que acompaña al archivo (ej: "Aquí tienes nuestro catálogo de departamentos")'
            }
          },
          required: ['archivo_id']
        }
      }
    });
  }
  
  const modelToUse = getDefaultModel();
  
  const chatParams: any = {
    model: modelToUse,
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory
    ],
    max_tokens: 800,
    temperature: 0.7
  };
  
  if (openaiTools.length > 0) {
    chatParams.tools = openaiTools;
    chatParams.tool_choice = 'auto';
  }
  
  let completion = await openai.chat.completions.create(chatParams);
  let totalTokens = completion.usage?.total_tokens || 0;
  let totalPromptTokens = completion.usage?.prompt_tokens || 0;
  let totalCompletionTokens = completion.usage?.completion_tokens || 0;
  
  const userId = business.userId;
  
  while (completion.choices[0]?.message?.tool_calls) {
    const toolCalls = completion.choices[0].message.tool_calls;
    const toolMessages: any[] = [completion.choices[0].message];
    
    for (const toolCall of toolCalls) {
      const fn = (toolCall as any).function;
      const toolName = fn.name;
      
      if (toolName === 'buscar_producto') {
        const args = JSON.parse(fn.arguments);
        const searchQuery = args.consulta || args.query || '';
        
        console.log(`[PRODUCT SEARCH] Query: "${searchQuery}" (intelligent matching)`);
        
        const searchResult = await searchProductsIntelligent(businessId, searchQuery, 10);
        
        const productResults = searchResult.products.map(p => ({
          id: p.id,
          nombre: p.title,
          precio: `${currencySymbol}${p.price}`,
          stock: p.stock,
          disponible: p.available,
          descripcion: p.description || 'Sin descripción',
          imagen: p.imageUrl || null,
          similitud: Math.round(p.similarity * 100)
        }));
        
        let resultContent: string;
        if (productResults.length > 0) {
          const bestMatch = searchResult.bestMatch;
          resultContent = JSON.stringify({
            productos_encontrados: productResults,
            coincidencia_exacta: searchResult.exactMatch,
            mejor_coincidencia: bestMatch ? {
              nombre: bestMatch.title,
              similitud: Math.round(bestMatch.similarity * 100) + '%'
            } : null,
            nota: searchResult.exactMatch 
              ? 'Se encontró una coincidencia exacta' 
              : 'Se muestran los productos más similares a la búsqueda'
          });
        } else {
          resultContent = JSON.stringify({ 
            mensaje: `No se encontraron productos similares a "${searchQuery}"`,
            sugerencia: 'Intenta con otro término o pregunta al cliente por más detalles'
          });
        }
        
        console.log(`[PRODUCT SEARCH] Found ${productResults.length} products (exact: ${searchResult.exactMatch})`);
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultContent
        });
        continue;
      }
      
      if (toolName === 'crear_enlace_pago') {
        const args = JSON.parse(fn.arguments);
        let productId = args.producto_id;
        const quantity = args.cantidad || 1;
        const customerName = args.nombre_cliente;
        const shippingAddress = args.direccion_envio;
        const city = args.ciudad || '';
        const country = args.pais || '';
        
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId);
        if (!isUUID) {
          console.log(`[PAYMENT LINK] productId "${productId}" is not a UUID, searching by name...`);
          const productByName = await prisma.product.findFirst({
            where: {
              businessId,
              title: { contains: productId, mode: 'insensitive' }
            }
          });
          if (productByName) {
            console.log(`[PAYMENT LINK] Found product by name: ${productByName.id} (${productByName.title})`);
            productId = productByName.id;
          } else {
            console.log(`[PAYMENT LINK] No product found matching name "${productId}"`);
          }
        }
        
        const canUsePaymentLink = business.user?.paymentLinkEnabled || false;
        console.log(`[PAYMENT LINK] Creating for product ${productId}, quantity ${quantity}, paymentLinkEnabled: ${canUsePaymentLink}`);
        
        let paymentResult: string;
        
        if (!canUsePaymentLink) {
          const product = await prisma.product.findUnique({
            where: { id: productId }
          });
          
          if (!product) {
            paymentResult = JSON.stringify({
              exito: false,
              error: 'Producto no encontrado'
            });
            await prisma.paymentLinkRequest.create({
              data: {
                businessId,
                contactPhone,
                triggerSource: 'agent',
                productId,
                isSuccess: false,
                failureReason: 'Producto no encontrado',
                isPro: false
              }
            });
          } else {
            const totalAmount = product.price * quantity;
            const order = await prisma.order.create({
              data: {
                businessId,
                contactPhone,
                contactName: customerName,
                shippingAddress,
                shippingCity: city,
                shippingCountry: country,
                totalAmount,
                currencyCode: business.currencyCode || 'PEN',
                currencySymbol: business.currencySymbol || 'S/.',
                status: 'AWAITING_VOUCHER',
                items: {
                  create: [{
                    productId: product.id,
                    productTitle: product.title,
                    quantity,
                    unitPrice: product.price,
                    imageUrl: product.imageUrl
                  }]
                }
              }
            });
            
            await prisma.paymentLinkRequest.create({
              data: {
                businessId,
                contactPhone,
                triggerSource: 'agent',
                productId: product.id,
                productName: product.title,
                amount: totalAmount,
                quantity,
                isSuccess: true,
                orderId: order.id,
                isPro: false
              }
            });
            
            paymentResult = JSON.stringify({
              exito: true,
              mensaje: 'Pedido creado exitosamente',
              pedido_id: order.id,
              esperando_voucher: true,
              instrucciones: 'Pide al cliente que envíe el comprobante de pago (voucher/transferencia) para confirmar su pedido.'
            });
            console.log(`[PAYMENT LINK] Order created with AWAITING_VOUCHER status: ${order.id}`);
          }
        } else {
          const product = await prisma.product.findUnique({
            where: { id: productId }
          });
          
          const result = await createProductPaymentLink({
            businessId,
            contactPhone,
            contactName: customerName,
            items: [{ productId, quantity }],
            shippingAddress,
            shippingCity: city,
            shippingCountry: country
          });
          
          if (result.success && result.paymentUrl) {
            await prisma.paymentLinkRequest.create({
              data: {
                businessId,
                contactPhone,
                triggerSource: 'agent',
                productId,
                productName: product?.title,
                amount: result.totalAmount,
                quantity,
                isSuccess: true,
                orderId: result.orderId,
                paymentSessionId: result.paymentSessionId,
                isPro: true
              }
            });
            
            paymentResult = JSON.stringify({
              exito: true,
              mensaje: 'Enlace de pago generado exitosamente',
              enlace_pago: result.paymentUrl,
              pedido_id: result.orderId,
              instrucciones: 'Comparte este enlace con el cliente para que complete su pago de forma segura.'
            });
            console.log(`[PAYMENT LINK] Created successfully: ${result.paymentUrl}`);
          } else {
            await prisma.paymentLinkRequest.create({
              data: {
                businessId,
                contactPhone,
                triggerSource: 'agent',
                productId,
                productName: product?.title,
                quantity,
                isSuccess: false,
                failureReason: result.error || 'No se pudo generar el enlace de pago',
                isPro: true
              }
            });
            
            paymentResult = JSON.stringify({
              exito: false,
              error: result.error || 'No se pudo generar el enlace de pago'
            });
            console.log(`[PAYMENT LINK] Failed: ${result.error}`);
          }
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: paymentResult
        });
        continue;
      }
      
      if (toolName === 'consultar_disponibilidad') {
        const args = JSON.parse(fn.arguments);
        const fecha = args.fecha;
        
        console.log(`[APPOINTMENT] Checking availability for ${fecha}`);
        
        try {
          const response = await axios.get(
            `${process.env.CORE_API_URL || 'http://localhost:3001'}/appointments/internal/availability`,
            {
              params: { businessId, date: fecha },
              headers: { 'x-internal-secret': INTERNAL_AGENT_SECRET }
            }
          );
          
          const data = response.data;
          let resultContent: string;
          
          if (data.available) {
            const availableSlots = data.slots.filter((s: any) => s.available);
            resultContent = JSON.stringify({
              disponible: true,
              horario_atencion: data.businessHours,
              horarios_disponibles: availableSlots.map((s: any) => s.time),
              horarios_ocupados: data.existingAppointments,
              nota: availableSlots.length > 0 
                ? `Hay ${availableSlots.length} horarios disponibles` 
                : 'Todos los horarios están ocupados para esta fecha'
            });
          } else {
            resultContent = JSON.stringify({
              disponible: false,
              razon: data.reason || 'No hay disponibilidad para esta fecha'
            });
          }
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent
          });
        } catch (error: any) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: 'Error consultando disponibilidad', detalle: error.message })
          });
        }
        continue;
      }
      
      if (toolName === 'agendar_cita') {
        const args = JSON.parse(fn.arguments);
        const fechaHora = args.fecha_hora;
        const nombreCliente = args.nombre_cliente;
        const servicio = args.servicio || '';
        const duracion = args.duracion_minutos || 60;
        const notas = args.notas || '';
        
        console.log(`[APPOINTMENT] Scheduling for ${fechaHora}, client: ${nombreCliente}`);
        
        try {
          const response = await axios.post(
            `${process.env.CORE_API_URL || 'http://localhost:3001'}/appointments/internal/schedule`,
            {
              businessId,
              contactPhone,
              contactName: nombreCliente,
              scheduledAt: fechaHora,
              durationMinutes: duracion,
              service: servicio,
              notes: notas
            },
            {
              headers: { 'x-internal-secret': INTERNAL_AGENT_SECRET }
            }
          );
          
          const data = response.data;
          let resultContent: string;
          
          if (data.success) {
            const apt = data.appointment;
            const scheduledDate = new Date(apt.scheduledAt);
            const dateStr = scheduledDate.toLocaleDateString('es-PE', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            });
            const timeStr = scheduledDate.toLocaleTimeString('es-PE', { 
              hour: '2-digit', 
              minute: '2-digit' 
            });
            
            resultContent = JSON.stringify({
              exito: true,
              cita_id: apt.id,
              fecha: dateStr,
              hora: timeStr,
              duracion: `${apt.durationMinutes} minutos`,
              servicio: apt.service || 'No especificado',
              mensaje: `Cita agendada exitosamente para ${dateStr} a las ${timeStr}`
            });
            console.log(`[APPOINTMENT] Created successfully: ${apt.id}`);
          } else {
            resultContent = JSON.stringify({
              exito: false,
              error: data.error || 'No se pudo agendar la cita'
            });
            console.log(`[APPOINTMENT] Failed: ${data.error}`);
          }
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent
          });
        } catch (error: any) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ 
              exito: false, 
              error: 'Error al agendar la cita', 
              detalle: error.message 
            })
          });
        }
        continue;
      }
      
      // Handle file sending tool
      if (toolName === 'enviar_archivo') {
        const args = JSON.parse(fn.arguments);
        const archivoId = args.archivo_id;
        const mensajeAcompanante = args.mensaje_acompanante || '';
        
        console.log(`[AGENT FILE] Sending file ${archivoId}`);
        
        const archivo = agentFiles.find(f => f.id === archivoId);
        
        if (!archivo) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ exito: false, error: 'Archivo no encontrado' })
          });
          continue;
        }
        
        // We return the file URL so it gets sent with the response
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            exito: true,
            archivo_url: archivo.fileUrl,
            archivo_nombre: archivo.name,
            tipo: archivo.fileType,
            mensaje: mensajeAcompanante || `Enviando ${archivo.name}`,
            instruccion: `Incluye esta URL en tu respuesta para que se envíe el archivo: ${archivo.fileUrl}`
          })
        });
        
        console.log(`[AGENT FILE] File found: ${archivo.name}, URL: ${archivo.fileUrl}`);
        continue;
      }
      
      const tool = tools.find(t => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === toolName);
      
      if (tool) {
        const args = JSON.parse(fn.arguments);
        const startTime = Date.now();
        
        console.log(`[TOOL CALL] ${tool.name}:`, JSON.stringify(args));
        
        const result = await executeExternalTool(tool, args);
        const duration = Date.now() - startTime;
        
        console.log(`[TOOL RESPONSE] ${tool.name} (${duration}ms):`, result.substring(0, 500));
        
        try {
          await prisma.toolLog.create({
            data: {
              toolId: tool.id,
              businessId,
              contactPhone,
              request: args,
              response: result ? JSON.parse(result) : null,
              status: 'success',
              duration
            }
          });
        } catch (logError) {
          await prisma.toolLog.create({
            data: {
              toolId: tool.id,
              businessId,
              contactPhone,
              request: args,
              response: { raw: result },
              status: 'success',
              duration
            }
          });
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }
    }
    
    const nextParams: any = {
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        ...toolMessages
      ],
      max_tokens: 800,
      temperature: 0.7
    };
    
    if (openaiTools.length > 0) {
      nextParams.tools = openaiTools;
    }
    
    completion = await openai.chat.completions.create(nextParams);
    totalTokens += completion.usage?.total_tokens || 0;
    totalPromptTokens += completion.usage?.prompt_tokens || 0;
    totalCompletionTokens += completion.usage?.completion_tokens || 0;
  }
  
  if (totalTokens > 0) {
    await logTokenUsage({
      businessId,
      userId,
      feature: 'chat_agent',
      model: modelToUse,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens
    });
  }
  
  const aiResponse = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.';
  
  console.log(`[AI RESPONSE]:`, aiResponse.substring(0, 300));
  
  const { mediaItems } = extractMediaFromText(aiResponse);
  if (mediaItems.length > 0) {
    console.log(`[MEDIA DETECTED]:`, mediaItems.map(m => `${m.type}: ${m.url}`));
  } else {
    console.log(`[MEDIA DETECTED]: None`);
  }
  
  const instance = business.instances[0];
  if (instance) {
    try {
      let sentMedia: MediaItem[] = [];
      
      if (instance.provider === 'META_CLOUD' && instance.metaCredential) {
        console.log('[META CLOUD] Sending response via Meta Cloud API');
        const metaService = new MetaCloudService({
          accessToken: instance.metaCredential.accessToken,
          phoneNumberId: instance.metaCredential.phoneNumberId,
          businessId: instance.metaCredential.businessId
        });
        
        const { cleanedText, mediaItems } = extractMediaFromText(aiResponse);
        const finalText = cleanMarkdownForWhatsApp(cleanedText);
        
        if (finalText) {
          if (splitMessages) {
            const parts = smartSplitMessage(finalText);
            for (let i = 0; i < parts.length; i++) {
              if (i > 0) {
                const delay = calculateTypingDelay(parts[i]);
                await new Promise(resolve => setTimeout(resolve, delay));
              }
              await metaService.sendMessage({ to: contactPhone, text: parts[i] });
            }
          } else {
            await metaService.sendMessage({ to: contactPhone, text: finalText });
          }
        }
        
        for (const media of mediaItems) {
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (media.type === 'image') {
              await metaService.sendMessage({ to: contactPhone, mediaUrl: media.url, mediaType: 'image' });
            } else if (media.type === 'video') {
              await metaService.sendMessage({ to: contactPhone, mediaUrl: media.url, mediaType: 'video' });
            } else if (media.type === 'file') {
              await metaService.sendMessage({ to: contactPhone, mediaUrl: media.url, mediaType: 'document', filename: media.fileName });
            }
            sentMedia.push(media);
          } catch (mediaError: any) {
            console.error(`Failed to send media via Meta Cloud: ${media.url}`, mediaError.message);
          }
        }
      } else if (instance.instanceBackendId) {
        // Send via Baileys API
        try {
          await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/markAsRead`, {
            from: phone
          });
        } catch (readError: any) {
          console.log('Could not mark messages as read:', readError.message);
        }
        
        const result = await sendMessageInParts(instance.instanceBackendId, phone, aiResponse, splitMessages);
        sentMedia = result.sentMedia;
      }
      
      await prisma.messageLog.create({
        data: {
          businessId,
          instanceId: instance.id,
          direction: 'outbound',
          recipient: contactPhone,
          message: aiResponse,
          metadata: {
            contactJid: phone,
            contactPhone,
            contactName: contactName || '',
            provider: instance.provider,
            splitMessages,
            sentMedia: sentMedia.length > 0 ? sentMedia.map(m => ({ type: m.type, url: m.url })) : undefined
          }
        }
      });
    } catch (sendError: any) {
      console.error('Failed to send WhatsApp message:', sendError.response?.data || sendError.message);
    }
  }
  
  return { response: aiResponse, tokensUsed: totalTokens };
}

router.post('/think', internalOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { business_id, user_message, phone, phoneNumber, contactName, instanceId, instanceBackendId } = req.body;
    
    if (!business_id || !user_message || !phone) {
      return res.status(400).json({ error: 'business_id, user_message and phone are required' });
    }
    
    const contactPhone = phoneNumber || phone.replace('@s.whatsapp.net', '').replace('@lid', '');
    
    const business = await prisma.business.findUnique({
      where: { id: business_id },
      include: { promptMaster: true }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!business.botEnabled) {
      return res.json({
        action: 'manual',
        message: 'Bot is disabled',
        botEnabled: false
      });
    }
    
    const bufferSeconds = business.promptMaster?.bufferSeconds || 0;
    const bufferKey = `${business_id}:${contactPhone}`;
    
    if (bufferSeconds > 0) {
      const existingTimeout = activeBuffers.get(bufferKey);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      
      const existingBuffer = await prisma.messageBuffer.findUnique({
        where: { businessId_contactPhone: { businessId: business_id, contactPhone } }
      });
      
      const currentMessages = existingBuffer 
        ? [...(existingBuffer.messages as string[]), user_message]
        : [user_message];
      
      await prisma.messageBuffer.upsert({
        where: { businessId_contactPhone: { businessId: business_id, contactPhone } },
        create: {
          businessId: business_id,
          contactPhone,
          messages: currentMessages,
          expiresAt: new Date(Date.now() + bufferSeconds * 1000)
        },
        update: {
          messages: currentMessages,
          expiresAt: new Date(Date.now() + bufferSeconds * 1000)
        }
      });
      
      const timeout = setTimeout(async () => {
        try {
          const buffer = await prisma.messageBuffer.findUnique({
            where: { businessId_contactPhone: { businessId: business_id, contactPhone } }
          });
          
          if (buffer) {
            const messages = buffer.messages as string[];
            
            await prisma.messageBuffer.delete({
              where: { id: buffer.id }
            });
            
            activeBuffers.delete(bufferKey);
            
            await processWithAgentQueued(
              business_id,
              messages,
              phone,
              contactPhone,
              contactName,
              instanceId,
              instanceBackendId
            );
          }
        } catch (error) {
          console.error('Buffer processing error:', error);
        }
      }, bufferSeconds * 1000);
      
      activeBuffers.set(bufferKey, timeout);
      
      return res.json({
        action: 'buffered',
        message: `Message buffered, will process in ${bufferSeconds} seconds`,
        bufferSeconds,
        messagesInBuffer: currentMessages.length
      });
    }
    
    const result = await processWithAgentQueued(
      business_id,
      [user_message],
      phone,
      contactPhone,
      contactName,
      instanceId,
      instanceBackendId
    );
    
    if (result.queued) {
      res.json({
        action: 'queued',
        message: 'Message queued for AI processing',
        botEnabled: true
      });
    } else {
      res.json({
        action: 'responded',
        response: result.response,
        botEnabled: true,
        model: business.openaiModel,
        tokensUsed: result.tokensUsed
      });
    }
  } catch (error: any) {
    console.error('Agent think error:', error);
    
    if (error.code === 'invalid_api_key') {
      return res.status(400).json({ error: 'Invalid OpenAI API key' });
    }
    
    res.status(500).json({ error: 'AI processing failed' });
  }
});

router.get('/config', authMiddleware, requireActiveSubscription, async (req: Request, res: Response) => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const prompt = await prisma.agentPrompt.findUnique({
      where: { businessId: business_id as string },
      include: { tools: true }
    });
    
    res.json({
      prompt: prompt?.prompt || '',
      bufferSeconds: prompt?.bufferSeconds || 0,
      historyLimit: prompt?.historyLimit || 10,
      splitMessages: prompt?.splitMessages ?? true,
      tools: prompt?.tools || []
    });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

router.get('/memory/:businessId/:leadId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, leadId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const result = await getAgentMemory(businessId, leadId);
    res.json(result);
  } catch (error: any) {
    console.error('Get memory error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/memory/:businessId/:leadId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, leadId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const result = await clearAgentMemory(businessId, leadId);
    res.json(result);
  } catch (error: any) {
    console.error('Clear memory error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/memory/stats/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const result = await getMemoryStats(businessId);
    res.json(result);
  } catch (error: any) {
    console.error('Memory stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/queue/stats', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const stats = await getAIQueueStats();
    res.json({
      queue: 'ai-response',
      ...stats,
      useQueue: USE_AI_QUEUE
    });
  } catch (error: any) {
    console.error('Queue stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

import crypto from 'crypto';

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey(): string {
  return `efk_${crypto.randomBytes(32).toString('hex')}`;
}

router.post('/api-key/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (business.agentVersion !== 'v2') {
      return res.status(400).json({ error: 'API keys are only available for V2 agents' });
    }
    
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const apiKeyPrefix = apiKey.substring(0, 12);
    
    await prisma.business.update({
      where: { id: businessId },
      data: {
        apiKeyHash,
        apiKeyPrefix,
        apiKeyCreatedAt: new Date()
      }
    });
    
    res.json({
      apiKey,
      prefix: apiKeyPrefix,
      createdAt: new Date(),
      message: 'API key created. Save it now - you will not be able to see it again.'
    });
  } catch (error: any) {
    console.error('Generate API key error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api-key/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId },
      select: {
        apiKeyPrefix: true,
        apiKeyCreatedAt: true,
        agentVersion: true
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json({
      hasApiKey: !!business.apiKeyPrefix,
      prefix: business.apiKeyPrefix,
      createdAt: business.apiKeyCreatedAt,
      agentVersion: business.agentVersion
    });
  } catch (error: any) {
    console.error('Get API key info error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api-key/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.business.update({
      where: { id: businessId },
      data: {
        apiKeyHash: null,
        apiKeyPrefix: null,
        apiKeyCreatedAt: null
      }
    });
    
    res.json({ message: 'API key revoked' });
  } catch (error: any) {
    console.error('Revoke API key error:', error);
    res.status(500).json({ error: error.message });
  }
});

const WEBHOOK_EVENTS = [
  'user_message',
  'agent_message', 
  'state_change',
  'tool_call',
  'stage_change'
];

router.put('/webhook/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { webhookUrl, webhookEvents } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (business.agentVersion !== 'v2') {
      return res.status(400).json({ error: 'Webhooks are only available for V2 agents' });
    }
    
    if (webhookUrl && !webhookUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'Webhook URL must use HTTPS' });
    }
    
    const validEvents = (webhookEvents || []).filter((e: string) => WEBHOOK_EVENTS.includes(e));
    
    const webhookSecret = business.webhookSecret || `whs_${crypto.randomBytes(16).toString('hex')}`;
    
    await prisma.business.update({
      where: { id: businessId },
      data: {
        webhookUrl: webhookUrl || null,
        webhookEvents: validEvents,
        webhookSecret
      }
    });
    
    res.json({
      webhookUrl: webhookUrl || null,
      webhookEvents: validEvents,
      webhookSecret,
      availableEvents: WEBHOOK_EVENTS
    });
  } catch (error: any) {
    console.error('Update webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/webhook/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId },
      select: {
        webhookUrl: true,
        webhookEvents: true,
        webhookSecret: true,
        agentVersion: true
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json({
      webhookUrl: business.webhookUrl,
      webhookEvents: business.webhookEvents,
      webhookSecret: business.webhookSecret,
      availableEvents: WEBHOOK_EVENTS,
      agentVersion: business.agentVersion
    });
  } catch (error: any) {
    console.error('Get webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
