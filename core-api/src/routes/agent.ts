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
import { scheduleFollowUp } from '../services/followUpService.js';
import { dispatchAgentMessage, dispatchWebhook } from '../services/webhookService.js';
import { analyzeIntent, buildDynamicPrompt, getConversationContext, selectToolsForIntent, IntentAnalysis } from '../services/intentAnalyzer.js';
import { getContactStageStatus } from '../services/funnelStageService.js';

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
  instanceBackendId?: string,
  providerMessageId?: string,
  provider?: string
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
      priority: 'normal',
      providerMessageId,
      provider
    });
    
    if (jobId) {
      console.log(`[Agent] Message queued for parallel processing: ${jobId}`);
      return { response: '', queued: true };
    }
  }
  
  return await processWithAgent(businessId, messages, phone, contactPhone, contactName, instanceId, instanceBackendId, providerMessageId, provider);
}

async function processWithAgentQueuedWithIds(
  businessId: string,
  messages: string[],
  phone: string,
  contactPhone: string,
  contactName: string,
  instanceId?: string,
  instanceBackendId?: string,
  providerMessageIds?: string[],
  provider?: string
): Promise<{ response: string; tokensUsed?: number; queued?: boolean }> {
  console.log(`[Agent Processor] Starting processWithAgentQueuedWithIds for ${contactPhone} with ${messages.length} messages`);
  const queue = getAIResponseQueue();
  
  if (USE_AI_QUEUE && queue) {
    console.log(`[Agent Processor] Attempting to queue message for ${contactPhone}`);
    const jobId = await queueAIResponse({
      businessId,
      contactPhone,
      contactName,
      messages,
      phone,
      instanceId,
      instanceBackendId,
      priority: 'normal',
      providerMessageIds,
      provider
    });
    
    if (jobId) {
      console.log(`[Agent] Message queued for parallel processing with ${providerMessageIds?.length || 0} message IDs: ${jobId}`);
      return { response: '', queued: true };
    }
  }
  
  // Fallback - use first message ID for single processing
  console.log(`[Agent Processor] Falling back to direct processing for ${contactPhone}`);
  const firstMessageId = providerMessageIds?.[0];
  try {
    const result = await processWithAgent(businessId, messages, phone, contactPhone, contactName, instanceId, instanceBackendId, firstMessageId, provider);
    console.log(`[Agent Processor] processWithAgent completed for ${contactPhone}: response length=${result.response?.length || 0}`);
    return result;
  } catch (error: any) {
    console.error(`[Agent Processor] Error in processWithAgent for ${contactPhone}:`, error.message);
    throw error;
  }
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
    
    // Check if bot is disabled globally - but allow if contact has testing mode enabled
    if (!business.botEnabled) {
      const { phone, phoneNumber } = req.body;
      const contactPhone = (phoneNumber || phone || '').replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
      
      if (contactPhone) {
        const contact = await prisma.contact.findFirst({
          where: {
            businessId: business_id,
            phone: contactPhone
          },
          select: { botTestEnabled: true }
        });
        
        if (contact?.botTestEnabled) {
          console.log(`[Agent Middleware] Bot disabled globally but Testing ON for contact ${contactPhone}, allowing...`);
        } else {
          console.log(`[Agent Middleware] Bot disabled globally, no testing mode for contact ${contactPhone}`);
          return res.json({ action: 'manual', message: 'Bot is disabled', botEnabled: false });
        }
      } else {
        return res.json({ action: 'manual', message: 'Bot is disabled', botEnabled: false });
      }
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
    
    const allBuffers = await prisma.messageBuffer.findMany();
    if (allBuffers.length > 0) {
      console.log(`[BUFFER-WORKER] Found ${allBuffers.length} total buffers, checking for expired...`);
    }
    
    const expiredBuffers = await prisma.messageBuffer.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          { processingUntil: null },
          { processingUntil: { lt: now } }
        ]
      }
    });
    
    if (expiredBuffers.length > 0) {
      console.log(`[BUFFER-WORKER] Found ${expiredBuffers.length} expired buffers to process`);
    }
    
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
        const bufferData = buffer.messages as any;
        const messages = bufferData?.texts || (Array.isArray(bufferData) ? bufferData : []);
        const storedMessageIds = bufferData?.providerMessageIds || [];
        
        const business = await prisma.business.findUnique({
          where: { id: buffer.businessId }
        });
        
        if (!business) {
          await prisma.messageBuffer.delete({ where: { id: buffer.id } });
          continue;
        }
        
        // Check if bot is disabled globally - but allow if contact has testing mode enabled
        if (!business.botEnabled) {
          const contact = await prisma.contact.findFirst({
            where: {
              businessId: buffer.businessId,
              phone: buffer.contactPhone
            },
            select: { botTestEnabled: true }
          });
          
          if (!contact?.botTestEnabled) {
            console.log(`[BUFFER-WORKER] Bot disabled and no testing mode for ${buffer.contactPhone}, deleting buffer`);
            await prisma.messageBuffer.delete({ where: { id: buffer.id } });
            continue;
          }
          console.log(`[BUFFER-WORKER] Bot disabled but Testing ON for ${buffer.contactPhone}, processing...`);
        }
        
        let instance = null;
        
        if (buffer.instanceId) {
          instance = await prisma.whatsAppInstance.findUnique({
            where: { id: buffer.instanceId },
            include: { metaCredential: true, metaCoexistCredential: true }
          });
          console.log(`[BUFFER-WORKER] Using stored instanceId ${buffer.instanceId} for ${bufferKey}`);
        }
        
        if (!instance) {
          instance = await prisma.whatsAppInstance.findFirst({
            where: { businessId: buffer.businessId, status: 'connected' },
            include: { metaCredential: true, metaCoexistCredential: true }
          });
          if (instance) {
            console.log(`[BUFFER-WORKER] Fallback to connected instance ${instance.id} for ${bufferKey}`);
          }
        }
        
        if (!instance) {
          instance = await prisma.whatsAppInstance.findFirst({
            where: { businessId: buffer.businessId },
            include: { metaCredential: true, metaCoexistCredential: true }
          });
          console.log(`[BUFFER-WORKER] Fallback to any instance for ${bufferKey}`);
        }
        
        const provider = instance?.provider || undefined;
        
        console.log(`[BUFFER-WORKER] Found ${storedMessageIds.length} stored message IDs, provider=${provider || 'unknown'}, instanceId=${instance?.id || 'none'} for ${bufferKey}`);
        
        const contactJid = `${buffer.contactPhone}@s.whatsapp.net`;
        const resolvedBackendId = instance?.instanceBackendId || `biz_${buffer.businessId.substring(0, 8)}`;
        
        await processWithAgentQueuedWithIds(
          buffer.businessId,
          messages,
          contactJid,
          buffer.contactPhone,
          '',
          instance?.id,
          resolvedBackendId,
          storedMessageIds,
          provider
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

interface ResponseValidation {
  isValid: boolean;
  issues: string[];
  sanitizedResponse: string;
}

function validateAgentResponse(
  response: string,
  recentHistory: string[],
  businessObjective: 'SALES' | 'APPOINTMENTS'
): ResponseValidation {
  const issues: string[] = [];
  let sanitizedResponse = response;
  
  // Check for empty or too short responses
  if (!response || response.trim().length < 10) {
    issues.push('Response too short');
    return { isValid: false, issues, sanitizedResponse: '' };
  }
  
  // Check for excessively long responses (>800 chars might overwhelm)
  if (response.length > 1500) {
    issues.push('Response might be too long');
    // Don't fail, just flag
  }
  
  // Check for repetitive content (same phrase repeated)
  const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const uniqueSentences = new Set(sentences.map(s => s.trim().toLowerCase()));
  if (sentences.length > 2 && uniqueSentences.size < sentences.length * 0.6) {
    issues.push('Response may contain repetitive content');
  }
  
  // Check for hallucination patterns - fake data markers
  const hallucniationPatterns = [
    /\[INSERTAR.*\]/gi,
    /\[AGREGAR.*\]/gi,
    /\[AQUÍ.*\]/gi,
    /ejemplo\.com/gi,
    /xxx+/gi,
    /\$\{.*\}/g,
    /{{.*}}/g
  ];
  
  for (const pattern of hallucniationPatterns) {
    if (pattern.test(response)) {
      issues.push('Response contains placeholder/template text');
      sanitizedResponse = sanitizedResponse.replace(pattern, '');
    }
  }
  
  // Check if response mentions competitor products or services
  const competitorPatterns = [
    /amazon/gi, /mercadolibre/gi, /aliexpress/gi,
    /chatgpt/gi, /gemini/gi, /claude/gi
  ];
  for (const pattern of competitorPatterns) {
    if (pattern.test(response)) {
      issues.push('Response mentions competitor');
    }
  }
  
  // For SALES: check if response tries to close without proper context
  if (businessObjective === 'SALES') {
    const closingWithoutProducts = /complet(a|e|ar)|finaliz(a|ar)|confirma(r)? (tu|el|la) (pedido|orden)/i.test(response);
    const hasProductMention = /producto|artículo|precio|\$/i.test(response);
    if (closingWithoutProducts && !hasProductMention && recentHistory.length < 5) {
      issues.push('Trying to close sale prematurely');
    }
  }
  
  return {
    isValid: issues.length === 0 || !issues.some(i => i.includes('too short') || i.includes('placeholder')),
    issues,
    sanitizedResponse: sanitizedResponse.trim()
  };
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

// Product images are now sent explicitly when the agent includes the URL from buscar_producto results
// (following the same pattern as enviar_archivo)

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
  instanceBackendId?: string,
  providerMessageId?: string
): Promise<{ response: string; tokensUsed?: number }> {
  const historyLimit = business.agentPrompts?.[0]?.historyLimit || 10;
  const splitMessages = business.agentPrompts?.[0]?.splitMessages ?? true;
  
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
  
  const userTools = business.agentPrompts?.[0]?.tools || [];
  const toolsConfig = userTools.map((t: any) => ({
    name: t.name,
    description: t.description,
    url: t.url,
    method: t.method || 'POST',
    headers: t.headers,
    bodyTemplate: t.bodyTemplate,
    parameters: t.parameters,
    dynamicVariables: t.dynamicVariables,
    enabled: t.enabled ?? true
  }));
  
  const conversationHistory = buildConversationHistory(recentMessages.reverse());
  const businessContext = buildBusinessContext(
    business, 
    business.agentPrompts?.[0]?.prompt,
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
  
  // Send response to WhatsApp - find the correct instance based on instanceBackendId
  let instance = business.instances?.find((i: any) => i.instanceBackendId === instanceBackendId);
  if (!instance && instanceBackendId) {
    // Try to find by partial match (biz_XXXXXXXX format)
    instance = business.instances?.find((i: any) => 
      instanceBackendId.includes(i.id.substring(0, 8)) || 
      i.instanceBackendId?.includes(instanceBackendId.substring(4))
    );
  }
  if (!instance) {
    // Fallback to first instance only if no specific instanceBackendId was provided
    instance = business.instances?.[0];
    if (instanceBackendId) {
      console.warn(`[Agent V2] Could not find instance with backendId ${instanceBackendId}, falling back to first instance (${instance?.provider})`);
    }
  }
  const backendId = instanceBackendId || instance?.instanceBackendId;
  
  if (aiResponse && instance) {
    try {
      let sentMedia: any[] = [];
      
      if ((instance.provider === 'META_CLOUD' && instance.metaCredential) || 
          (instance.provider === 'META_COEXIST' && instance.metaCoexistCredential)) {
        // Meta Cloud API or Meta Coexist
        const isCoexist = instance.provider === 'META_COEXIST';
        const accessToken = isCoexist 
          ? (instance.metaCoexistCredential!.systemAccessToken || instance.metaCoexistCredential!.userAccessToken)
          : instance.metaCredential!.accessToken;
        const phoneNumberId = isCoexist 
          ? instance.metaCoexistCredential!.phoneNumberId 
          : instance.metaCredential!.phoneNumberId;
        const metaBusinessId = isCoexist 
          ? instance.metaCoexistCredential!.metaBusinessId 
          : instance.metaCredential!.businessId;
        
        const metaService = new MetaCloudService({
          accessToken,
          phoneNumberId,
          businessId: metaBusinessId
        });
        
        console.log(`[Agent V2] Sending response via ${isCoexist ? 'Meta Coexist' : 'Meta Cloud'} API`);
        
        // Mark message as read AFTER buffer expires (before responding)
        try {
          // Use the providerMessageId passed directly, or fallback to DB lookup
          let messageIdToMark = providerMessageId;
          
          if (!messageIdToMark) {
            console.log(`[Agent V2] No providerMessageId passed, looking up in DB for:`, contactPhone);
            const lastInboundMessage = await prisma.messageLog.findFirst({
              where: {
                businessId: business.id,
                sender: contactPhone,
                direction: 'inbound'
              },
              orderBy: { createdAt: 'desc' },
              select: { providerMessageId: true }
            });
            messageIdToMark = lastInboundMessage?.providerMessageId || undefined;
          }
          
          if (messageIdToMark) {
            await metaService.markMessageAsRead(messageIdToMark);
            console.log(`[Agent V2] ${isCoexist ? 'Meta Coexist' : 'Meta Cloud'} message marked as read:`, messageIdToMark);
          } else {
            console.log('[Agent V2] No providerMessageId available to mark as read');
          }
        } catch (readError: any) {
          console.log('Could not mark Meta message as read:', readError.message);
        }
        
        // Send the message via Meta Cloud/Coexist
        const { cleanedText, mediaItems } = extractMediaFromText(aiResponse);
        const finalText = cleanMarkdownForWhatsApp(cleanedText);
        
        // Use only media URLs explicitly included in the AI response (no auto-matching)
        const allMedia = [...mediaItems];
        
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
        
        for (const media of allMedia) {
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
            console.error(`[Agent V2] Failed to send media via ${isCoexist ? 'Meta Coexist' : 'Meta Cloud'}: ${media.url}`, mediaError.message);
          }
        }
      } else if (backendId) {
        // Baileys API
        // Mark messages as read before responding
        try {
          await axios.post(`${WA_API_URL}/instances/${backendId}/markAsRead`, {
            from: phone
          });
        } catch (readError: any) {
          console.log('Could not mark messages as read:', readError.message);
        }
        
        // Send the message (media URLs in the response are detected and sent automatically)
        const result = await sendMessageInParts(backendId, phone, aiResponse, splitMessages);
        sentMedia = result.sentMedia;
      }
      
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
            provider: instance.provider,
            splitMessages,
            sentMedia: sentMedia.length > 0 ? sentMedia.map((m: any) => ({ type: m.type, url: m.url })) : undefined
          }
        }
      });
      
      console.log(`[Agent V2] Response sent to ${contactPhone}:`, aiResponse.substring(0, 100));
      
      // Dispatch agent_message webhook
      dispatchAgentMessage(
        business.id,
        contactPhone,
        aiResponse,
        sentMedia.length > 0 ? sentMedia.map((m: any) => m.url) : undefined,
        undefined,
        instance?.id
      ).catch(err => console.error('[Agent V2] Failed to dispatch agent_message webhook:', err.message));
      
      // Schedule follow-up after sending response
      await scheduleFollowUp(business.id, contactPhone, 'ai', instance?.id);
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
  instanceBackendIdParam?: string,
  providerMessageId?: string,
  provider?: string
): Promise<{ response: string; tokensUsed?: number }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      policy: true,
      agentPrompts: { include: { tools: { where: { enabled: true } } } },
      instances: { include: { metaCredential: true, metaCoexistCredential: true } },
      user: { select: { isPro: true, paymentLinkEnabled: true } }
    }
  });
  
  // Load products filtered by instanceId - includes instance-specific products and shared products (null instanceId)
  const products = await prisma.product.findMany({
    where: {
      businessId,
      OR: instanceId 
        ? [{ instanceId }, { instanceId: null }]
        : [{ instanceId: null }]
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!business) {
    throw new Error('Business not found');
  }
  
  // Check if bot is enabled globally OR if contact has test mode enabled
  if (!business.botEnabled) {
    // Look up the contact to check if test mode is enabled
    const contact = await prisma.contact.findFirst({
      where: {
        businessId,
        phone: contactPhone.replace(/@.*/, '').replace(/[^0-9]/g, '')
      },
      select: { botTestEnabled: true }
    });
    
    if (!contact?.botTestEnabled) {
      console.log(`[Agent] Bot disabled and contact ${contactPhone} has no test mode, returning empty`);
      return { response: '' };
    }
    console.log(`[Agent] Bot disabled globally but Testing ON for contact ${contactPhone}, generating response...`);
  }
  
  if (business.agentVersion === 'v2') {
    // Find the correct instance - prioritize instanceId if provided
    let instance: any = null;
    let backendId = instanceBackendIdParam;
    
    // First, try to find by instanceId (most accurate)
    if (instanceId) {
      instance = business.instances?.find((i: any) => i.id === instanceId);
      if (instance) {
        backendId = backendId || instance.instanceBackendId;
        console.log(`[Agent V2] Found instance by ID: ${instanceId} (provider: ${instance.provider})`);
      }
    }
    
    // Second, try to find by instanceBackendId
    if (!instance && instanceBackendIdParam) {
      instance = business.instances?.find((i: any) => i.instanceBackendId === instanceBackendIdParam);
      if (instance) {
        console.log(`[Agent V2] Found instance by backendId: ${instanceBackendIdParam} (provider: ${instance.provider})`);
      }
    }
    
    // Third, try to find by provider if specified
    if (!instance && provider) {
      instance = business.instances?.find((i: any) => i.provider === provider);
      if (instance) {
        backendId = backendId || instance.instanceBackendId;
        console.log(`[Agent V2] Found instance by provider: ${provider}`);
      }
    }
    
    // Fallback to first instance only if nothing else matched
    if (!instance) {
      instance = business.instances?.[0];
      backendId = backendId || instance?.instanceBackendId;
      if (instanceId || instanceBackendIdParam || provider) {
        console.warn(`[Agent V2] Could not find specific instance, falling back to first (${instance?.provider})`);
      }
    }
    
    // Fallback: generate backendId dynamically if still null
    if (!backendId && instanceId) {
      const dbInstance = await prisma.whatsAppInstance.findUnique({
        where: { id: instanceId }
      });
      if (dbInstance && dbInstance.instanceBackendId) {
        backendId = dbInstance.instanceBackendId;
        console.log(`[Agent V2] Instance loaded from DB: ${instanceId} -> backendId: ${backendId}`);
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
        return await processWithAgentV2(business, messages, contactPhone, contactName, phone, backendId || undefined, providerMessageId);
      }
    } catch (v2Error: any) {
      console.error('[Agent V2] Error, falling back to V1:', v2Error.message);
    }
  }
  
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured. Contact administrator.');
  }
  
  const openai = getOpenAIClient();
  const promptConfig = business.agentPrompts?.[0];
  const historyLimit = promptConfig?.historyLimit || 10;
  const splitMessages = promptConfig?.splitMessages ?? true;
  const tools = promptConfig?.tools || [];
  
  const combinedMessage = messages.join(' ');
  const businessObjective = business.businessObjective as 'SALES' | 'APPOINTMENTS';
  const normalizedContactPhone = contactPhone.replace(/@.*/, '').replace(/[^0-9]/g, '');
  
  const recentMessagesForIntent = await prisma.messageLog.findMany({
    where: { 
      businessId,
      OR: [
        { sender: contactPhone },
        { recipient: contactPhone }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { message: true, direction: true }
  });
  
  const conversationHistoryForIntent = recentMessagesForIntent
    .reverse()
    .map((m: { message: string | null; direction: string }) => `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.message || ''}`)
    .filter((m: string) => m.length > 10);
  
  let intentAnalysis: IntentAnalysis | null = null;
  try {
    intentAnalysis = await analyzeIntent(
      businessId,
      combinedMessage,
      conversationHistoryForIntent,
      businessObjective,
      normalizedContactPhone
    );
    console.log(`[Agent V1] Intent detected: ${intentAnalysis.intent} (${(intentAnalysis.confidence * 100).toFixed(0)}%)`);
    
    if (intentAnalysis.objection) {
      console.log(`[Agent V1] Objection detected: ${intentAnalysis.objection.name}`);
    }
  } catch (intentError: any) {
    console.error('[Agent V1] Intent analysis failed:', intentError.message);
  }
  
  const conversationContext = await getConversationContext(businessId, contactPhone);
  
  // Initialize funnel stage for this contact (auto-creates if funnel stages exist)
  let funnelStatus = null;
  try {
    funnelStatus = await getContactStageStatus(businessId, normalizedContactPhone);
    if (funnelStatus.currentStage) {
      console.log(`[Agent V1] Funnel stage: ${funnelStatus.currentStage.name} (missing: ${funnelStatus.missingFields.join(', ') || 'none'})`);
    }
  } catch (funnelError: any) {
    console.log(`[Agent V1] Funnel stage check skipped: ${funnelError.message}`);
  }
  
  // Load extracted contact data from ContactSettings.notes
  const contactSettings = await prisma.contactSettings.findFirst({
    where: {
      businessId,
      contactPhone: normalizedContactPhone
    }
  });
  
  let systemPrompt = promptConfig?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
  
  // Store extracted data for later use in buildDynamicPrompt
  let extractedDataForPrompt: Record<string, any> = {};
  
  // Add extracted contact data to prompt so agent knows what info we already have
  if (contactSettings?.notes) {
    try {
      const parsedNotes = JSON.parse(contactSettings.notes);
      const extractedData = parsedNotes.extractedData || {};
      const dataEntries = Object.entries(extractedData).filter(([_, v]) => v && String(v).trim() !== '');
      
      if (dataEntries.length > 0) {
        extractedDataForPrompt = Object.fromEntries(dataEntries);
        systemPrompt += `\n\n## DATOS YA RECOLECTADOS DEL CLIENTE (NO volver a pedir):`;
        dataEntries.forEach(([key, value]) => {
          systemPrompt += `\n- ${key}: ${value}`;
        });
        systemPrompt += `\n\nIMPORTANTE: YA tienes estos datos. NO los vuelvas a pedir. Usa esta información para avanzar en la conversación.`;
        console.log(`[Agent V1] Loaded extracted data for context: ${JSON.stringify(extractedDataForPrompt)}`);
      }
    } catch (parseError) {
      // Notes not valid JSON, ignore
    }
  }
  
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
  const productCount = products?.length || 0;
  const isAppointmentMode = business.businessObjective === 'APPOINTMENTS';
  
  // Add product catalog info only for SALES mode
  if (!isAppointmentMode && productCount > 0 && productCount <= 20) {
    systemPrompt += `\n\n## Catálogo de productos:`;
    products.forEach((product: any) => {
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
    systemPrompt += `\n- Si el cliente pregunta de forma general (ej: "precio de motos", "qué KTM tienen"), PRIMERO pregunta qué modelo específico le interesa.`;
    systemPrompt += `\n- Solo cuando el cliente especifique un modelo concreto, muestra los detalles de ese producto.`;
    systemPrompt += `\n- ENVÍO DE IMÁGENES: SIEMPRE sigue la "instruccion" que devuelve buscar_producto para enviar la foto del producto.`;
    systemPrompt += `\n- OBLIGATORIO: Si buscar_producto devuelve "imagen_producto", DEBES incluir la URL al final de tu mensaje.`;
    systemPrompt += `\n- Incluye la URL SOLA al final de tu mensaje (sin Markdown). Solo UNA imagen por mensaje.`;
    systemPrompt += `\n- Si un producto tiene stock 0, indica que está agotado y ofrece alternativas.`;
    systemPrompt += `\n- Para generar pedidos, usa el ID del producto (el valor después de "ID:").`;
  } else if (!isAppointmentMode && productCount > 20) {
    systemPrompt += `\n\n## Catálogo de productos:`;
    systemPrompt += `\nTienes acceso a un catálogo de ${productCount} productos con BÚSQUEDA INTELIGENTE.`;
    systemPrompt += `\nLos precios están en ${business.currencyCode || 'PEN'} (${currencySymbol}).`;
    systemPrompt += `\n\n## Reglas para responder sobre productos:`;
    systemPrompt += `\n- Cuando el cliente mencione un producto, usa buscar_producto inmediatamente.`;
    systemPrompt += `\n- La búsqueda es inteligente: encontrará productos aunque el cliente escriba con errores.`;
    systemPrompt += `\n- CONFÍA en "mejor_coincidencia" - es el producto más parecido a lo que busca el cliente.`;
    systemPrompt += `\n- ENVÍO DE IMÁGENES: SIEMPRE sigue la "instruccion" que devuelve buscar_producto para enviar la foto del producto.`;
    systemPrompt += `\n- OBLIGATORIO: Si buscar_producto devuelve "imagen_producto", DEBES incluir la URL al final de tu mensaje.`;
    systemPrompt += `\n- Incluye la URL SOLA al final de tu mensaje (sin Markdown). Solo UNA imagen por mensaje.`;
    systemPrompt += `\n- Si un producto tiene stock 0, indica que está agotado y sugiere alternativas.`;
  }
  
  // Add appointments context for APPOINTMENTS mode
  if (isAppointmentMode) {
    systemPrompt += `\n\n## Modo Citas Activo:`;
    systemPrompt += `\nEres un asistente especializado en agendar citas y consultas.`;
    systemPrompt += `\n- Usa consultar_disponibilidad para verificar horarios antes de proponer fechas.`;
    systemPrompt += `\n- Usa agendar_cita cuando el cliente confirme fecha y hora.`;
    systemPrompt += `\n- Siempre confirma los datos del cliente antes de agendar.`;
    systemPrompt += `\n- Si no hay horarios disponibles, ofrece fechas alternativas o pregunta qué día prefiere.`;
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
    systemPrompt += `\n- Etapa CRM: ${tag.name}`;
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
  
  // Add funnel stage context if available
  if (funnelStatus?.currentStage) {
    systemPrompt += `\n\n## FLUJO DE VENTA - Etapa actual: "${funnelStatus.currentStage.name}"`;
    if (funnelStatus.currentStage.promptContext) {
      systemPrompt += `\n${funnelStatus.currentStage.promptContext}`;
    }
    if (funnelStatus.missingFields.length > 0) {
      systemPrompt += `\n\n### DATOS OBLIGATORIOS PENDIENTES (debes obtenerlos ANTES de avanzar):`;
      funnelStatus.missingFields.forEach((field: string) => {
        systemPrompt += `\n- ${field}`;
      });
      systemPrompt += `\n\nIMPORTANTE: NO avances a la siguiente etapa ni cierres la venta hasta tener TODOS estos datos.`;
    } else if (funnelStatus.canAdvance && funnelStatus.nextStage) {
      systemPrompt += `\n\n### Datos completos - puedes avanzar a "${funnelStatus.nextStage.name}"`;
    }
    if (funnelStatus.currentStage.blockedTopics && funnelStatus.currentStage.blockedTopics.length > 0) {
      systemPrompt += `\n\n### TEMAS BLOQUEADOS en esta etapa (no abordar aún):`;
      funnelStatus.currentStage.blockedTopics.forEach((topic: string) => {
        systemPrompt += `\n- ${topic}`;
      });
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
  
  const paymentLinkEnabled = business.user?.paymentLinkEnabled ?? false;
  
  if (intentAnalysis) {
    systemPrompt = buildDynamicPrompt(
      systemPrompt,
      intentAnalysis,
      conversationContext,
      businessObjective,
      {
        paymentLinkEnabled,
        extractedData: extractedDataForPrompt
      }
    );
    console.log(`[Agent V1] Dynamic prompt built with intent context (paymentMode: ${paymentLinkEnabled ? 'STRIPE' : 'VOUCHER'})`);
  }
  
  // Filter by instanceId if available to avoid mixing conversations from different instances
  // Build phone filter that matches any variant of the contact phone
  const phoneVariants = [contactPhone, phone].filter(Boolean);
  const phoneConditions = phoneVariants.flatMap(p => [
    { sender: p },
    { recipient: p }
  ]);
  
  const messageFilter: any = { 
    businessId,
    OR: phoneConditions
  };
  
  // If we have an instanceId, add it as an AND condition with fallback to null (legacy messages)
  if (instanceId) {
    messageFilter.AND = [
      {
        OR: [
          { instanceId: instanceId },
          { instanceId: null } // Include legacy messages without instanceId
        ]
      }
    ];
  }
  
  const recentMessages = await prisma.messageLog.findMany({
    where: messageFilter,
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
    const dynamicVars = (tool.dynamicVariables as any[]) || [];
    const properties: Record<string, any> = {};
    const requiredSet = new Set<string>();
    
    if (toolParams.length > 0) {
      toolParams.forEach((param: any) => {
        properties[param.name] = {
          type: param.type || 'string',
          description: param.description || `Parameter ${param.name}`
        };
        if (param.required) {
          requiredSet.add(param.name);
        }
      });
    } else if (dynamicVars.length === 0) {
      properties['query'] = { type: 'string', description: 'The query or data to send to the external service' };
      requiredSet.add('query');
    }
    
    dynamicVars.forEach((v: any) => {
      let desc = v.description || `Variable ${v.name}`;
      if (v.formatExample) {
        desc += ` (formato: ${v.formatExample})`;
      }
      // Only add if not already defined in parameters
      if (!properties[v.name]) {
        properties[v.name] = {
          type: 'string',
          description: desc
        };
      }
      requiredSet.add(v.name);
    });
    
    return {
      type: 'function' as const,
      function: {
        name: tool.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required: Array.from(requiredSet)
        }
      }
    };
  });
  
  // Sales tools - only for SALES objective (not APPOINTMENTS)
  const isSalesMode = business.businessObjective !== 'APPOINTMENTS';
  
  if (isSalesMode && productCount > 20) {
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
  
  if (isSalesMode && productCount > 0) {
    const canUsePaymentLink = business.user?.paymentLinkEnabled ?? false;
    
    // Use different tool name/description based on payment mode
    const orderToolName = canUsePaymentLink ? 'crear_enlace_pago' : 'registrar_pedido';
    const orderToolDescription = canUsePaymentLink 
      ? 'Genera un enlace de pago para que el cliente complete su compra. Usa esta función cuando el cliente confirme que quiere comprar un producto y tengas todos sus datos de envío.'
      : 'Registra un pedido para el cliente que pagará por transferencia/voucher. Usa esta función cuando el cliente confirme que quiere comprar un producto y tengas todos sus datos de envío. El pedido quedará pendiente hasta que el cliente envíe el comprobante de pago.';
    
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: orderToolName,
        description: orderToolDescription,
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
            },
            coordenadas_ubicacion: {
              type: 'string',
              description: 'Coordenadas GPS de la ubicación del cliente en formato "latitud,longitud" (ejemplo: -12.046374,-77.042793). Se obtiene cuando el cliente comparte su ubicación actual por WhatsApp.'
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
        
        console.log(`[PRODUCT SEARCH] Query: "${searchQuery}" (intelligent matching, instanceId: ${instanceId || 'all'})`);
        
        const searchResult = await searchProductsIntelligent(businessId, searchQuery, 10, instanceId);
        
        const productResults = searchResult.products.map(p => ({
          id: p.id,
          nombre: p.title,
          precio: `${currencySymbol}${p.price}`,
          stock: p.stock,
          disponible: p.available,
          descripcion: p.description || 'Sin descripción',
          imagen_url: p.imageUrl || null,
          similitud: Math.round(p.similarity * 100)
        }));
        
        let resultContent: string;
        if (productResults.length > 0) {
          const bestMatch = searchResult.bestMatch;
          const bestMatchWithImage = bestMatch?.imageUrl ? {
            nombre: bestMatch.title,
            similitud: Math.round(bestMatch.similarity * 100) + '%',
            imagen_url: bestMatch.imageUrl
          } : bestMatch ? {
            nombre: bestMatch.title,
            similitud: Math.round(bestMatch.similarity * 100) + '%'
          } : null;
          
          // Build result with instruction for sending image (same pattern as enviar_archivo)
          const result: any = {
            productos_encontrados: productResults,
            coincidencia_exacta: searchResult.exactMatch,
            mejor_coincidencia: bestMatchWithImage,
            nota: searchResult.exactMatch 
              ? 'Se encontró una coincidencia exacta' 
              : 'Se muestran los productos más similares a la búsqueda'
          };
          
          // Add instruction for sending image if best match has image (same direct format as enviar_archivo)
          if (bestMatch?.imageUrl) {
            result.instruccion = `IMPORTANTE: Incluye esta URL en tu respuesta para enviar la foto del producto: ${bestMatch.imageUrl}`;
            result.imagen_producto = {
              url: bestMatch.imageUrl,
              nombre: bestMatch.title
            };
          }
          
          resultContent = JSON.stringify(result);
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
      
      if (toolName === 'crear_enlace_pago' || toolName === 'registrar_pedido') {
        const args = JSON.parse(fn.arguments);
        let productId = args.producto_id;
        const quantity = args.cantidad || 1;
        const customerName = args.nombre_cliente;
        const shippingAddress = args.direccion_envio;
        const city = args.ciudad || '';
        const country = args.pais || '';
        const locationCoordinates = args.coordenadas_ubicacion || null;
        
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
                instanceId: instanceId || null,
                contactPhone,
                contactName: customerName,
                shippingAddress,
                shippingCity: city,
                shippingCountry: country,
                locationCoordinates,
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
  
  let aiResponse = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.';
  
  // Validate response anti-saturation
  const validation = validateAgentResponse(aiResponse, conversationHistoryForIntent, businessObjective);
  if (!validation.isValid) {
    console.warn(`[Agent V1] Response validation failed: ${validation.issues.join(', ')}`);
    if (validation.sanitizedResponse) {
      aiResponse = validation.sanitizedResponse;
    }
  } else if (validation.issues.length > 0) {
    console.log(`[Agent V1] Response warnings: ${validation.issues.join(', ')}`);
  }
  
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
      
      if ((instance.provider === 'META_CLOUD' && instance.metaCredential) ||
          (instance.provider === 'META_COEXIST' && instance.metaCoexistCredential)) {
        // Meta Cloud API or Meta Coexist
        const isCoexist = instance.provider === 'META_COEXIST';
        const accessToken = isCoexist 
          ? (instance.metaCoexistCredential!.systemAccessToken || instance.metaCoexistCredential!.userAccessToken)
          : instance.metaCredential!.accessToken;
        const phoneNumberId = isCoexist 
          ? instance.metaCoexistCredential!.phoneNumberId 
          : instance.metaCredential!.phoneNumberId;
        const metaBusinessId = isCoexist 
          ? instance.metaCoexistCredential!.metaBusinessId 
          : instance.metaCredential!.businessId;
        
        console.log(`[${isCoexist ? 'META COEXIST' : 'META CLOUD'}] Sending response via ${isCoexist ? 'Meta Coexist' : 'Meta Cloud'} API`);
        const metaService = new MetaCloudService({
          accessToken,
          phoneNumberId,
          businessId: metaBusinessId
        });
        
        // Mark message as read AFTER buffer expires (before responding)
        try {
          // Use the providerMessageId passed directly, or fallback to DB lookup
          let messageIdToMark = providerMessageId;
          
          if (!messageIdToMark) {
            console.log(`[${isCoexist ? 'META COEXIST' : 'META CLOUD'}] No providerMessageId passed, looking up in DB for:`, contactPhone);
            const lastInboundMessage = await prisma.messageLog.findFirst({
              where: {
                businessId,
                sender: contactPhone,
                direction: 'inbound'
              },
              orderBy: { createdAt: 'desc' },
              select: { providerMessageId: true }
            });
            messageIdToMark = lastInboundMessage?.providerMessageId || undefined;
          }
          
          if (messageIdToMark) {
            await metaService.markMessageAsRead(messageIdToMark);
            console.log(`[${isCoexist ? 'META COEXIST' : 'META CLOUD'}] Message marked as read:`, messageIdToMark);
          } else {
            console.log(`[${isCoexist ? 'META COEXIST' : 'META CLOUD'}] No providerMessageId available to mark as read`);
          }
        } catch (readError: any) {
          console.log('Could not mark Meta message as read:', readError.message);
        }
        
        const { cleanedText, mediaItems } = extractMediaFromText(aiResponse);
        const finalText = cleanMarkdownForWhatsApp(cleanedText);
        
        // Use only media URLs explicitly included in the AI response (no auto-matching)
        const allMedia = [...mediaItems];
        
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
        
        for (const media of allMedia) {
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
            console.error(`Failed to send media via ${isCoexist ? 'Meta Coexist' : 'Meta Cloud'}: ${media.url}`, mediaError.message);
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
        
        // Send the message (media URLs in the response are detected and sent automatically)
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
      
      // Dispatch agent_message webhook
      dispatchAgentMessage(
        businessId,
        contactPhone,
        aiResponse,
        sentMedia.length > 0 ? sentMedia.map(m => m.url) : undefined,
        undefined,
        instance?.id
      ).catch(err => console.error('[Agent V1] Failed to dispatch agent_message webhook:', err.message));
      
      // Schedule follow-up after sending response
      await scheduleFollowUp(businessId, contactPhone, 'ai', instance?.id);
    } catch (sendError: any) {
      console.error('Failed to send WhatsApp message:', sendError.response?.data || sendError.message);
    }
  }
  
  return { response: aiResponse, tokensUsed: totalTokens };
}

router.post('/think', internalOrAuthMiddleware, async (req: Request, res: Response) => {
  console.log(`[Agent Think] Endpoint called - business_id: ${req.body.business_id}, phone: ${req.body.phone}`);
  try {
    const { business_id, user_message, phone, phoneNumber, contactName, instanceId, instanceBackendId, providerMessageId, provider } = req.body;
    
    if (!business_id || !user_message || !phone) {
      return res.status(400).json({ error: 'business_id, user_message and phone are required' });
    }
    
    const contactPhone = phoneNumber || phone.replace('@s.whatsapp.net', '').replace('@lid', '');
    
    const business = await prisma.business.findUnique({
      where: { id: business_id },
      include: { agentPrompts: true }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // Check if bot is disabled globally but contact has testing mode enabled
    if (!business.botEnabled) {
      const contact = await prisma.contact.findFirst({
        where: {
          businessId: business_id,
          phone: contactPhone.replace(/\D/g, '')
        },
        select: { botTestEnabled: true }
      });
      
      if (!contact?.botTestEnabled) {
        console.log(`[Agent Think] Bot disabled globally and no testing mode for contact ${contactPhone}`);
        return res.json({
          action: 'manual',
          message: 'Bot is disabled',
          botEnabled: false
        });
      }
      console.log(`[Agent Think] Bot disabled globally but Testing ON for contact ${contactPhone}, processing...`);
    }
    
    const promptConfig = business.agentPrompts?.[0];
    const bufferSeconds = promptConfig?.bufferSeconds ?? 7;
    const bufferKey = `${business_id}:${contactPhone}`;
    
    if (bufferSeconds > 0) {
      const existingTimeout = activeBuffers.get(bufferKey);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      
      const existingBuffer = await prisma.messageBuffer.findUnique({
        where: { businessId_contactPhone: { businessId: business_id, contactPhone } }
      });
      
      // Handle both old format (array) and new format (object with texts/providerMessageIds)
      let existingTexts: string[] = [];
      let existingMessageIds: string[] = [];
      
      if (existingBuffer?.messages) {
        const bufferData = existingBuffer.messages as any;
        if (Array.isArray(bufferData)) {
          // Old format: messages is an array of strings
          existingTexts = bufferData;
        } else if (bufferData?.texts && Array.isArray(bufferData.texts)) {
          // New format: messages is { texts: [...], providerMessageIds: [...] }
          existingTexts = bufferData.texts;
          existingMessageIds = bufferData.providerMessageIds || [];
        }
      }
      
      const currentMessages = [...existingTexts, user_message];
      
      // Accumulate all providerMessageIds for marking as read later
      const currentProviderMessageIds = providerMessageId 
        ? [...existingMessageIds, providerMessageId]
        : existingMessageIds;
      
      const expiresAt = new Date(Date.now() + bufferSeconds * 1000);
      console.log(`[Agent Think] Creating/updating buffer for ${contactPhone} with ${currentMessages.length} messages, expires at ${expiresAt.toISOString()}`);
      
      await prisma.messageBuffer.upsert({
        where: { businessId_contactPhone: { businessId: business_id, contactPhone } },
        create: {
          businessId: business_id,
          contactPhone,
          instanceId: instanceId || null,
          messages: { 
            texts: currentMessages, 
            providerMessageIds: currentProviderMessageIds,
            contactJid: phone,
            contactName: contactName || '',
            provider: provider || undefined
          },
          expiresAt
        },
        update: {
          messages: { 
            texts: currentMessages, 
            providerMessageIds: currentProviderMessageIds,
            contactJid: phone,
            contactName: contactName || '',
            provider: provider || undefined
          },
          instanceId: instanceId || undefined,
          expiresAt
        }
      });
      
      console.log(`[Agent Think] Buffer created/updated successfully for ${contactPhone}`);
      
      // Capture all providerMessageIds and provider for this buffer
      const capturedProviderMessageIds = currentProviderMessageIds;
      const capturedProvider = provider;
      
      const timeout = setTimeout(async () => {
        console.log(`[Agent Buffer] Processing buffer for ${contactPhone} after ${bufferSeconds}s delay`);
        try {
          const buffer = await prisma.messageBuffer.findUnique({
            where: { businessId_contactPhone: { businessId: business_id, contactPhone } }
          });
          
          if (buffer) {
            const bufferData = buffer.messages as any;
            const messages = bufferData?.texts || (Array.isArray(bufferData) ? bufferData : []);
            const messageIds = bufferData?.providerMessageIds || [];
            
            console.log(`[Agent Buffer] Found ${messages.length} messages to process for ${contactPhone}`);
            
            await prisma.messageBuffer.delete({
              where: { id: buffer.id }
            });
            
            activeBuffers.delete(bufferKey);
            
            console.log(`[Agent Buffer] Calling processWithAgentQueuedWithIds for ${contactPhone}`);
            await processWithAgentQueuedWithIds(
              business_id,
              messages,
              phone,
              contactPhone,
              contactName,
              instanceId,
              instanceBackendId,
              messageIds,
              capturedProvider
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
      instanceBackendId,
      providerMessageId,
      provider
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
    
    const prompt = await prisma.agentPrompt.findFirst({
      where: { businessId: business_id as string },
      include: { tools: true },
      orderBy: { updatedAt: 'desc' }
    });
    
    res.json({
      prompt: prompt?.prompt || '',
      bufferSeconds: prompt?.bufferSeconds ?? 7,
      historyLimit: prompt?.historyLimit || 10,
      splitMessages: prompt?.splitMessages ?? true,
      tools: prompt?.tools || []
    });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

router.get('/health/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { contactPhone, instanceId } = req.query;
    
    // Build product filter - only show products for selected instance
    // If instance is specified, show ONLY that instance's products (not shared ones)
    const productWhere: any = { businessId };
    if (instanceId && String(instanceId).trim() !== '') {
      productWhere.instanceId = instanceId as string;
    }
    
    // Build instance filter for resources that support it
    const instanceFilter = instanceId && String(instanceId).trim() !== '' 
      ? { instanceId: instanceId as string }
      : {};
    
    const [business, promptSections, leadStages, extractionFields, reminders, products] = await Promise.all([
      prisma.business.findFirst({
        where: { id: businessId, userId: req.userId },
        include: {
          agentPrompts: { 
            include: { 
              tools: true,
              files: { select: { id: true, name: true, fileUrl: true } }
            } 
          },
          instances: { select: { id: true, status: true, provider: true, phoneNumber: true, businessObjective: true } },
          availability: { select: { dayOfWeek: true, isBlocked: true, startTime: true, endTime: true } },
          policy: true,
          user: { select: { paymentLinkEnabled: true, subscriptionTier: true, subscriptionStatus: true } }
        }
      }),
      prisma.promptSection.findMany({
        where: { businessId, enabled: true },
        select: { id: true, title: true, type: true, isCore: true, embedding: true, content: true }
      }),
      prisma.tag.findMany({
        where: { businessId, ...instanceFilter },
        select: { id: true, name: true, description: true, color: true },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.extractionField.findMany({
        where: { businessId, enabled: true, ...instanceFilter },
        select: { id: true, fieldKey: true, fieldLabel: true, description: true, fieldType: true }
      }),
      prisma.reminder.findMany({
        where: { 
          businessId,
          status: 'PENDING'
        },
        select: { id: true, contactPhone: true, scheduledAt: true },
        orderBy: { scheduledAt: 'asc' },
        take: 10
      }),
      prisma.product.findMany({
        where: productWhere,
        select: { id: true, title: true, price: true, stock: true, imageUrl: true, instanceId: true }
      })
    ]);
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // Use instance objective if available, otherwise fall back to business objective
    let objective = business.businessObjective || 'SALES';
    let selectedInstance = null;
    if (instanceId && String(instanceId).trim() !== '') {
      selectedInstance = business.instances?.find((i: any) => i.id === instanceId);
      if (selectedInstance?.businessObjective) {
        objective = selectedInstance.businessObjective;
      }
    }
    const isSalesMode = objective !== 'APPOINTMENTS';
    const isAppointmentMode = objective === 'APPOINTMENTS';
    const productCount = products.length;
    
    // Find the correct prompt for the selected instance
    // If instanceId is specified, ONLY use that instance's prompt (strict isolation)
    // If no instanceId, use the first available prompt (legacy behavior)
    let selectedPrompt = null;
    if (instanceId && String(instanceId).trim() !== '') {
      selectedPrompt = business.agentPrompts?.find((p: any) => p.instanceId === instanceId);
    } else {
      // Legacy: use first prompt without instanceId, or any first prompt
      selectedPrompt = business.agentPrompts?.find((p: any) => !p.instanceId) || business.agentPrompts?.[0];
    }
    const customTools = selectedPrompt?.tools || [];
    const agentFiles = selectedPrompt?.files || [];
    const hasAvailability = business.availability?.some((a: any) => !a.isBlocked) || false;
    const instanceConnected = business.instances?.some((i: any) => i.status === 'open' || i.status === 'connected') || false;
    const paymentLinkEnabled = business.user?.paymentLinkEnabled ?? false;
    
    const activeTools: any[] = [];
    const inactiveTools: any[] = [];
    const contextItems: any[] = [];
    const warnings: string[] = [];
    
    if (isSalesMode) {
      if (productCount > 20) {
        activeTools.push({ name: 'buscar_producto', type: 'builtin', description: 'Busqueda inteligente de productos' });
      } else if (productCount > 0) {
        contextItems.push({ name: 'Catalogo en prompt', count: productCount, description: 'Productos incluidos directamente' });
      }
      
      if (productCount > 0) {
        if (paymentLinkEnabled) {
          activeTools.push({ name: 'crear_enlace_pago', type: 'builtin', description: 'Genera enlaces de pago con Stripe' });
          inactiveTools.push({ name: 'crear_pedido_voucher', reason: 'Link de pago activado por Super Admin' });
        } else {
          activeTools.push({ name: 'crear_pedido_voucher', type: 'builtin', description: 'Crea pedidos con comprobante de pago' });
          inactiveTools.push({ name: 'crear_enlace_pago', reason: 'Solo activable por Super Admin' });
        }
      } else {
        inactiveTools.push({ name: 'crear_pedido_voucher', reason: 'Sin productos configurados' });
        inactiveTools.push({ name: 'crear_enlace_pago', reason: 'Sin productos configurados' });
        warnings.push('Agrega productos para habilitar ventas');
      }
      
      inactiveTools.push({ name: 'consultar_disponibilidad', reason: 'Solo en modo CITAS' });
      inactiveTools.push({ name: 'agendar_cita', reason: 'Solo en modo CITAS' });
    }
    
    if (isAppointmentMode) {
      activeTools.push({ name: 'consultar_disponibilidad', type: 'builtin', description: 'Verifica horarios disponibles' });
      activeTools.push({ name: 'agendar_cita', type: 'builtin', description: 'Agenda citas con clientes' });
      
      if (!hasAvailability) {
        warnings.push('Configura horarios de atencion para que funcionen las citas');
      } else {
        contextItems.push({ name: 'Horarios configurados', description: 'Disponibilidad semanal activa' });
      }
      
      inactiveTools.push({ name: 'buscar_producto', reason: 'Solo en modo VENTAS' });
      inactiveTools.push({ name: 'crear_pedido_voucher', reason: 'Solo en modo VENTAS' });
      inactiveTools.push({ name: 'crear_enlace_pago', reason: 'Solo en modo VENTAS' });
    }
    
    if (agentFiles.length > 0) {
      activeTools.push({ name: 'enviar_archivo', type: 'builtin', description: 'Envia archivos al cliente' });
      contextItems.push({ name: 'Archivos disponibles', count: agentFiles.length, files: agentFiles.map((f: any) => f.name) });
    } else {
      inactiveTools.push({ name: 'enviar_archivo', reason: 'Sin archivos cargados' });
    }
    
    customTools.forEach((tool: any) => {
      activeTools.push({ 
        name: `custom_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`, 
        type: 'custom', 
        description: tool.description,
        endpoint: tool.endpoint
      });
    });
    
    if (!instanceConnected) {
      warnings.push('WhatsApp no conectado - el agente no puede recibir mensajes');
    }
    
    if (!business.agentPrompts?.[0]?.prompt) {
      warnings.push('Configura el prompt del agente para mejores respuestas');
    } else {
      contextItems.push({ name: 'Prompt personalizado', description: 'Instrucciones del negocio configuradas' });
    }
    
    if (business.policy) {
      contextItems.push({ name: 'Politicas del negocio', description: 'Envios, devoluciones, tono de marca' });
    }
    
    const coreSections = promptSections.filter(s => s.isCore);
    const ragSections = promptSections.filter(s => !s.isCore);
    const ragWithoutEmbeddings = ragSections.filter(s => !s.embedding);
    
    if (ragWithoutEmbeddings.length > 0) {
      warnings.push(`${ragWithoutEmbeddings.length} secciones RAG sin embeddings - editalas para generar embeddings`);
    }
    
    if (coreSections.length > 0) {
      contextItems.push({ 
        name: 'Secciones Core', 
        count: coreSections.length, 
        description: 'Siempre incluidas en el prompt',
        files: coreSections.map(s => s.title)
      });
    }
    
    if (ragSections.length > 0) {
      activeTools.push({ 
        name: 'buscar_seccion_rag', 
        type: 'builtin', 
        description: `Recupera secciones por contexto (${ragSections.length} disponibles)` 
      });
      contextItems.push({ 
        name: 'Secciones RAG', 
        count: ragSections.length, 
        description: 'Recuperadas dinamicamente segun contexto del mensaje',
        files: ragSections.map(s => s.title)
      });
    }
    
    // Build the complete context network
    const promptContext = {
      masterPrompt: business.agentPrompts?.[0]?.prompt ? {
        enabled: true,
        length: business.agentPrompts?.[0].prompt.length,
        preview: business.agentPrompts?.[0].prompt.substring(0, 200) + (business.agentPrompts?.[0].prompt.length > 200 ? '...' : '')
      } : null,
      bufferSeconds: business.agentPrompts?.[0]?.bufferSeconds ?? 7,
      historyLimit: business.agentPrompts?.[0]?.historyLimit || 10,
      splitMessages: business.agentPrompts?.[0]?.splitMessages ?? true
    };
    
    const policyContext = business.policy ? {
      enabled: true,
      sections: {
        shippingPolicy: !!business.policy.shippingPolicy,
        refundPolicy: !!business.policy.refundPolicy,
        brandVoice: !!business.policy.brandVoice,
        allowedHours: !!business.policy.allowedHours
      }
    } : null;
    
    const catalogContext = {
      mode: productCount > 20 ? 'search_tool' : productCount > 0 ? 'in_prompt' : 'empty',
      count: productCount,
      products: products.slice(0, 5).map((p: any) => ({
        id: p.id,
        title: p.title,
        price: p.price,
        stock: p.stock,
        hasImage: !!p.imageUrl
      })),
      hasMore: productCount > 5
    };
    
    const leadStagesContext = {
      enabled: leadStages.length > 0,
      count: leadStages.length,
      stages: leadStages.map((s: any) => ({
        name: s.name,
        color: s.color,
        description: s.description
      }))
    };
    
    const dataExtractionContext = {
      enabled: extractionFields.length > 0,
      count: extractionFields.length,
      fields: extractionFields.map((f: any) => ({
        key: f.fieldKey,
        label: f.fieldLabel,
        type: f.fieldType,
        description: f.description
      }))
    };
    
    const remindersContext = {
      pendingCount: reminders.length,
      nextReminders: reminders.slice(0, 3).map((r: any) => ({
        phone: r.contactPhone,
        scheduledAt: r.scheduledAt
      }))
    };
    
    const availabilityContext = business.availability && hasAvailability ? {
      enabled: true,
      days: business.availability.filter((a: any) => !a.isBlocked).map((a: any) => ({
        day: a.dayOfWeek,
        start: a.startTime,
        end: a.endTime
      }))
    } : null;
    
    const filesContext = agentFiles.length > 0 ? {
      enabled: true,
      count: agentFiles.length,
      files: agentFiles.map((f: any) => ({
        name: f.name,
        url: f.fileUrl
      }))
    } : null;
    
    const instanceContext = business.instances?.[0] ? {
      connected: instanceConnected,
      provider: business.instances[0].provider,
      phoneNumber: business.instances[0].phoneNumber,
      status: business.instances[0].status
    } : null;
    
    const subscriptionContext = {
      tier: business.user?.subscriptionTier || 'BASIC',
      status: business.user?.subscriptionStatus || 'PENDING',
      paymentLinkEnabled
    };
    
    res.json({
      objective,
      objectiveLabel: isAppointmentMode ? 'Citas' : 'Ventas',
      model: business.openaiModel || 'gpt-4o-mini',
      botEnabled: business.botEnabled ?? true,
      timezone: business.timezone || 'America/Lima',
      currencyCode: business.currencyCode || 'PEN',
      currencySymbol: business.currencySymbol || 'S/.',
      instanceConnected,
      paymentLinkEnabled,
      paymentMode: paymentLinkEnabled ? 'Link de Pago (Stripe)' : 'Voucher/Comprobante',
      activeTools,
      inactiveTools,
      contextItems,
      warnings,
      stats: {
        productCount,
        customToolCount: customTools.length,
        fileCount: agentFiles.length,
        ragSectionCount: ragSections.length,
        coreSectionCount: coreSections.length,
        leadStageCount: leadStages.length,
        extractionFieldCount: extractionFields.length,
        pendingReminderCount: reminders.length
      },
      // Detailed context network
      contextNetwork: {
        prompt: promptContext,
        policy: policyContext,
        catalog: catalogContext,
        leadStages: leadStagesContext,
        dataExtraction: dataExtractionContext,
        reminders: remindersContext,
        availability: availabilityContext,
        files: filesContext,
        instance: instanceContext,
        subscription: subscriptionContext,
        sections: {
          core: coreSections.map((s: any) => ({
            title: s.title,
            type: s.type,
            contentPreview: s.content?.substring(0, 100) + (s.content?.length > 100 ? '...' : '')
          })),
          rag: ragSections.map((s: any) => ({
            title: s.title,
            type: s.type,
            hasEmbedding: !!s.embedding,
            contentPreview: s.content?.substring(0, 100) + (s.content?.length > 100 ? '...' : '')
          }))
        },
        customTools: customTools.map((t: any) => ({
          name: t.name,
          description: t.description,
          endpoint: t.endpoint,
          method: t.method
        }))
      }
    });
  } catch (error: any) {
    console.error('Get agent health error:', error);
    res.status(500).json({ error: 'Failed to get agent health' });
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

async function checkProFeatureAccess(userId: string): Promise<{ allowed: boolean; tier: string; message?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionTier: true, subscriptionStatus: true, isPro: true, proBonusExpiresAt: true }
  });
  
  if (!user) {
    return { allowed: false, tier: 'UNKNOWN', message: 'User not found' };
  }
  
  const tier = user.subscriptionTier || 'BASIC';
  const isProOrHigher = tier === 'PRO' || tier === 'ENTERPRISE';
  const hasIsPro = user.isPro === true;
  const hasValidProBonus = user.proBonusExpiresAt && user.proBonusExpiresAt > new Date();
  
  if (hasIsPro || hasValidProBonus) {
    return { allowed: true, tier: hasIsPro ? 'ENTERPRISE' : tier };
  }
  
  if (!isProOrHigher) {
    return { 
      allowed: false, 
      tier, 
      message: 'Esta funcion solo esta disponible para el plan PRO ($97/mes). Tu plan actual es BASIC ($29/mes).' 
    };
  }
  
  return { allowed: true, tier };
}

router.post('/api-key/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const proAccess = await checkProFeatureAccess(req.userId!);
    if (!proAccess.allowed) {
      return res.status(403).json({ error: proAccess.message, tier: proAccess.tier, requiresPro: true });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
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
    
    const proAccess = await checkProFeatureAccess(req.userId!);
    if (!proAccess.allowed) {
      return res.status(403).json({ error: proAccess.message, tier: proAccess.tier, requiresPro: true });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
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

router.post('/webhook/:businessId/test', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId },
      select: {
        id: true,
        name: true,
        webhookUrl: true,
        webhookEvents: true,
        userId: true
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const user = await prisma.user.findUnique({
      where: { id: business.userId },
      select: { subscriptionTier: true, email: true }
    });

    const testData = {
      contactPhone: '+1234567890',
      contactName: 'Test Contact',
      message: 'This is a test webhook message',
      messageType: 'text',
      test: true
    };

    const result = await dispatchWebhook(businessId, 'user_message', testData);

    res.json({
      ...result,
      businessName: business.name,
      webhookUrl: business.webhookUrl,
      webhookEvents: business.webhookEvents,
      userTier: user?.subscriptionTier,
      testPayload: testData
    });
  } catch (error: any) {
    console.error('Test webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== DELIVERY ZONES ====================

router.get('/delivery-zones/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const zones = await prisma.deliveryZone.findMany({
      where: { businessId },
      orderBy: { order: 'asc' }
    });
    
    res.json(zones);
  } catch (error: any) {
    console.error('Get delivery zones error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/delivery-zones/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { name, districts, address, cost, freeAbove, deliveryTime, policy } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const maxOrder = await prisma.deliveryZone.aggregate({
      where: { businessId },
      _max: { order: true }
    });
    
    const zone = await prisma.deliveryZone.create({
      data: {
        businessId,
        name,
        districts: districts || [],
        address,
        cost: parseFloat(cost) || 0,
        freeAbove: freeAbove ? parseFloat(freeAbove) : null,
        deliveryTime,
        policy,
        order: (maxOrder._max.order || 0) + 1
      }
    });
    
    res.json(zone);
  } catch (error: any) {
    console.error('Create delivery zone error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/delivery-zones/:businessId/:zoneId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, zoneId } = req.params;
    const { name, districts, address, cost, freeAbove, deliveryTime, policy, isActive, order } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const zone = await prisma.deliveryZone.update({
      where: { id: zoneId },
      data: {
        name,
        districts,
        address,
        cost: cost !== undefined ? parseFloat(cost) : undefined,
        freeAbove: freeAbove !== undefined ? (freeAbove ? parseFloat(freeAbove) : null) : undefined,
        deliveryTime,
        policy,
        isActive,
        order
      }
    });
    
    res.json(zone);
  } catch (error: any) {
    console.error('Update delivery zone error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/delivery-zones/:businessId/:zoneId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, zoneId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.deliveryZone.delete({
      where: { id: zoneId }
    });
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete delivery zone error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/delivery-zones/:businessId/import', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { zones } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!Array.isArray(zones)) {
      return res.status(400).json({ error: 'zones must be an array' });
    }
    
    const maxOrder = await prisma.deliveryZone.aggregate({
      where: { businessId },
      _max: { order: true }
    });
    
    let currentOrder = (maxOrder._max.order || 0) + 1;
    const created: any[] = [];
    const errors: any[] = [];
    
    for (const z of zones) {
      try {
        if (!z.name) {
          errors.push({ row: z, error: 'name is required' });
          continue;
        }
        
        const zone = await prisma.deliveryZone.create({
          data: {
            businessId,
            name: z.name,
            districts: Array.isArray(z.districts) ? z.districts : (z.districts ? z.districts.split(',').map((d: string) => d.trim()) : []),
            address: z.address || null,
            cost: parseFloat(z.cost) || 0,
            freeAbove: z.freeAbove ? parseFloat(z.freeAbove) : null,
            deliveryTime: z.deliveryTime || null,
            policy: z.policy || null,
            order: currentOrder++
          }
        });
        created.push(zone);
      } catch (e: any) {
        errors.push({ row: z, error: e.message });
      }
    }
    
    res.json({ 
      success: true, 
      imported: created.length, 
      errors: errors.length,
      errorDetails: errors 
    });
  } catch (error: any) {
    console.error('Import delivery zones error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/delivery-zones/:businessId/reorder', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { zoneIds } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!Array.isArray(zoneIds)) {
      return res.status(400).json({ error: 'zoneIds must be an array' });
    }
    
    await Promise.all(
      zoneIds.map((id, index) => 
        prisma.deliveryZone.update({
          where: { id },
          data: { order: index }
        })
      )
    );
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Reorder delivery zones error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/funnel-stages/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { instance_id } = req.query;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const whereClause: any = { businessId };
    if (instance_id && String(instance_id).trim() !== '') {
      whereClause.instanceId = instance_id as string;
    }
    
    const stages = await prisma.funnelStage.findMany({
      where: whereClause,
      orderBy: { order: 'asc' }
    });
    
    res.json(stages);
  } catch (error: any) {
    console.error('Get funnel stages error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/funnel-stages/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { name, description, promptContext, requiredFieldKeys, blockedTopics, toolsAllowed, instanceId } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!name?.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    const whereClause: any = { businessId };
    if (instanceId) {
      whereClause.instanceId = instanceId;
    }
    
    const maxOrder = await prisma.funnelStage.aggregate({
      where: whereClause,
      _max: { order: true }
    });
    
    const stage = await prisma.funnelStage.create({
      data: {
        businessId,
        instanceId: instanceId || null,
        name: name.trim(),
        description: description || null,
        promptContext: promptContext || null,
        requiredFieldKeys: requiredFieldKeys || [],
        blockedTopics: blockedTopics || [],
        toolsAllowed: toolsAllowed || [],
        order: (maxOrder._max.order ?? -1) + 1
      }
    });
    
    res.json(stage);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'A stage with this name already exists' });
    }
    console.error('Create funnel stage error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/funnel-stages/:businessId/:stageId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, stageId } = req.params;
    const { name, description, promptContext, requiredFieldKeys, blockedTopics, toolsAllowed, isActive } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const stage = await prisma.funnelStage.update({
      where: { id: stageId },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        description: description !== undefined ? description : undefined,
        promptContext: promptContext !== undefined ? promptContext : undefined,
        requiredFieldKeys: requiredFieldKeys !== undefined ? requiredFieldKeys : undefined,
        blockedTopics: blockedTopics !== undefined ? blockedTopics : undefined,
        toolsAllowed: toolsAllowed !== undefined ? toolsAllowed : undefined,
        isActive: isActive !== undefined ? isActive : undefined
      }
    });
    
    res.json(stage);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'A stage with this name already exists' });
    }
    console.error('Update funnel stage error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/funnel-stages/:businessId/:stageId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, stageId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.funnelStage.delete({
      where: { id: stageId }
    });
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete funnel stage error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/funnel-stages/:businessId/reorder', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { stageIds } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!Array.isArray(stageIds)) {
      return res.status(400).json({ error: 'stageIds must be an array' });
    }
    
    await Promise.all(
      stageIds.map((id, index) => 
        prisma.funnelStage.update({
          where: { id },
          data: { order: index }
        })
      )
    );
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Reorder funnel stages error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/extraction-fields/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const fields = await prisma.extractionField.findMany({
      where: { businessId, enabled: true },
      orderBy: { order: 'asc' }
    });
    
    res.json(fields);
  } catch (error: any) {
    console.error('Get extraction fields error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ INTELLIGENT PROMPT IMPORTER ============

import { geminiService } from '../services/gemini.js';

router.post('/analyze-prompt', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, rawPrompt } = req.body;
    
    if (!business_id || !rawPrompt) {
      return res.status(400).json({ error: 'business_id and rawPrompt are required' });
    }
    
    if (rawPrompt.length > 50000) {
      return res.status(400).json({ error: 'Prompt too long (max 50,000 characters)' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!geminiService.isConfigured()) {
      return res.status(503).json({ error: 'Gemini API not configured' });
    }
    
    console.log(`[IMPORT] Analyzing prompt for business ${business_id}, length: ${rawPrompt.length}`);
    
    const result = await geminiService.analyzeBusinessPrompt(rawPrompt);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to analyze prompt' });
    }
    
    // Get existing data to detect conflicts
    const [existingProducts, existingFields, existingStages, existingObjections, existingZones] = await Promise.all([
      prisma.product.findMany({ where: { businessId: business_id }, select: { title: true } }),
      prisma.extractionField.findMany({ where: { businessId: business_id }, select: { fieldKey: true } }),
      prisma.funnelStage.findMany({ where: { businessId: business_id }, select: { name: true } }),
      prisma.salesObjection.findMany({ where: { businessId: business_id }, select: { name: true } }),
      prisma.deliveryZone.findMany({ where: { businessId: business_id }, select: { name: true } })
    ]);
    
    const conflicts = {
      products: result.config.products.filter((p: { title: string }) => 
        existingProducts.some((ep: { title: string }) => ep.title.toLowerCase() === p.title.toLowerCase())
      ).map((p: { title: string }) => p.title),
      extractionFields: result.config.extractionFields.filter((f: { key: string }) =>
        existingFields.some((ef: { fieldKey: string }) => ef.fieldKey === f.key)
      ).map((f: { key: string }) => f.key),
      funnelStages: result.config.funnelStages.filter((s: { name: string }) =>
        existingStages.some((es: { name: string }) => es.name.toLowerCase() === s.name.toLowerCase())
      ).map((s: { name: string }) => s.name),
      objections: result.config.objections.filter((o: { trigger: string }) =>
        existingObjections.some((eo: { name: string }) => eo.name.toLowerCase() === o.trigger.toLowerCase())
      ).map((o: { trigger: string }) => o.trigger),
      deliveryZones: result.config.deliveryZones.filter((z: { name: string }) =>
        existingZones.some((ez: { name: string }) => ez.name.toLowerCase() === z.name.toLowerCase())
      ).map((z: { name: string }) => z.name)
    };
    
    res.json({
      success: true,
      config: result.config,
      missing: result.missing,
      warnings: result.warnings,
      conflicts,
      confidence: result.confidence,
      existingCounts: {
        products: existingProducts.length,
        extractionFields: existingFields.length,
        funnelStages: existingStages.length,
        objections: existingObjections.length,
        deliveryZones: existingZones.length
      }
    });
  } catch (error: any) {
    console.error('Analyze prompt error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/import-config', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, config, options = {} } = req.body;
    
    if (!business_id || !config) {
      return res.status(400).json({ error: 'business_id and config are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const { skipConflicts = true } = options;
    const results: Record<string, { created: number; skipped: number; errors: string[] }> = {
      products: { created: 0, skipped: 0, errors: [] },
      extractionFields: { created: 0, skipped: 0, errors: [] },
      funnelStages: { created: 0, skipped: 0, errors: [] },
      objections: { created: 0, skipped: 0, errors: [] },
      deliveryZones: { created: 0, skipped: 0, errors: [] },
      businessInfo: { created: 0, skipped: 0, errors: [] },
      agentPrompt: { created: 0, skipped: 0, errors: [] }
    };
    
    // Import Products
    if (config.products?.length > 0) {
      const existingTitles = (await prisma.product.findMany({
        where: { businessId: business_id },
        select: { title: true }
      })).map((p: { title: string }) => p.title.toLowerCase());
      
      for (const product of config.products) {
        try {
          if (skipConflicts && existingTitles.includes(product.title.toLowerCase())) {
            results.products.skipped++;
            continue;
          }
          await prisma.product.create({
            data: {
              businessId: business_id,
              title: product.title,
              description: product.description || null,
              price: product.price || 0
            }
          });
          results.products.created++;
        } catch (err: any) {
          results.products.errors.push(`${product.title}: ${err.message}`);
        }
      }
    }
    
    // Import Extraction Fields
    if (config.extractionFields?.length > 0) {
      const existingKeys = (await prisma.extractionField.findMany({
        where: { businessId: business_id },
        select: { fieldKey: true }
      })).map(f => f.fieldKey);
      
      const maxOrder = await prisma.extractionField.aggregate({
        where: { businessId: business_id },
        _max: { order: true }
      });
      let order = (maxOrder._max.order || 0) + 1;
      
      for (const field of config.extractionFields) {
        try {
          if (skipConflicts && existingKeys.includes(field.key)) {
            results.extractionFields.skipped++;
            continue;
          }
          await prisma.extractionField.create({
            data: {
              businessId: business_id,
              fieldKey: field.key,
              fieldLabel: field.label,
              fieldType: 'text',
              description: field.description || null,
              order: order++,
              enabled: true
            }
          });
          results.extractionFields.created++;
        } catch (err: any) {
          results.extractionFields.errors.push(`${field.key}: ${err.message}`);
        }
      }
    }
    
    // Import Funnel Stages
    if (config.funnelStages?.length > 0) {
      const existingNames = (await prisma.funnelStage.findMany({
        where: { businessId: business_id },
        select: { name: true }
      })).map(s => s.name.toLowerCase());
      
      const maxOrder = await prisma.funnelStage.aggregate({
        where: { businessId: business_id },
        _max: { order: true }
      });
      let order = (maxOrder._max.order || 0) + 1;
      
      for (const stage of config.funnelStages) {
        try {
          if (skipConflicts && existingNames.includes(stage.name.toLowerCase())) {
            results.funnelStages.skipped++;
            continue;
          }
          await prisma.funnelStage.create({
            data: {
              businessId: business_id,
              name: stage.name,
              description: stage.description || null,
              order: order++,
              requiredFieldKeys: stage.requiredFields || [],
              blockedTopics: stage.blockedTopics || [],
              isActive: true
            }
          });
          results.funnelStages.created++;
        } catch (err: any) {
          results.funnelStages.errors.push(`${stage.name}: ${err.message}`);
        }
      }
    }
    
    // Import Objections (using SalesObjection model)
    if (config.objections?.length > 0) {
      const existingNames = (await prisma.salesObjection.findMany({
        where: { businessId: business_id },
        select: { name: true }
      })).map((o: { name: string }) => o.name.toLowerCase());
      
      for (const objection of config.objections) {
        try {
          if (skipConflicts && existingNames.includes(objection.trigger.toLowerCase())) {
            results.objections.skipped++;
            continue;
          }
          await prisma.salesObjection.create({
            data: {
              businessId: business_id,
              name: objection.trigger,
              triggerPhrases: [objection.trigger],
              responseScript: objection.response,
              category: objection.category || 'general',
              priority: 50,
              isActive: true
            }
          });
          results.objections.created++;
        } catch (err: any) {
          results.objections.errors.push(`${objection.trigger}: ${err.message}`);
        }
      }
    }
    
    // Import Delivery Zones
    if (config.deliveryZones?.length > 0) {
      const existingNames = (await prisma.deliveryZone.findMany({
        where: { businessId: business_id },
        select: { name: true }
      })).map((z: { name: string }) => z.name.toLowerCase());
      
      for (const zone of config.deliveryZones) {
        try {
          if (skipConflicts && existingNames.includes(zone.name.toLowerCase())) {
            results.deliveryZones.skipped++;
            continue;
          }
          await prisma.deliveryZone.create({
            data: {
              businessId: business_id,
              name: zone.name,
              cost: zone.price || 0,
              deliveryTime: zone.estimatedTime || null,
              isActive: true
            }
          });
          results.deliveryZones.created++;
        } catch (err: any) {
          results.deliveryZones.errors.push(`${zone.name}: ${err.message}`);
        }
      }
    }
    
    // Update Business Info if provided
    if (config.businessInfo && Object.keys(config.businessInfo).length > 0) {
      try {
        const updateData: any = {};
        if (config.businessInfo.name) updateData.name = config.businessInfo.name;
        if (config.businessInfo.description) updateData.description = config.businessInfo.description;
        if (config.businessInfo.industry) updateData.industry = config.businessInfo.industry;
        if (config.businessInfo.currency) updateData.currencyCode = config.businessInfo.currency;
        if (config.businessInfo.timezone) updateData.timezone = config.businessInfo.timezone;
        
        if (Object.keys(updateData).length > 0) {
          await prisma.business.update({
            where: { id: business_id },
            data: updateData
          });
          results.businessInfo.created = 1;
        }
      } catch (err: any) {
        results.businessInfo.errors.push(err.message);
      }
    }
    
    // Update Agent Prompt if provided (using AgentPrompt table)
    if (config.agentPrompt) {
      try {
        const existingPrompt = await prisma.agentPrompt.findFirst({
          where: { businessId: business_id, instanceId: null }
        });
        
        if (existingPrompt) {
          await prisma.agentPrompt.update({
            where: { id: existingPrompt.id },
            data: { prompt: config.agentPrompt }
          });
        } else {
          await prisma.agentPrompt.create({
            data: {
              businessId: business_id,
              prompt: config.agentPrompt
            }
          });
        }
        results.agentPrompt.created = 1;
      } catch (err: any) {
        results.agentPrompt.errors.push(err.message);
      }
    }
    
    const totalCreated = Object.values(results).reduce((sum, r) => sum + r.created, 0);
    const totalSkipped = Object.values(results).reduce((sum, r) => sum + r.skipped, 0);
    const totalErrors = Object.values(results).reduce((sum, r) => sum + r.errors.length, 0);
    
    console.log(`[IMPORT] Config imported for business ${business_id}: ${totalCreated} created, ${totalSkipped} skipped, ${totalErrors} errors`);
    
    res.json({
      success: true,
      summary: {
        totalCreated,
        totalSkipped,
        totalErrors
      },
      details: results
    });
  } catch (error: any) {
    console.error('Import config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ FULL PROMPT IMPORT (Master + Sections + Config) ============

router.post('/import-full-prompt', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, rawPrompt, instanceId, options = {} } = req.body;
    
    if (!business_id || !rawPrompt) {
      return res.status(400).json({ error: 'business_id and rawPrompt are required' });
    }
    
    if (rawPrompt.length > 60000) {
      return res.status(400).json({ error: 'Prompt too long (max 60,000 characters)' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!geminiService.isConfigured()) {
      return res.status(503).json({ error: 'Gemini API not configured' });
    }
    
    const { skipConflicts = true, clearExisting = false } = options;
    
    console.log(`[IMPORT-FULL] Starting full import for business ${business_id}, length: ${rawPrompt.length}`);
    
    // Run both analyses in parallel
    const [masterResult, configResult] = await Promise.all([
      geminiService.generateMasterPromptAndSections(rawPrompt),
      geminiService.analyzeBusinessPrompt(rawPrompt)
    ]);
    
    if (!masterResult.success) {
      return res.status(500).json({ error: masterResult.error || 'Failed to generate master prompt and sections' });
    }
    
    const results = {
      masterPrompt: { updated: false, error: null as string | null },
      sections: { created: 0, skipped: 0, cleared: 0, errors: [] as string[] },
      config: { products: 0, fields: 0, stages: 0, objections: 0, zones: 0 }
    };
    
    // 1. Update Master Prompt
    try {
      const existingPrompt = await prisma.agentPrompt.findFirst({
        where: { 
          businessId: business_id, 
          ...(instanceId ? { instanceId } : { instanceId: null })
        }
      });
      
      if (existingPrompt) {
        await prisma.agentPrompt.update({
          where: { id: existingPrompt.id },
          data: { 
            prompt: masterResult.masterPrompt,
            bufferSeconds: 10,
            historyLimit: 15
          }
        });
      } else {
        await prisma.agentPrompt.create({
          data: {
            businessId: business_id,
            instanceId: instanceId || undefined,
            prompt: masterResult.masterPrompt,
            bufferSeconds: 10,
            historyLimit: 15
          }
        });
      }
      results.masterPrompt.updated = true;
      console.log(`[IMPORT-FULL] Master prompt updated, length: ${masterResult.masterPrompt.length}`);
    } catch (err: any) {
      results.masterPrompt.error = err.message;
    }
    
    // 2. Clear existing sections if requested
    if (clearExisting) {
      const deleted = await prisma.promptSection.deleteMany({
        where: { 
          businessId: business_id,
          ...(instanceId ? { instanceId } : {})
        }
      });
      results.sections.cleared = deleted.count;
    }
    
    // 3. Create Sections
    const existingSections = await prisma.promptSection.findMany({
      where: { businessId: business_id },
      select: { title: true, type: true }
    });
    const existingKeys = new Set(existingSections.map(s => `${s.type}:${s.title.toLowerCase()}`));
    
    for (const section of masterResult.sections) {
      const key = `${section.type}:${section.title.toLowerCase()}`;
      if (skipConflicts && existingKeys.has(key)) {
        results.sections.skipped++;
        continue;
      }
      
      try {
        await prisma.promptSection.create({
          data: {
            businessId: business_id,
            instanceId: instanceId || null,
            title: section.title,
            content: section.content,
            type: section.type,
            isCore: section.isCore,
            priority: section.priority,
            enabled: true,
            metadata: { keywords: section.keywords, sourceType: 'auto-import' }
          }
        });
        results.sections.created++;
      } catch (err: any) {
        results.sections.errors.push(`${section.title}: ${err.message}`);
      }
    }
    
    // 4. Import structured config (products, fields, stages, etc) from analyzeBusinessPrompt
    if (configResult.success && configResult.config) {
      const cfg = configResult.config;
      
      // Products
      if (cfg.products?.length > 0) {
        const existingTitles = new Set((await prisma.product.findMany({
          where: { businessId: business_id },
          select: { title: true }
        })).map(p => p.title.toLowerCase()));
        
        for (const product of cfg.products) {
          if (skipConflicts && existingTitles.has(product.title.toLowerCase())) continue;
          try {
            await prisma.product.create({
              data: {
                businessId: business_id,
                instanceId: instanceId || null,
                title: product.title,
                description: product.description || null,
                price: product.price || 0
              }
            });
            results.config.products++;
          } catch {}
        }
      }
      
      // Extraction Fields
      if (cfg.extractionFields?.length > 0) {
        const existingKeys = new Set((await prisma.extractionField.findMany({
          where: { businessId: business_id },
          select: { fieldKey: true }
        })).map(f => f.fieldKey));
        
        let order = ((await prisma.extractionField.aggregate({
          where: { businessId: business_id },
          _max: { order: true }
        }))._max.order || 0) + 1;
        
        for (const field of cfg.extractionFields) {
          if (skipConflicts && existingKeys.has(field.key)) continue;
          try {
            await prisma.extractionField.create({
              data: {
                businessId: business_id,
                instanceId: instanceId || null,
                fieldKey: field.key,
                fieldLabel: field.label,
                fieldType: 'text',
                order: order++,
                enabled: true
              }
            });
            results.config.fields++;
          } catch {}
        }
      }
      
      // Funnel Stages
      if (cfg.funnelStages?.length > 0) {
        const existingNames = new Set((await prisma.funnelStage.findMany({
          where: { businessId: business_id },
          select: { name: true }
        })).map(s => s.name.toLowerCase()));
        
        let order = ((await prisma.funnelStage.aggregate({
          where: { businessId: business_id },
          _max: { order: true }
        }))._max.order || 0) + 1;
        
        for (const stage of cfg.funnelStages) {
          if (skipConflicts && existingNames.has(stage.name.toLowerCase())) continue;
          try {
            await prisma.funnelStage.create({
              data: {
                businessId: business_id,
                instanceId: instanceId || null,
                name: stage.name,
                description: stage.description || null,
                order: order++,
                requiredFieldKeys: stage.requiredFields || [],
                blockedTopics: stage.blockedTopics || [],
                isActive: true
              }
            });
            results.config.stages++;
          } catch {}
        }
      }
      
      // Objections
      if (cfg.objections?.length > 0) {
        const existingNames = new Set((await prisma.salesObjection.findMany({
          where: { businessId: business_id },
          select: { name: true }
        })).map(o => o.name.toLowerCase()));
        
        for (const objection of cfg.objections) {
          if (skipConflicts && existingNames.has(objection.trigger.toLowerCase())) continue;
          try {
            await prisma.salesObjection.create({
              data: {
                businessId: business_id,
                name: objection.trigger,
                triggerPhrases: [objection.trigger],
                responseScript: objection.response,
                category: objection.category || 'general',
                isActive: true
              }
            });
            results.config.objections++;
          } catch {}
        }
      }
      
      // Delivery Zones
      if (cfg.deliveryZones?.length > 0) {
        const existingNames = new Set((await prisma.deliveryZone.findMany({
          where: { businessId: business_id },
          select: { name: true }
        })).map(z => z.name.toLowerCase()));
        
        for (const zone of cfg.deliveryZones) {
          if (skipConflicts && existingNames.has(zone.name.toLowerCase())) continue;
          try {
            await prisma.deliveryZone.create({
              data: {
                businessId: business_id,
                name: zone.name,
                cost: zone.price || 0,
                deliveryTime: zone.estimatedTime || null,
                isActive: true
              }
            });
            results.config.zones++;
          } catch {}
        }
      }
    }
    
    console.log(`[IMPORT-FULL] Completed for business ${business_id}:`, results);
    
    res.json({
      success: true,
      results,
      masterPromptPreview: masterResult.masterPrompt.substring(0, 500) + '...',
      sectionsGenerated: masterResult.sections.length
    });
  } catch (error: any) {
    console.error('[IMPORT-FULL] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ RAG KNOWLEDGE SECTIONS ============

import { generateEmbedding, retrieveRelevantSections, formatSectionsForPrompt, getRAGStats } from '../services/ragService.js';

router.post('/parse-prompt-sections', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, rawPrompt, instanceId } = req.body;
    
    if (!business_id || !rawPrompt) {
      return res.status(400).json({ error: 'business_id and rawPrompt are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!geminiService.isConfigured()) {
      return res.status(503).json({ error: 'Gemini API not configured' });
    }
    
    console.log(`[RAG-IMPORT] Parsing prompt to sections for business ${business_id}, length: ${rawPrompt.length}`);
    
    const result = await geminiService.parsePromptToSections(rawPrompt);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to parse prompt' });
    }
    
    const existingSections = await prisma.promptSection.findMany({
      where: { 
        businessId: business_id,
        ...(instanceId ? { OR: [{ instanceId }, { instanceId: null }] } : {})
      },
      select: { type: true, title: true }
    });
    
    const existingTypes = new Set(existingSections.map(s => s.type));
    
    res.json({
      success: true,
      sections: result.sections,
      missingCategories: result.missingCategories,
      existingSections: existingSections.length,
      existingTypes: Array.from(existingTypes)
    });
  } catch (error: any) {
    console.error('Parse prompt sections error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/import-sections', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, sections, instanceId, replaceExisting = false } = req.body;
    
    if (!business_id || !sections || !Array.isArray(sections)) {
      return res.status(400).json({ error: 'business_id and sections array are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    console.log(`[RAG-IMPORT] Importing ${sections.length} sections for business ${business_id}, replaceExisting: ${replaceExisting}`);
    
    if (replaceExisting) {
      const deleted = await prisma.promptSection.deleteMany({
        where: {
          businessId: business_id,
          ...(instanceId ? { instanceId } : {}),
          sourceType: 'import'
        }
      });
      console.log(`[RAG-IMPORT] Deleted ${deleted.count} existing imported sections`);
    }
    
    const results = { created: 0, skipped: 0, errors: [] as string[] };
    
    for (const section of sections) {
      try {
        if (!section.title || !section.content || !section.type) {
          results.errors.push(`Section missing required fields: ${JSON.stringify(section).substring(0, 100)}`);
          continue;
        }
        
        let embedding: number[] | null = null;
        if (!section.isCore) {
          embedding = await generateEmbedding(`${section.title}\n${section.content}`);
        }
        
        await prisma.promptSection.create({
          data: {
            businessId: business_id,
            instanceId: instanceId || null,
            type: section.type,
            title: section.title,
            content: section.content,
            isCore: section.isCore || false,
            priority: section.priority || 0,
            keywords: section.keywords || [],
            embedding: embedding as any,
            sourceType: 'import',
            enabled: true
          }
        });
        results.created++;
      } catch (err: any) {
        results.errors.push(`${section.title}: ${err.message}`);
      }
    }
    
    console.log(`[RAG-IMPORT] Import complete: ${results.created} created, ${results.errors.length} errors`);
    
    res.json({
      success: true,
      created: results.created,
      skipped: results.skipped,
      errors: results.errors
    });
  } catch (error: any) {
    console.error('Import sections error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/knowledge-sections/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { instanceId } = req.query;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const where: any = { businessId, enabled: true };
    if (instanceId) {
      where.OR = [{ instanceId: instanceId as string }, { instanceId: null }];
    }
    
    const sections = await prisma.promptSection.findMany({
      where,
      orderBy: [{ isCore: 'desc' }, { priority: 'desc' }, { type: 'asc' }],
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        isCore: true,
        priority: true,
        keywords: true,
        sourceType: true,
        instanceId: true,
        createdAt: true,
        updatedAt: true
      }
    });
    
    const byType: Record<string, typeof sections> = {};
    for (const section of sections) {
      if (!byType[section.type]) {
        byType[section.type] = [];
      }
      byType[section.type].push(section);
    }
    
    const allTypes = ['CORE', 'TONE', 'SALES', 'POLICIES', 'FAQ', 'OBJECTIONS', 'CLOSING', 'OTHER'];
    const missingTypes = allTypes.filter(t => !byType[t] || byType[t].length === 0);
    
    res.json({
      sections,
      byType,
      totalSections: sections.length,
      missingTypes,
      coverage: ((allTypes.length - missingTypes.length) / allTypes.length * 100).toFixed(0) + '%'
    });
  } catch (error: any) {
    console.error('Get knowledge sections error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/knowledge-sections', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, instanceId, type, title, content, isCore, priority, keywords } = req.body;
    
    if (!business_id || !type || !title || !content) {
      return res.status(400).json({ error: 'business_id, type, title, and content are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    let embedding: number[] | null = null;
    if (!isCore) {
      embedding = await generateEmbedding(`${title}\n${content}`);
    }
    
    const section = await prisma.promptSection.create({
      data: {
        businessId: business_id,
        instanceId: instanceId || null,
        type,
        title,
        content,
        isCore: isCore || false,
        priority: priority || 5,
        keywords: keywords || [],
        embedding: embedding as any,
        sourceType: 'manual',
        enabled: true
      }
    });
    
    console.log(`[RAG] Created section ${section.id} (${type}) for business ${business_id}`);
    
    res.json({ success: true, section });
  } catch (error: any) {
    console.error('Create knowledge section error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/knowledge-sections/:sectionId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { sectionId } = req.params;
    const { title, content, isCore, priority, keywords, enabled } = req.body;
    
    const section = await prisma.promptSection.findUnique({
      where: { id: sectionId },
      include: { business: true }
    });
    
    if (!section || section.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Section not found' });
    }
    
    let embedding = section.embedding;
    if (title !== undefined || content !== undefined) {
      const newTitle = title || section.title;
      const newContent = content || section.content;
      if (!section.isCore) {
        embedding = await generateEmbedding(`${newTitle}\n${newContent}`) as any;
      }
    }
    
    const updated = await prisma.promptSection.update({
      where: { id: sectionId },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(isCore !== undefined && { isCore }),
        ...(priority !== undefined && { priority }),
        ...(keywords !== undefined && { keywords }),
        ...(enabled !== undefined && { enabled }),
        ...(embedding !== undefined && { embedding: embedding as any })
      }
    });
    
    res.json({ success: true, section: updated });
  } catch (error: any) {
    console.error('Update knowledge section error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/knowledge-sections/:sectionId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { sectionId } = req.params;
    
    const section = await prisma.promptSection.findUnique({
      where: { id: sectionId },
      include: { business: true }
    });
    
    if (!section || section.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Section not found' });
    }
    
    await prisma.promptSection.delete({ where: { id: sectionId } });
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete knowledge section error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/query-knowledge', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, query, instanceId, categories, topK = 5 } = req.body;
    
    if (!business_id || !query) {
      return res.status(400).json({ error: 'business_id and query are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const result = await retrieveRelevantSections(business_id, query, topK);
    const formattedContext = formatSectionsForPrompt(result);
    
    res.json({
      success: true,
      coreSections: result.coreSections,
      ragSections: result.ragSections,
      totalTokensEstimate: result.totalTokensEstimate,
      formattedContext
    });
  } catch (error: any) {
    console.error('Query knowledge error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/knowledge-stats/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const stats = await getRAGStats(businessId);
    
    res.json({ success: true, stats });
  } catch (error: any) {
    console.error('Get knowledge stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/suggest-missing-content', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, category } = req.body;
    
    if (!business_id || !category) {
      return res.status(400).json({ error: 'business_id and category are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existingSections = await prisma.promptSection.findMany({
      where: { businessId: business_id, enabled: true },
      select: { title: true, content: true }
    });
    
    const result = await geminiService.suggestMissingContent(
      category,
      existingSections,
      { name: business.name, industry: business.industry || undefined }
    );
    
    res.json(result);
  } catch (error: any) {
    console.error('Suggest missing content error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
