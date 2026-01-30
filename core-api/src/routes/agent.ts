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
import { analyzeIntent, buildDynamicPrompt, getConversationContext, selectToolsForIntent, IntentAnalysis, ConversationContext } from '../services/intentAnalyzer.js';
import { getContactStageStatus, setContactStage } from '../services/funnelStageService.js';
import { createAutoOrder } from '../services/orderAutoCreator.js';
import { createOrder, findProductWithScope, formatAgentToolResponse, addItemToExistingOrder, checkExistingPendingOrder, createOrderFromAgent } from '../services/orderService.js';
import { queueAgentResponse, markMessageAsRead as markMsgRead, isQueueAvailable, extractMediaFromText as extractMediaHelper } from '../services/whatsappSender.js';
import { retrieveRelevantSections, formatSectionsForPrompt } from '../services/ragService.js';
import { parseAgentOutputToWhatsAppEvents } from '../services/agentOutputParser.js';
import { processWithOrchestrator, OrchestratorInput } from '../services/agent/index.js';
import { toolRegistry } from '../services/agent/core/toolRegistry.js';
import { registerAllNativeTools } from '../services/agent/tools/index.js';

const router = Router();

const USE_V3_AGENT = process.env.USE_V3_AGENT === 'true';

// Interfaces for layered context system
interface LayeredContext {
  systemPrompt: string;
  tools: OpenAI.Chat.ChatCompletionTool[];
  metadata: {
    tokensEstimate: number;
    layersUsed: string[];
    coreSectionsCount: number;
    ragSectionsCount: number;
  };
}

interface ContextBuilderParams {
  business: any;
  contactPhone: string;
  messages: string[];
  instanceId?: string;
  intentAnalysis?: IntentAnalysis;
  conversationContext?: ConversationContext;
  funnelStatus?: any;
  existingOrder?: any;
  extractedData?: Record<string, any>;
  products?: any[];
  deliveryZones?: any[];
  agentFiles?: any[];
  promptConfig?: any;
  contactSettings?: any;
  pendingVoucherOrder?: any;
  contactAssignment?: any;
}

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

// Generate embedding for RAG sections
async function generateSectionEmbedding(text: string): Promise<number[] | null> {
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      console.warn('[EMBEDDING] OPENAI_API_KEY not set, skipping embedding');
      return null;
    }
    const openai = new OpenAI({ apiKey: openaiKey });
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000)
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('[EMBEDDING] Error generating embedding:', error);
    return null;
  }
}
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
  console.log(`[Agent Processor] Falling back to direct processing for ${contactPhone}, USE_V3_AGENT=${USE_V3_AGENT}`);
  const firstMessageId = providerMessageIds?.[0];
  
  try {
    // Check if V3 agent should be used
    if (USE_V3_AGENT) {
      console.log(`[Agent Processor] Using V3 Orchestrator for ${contactPhone}`);
      
      // Convert messages to ChatMessage format
      const chatMessages = messages.map((content: string, idx: number) => ({
        role: idx === messages.length - 1 ? 'user' as const : 'user' as const,
        content
      }));
      
      const orchestratorInput: OrchestratorInput = {
        businessId,
        instanceId: instanceId || null,
        contactPhone: phone,
        contactName,
        messages: chatMessages
      };
      
      const v3Result = await processWithOrchestrator(orchestratorInput);
      console.log(`[Agent Processor] V3 Orchestrator completed for ${contactPhone}: response length=${v3Result.response?.length || 0}`);
      
      // Send response via WhatsApp
      if (v3Result.response && v3Result.response.length > 0) {
        const business = await prisma.business.findUnique({
          where: { id: businessId },
          include: { 
            instances: {
              include: {
                metaCredential: true,
                metaCoexistCredential: true
              }
            }
          }
        });
        
        if (business) {
          await sendWhatsAppResponseDirect(instanceId || '', phone, v3Result.response, business);
        }
      }
      
      return { response: v3Result.response, queued: false };
    }
    
    // Fallback to V1
    console.log(`[Agent Processor] Using V1 Agent for ${contactPhone}`);
    const result = await processWithAgent(businessId, messages, phone, contactPhone, contactName, instanceId, instanceBackendId, firstMessageId, provider);
    console.log(`[Agent Processor] processWithAgent completed for ${contactPhone}: response length=${result.response?.length || 0}`);
    return result;
  } catch (error: any) {
    console.error(`[Agent Processor] Error in processing for ${contactPhone}:`, error.message);
    
    // If V3 fails, try V1 as fallback
    if (USE_V3_AGENT) {
      console.log(`[Agent Processor] V3 failed, falling back to V1 for ${contactPhone}`);
      try {
        const result = await processWithAgent(businessId, messages, phone, contactPhone, contactName, instanceId, instanceBackendId, firstMessageId, provider);
        return result;
      } catch (v1Error: any) {
        console.error(`[Agent Processor] V1 fallback also failed for ${contactPhone}:`, v1Error.message);
        throw v1Error;
      }
    }
    
    throw error;
  }
}

async function sendWhatsAppResponseDirect(
  instanceId: string,
  phone: string,
  message: string,
  business: any
): Promise<void> {
  try {
    const instance = business.instances?.find((i: any) => i.id === instanceId);
    const cleanPhone = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    
    if (!instance) {
      console.error(`[Agent Send] Instance ${instanceId} not found in business instances`);
      return;
    }
    
    const events = parseAgentOutputToWhatsAppEvents(message);
    console.log(`[Agent Send] Parsed ${events.length} events for ${cleanPhone}:`, events.map(e => e.type));
    
    const metaCredential = instance.metaCredential;
    const coexistCredential = instance.metaCoexistCredential;
    
    if ((instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') && (metaCredential || coexistCredential)) {
      let accessToken: string;
      let phoneNumberId: string;
      let metaBusinessId: string;
      
      if (metaCredential) {
        accessToken = metaCredential.accessToken;
        phoneNumberId = metaCredential.phoneNumberId;
        metaBusinessId = metaCredential.businessId;
      } else if (coexistCredential) {
        accessToken = coexistCredential.systemAccessToken || coexistCredential.userAccessToken;
        phoneNumberId = coexistCredential.phoneNumberId;
        metaBusinessId = coexistCredential.metaBusinessId;
      } else {
        console.error(`[Agent Send] No valid credential found for instance ${instanceId}`);
        return;
      }
      
      console.log(`[Agent Send] Sending via Meta Cloud API (${instance.provider}) to ${cleanPhone}`);
      const metaService = new MetaCloudService({
        accessToken,
        phoneNumberId,
        businessId: metaBusinessId
      });
      
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        
        if (i > 0) {
          const delay = event.type === 'text' ? calculateTypingDelay(event.text || '') : 500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Save message to database
        const messageLog = await prisma.messageLog.create({
          data: {
            businessId: business.id,
            instanceId: instance.id,
            direction: 'outbound',
            sender: instance.phoneNumber || 'bot',
            recipient: cleanPhone,
            message: event.type === 'text' ? event.text : (event.caption || null),
            mediaUrl: event.url || null,
            deliveryStatus: 'pending',
            deliveryAttempts: 0,
            metadata: { 
              source: 'agent_direct',
              provider: instance.provider || 'BAILEYS',
              type: event.type,
              ...(event.type !== 'text' && { mediaType: event.type, filename: event.filename })
            }
          }
        });
        
        console.log(`[Agent Send] Sending event ${i+1}/${events.length}: type=${event.type}, to=${cleanPhone}, logId=${messageLog.id}`);
        
        try {
          let sendResult: any;
          
          if (event.type === 'text' && event.text) {
            sendResult = await metaService.sendTextMessage(cleanPhone, event.text);
          } else if (event.type === 'image' && event.url) {
            sendResult = await metaService.sendImageMessage(cleanPhone, event.url, event.caption);
          } else if (event.type === 'video' && event.url) {
            sendResult = await metaService.sendVideoMessage(cleanPhone, event.url, event.caption);
          } else if (event.type === 'audio' && event.url) {
            sendResult = await metaService.sendAudioMessage(cleanPhone, event.url);
          } else if (event.type === 'document' && event.url) {
            sendResult = await metaService.sendDocumentMessage(cleanPhone, event.url, event.filename, event.caption);
          }
          
          const providerMessageId = sendResult?.messages?.[0]?.id;
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              deliveryStatus: 'sent',
              deliveryAttempts: 1,
              providerMessageId: providerMessageId || null
            }
          });
          console.log(`[Agent Send] Event ${i+1} SUCCESS: messageId=${providerMessageId}`);
        } catch (sendErr: any) {
          console.error(`[Agent Send] Event ${i+1} FAILED: ${sendErr.message}`);
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              deliveryStatus: 'failed',
              deliveryError: sendErr.message,
              deliveryAttempts: 1
            }
          });
        }
      }
    } else if (instance.instanceBackendId) {
      // BAILEYS provider - send via WA API
      const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
      
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        
        if (i > 0) {
          const delay = event.type === 'text' ? calculateTypingDelay(event.text || '') : 500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const messageLog = await prisma.messageLog.create({
          data: {
            businessId: business.id,
            instanceId: instance.id,
            direction: 'outbound',
            sender: instance.phoneNumber || 'bot',
            recipient: cleanPhone,
            message: event.type === 'text' ? event.text : (event.caption || null),
            mediaUrl: event.url || null,
            deliveryStatus: 'pending',
            deliveryAttempts: 0,
            metadata: { 
              source: 'agent_direct',
              provider: 'BAILEYS',
              type: event.type
            }
          }
        });
        
        try {
          const payload: any = { to: cleanPhone };
          
          if (event.type === 'text') {
            payload.text = event.text;
          } else {
            payload.mediaUrl = event.url;
            payload.mediaType = event.type;
            if (event.caption) payload.caption = event.caption;
            if (event.filename) payload.filename = event.filename;
          }
          
          const response = await axios.post(
            `${WA_API_URL}/instances/${instance.instanceBackendId}/send`,
            payload
          );
          
          const waMessageId = response.data?.messageId;
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              deliveryStatus: 'sent',
              deliveryAttempts: 1,
              providerMessageId: waMessageId || null
            }
          });
          console.log(`[Agent Send] Baileys event ${i+1} SUCCESS: messageId=${waMessageId}`);
        } catch (sendErr: any) {
          console.error(`[Agent Send] Baileys event ${i+1} FAILED: ${sendErr.message}`);
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              deliveryStatus: 'failed',
              deliveryError: sendErr.message,
              deliveryAttempts: 1
            }
          });
        }
      }
    } else {
      console.error(`[Agent Send] No valid provider/credentials for instance ${instanceId}`);
    }
  } catch (error: any) {
    console.error(`[Agent Send] Error sending WhatsApp response:`, error.message);
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
  
  // Convert Markdown links to plain URLs (WhatsApp doesn't support Markdown links)
  sanitizedResponse = sanitizedResponse.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    // If text and URL are the same, just return the URL
    if (text === url) return url;
    // If text is different, return "text: url" format
    return `${text}: ${url}`;
  });
  
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

async function sendAgentResponseDirect(
  business: any,
  instance: any,
  backendId: string | undefined,
  contactPhone: string,
  phone: string,
  aiResponse: string,
  splitMessages: boolean,
  contactName?: string,
  incomingMessageId?: string
): Promise<void> {
  let sentMedia: any[] = [];
  
  if ((instance.provider === 'META_CLOUD' && instance.metaCredential) || 
      (instance.provider === 'META_COEXIST' && instance.metaCoexistCredential)) {
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
    
    // Mark message as read for Meta providers (legacy fallback)
    if (incomingMessageId) {
      try {
        await metaService.markAsRead(incomingMessageId);
      } catch (readErr: any) {
        console.warn('[Direct Send] Failed to mark as read:', readErr.message);
      }
    }
    
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
        console.error(`[Direct Send] Failed to send media: ${media.url}`, mediaError.message);
      }
    }
  } else if (backendId) {
    const result = await sendMessageInParts(backendId, phone, aiResponse, splitMessages);
    sentMedia = result.sentMedia;
  }
  
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
        agentVersion: 'legacy_direct',
        provider: instance.provider,
        splitMessages,
        sentMedia: sentMedia.length > 0 ? sentMedia.map((m: any) => ({ type: m.type, url: m.url })) : undefined
      }
    }
  });
  
  dispatchAgentMessage(
    business.id,
    contactPhone,
    aiResponse,
    sentMedia.length > 0 ? sentMedia.map((m: any) => m.url) : undefined,
    undefined,
    instance?.id
  ).catch(err => console.error('[Direct Send] Failed to dispatch webhook:', err.message));
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
      // Mark message as read before responding
      let messageIdToMark = providerMessageId;
      if (!messageIdToMark) {
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
        await markMsgRead({ instanceId: instance.id, providerMessageId: messageIdToMark });
        console.log(`[Agent V2] Message marked as read:`, messageIdToMark);
      }
      
      // Queue the response for sending via unified outbound queue
      if (isQueueAvailable()) {
        const queueResult = await queueAgentResponse({
          businessId: business.id,
          instanceId: instance.id,
          to: contactPhone,
          response: aiResponse,
          splitMessages,
          priority: 'normal'
        });
        
        if (queueResult.success) {
          console.log(`[Agent V2] Response queued: ${queueResult.jobIds?.length || 1} jobs for ${contactPhone}`);
        } else {
          console.error(`[Agent V2] Failed to queue response: ${queueResult.error}`);
          throw new Error(queueResult.error);
        }
      } else {
        // Fallback to direct send if queue not available (legacy mode)
        console.warn('[Agent V2] Queue not available, falling back to direct send');
        await sendAgentResponseDirect(business, instance, backendId, contactPhone, phone, aiResponse, splitMessages, contactName, messageIdToMark);
      }
      
      // Schedule follow-up after queuing response
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
  
  // Load delivery zones filtered by instanceId
  const deliveryZones = await prisma.deliveryZone.findMany({
    where: {
      businessId,
      isActive: true,
      OR: instanceId 
        ? [{ instanceId }, { instanceId: null }]
        : [{ instanceId: null }]
    },
    orderBy: { order: 'asc' }
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
  
  // Find the correct prompt config: instance-specific first, then shared (null instanceId), then first available
  let promptConfig = instanceId 
    ? business.agentPrompts?.find((p: any) => p.instanceId === instanceId)
    : null;
  
  if (!promptConfig) {
    promptConfig = business.agentPrompts?.find((p: any) => !p.instanceId) || business.agentPrompts?.[0];
  }
  console.log(`[Agent V1] Using prompt: ${promptConfig?.id || 'default'} (instanceId: ${instanceId || 'none'})`);
  
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
  
  // Store extracted data for later use
  let extractedDataForPrompt: Record<string, any> = {};
  if (contactSettings?.notes) {
    try {
      const parsedNotes = JSON.parse(contactSettings.notes);
      const extractedData = parsedNotes.extractedData || {};
      const dataEntries = Object.entries(extractedData).filter(([_, v]) => v && String(v).trim() !== '');
      if (dataEntries.length > 0) {
        extractedDataForPrompt = Object.fromEntries(dataEntries);
        console.log(`[Agent V1] Loaded extracted data for context: ${JSON.stringify(extractedDataForPrompt)}`);
      }
    } catch (parseError) {
      // Notes not valid JSON, ignore
    }
  }
  
  // Check for active pending order
  const existingOrder = await checkExistingPendingOrder(businessId, normalizedContactPhone, instanceId);
  let existingOrderWithItems: any = null;
  if (existingOrder) {
    const orderItems = await prisma.orderItem.findMany({
      where: { orderId: existingOrder.id }
    });
    existingOrderWithItems = { ...existingOrder, items: orderItems };
  }
  
  // Load pending voucher order
  const pendingVoucherOrder = await prisma.order.findFirst({
    where: {
      businessId,
      contactPhone: contactPhone.replace(/\D/g, ''),
      status: 'AWAITING_VOUCHER'
    },
    orderBy: { createdAt: 'desc' },
    include: { items: true }
  });
  
  // Load contact assignment (tags) - now supports multiple tags
  const contactAssignments = await prisma.tagAssignment.findMany({
    where: {
      businessId,
      contactPhone: contactPhone
    },
    include: {
      tag: {
        include: {
          stagePrompt: true
        }
      }
    }
  });
  
  // For backward compatibility, use first tag if exists
  const contactAssignment = contactAssignments.length > 0 ? contactAssignments[0] : null;
  
  // Load agent files
  const agentFiles = await prisma.agentFile.findMany({
    where: { 
      prompt: { businessId },
      enabled: true 
    },
    orderBy: { order: 'asc' }
  });
  
  // Build layered context using new system
  const layeredContext = await buildLayeredContext({
    business,
    contactPhone: normalizedContactPhone,
    messages: [combinedMessage],
    instanceId,
    intentAnalysis: intentAnalysis || undefined,
    conversationContext,
    funnelStatus,
    existingOrder: existingOrderWithItems || undefined,
    extractedData: extractedDataForPrompt,
    products,
    deliveryZones,
    agentFiles,
    promptConfig,
    contactSettings,
    pendingVoucherOrder: pendingVoucherOrder || undefined,
    contactAssignment: contactAssignment || undefined
  }, tools);
  
  const systemPrompt = layeredContext.systemPrompt;
  const openaiTools = layeredContext.tools;
  
  console.log(`[Agent V1] Layered context built: ${layeredContext.metadata.layersUsed.join(', ')}, Core: ${layeredContext.metadata.coreSectionsCount}, RAG: ${layeredContext.metadata.ragSectionsCount}, ~${layeredContext.metadata.tokensEstimate} tokens`);
  
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
  
  // OLD CODE REMOVED - Now using buildLayeredContext above
  // The following code was replaced by buildLayeredContext:
  // - Manual prompt construction
  // - Manual tool construction
  
  // Continue with OpenAI API call using layered context
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
    
    // Force tool usage when customer is ready to buy (READY_TO_BUY or CLOSING intent)
    const shouldForceOrderTool = intentAnalysis && 
      (intentAnalysis.intent === 'READY_TO_BUY' || intentAnalysis.intent === 'CLOSING') &&
      business.businessObjective !== 'APPOINTMENTS';
    
    if (shouldForceOrderTool) {
      // Find the specific order tool name
      const orderTool = openaiTools.find((t: any) => 
        t.function?.name === 'registrar_pedido' || t.function?.name === 'crear_enlace_pago'
      );
      
      if (orderTool) {
        const orderToolName = (orderTool as any).function?.name;
        // Force the SPECIFIC order tool - required for Gemini/OpenRouter
        chatParams.tool_choice = { 
          type: 'function', 
          function: { name: orderToolName } 
        };
        console.log(`[Agent V1] FORCING tool_choice to SPECIFIC tool: ${orderToolName} due to intent: ${intentAnalysis?.intent}`);
      } else {
        chatParams.tool_choice = 'auto';
      }
    } else {
      chatParams.tool_choice = 'auto';
    }
  }
  
  // Log available tools for debugging
  const toolNames = openaiTools.map(t => (t as any).function?.name || 'unknown');
  console.log(`[Agent V1] Available tools: [${toolNames.join(', ')}] for business ${businessId}`);
  
  let completion = await openai.chat.completions.create(chatParams);
  let totalTokens = completion.usage?.total_tokens || 0;
  let totalPromptTokens = completion.usage?.prompt_tokens || 0;
  let totalCompletionTokens = completion.usage?.completion_tokens || 0;
  
  // CRITICAL LOGGING: Did OpenAI call any tools?
  const hasToolCalls = !!completion.choices[0]?.message?.tool_calls;
  const responseContent = completion.choices[0]?.message?.content || '';
  console.log(`[Agent V1] OpenAI response - hasToolCalls: ${hasToolCalls}, responsePreview: "${responseContent.substring(0, 100)}..."`);
  
  if (!hasToolCalls && (responseContent.toLowerCase().includes('pedido') || responseContent.toLowerCase().includes('registrado') || responseContent.toLowerCase().includes('confirmado'))) {
    console.warn(`[Agent V1] WARNING: Agent mentioned "pedido/registrado/confirmado" but DID NOT call registrar_pedido tool!`);
    console.warn(`[Agent V1] Full response: ${responseContent}`);
  }
  
  const userId = business.userId;
  
  // Track if order tool was executed
  let orderToolExecuted = false;
  
  // Track product images to send automatically (don't rely on AI including the URL)
  const productImagesToSend: string[] = [];
  
  while (completion.choices[0]?.message?.tool_calls) {
    const toolCalls = completion.choices[0].message.tool_calls;
    console.log(`[Agent V1] Processing ${toolCalls.length} tool calls: ${toolCalls.map((t: any) => t.function.name).join(', ')}`);
    const toolMessages: any[] = [completion.choices[0].message];
    
    for (const toolCall of toolCalls) {
      const fn = (toolCall as any).function;
      const toolName = fn.name;
      console.log(`[Agent V1] Executing tool: ${toolName} with args: ${fn.arguments}`);
      
      if (toolName === 'buscar_producto') {
        const args = JSON.parse(fn.arguments);
        const searchQuery = args.consulta || args.query || '';
        
        console.log(`[PRODUCT SEARCH] Query: "${searchQuery}" (intelligent matching, instanceId: ${instanceId || 'all'})`);
        
        const searchResult = await searchProductsIntelligent(businessId, searchQuery, 10, instanceId);
        const currencySymbol = business.currencySymbol || 'S/.';
        
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
            result.instruccion = `🖼️ OBLIGATORIO: Este producto tiene imagen. DEBES incluir esta URL al final de tu respuesta para que se envíe la foto: ${bestMatch.imageUrl}`;
            result.imagen_producto = {
              url: bestMatch.imageUrl,
              nombre: bestMatch.title
            };
            result.aviso_imagen = `Este producto tiene imagen disponible. Incluye la URL ${bestMatch.imageUrl} al final de tu respuesta.`;
            // Also save for automatic sending (don't rely on AI including the URL)
            if (!productImagesToSend.includes(bestMatch.imageUrl)) {
              productImagesToSend.push(bestMatch.imageUrl);
              console.log(`[PRODUCT IMAGE] Queued for auto-send: ${bestMatch.imageUrl}`);
            }
          }
          
          resultContent = JSON.stringify(result);
        } else {
          resultContent = JSON.stringify({ 
            error: true,
            mensaje: `PRODUCTO NO ENCONTRADO: "${searchQuery}" no existe en el catálogo.`,
            instruccion_obligatoria: 'NO inventes este producto. Responde al cliente que ese producto no está disponible y pregunta si le interesa otro producto del catálogo.',
            sugerencia: 'Pregunta al cliente qué otro producto le interesa o si quiere ver las opciones disponibles.'
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
        orderToolExecuted = true;
        console.log(`[Agent V1] ORDER TOOL EXECUTED: ${toolName}`);
        const args = JSON.parse(fn.arguments);
        const productSearch = args.producto_id;
        const quantity = args.cantidad || 1;
        const customerName = args.nombre_cliente;
        const shippingAddress = args.direccion_envio;
        const city = args.ciudad || '';
        const country = args.pais || '';
        const locationCoordinates = args.coordenadas_ubicacion || null;
        const deliveryZoneName = args.zona_entrega || '';
        const shippingCostFromAgent = args.costo_envio ?? null;
        
        const canUsePaymentLink = business.user?.paymentLinkEnabled || false;
        console.log(`[Agent V1] Order tool: product="${productSearch}", qty=${quantity}, paymentLink=${canUsePaymentLink}, zone="${deliveryZoneName}", shippingCost=${shippingCostFromAgent}, instance=${instanceId || 'NULL'}`);
        
        let paymentResult: string;
        
        if (!canUsePaymentLink) {
          // Use simplified function that handles everything automatically
          const result = await createOrderFromAgent({
            businessId,
            instanceId,
            contactPhone,
            producto_id: productSearch,
            cantidad: quantity,
            nombre_cliente: customerName,
            direccion_envio: shippingAddress,
            ciudad: city,
            pais: country,
            zona_entrega: deliveryZoneName,
            costo_envio: shippingCostFromAgent ?? undefined
          });
          
          paymentResult = JSON.stringify(result);
          console.log(`[Agent V1] Order result: ${result.exito ? 'SUCCESS' : 'FAILED'}, orderId: ${result.pedido_id || 'N/A'}`);
        } else {
          const product = await findProductWithScope(businessId, productSearch, instanceId);
          
          if (!product) {
            paymentResult = JSON.stringify({
              exito: false,
              error: `Producto "${productSearch}" no encontrado en el catálogo`
            });
            console.log(`[PAYMENT LINK] Product not found: ${productSearch}`);
          } else {
            const result = await createProductPaymentLink({
              businessId,
              contactPhone,
              contactName: customerName,
              items: [{ productId: product.id, quantity }],
              shippingAddress,
              shippingCity: city,
              shippingCountry: country,
              instanceId: instanceId || undefined
            });
            
            if (result.success && result.paymentUrl) {
              await prisma.paymentLinkRequest.create({
                data: {
                  businessId,
                  contactPhone,
                  triggerSource: 'agent',
                  productId: product.id,
                  productName: product.title,
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
                  productId: product.id,
                  productName: product.title,
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
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: paymentResult
        });
        continue;
      }
      
      if (toolName === 'agregar_producto_orden') {
        const args = JSON.parse(fn.arguments);
        const productSearch = args.producto_id;
        const quantity = args.cantidad || 1;
        
        console.log(`[Agent V1] Adding product to existing order: product="${productSearch}", qty=${quantity}`);
        
        const product = await findProductWithScope(businessId, productSearch, instanceId);
        
        if (!product) {
          const addItemResult = JSON.stringify({
            exito: false,
            error: `Producto "${productSearch}" no encontrado en el catálogo`
          });
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: addItemResult
          });
          continue;
        }
        
        const addItemResult = await addItemToExistingOrder(
          businessId,
          contactPhone,
          {
            productId: product.id,
            productTitle: product.title,
            quantity,
            unitPrice: product.price,
            imageUrl: product.imageUrl || null
          },
          instanceId
        );
        
        if (addItemResult.success) {
          const response = JSON.stringify({
            exito: true,
            mensaje: `Producto "${product.title}" agregado exitosamente a la orden activa`,
            pedido_id: addItemResult.orderId,
            total_actualizado: addItemResult.newTotal,
            cantidad_items: addItemResult.itemCount,
            moneda: business.currencySymbol || 'S/.',
            orden_activa: true,
            instrucciones: 'El producto se agregó a la orden activa. Puedes seguir agregando más productos o completar los datos faltantes.'
          });
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: response
          });
          console.log(`[Agent V1] Product added to order: ${addItemResult.orderId}, new total: ${addItemResult.newTotal}`);
        } else {
          const response = JSON.stringify({
            exito: false,
            error: addItemResult.reason || 'No se pudo agregar el producto a la orden'
          });
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: response
          });
          console.log(`[Agent V1] Failed to add product: ${addItemResult.reason}`);
        }
        continue;
      }
      
      // CRITICAL TOOL: Calculate order total (products + shipping)
      if (toolName === 'calcular_total_pedido') {
        const args = JSON.parse(fn.arguments);
        console.log(`[Agent V1] Calculating order total:`, JSON.stringify(args));
        
        try {
          // Note: deliveryZones is already loaded at the start of the handler from prisma
          // DeliveryZone uses 'cost' for shipping price and 'freeAbove' for free shipping threshold
          const currencySymbol = business.currencySymbol || 'S/.';
          
          // Validate inputs
          if (!args.productos || args.productos.length === 0) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                exito: false,
                error: 'No se especificaron productos. Pregunta qué productos desea el cliente.'
              })
            });
            continue;
          }
          
          if (!args.zona_envio || args.zona_envio.trim() === '') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                exito: false,
                error: 'No se especificó la zona de envío. Pregunta al cliente su distrito o zona.'
              })
            });
            continue;
          }
          
          // Find matching delivery zone (fuzzy match)
          const zonaNormalizada = args.zona_envio.toLowerCase().trim();
          let matchedZone: typeof deliveryZones[0] | null = null;
          
          for (const zone of deliveryZones) {
            const zoneName = zone.name.toLowerCase().trim();
            if (zoneName === zonaNormalizada || 
                zoneName.includes(zonaNormalizada) || 
                zonaNormalizada.includes(zoneName)) {
              matchedZone = zone;
              break;
            }
          }
          
          if (!matchedZone) {
            const availableZones = deliveryZones.map(z => z.name).join(', ');
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                exito: false,
                error: `Zona "${args.zona_envio}" no encontrada. Zonas disponibles: ${availableZones || 'No hay zonas configuradas'}`
              })
            });
            continue;
          }
          
          // Calculate product subtotal
          let subtotal = 0;
          const productDetails: Array<{ nombre: string; cantidad: number; precio_unitario: number; subtotal: number }> = [];
          const notFoundProducts: string[] = [];
          
          for (const item of args.productos) {
            const product = await findProductWithScope(businessId, item.nombre, instanceId);
            const cantidad = Math.max(1, item.cantidad || 1);
            
            if (product) {
              const itemTotal = product.price * cantidad;
              subtotal += itemTotal;
              productDetails.push({
                nombre: product.title + (product.variation ? ` (${product.variation})` : ''),
                cantidad,
                precio_unitario: product.price,
                subtotal: itemTotal
              });
            } else {
              notFoundProducts.push(item.nombre);
            }
          }
          
          if (productDetails.length === 0) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                exito: false,
                error: `Productos no encontrados: ${notFoundProducts.join(', ')}. Verifica los nombres.`
              })
            });
            continue;
          }
          
          // Check if subtotal qualifies for free shipping
          const freeShippingThreshold = matchedZone.freeAbove || null;
          const qualifiesForFreeShipping = freeShippingThreshold !== null && subtotal >= freeShippingThreshold;
          const shippingCost = qualifiesForFreeShipping ? 0 : (matchedZone.cost || 0);
          const total = subtotal + shippingCost;
          
          const result = {
            exito: true,
            productos: productDetails,
            subtotal_productos: subtotal,
            zona_envio: matchedZone.name,
            costo_envio: shippingCost,
            total: total,
            moneda: currencySymbol,
            resumen: `Subtotal: ${currencySymbol}${subtotal.toFixed(2)} + Envío (${matchedZone.name}): ${currencySymbol}${shippingCost.toFixed(2)} = TOTAL: ${currencySymbol}${total.toFixed(2)}`,
            productos_no_encontrados: notFoundProducts.length > 0 ? notFoundProducts : undefined,
            envio_gratis: qualifiesForFreeShipping 
              ? `Envío GRATIS por compras mayores a ${currencySymbol}${freeShippingThreshold}` 
              : (freeShippingThreshold ? `Envío gratis desde ${currencySymbol}${freeShippingThreshold}` : undefined)
          };
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
          
          console.log(`[Agent V1] Order total calculated: ${currencySymbol}${total.toFixed(2)} (${productDetails.length} products + shipping to ${matchedZone.name})`);
        } catch (error: any) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              exito: false,
              error: `Error al calcular: ${error.message}`
            })
          });
          console.error(`[Agent V1] Error calculating total:`, error.message);
        }
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
            content: JSON.stringify({ 
              disponible: false, 
              error: 'Error al consultar disponibilidad', 
              detalle: error.message 
            })
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
      
      // Handle RAG section search tool
      if (toolName === 'buscar_seccion_rag') {
        const args = JSON.parse(fn.arguments);
        const query = args.consulta || args.query || '';
        
        console.log(`[RAG SEARCH] Query: "${query}" for business ${businessId}`);
        
        try {
          // Use the RAG service to retrieve relevant sections
          const ragResult = await retrieveRelevantSections(
            businessId,
            query,
            5, // Limit to 5 most relevant sections
            instanceId
          );
          
          if (ragResult.ragSections.length > 0) {
            const formattedSections = formatSectionsForPrompt(ragResult);
            const result = JSON.stringify({
              exito: true,
              secciones_encontradas: ragResult.ragSections.length,
              secciones: ragResult.ragSections.map((s: any) => ({
                titulo: s.title,
                contenido: s.content.substring(0, 500) + (s.content.length > 500 ? '...' : ''),
                relevancia: s.similarity ? Math.round(s.similarity * 100) + '%' : 'N/A'
              })),
              contenido_completo: formattedSections,
              instruccion: 'Usa esta información para responder al cliente de manera precisa y contextualizada.'
            });
            
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });
            console.log(`[RAG SEARCH] Found ${ragResult.ragSections.length} relevant sections`);
          } else {
            const result = JSON.stringify({
              exito: false,
              mensaje: 'No se encontraron secciones relevantes para esta consulta',
              sugerencia: 'Responde al cliente basándote en el contexto general disponible'
            });
            
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });
            console.log(`[RAG SEARCH] No relevant sections found`);
          }
        } catch (error: any) {
          const result = JSON.stringify({
            exito: false,
            error: 'Error al buscar secciones',
            detalle: error.message
          });
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
          console.error(`[RAG SEARCH] Error:`, error);
        }
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
  
  // Remove image URLs from response if they were sent automatically
  if (productImagesToSend.length > 0) {
    const urlRegex = /https?:\/\/[^\s]+/g;
    aiResponse = aiResponse.replace(urlRegex, (url) => {
      return productImagesToSend.includes(url) ? '' : url;
    }).trim();
  }
  
  // Send response to WhatsApp if we have an instanceId and valid response
  if (instanceId && aiResponse) {
    await sendWhatsAppResponseDirect(instanceId, phone, aiResponse, business);
  }
  
  return { response: aiResponse, tokensUsed: totalTokens };
}

// ============ LAYERED CONTEXT SYSTEM ============

// CAPA 1: Base Context (Prompt maestro, objetivo, políticas básicas)
function buildBaseContext(business: any, promptConfig?: any): string {
  let context = promptConfig?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
  
  const businessObjective = business.businessObjective as 'SALES' | 'APPOINTMENTS';
  const isAppointmentMode = businessObjective === 'APPOINTMENTS';
  
  if (isAppointmentMode) {
    context += `\n\n## Modo de operación: CITAS Y SERVICIOS
Tu objetivo principal es ayudar a los clientes a agendar citas y consultar disponibilidad de servicios.
- Ofrece horarios disponibles cuando el cliente quiera agendar
- Confirma los detalles de la cita (fecha, hora, servicio)
- Responde preguntas sobre los servicios ofrecidos
- NO intentes vender productos ni crear pedidos`;
  } else {
    context += `\n\n## Modo de operación: VENTAS
Tu objetivo principal es ayudar a los clientes con sus compras y consultas sobre productos.`;
  }
  
  if (business.policy) {
    context += `\n\n## Políticas del negocio:`;
    if (business.policy.brandVoice) {
      context += `\n- Tono de marca: ${business.policy.brandVoice}`;
    }
    if (business.policy.shippingPolicy) {
      context += `\n- Envíos: ${business.policy.shippingPolicy}`;
    }
    if (business.policy.refundPolicy) {
      context += `\n- Devoluciones: ${business.policy.refundPolicy}`;
    }
  }
  
  return context;
}

// CAPA 2: Critical Context (Orden activa, funnel stage, datos extraídos)
function buildCriticalContext(params: ContextBuilderParams): string {
  let context = '';
  
  // Orden activa con tracking de pagos
  if (params.existingOrder) {
    const currencySymbol = params.business.currencySymbol || 'S/.';
    const orderItems = params.existingOrder.items || [];
    const itemsList = orderItems.map((item: any) => `- ${item.productTitle} (x${item.quantity}) - ${currencySymbol}${(item.unitPrice * item.quantity).toFixed(2)}`).join('\n');
    
    const paidAmount = params.existingOrder.paidAmount || 0;
    const totalAmount = params.existingOrder.totalAmount || 0;
    const pendingAmount = Math.max(0, totalAmount - paidAmount);
    const paymentProgress = paidAmount > 0 ? `(${((paidAmount / totalAmount) * 100).toFixed(0)}% pagado)` : '';
    
    let statusText = 'Pendiente de pago';
    if (params.existingOrder.status === 'AWAITING_VOUCHER') {
      if (paidAmount > 0 && paidAmount < totalAmount) {
        statusText = 'Pago parcial recibido - esperando completar pago';
      } else {
        statusText = 'Esperando comprobante de pago';
      }
    } else if (params.existingOrder.status === 'PAID') {
      statusText = 'PAGADO COMPLETAMENTE';
    }
    
    context += `\n\n## 🛒 ORDEN ACTIVA EN ESTA CONVERSACIÓN:
- ID de pedido: ${params.existingOrder.id.slice(-8).toUpperCase()}
- Estado: ${statusText} ${paymentProgress}
- Productos en la orden:
${itemsList}

### 💰 ESTADO DE PAGO:
- Total del pedido: ${currencySymbol}${totalAmount.toFixed(2)}
- Monto pagado: ${currencySymbol}${paidAmount.toFixed(2)}
- Monto pendiente: ${currencySymbol}${pendingAmount.toFixed(2)}`;

    if (paidAmount > 0 && pendingAmount > 0) {
      context += `\n\n⚠️ El cliente ha realizado un pago parcial. Falta ${currencySymbol}${pendingAmount.toFixed(2)} para completar el pedido.
Cuando el cliente envíe otro voucher, se SUMARÁ al monto pagado.`;
    }

    context += `\n\nIMPORTANTE: Esta orden está ACTIVA. Puedes:
- Agregar más productos usando agregar_producto_orden
- Completar datos faltantes (dirección, nombre)
- Recibir múltiples pagos parciales hasta completar el total
- La orden se mantendrá activa hasta que el monto pagado = total.`;
  }
  
  // Funnel stage
  if (params.funnelStatus?.currentStage) {
    context += `\n\n## FLUJO DE VENTA - Etapa actual: "${params.funnelStatus.currentStage.name}"`;
    if (params.funnelStatus.currentStage.promptContext) {
      context += `\n${params.funnelStatus.currentStage.promptContext}`;
    }
    if (params.funnelStatus.missingFields && params.funnelStatus.missingFields.length > 0) {
      context += `\n\n### DATOS OBLIGATORIOS PENDIENTES (debes obtenerlos ANTES de avanzar):`;
      params.funnelStatus.missingFields.forEach((field: string) => {
        context += `\n- ${field}`;
      });
      context += `\n\nIMPORTANTE: NO avances a la siguiente etapa ni cierres la venta hasta tener TODOS estos datos.`;
    } else if (params.funnelStatus.canAdvance && params.funnelStatus.nextStage) {
      context += `\n\n### Datos completos - puedes avanzar a "${params.funnelStatus.nextStage.name}"`;
    }
    if (params.funnelStatus.currentStage.blockedTopics && params.funnelStatus.currentStage.blockedTopics.length > 0) {
      context += `\n\n### TEMAS BLOQUEADOS en esta etapa (no abordar aún):`;
      params.funnelStatus.currentStage.blockedTopics.forEach((topic: string) => {
        context += `\n- ${topic}`;
      });
    }
  }
  
  // Estado del pedido (voucher pendiente)
  if (params.pendingVoucherOrder) {
    const productNames = params.pendingVoucherOrder.items.map((i: any) => `${i.productTitle} x${i.quantity}`).join(', ');
    const subtotal = params.pendingVoucherOrder.subtotalAmount || params.pendingVoucherOrder.items.reduce((sum: number, i: any) => sum + (i.unitPrice * i.quantity), 0);
    const shipping = params.pendingVoucherOrder.shippingCost || 0;
    
    context += `\n\n## ⚠️ PEDIDO PENDIENTE DE PAGO (ID: ${params.pendingVoucherOrder.id.slice(-8)}):
- Productos: ${productNames}
- Subtotal: ${params.pendingVoucherOrder.currencySymbol}${subtotal.toFixed(2)}`;
    if (shipping > 0) {
      context += `\n- Envío: ${params.pendingVoucherOrder.currencySymbol}${shipping.toFixed(2)}`;
    }
    context += `\n- TOTAL A PAGAR: ${params.pendingVoucherOrder.currencySymbol}${params.pendingVoucherOrder.totalAmount.toFixed(2)}`;
    if (params.pendingVoucherOrder.shippingAddress) {
      context += `\n- Dirección de envío: ${params.pendingVoucherOrder.shippingAddress}`;
    }
    
    if (params.pendingVoucherOrder.voucherImageUrl) {
      context += `\n\n## ✅ COMPROBANTE RECIBIDO:
- El cliente ya envió su comprobante de pago.
- Agradécele y confirma que el equipo está validando el pago.
- NO le pidas más comprobantes ni datos adicionales.`;
    } else {
      context += `\n\n## 📱 ESPERANDO COMPROBANTE DE PAGO:
- Pide amablemente al cliente que envíe una FOTO del comprobante de pago (voucher/transferencia).
- Recuérdale el monto total a depositar: ${params.pendingVoucherOrder.currencySymbol}${params.pendingVoucherOrder.totalAmount.toFixed(2)}
- Cuando el cliente envíe una IMAGEN, el sistema la procesará automáticamente como comprobante.
- NO crees otro pedido mientras este está pendiente.`;
    }
  }
  
  // Datos extraídos del cliente
  if (params.extractedData && Object.keys(params.extractedData).length > 0) {
    context += `\n\n## DATOS YA RECOLECTADOS DEL CLIENTE (NO volver a pedir):`;
    Object.entries(params.extractedData).forEach(([key, value]) => {
      if (value && String(value).trim() !== '') {
        context += `\n- ${key}: ${value}`;
      }
    });
    context += `\n\nIMPORTANTE: YA tienes estos datos. NO los vuelvas a pedir. Usa esta información para avanzar en la conversación.`;
  }
  
  // Tag/Etapa CRM
  if (params.contactAssignment?.tag) {
    const tag = params.contactAssignment.tag;
    context += `\n\n## Estado actual del cliente:
- Etapa CRM: ${tag.name}`;
    if (tag.description) {
      context += `\n- Contexto de etapa: ${tag.description}`;
    }
    
    if (tag.stagePrompt) {
      if (tag.stagePrompt.systemContext) {
        context += `\n\n## Instrucciones especiales para esta etapa:\n${tag.stagePrompt.systemContext}`;
      }
      if (tag.stagePrompt.promptOverride) {
        context = tag.stagePrompt.promptOverride + `\n\n${context}`;
      }
    }
  }
  
  return context;
}

// CAPA 3: Core Context (Secciones Core limitadas a 7 por prioridad)
async function buildCoreContext(params: ContextBuilderParams): Promise<{ context: string; count: number }> {
  const { business, instanceId } = params;
  const businessId = business.id;
  
  // Load only Core sections, limited to 7 by priority
  const coreSections = await prisma.promptSection.findMany({
    where: {
      businessId,
      enabled: true,
      isCore: true,
      OR: instanceId 
        ? [{ instanceId }, { instanceId: null }]
        : [{ instanceId: null }]
    },
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'asc' }
    ],
    take: 7
  });
  
  let context = '';
  if (coreSections.length > 0) {
    const totalCore = await prisma.promptSection.count({
      where: {
        businessId,
        enabled: true,
        isCore: true,
        OR: instanceId 
          ? [{ instanceId }, { instanceId: null }]
          : [{ instanceId: null }]
      }
    });
    
    if (totalCore > 7) {
      console.log(`[LAYERED-CONTEXT] Limited Core sections: ${coreSections.length} of ${totalCore} (showing top 7 by priority)`);
    } else {
      console.log(`[LAYERED-CONTEXT] Loaded ${coreSections.length} Core sections`);
    }
    
    coreSections.forEach(section => {
      context += `\n\n## ${section.title}:\n${section.content}`;
    });
  }
  
  return { context, count: coreSections.length };
}

// CAPA 4: Dynamic Context (RAG dinámico + Intent analysis)
async function buildDynamicContext(params: ContextBuilderParams): Promise<{ context: string; ragCount: number }> {
  const { business, messages, instanceId, intentAnalysis, conversationContext, extractedData } = params;
  const businessId = business.id;
  
  let context = '';
  let ragCount = 0;
  
  // RAG dinámico: buscar secciones relevantes según el mensaje
  const combinedMessage = messages.join(' ');
  try {
    const ragResult = await retrieveRelevantSections(businessId, combinedMessage, 5, instanceId);
    
    if (ragResult.ragSections.length > 0) {
      const ragContent = formatSectionsForPrompt(ragResult);
      context += `\n\n${ragContent}`;
      ragCount = ragResult.ragSections.length;
      console.log(`[LAYERED-CONTEXT] RAG: ${ragResult.coreSections.length} core + ${ragResult.ragSections.length} dynamic sections`);
    }
  } catch (ragError: any) {
    console.error('[LAYERED-CONTEXT] RAG retrieval failed, continuing without:', ragError.message);
  }
  
  // Intent-based dynamic prompt
  if (intentAnalysis && conversationContext) {
    const paymentLinkEnabled = params.business.user?.paymentLinkEnabled ?? false;
    const dynamicPrompt = buildDynamicPrompt(
      '', // Base prompt ya está en otras capas
      intentAnalysis,
      conversationContext,
      business.businessObjective as 'SALES' | 'APPOINTMENTS',
      {
        paymentLinkEnabled,
        extractedData: extractedData || {}
      }
    );
    
    // Solo agregar la parte dinámica (sin el base prompt)
    const dynamicParts = dynamicPrompt.split('\n\n').filter(part => 
      part.includes('REGLAS DE COMUNICACIÓN') ||
      part.includes('DATOS YA EXTRAÍDOS') ||
      part.includes('CONTEXTO ACTUAL') ||
      part.includes('INSTRUCCIÓN PARA') ||
      part.includes('CLIENTE LISTO') ||
      part.includes('HERRAMIENTAS SUGERIDAS')
    );
    
    if (dynamicParts.length > 0) {
      context += `\n\n${dynamicParts.join('\n\n')}`;
    }
  }
  
  return { context, ragCount };
}

// CAPA 5: Resources Context (Catálogo, zonas, archivos, herramientas)
function buildResourcesContext(params: ContextBuilderParams): string {
  const { business, products = [], deliveryZones = [], agentFiles = [] } = params;
  const businessObjective = business.businessObjective as 'SALES' | 'APPOINTMENTS';
  const isAppointmentMode = businessObjective === 'APPOINTMENTS';
  const currencySymbol = business.currencySymbol || 'S/.';
  const productCount = products.length;
  
  let context = '';
  
  // Catálogo de productos (solo para SALES mode)
  if (!isAppointmentMode) {
    if (productCount > 0 && productCount <= 20) {
      context += `\n\n## Catálogo de productos:`;
      products.forEach((product: any) => {
        context += `\n- [ID:${product.id}] ${product.title}: ${currencySymbol}${product.price}`;
        if (product.stock !== undefined) {
          context += ` (Stock: ${product.stock})`;
        }
        if (product.description) {
          context += ` - ${product.description}`;
        }
        const productImageUrl = product.imageUrl || (product.imageUrls && product.imageUrls.length > 0 ? product.imageUrls[0] : null);
        if (productImageUrl) {
          context += ` [IMG:${productImageUrl}]`;
        }
      });
      context += `\n\n## ⚠️ REGLA ABSOLUTAMENTE CRÍTICA - NO INVENTAR PRODUCTOS:
- PROHIBIDO inventar, imaginar o suponer productos que NO están en el catálogo de arriba.
- Solo puedes ofrecer los ${productCount} productos listados arriba. NADA MÁS.
- OBLIGATORIO: Verifica que el producto que menciona el cliente EXISTE en la lista de arriba antes de dar cualquier información.
- Si el cliente pregunta por un producto que NO está en la lista de arriba, responde: "Lo siento, ese producto no está disponible en nuestro catálogo. ¿Te puedo ayudar con alguno de nuestros productos disponibles?"
- NUNCA menciones marcas, modelos, precios o características de productos que NO estén explícitamente listados arriba.
- Si no estás 100% seguro de que el producto existe en la lista, di que no lo tienes disponible.
- Para generar pedidos, usa el ID del producto (el valor después de "ID:").`;
      
      context += `\n\n## 🖼️ REGLA CRÍTICA - ENVÍO DE IMÁGENES DE PRODUCTOS:
- OBLIGATORIO: Cada vez que menciones un producto que tiene imagen (marcado con [IMG:URL] en el catálogo), DEBES incluir esa URL en tu respuesta.
- SIEMPRE incluye la URL de la imagen al final de tu mensaje cuando respondas sobre un producto que tiene imagen disponible.
- Formato: Escribe tu respuesta normal y al final, en una línea separada, incluye SOLO la URL (sin Markdown, sin texto adicional, sin corchetes).
- Ejemplo correcto: "Este producto cuesta S/.50 y está disponible.\\nhttps://ejemplo.com/imagen.jpg"`;
    } else if (productCount > 20) {
      context += `\n\n## Catálogo de productos:
Tienes acceso a un catálogo de ${productCount} productos con BÚSQUEDA INTELIGENTE.
Los precios están en ${business.currencyCode || 'PEN'} (${currencySymbol}).

## ⚠️ REGLA ABSOLUTAMENTE CRÍTICA - NO INVENTAR PRODUCTOS:
- PROHIBIDO inventar, imaginar o suponer productos que NO existen en el catálogo.
- SIEMPRE usa buscar_producto antes de mencionar cualquier producto al cliente.
- Si buscar_producto NO encuentra el producto, responde: "Lo siento, ese producto no está disponible en nuestro catálogo. ¿Te puedo ayudar con otro producto?"
- NUNCA menciones marcas, modelos, precios o características de productos sin haberlos buscado primero.

## 🖼️ REGLA CRÍTICA - ENVÍO DE IMÁGENES DE PRODUCTOS:
- OBLIGATORIO: Cada vez que menciones un producto que tiene imagen, DEBES incluir la URL de la imagen en tu respuesta.
- Cuando buscar_producto devuelve "imagen_producto" o "instruccion" con una URL, esa URL DEBE aparecer al final de tu mensaje.
- Formato: Escribe tu respuesta normal y al final, en una línea separada, incluye SOLO la URL (sin Markdown, sin texto adicional, sin corchetes).`;
    } else if (productCount === 0) {
      context += `\n\n## ⚠️ CATÁLOGO VACÍO - REGLA CRÍTICA:
- Este negocio NO tiene productos registrados en el catálogo.
- PROHIBIDO inventar, mencionar o sugerir productos de cualquier tipo.
- Si el cliente pregunta por productos o precios, responde: "Actualmente no tenemos productos disponibles en nuestro catálogo. ¿Hay algo más en lo que pueda ayudarte?"
- NO menciones marcas, modelos ni precios porque NO hay catálogo disponible.`;
    }
    
    // Zonas de entrega
    if (deliveryZones.length > 0) {
      context += `\n\n## Zonas de entrega disponibles:`;
      deliveryZones.forEach((zone: any) => {
        context += `\n- [ZONA:${zone.id}] ${zone.name}`;
        if (zone.districts && zone.districts.length > 0) {
          context += `: ${zone.districts.join(', ')}`;
        }
        if (zone.cost !== null && zone.cost !== undefined) {
          context += ` - Costo envío: ${currencySymbol}${zone.cost}`;
        }
        if (zone.freeAbove) {
          context += ` (Gratis si compra es mayor a ${currencySymbol}${zone.freeAbove})`;
        }
        if (zone.deliveryTime) {
          context += ` - Tiempo: ${zone.deliveryTime}`;
        }
      });
      context += `\n\n## Reglas para zonas de entrega:
- SIEMPRE pregunta al cliente a qué zona/distrito pertenece su dirección de entrega.
- Verifica que el distrito/zona del cliente esté en la lista de arriba.
- Si la compra supera el monto de "freeAbove", el envío es GRATIS.`;
    }
    
    // Flujo de venta con orden temprana
    const canUsePaymentLink = business.user?.paymentLinkEnabled ?? false;
    if (!canUsePaymentLink) {
      context += `\n\n## ⚠️ FLUJO DE VENTA CON VOUCHER - ORDEN TEMPRANA:
1. **PASO 1 - PRODUCTO**: Identifica qué producto(s) quiere el cliente y la cantidad.
2. **PASO 2 - ZONA DE ENTREGA**: Pregunta el distrito/zona de entrega para calcular el costo de envío.
3. **PASO 3 - CREAR ORDEN Y CONFIRMAR**: 
   - Muestra resumen: productos, cantidades, subtotal, envío y TOTAL FINAL.
   - Pregunta el método de pago (transferencia, Yape, Plin, etc.)
   - USA registrar_pedido INMEDIATAMENTE después de que el cliente confirme el método de pago.
   - La orden se crea ACTIVA en este paso (no esperar más datos).
4. **PASO 4 - DATOS DE ENVÍO**: Con la orden activa, pide nombre y dirección exacta de entrega (estos datos se pueden agregar después).
5. **PASO 5 - SOLICITAR VOUCHER**: Pide al cliente que envíe foto del comprobante de pago.
6. **PASO 6 - PAGOS PARCIALES**: 
   - Si el cliente envía un pago parcial, se suma al monto pagado de la orden.
   - La orden muestra: Pagado vs Pendiente.
   - El cliente puede enviar múltiples vouchers hasta completar el total.
7. **PASO 7 - CONFIRMAR**: Cuando el monto pagado = total, el pedido se marca como PAGADO automáticamente.

## Reglas del flujo (ORDEN TEMPRANA):
- CREA la orden después de: producto + zona + confirmación de método de pago.
- NO esperes tener dirección completa para crear la orden - se puede agregar después.
- La orden permanece ACTIVA en toda la conversación para agregar productos o pagos.
- Cada voucher enviado SUMA al monto pagado (no reemplaza).
- SIEMPRE informa al cliente cuánto ha pagado y cuánto falta.`;
    }
    
    // Reglas de pedidos
    context += `\n\n## REGLA CRÍTICA - REGISTRO DE PEDIDOS:
- OBLIGATORIO: Antes de confirmar CUALQUIER pedido, DEBES usar la herramienta registrar_pedido o crear_enlace_pago.
- NUNCA digas "tu pedido está registrado/agendado/confirmado" sin haber ejecutado la herramienta primero.
- Solo confirma el pedido DESPUÉS de recibir "exito: true" de la herramienta.
- Si la herramienta falla, informa al cliente del error y NO confirmes el pedido.`;
    
    // Orden activa (si existe)
    if (params.existingOrder) {
      context += `\n\n## 🚨 REGLA CRÍTICA - TRABAJAR CON ORDEN ACTIVA:
- Si hay una orden activa (mostrada arriba), DEBES trabajar con esa orden.
- Si el cliente quiere agregar más productos, usa agregar_producto_orden (NO uses registrar_pedido de nuevo).
- Si faltan datos (dirección, nombre, etc.), puedes pedirlos y actualizar la orden.
- La orden permanece activa hasta que esté completa con todos los datos y el pago confirmado.
- NO crees una nueva orden si ya hay una activa.`;
    }
  } else if (isAppointmentMode) {
    context += `\n\n## Modo Citas Activo:
Eres un asistente especializado en agendar citas y consultas.
- Usa consultar_disponibilidad para verificar horarios antes de proponer fechas.
- Usa agendar_cita cuando el cliente confirme fecha y hora.
- Siempre confirma los datos del cliente antes de agendar.
- Si no hay horarios disponibles, ofrece fechas alternativas o pregunta qué día prefiere.`;
  }
  
  // Archivos disponibles
  if (agentFiles.length > 0) {
    context += `\n\n## Archivos disponibles para enviar:
Tienes acceso a ${agentFiles.length} archivos que puedes enviar al cliente cuando sea relevante.
Usa la función enviar_archivo cuando el cliente pregunte por alguno de estos temas o cuando sea apropiado según el contexto:`;
    agentFiles.forEach((file) => {
      context += `\n- [ID:${file.id}] ${file.name}`;
      if (file.description) context += `: ${file.description}`;
      if (file.triggerKeywords) context += ` (keywords: ${file.triggerKeywords})`;
      if (file.triggerContext) context += ` | Enviar cuando: ${file.triggerContext}`;
    });
    context += `\n\nIMPORTANTE: Cuando detectes que el cliente pregunta por algo relacionado a estos archivos (por keywords o contexto), usa enviar_archivo con el ID correspondiente.`;
  }
  
  return context;
}

// Función principal que combina todas las capas y construye herramientas
async function buildLayeredContext(params: ContextBuilderParams, tools: any[]): Promise<LayeredContext> {
  const { business, agentFiles = [], products = [] } = params;
  const businessId = business.id;
  const productCount = products.length;
  const isSalesMode = business.businessObjective !== 'APPOINTMENTS';
  const canUsePaymentLink = business.user?.paymentLinkEnabled ?? false;
  
  const layersUsed: string[] = [];
  
  // CAPA 1: Base
  const baseContext = buildBaseContext(business, params.promptConfig);
  layersUsed.push('base');
  
  // CAPA 2: Crítico
  const criticalContext = buildCriticalContext(params);
  if (criticalContext) {
    layersUsed.push('critical');
  }
  
  // CAPA 3: Core (limitado)
  const coreResult = await buildCoreContext(params);
  layersUsed.push('core');
  
  // CAPA 4: Dinámico (RAG + Intent)
  const dynamicResult = await buildDynamicContext(params);
  if (dynamicResult.ragCount > 0) {
    layersUsed.push('rag');
  }
  if (params.intentAnalysis) {
    layersUsed.push('intent');
  }
  
  // CAPA 5: Recursos
  const resourcesContext = buildResourcesContext(params);
  layersUsed.push('resources');
  
  // Combinar todas las capas
  let systemPrompt = baseContext;
  if (criticalContext) {
    systemPrompt += criticalContext;
  }
  if (coreResult.context) {
    systemPrompt += coreResult.context;
  }
  if (dynamicResult.context) {
    systemPrompt += dynamicResult.context;
  }
  if (resourcesContext) {
    systemPrompt += resourcesContext;
  }
  
  // Aplicar reemplazo de variables
  systemPrompt = replacePromptVariables(systemPrompt, business.timezone || 'America/Lima');
  
  // Construir herramientas
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
  
  // Sales tools
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
  
  // Order tools - with early order creation (address optional)
  if (isSalesMode) {
    const orderToolName = canUsePaymentLink ? 'crear_enlace_pago' : 'registrar_pedido';
    const orderToolDescription = canUsePaymentLink 
      ? 'Genera un enlace de pago para que el cliente complete su compra. Usa esta función cuando el cliente confirme que quiere comprar un producto y tengas todos sus datos de envío.'
      : 'Registra un pedido temprano para el cliente que pagará por transferencia/voucher. IMPORTANTE: Usa esta función INMEDIATAMENTE después de que el cliente confirme producto, zona de entrega y método de pago. La dirección de envío se puede agregar después - NO es obligatoria para crear el pedido. El pedido quedará activo para recibir pagos parciales.';
    
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
              description: 'ID o nombre del producto que el cliente quiere comprar. Si no hay catálogo, usa el nombre exacto del producto mencionado por el cliente.'
            },
            cantidad: {
              type: 'integer',
              description: 'Cantidad de unidades a comprar (por defecto 1)'
            },
            nombre_cliente: {
              type: 'string',
              description: 'Nombre completo del cliente (opcional, se puede agregar después)'
            },
            direccion_envio: {
              type: 'string',
              description: 'Dirección completa de envío (opcional, se puede agregar después de crear el pedido)'
            },
            ciudad: {
              type: 'string',
              description: 'Ciudad de envío (opcional)'
            },
            pais: {
              type: 'string',
              description: 'País de envío (opcional)'
            },
            zona_entrega: {
              type: 'string',
              description: 'Nombre o ID de la zona de entrega del cliente (ej: "Lima Centro", "Miraflores"). Debe coincidir con una de las zonas de entrega configuradas.'
            },
            costo_envio: {
              type: 'number',
              description: 'Costo de envío calculado según la zona de entrega. Puede ser 0 si el pedido supera el monto de envío gratis.'
            },
            coordenadas_ubicacion: {
              type: 'string',
              description: 'Coordenadas GPS de la ubicación del cliente en formato "latitud,longitud" (ejemplo: -12.046374,-77.042793). Se obtiene cuando el cliente comparte su ubicación actual por WhatsApp.'
            }
          },
          required: ['producto_id', 'zona_entrega']
        }
      }
    });
    
    if (!canUsePaymentLink) {
      openaiTools.push({
        type: 'function' as const,
        function: {
          name: 'agregar_producto_orden',
          description: 'Agrega un producto adicional a una orden activa existente. Usa esta función cuando el cliente quiera agregar más productos a su pedido que ya está en proceso. Solo funciona si hay una orden activa (AWAITING_VOUCHER o PENDING_PAYMENT) para este cliente.',
          parameters: {
            type: 'object',
            properties: {
              producto_id: {
                type: 'string',
                description: 'ID o nombre del producto que el cliente quiere agregar a la orden activa'
              },
              cantidad: {
                type: 'integer',
                description: 'Cantidad de unidades a agregar (por defecto 1)'
              }
            },
            required: ['producto_id']
          }
        }
      });
    }
  }
  
  // Appointment tools
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
  
  // File sending tool
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
  
  // RAG search tool (buscar_seccion_rag)
  const ragSectionsCount = await prisma.promptSection.count({
    where: {
      businessId,
      enabled: true,
      isCore: false,
      OR: params.instanceId 
        ? [{ instanceId: params.instanceId }, { instanceId: null }]
        : [{ instanceId: null }]
    }
  });
  
  if (ragSectionsCount > 0) {
    openaiTools.push({
      type: 'function' as const,
      function: {
        name: 'buscar_seccion_rag',
        description: 'Busca información específica en las secciones de conocimiento del negocio usando búsqueda semántica. Usa esta función cuando necesites información detallada sobre políticas, procedimientos, productos especiales, o cualquier tema que no esté en el contexto base.',
        parameters: {
          type: 'object',
          properties: {
            consulta: {
              type: 'string',
              description: 'Consulta o pregunta sobre el tema que necesitas buscar (ej: "política de devoluciones", "garantía de productos", "horarios de atención")'
            },
            limit: {
              type: 'integer',
              description: 'Número máximo de secciones a recuperar (por defecto 3, máximo 5)'
            }
          },
          required: ['consulta']
        }
      }
    });
  }
  
  // Estimar tokens (aproximado: 1 token ≈ 4 caracteres)
  const tokensEstimate = Math.ceil(systemPrompt.length / 4);
  
  console.log(`[LAYERED-CONTEXT] Built context with layers: ${layersUsed.join(', ')}, Core: ${coreResult.count}, RAG: ${dynamicResult.ragCount}, Tools: ${openaiTools.length}, ~${tokensEstimate} tokens`);
  
  return {
    systemPrompt,
    tools: openaiTools,
    metadata: {
      tokensEstimate,
      layersUsed,
      coreSectionsCount: coreResult.count,
      ragSectionsCount: dynamicResult.ragCount
    }
  };
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
    
    // Find the correct prompt config: instance-specific first, then shared (null instanceId), then first available
    let promptConfig = instanceId 
      ? business.agentPrompts?.find((p: any) => p.instanceId === instanceId)
      : null;
    
    if (!promptConfig) {
      promptConfig = business.agentPrompts?.find((p: any) => !p.instanceId) || business.agentPrompts?.[0];
    }
    
    const bufferSeconds = promptConfig?.bufferSeconds ?? 7;
    console.log(`[Agent Think] Buffer config: ${bufferSeconds}s (instanceId: ${instanceId || 'none'}, promptId: ${promptConfig?.id || 'none'})`);
    
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
          // Use atomic delete to claim the buffer - prevents race condition with legacyBufferProcessor
          // Only process if WE successfully deleted the buffer (no one else claimed it)
          const deletedBuffers = await prisma.messageBuffer.deleteMany({
            where: { 
              businessId: business_id, 
              contactPhone,
              // Only delete if not being processed by legacy worker
              OR: [
                { processingUntil: null },
                { processingUntil: { lt: new Date() } }
              ]
            }
          });
          
          if (deletedBuffers.count === 0) {
            console.log(`[Agent Buffer] Buffer for ${contactPhone} already processed by another worker, skipping`);
            activeBuffers.delete(bufferKey);
            return;
          }
          
          // We successfully claimed the buffer, now get the data from our captured state
          const messages = currentMessages;
          const messageIds = capturedProviderMessageIds;
          
          console.log(`[Agent Buffer] Claimed buffer with ${messages.length} messages to process for ${contactPhone}`);
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
        } catch (error) {
          console.error('Buffer processing error:', error);
          activeBuffers.delete(bufferKey);
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
    const { instanceId } = req.query;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // If instanceId provided, show instance-specific + shared zones; otherwise return all for business
    const whereClause: any = { businessId };
    if (instanceId && String(instanceId).trim() !== '') {
      // Show zones for this instance + shared zones (null instanceId)
      whereClause.OR = [
        { instanceId: String(instanceId) },
        { instanceId: null }
      ];
      delete whereClause.businessId;
      whereClause.AND = [{ businessId }];
    }
    
    const zones = await prisma.deliveryZone.findMany({
      where: whereClause,
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
    const { name, districts, address, cost, freeAbove, deliveryTime, policy, instanceId } = req.body;
    
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
        instanceId: instanceId || null,
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
    
    // Build where clause - if instanceId provided, include BOTH:
    // 1. Items with that specific instanceId  
    // 2. Items with null instanceId (business-level/global stages)
    let whereClause: any = { businessId };
    if (instance_id && String(instance_id).trim() !== '') {
      whereClause = {
        businessId,
        OR: [
          { instanceId: instance_id as string },
          { instanceId: null }
        ]
      };
    }
    
    console.log(`[FUNNEL-STAGES-GET] businessId=${businessId}, instance_id=${instance_id || 'none'}, whereClause=`, JSON.stringify(whereClause));
    
    const stages = await prisma.funnelStage.findMany({
      where: whereClause,
      orderBy: { order: 'asc' }
    });
    
    console.log(`[FUNNEL-STAGES-GET] Found ${stages.length} stages:`, stages.map(s => ({ id: s.id, name: s.name, instanceId: s.instanceId, order: s.order })));
    
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
    
    // First check if the stage exists and belongs to this business
    const existingStage = await prisma.funnelStage.findFirst({
      where: { id: stageId, businessId }
    });
    
    if (!existingStage) {
      return res.status(404).json({ error: 'Etapa no encontrada. Es posible que haya sido eliminada. Por favor, recarga la página.' });
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
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Etapa no encontrada. Por favor, recarga la página.' });
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
    
    console.log(`[FUNNEL-STAGES-REORDER] businessId=${businessId}, stageIds=`, stageIds);
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      console.log(`[FUNNEL-STAGES-REORDER] Business not found for userId=${req.userId}`);
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!Array.isArray(stageIds)) {
      console.log(`[FUNNEL-STAGES-REORDER] stageIds is not an array:`, typeof stageIds);
      return res.status(400).json({ error: 'stageIds must be an array' });
    }
    
    // First verify all stages exist and belong to this business
    const existingStages = await prisma.funnelStage.findMany({
      where: { 
        id: { in: stageIds },
        businessId 
      },
      select: { id: true }
    });
    
    const existingIds = new Set(existingStages.map(s => s.id));
    const missingIds = stageIds.filter(id => !existingIds.has(id));
    
    if (missingIds.length > 0) {
      console.log(`[FUNNEL-STAGES-REORDER] Missing stages: ${missingIds.join(', ')}`);
      return res.status(404).json({ 
        error: 'Etapa no encontrada. Es posible que haya sido eliminada. Por favor, recarga la página.',
        missingIds 
      });
    }
    
    console.log(`[FUNNEL-STAGES-REORDER] Updating ${stageIds.length} stages with new order...`);
    
    await Promise.all(
      stageIds.map((id, index) => {
        console.log(`[FUNNEL-STAGES-REORDER] Setting stage ${id} to order ${index}`);
        return prisma.funnelStage.update({
          where: { id },
          data: { order: index }
        });
      })
    );
    
    console.log(`[FUNNEL-STAGES-REORDER] Success!`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[FUNNEL-STAGES-REORDER] Error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Etapa no encontrada. Es posible que haya sido eliminada. Por favor, recarga la página.' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/funnel-stages/:businessId/contact/:contactPhone', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, contactPhone } = req.params;
    const { stageId, instanceId } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!stageId) {
      await prisma.contactFunnelState.deleteMany({
        where: { businessId, contactPhone: contactPhone.replace(/\D/g, '') }
      });
      return res.json({ success: true, message: 'Contact removed from funnel' });
    }
    
    const result = await setContactStage(businessId, contactPhone, stageId, instanceId);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ success: true, stageName: result.stageName });
  } catch (error: any) {
    console.error('Set contact stage error:', error);
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

// Get available tools for funnel stage configuration
router.get('/available-tools/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // Ensure native tools are registered
    registerAllNativeTools();
    
    // Get native tool names
    const nativeTools = toolRegistry.getAllToolNames();
    
    // Get custom tools for this business (from prompts)
    const businessPrompts = await prisma.agentPrompt.findMany({
      where: { businessId },
      select: { id: true }
    });
    
    const customToolsDb = await prisma.agentTool.findMany({
      where: { promptId: { in: businessPrompts.map(p => p.id) } },
      select: { name: true, description: true }
    });
    
    const tools = [
      ...nativeTools.map(name => ({ name, type: 'native' as const })),
      ...customToolsDb.map((t: { name: string; description: string }) => ({ name: t.name, type: 'custom' as const, description: t.description }))
    ];
    
    res.json(tools);
  } catch (error: any) {
    console.error('Get available tools error:', error);
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
    
    const result = await geminiService.analyzeBusinessPrompt(rawPrompt, business_id);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to analyze prompt' });
    }
    
    // Get existing data to detect conflicts
    const [existingProducts, existingFields, existingStages, existingZones] = await Promise.all([
      prisma.product.findMany({ where: { businessId: business_id }, select: { title: true } }),
      prisma.extractionField.findMany({ where: { businessId: business_id }, select: { fieldKey: true } }),
      prisma.funnelStage.findMany({ where: { businessId: business_id }, select: { name: true } }),
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
      // NOTE: Products are NOT imported here - they're managed separately via CSV import in Products UI
      extractionFields: { created: 0, skipped: 0, errors: [] },
      funnelStages: { created: 0, skipped: 0, errors: [] },
      deliveryZones: { created: 0, skipped: 0, errors: [] },
      businessInfo: { created: 0, skipped: 0, errors: [] },
      agentPrompt: { created: 0, skipped: 0, errors: [] }
    };
    
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
    const { business_id, rawPrompt, instanceId: rawInstanceId, options = {} } = req.body;
    
    if (!business_id || !rawPrompt) {
      return res.status(400).json({ error: 'business_id and rawPrompt are required' });
    }
    
    if (rawPrompt.length > 60000) {
      return res.status(400).json({ error: 'Prompt too long (max 60,000 characters)' });
    }
    
    // Normalize instanceId - treat empty string, 'undefined', 'null' as not provided
    const instanceId = rawInstanceId && 
      typeof rawInstanceId === 'string' && 
      rawInstanceId.trim() !== '' && 
      rawInstanceId !== 'undefined' && 
      rawInstanceId !== 'null' 
        ? rawInstanceId 
        : null;
    
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
    
    console.log(`[IMPORT-FULL] Starting full import for business ${business_id}, instanceId: ${instanceId || 'NULL'}, length: ${rawPrompt.length}`);
    
    // Run both analyses in parallel
    const [masterResult, configResult] = await Promise.all([
      geminiService.generateMasterPromptAndSections(rawPrompt, business_id),
      geminiService.analyzeBusinessPrompt(rawPrompt, business_id)
    ]);
    
    if (!masterResult.success) {
      return res.status(500).json({ error: masterResult.error || 'Failed to generate master prompt and sections' });
    }
    
    const results = {
      masterPrompt: { updated: false, error: null as string | null },
      sections: { created: 0, skipped: 0, cleared: 0, errors: [] as string[] },
      // NOTE: Products are NOT imported via prompt importer - they're managed separately via CSV import
      config: { fields: 0, stages: 0, zones: 0 }
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
        // Generate embedding for non-core sections (core sections are always included)
        let embedding: number[] | null = null;
        if (!section.isCore) {
          embedding = await generateSectionEmbedding(`${section.title}\n${section.content}`);
        }
        
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
            embedding: embedding as any,
            metadata: { keywords: section.keywords, sourceType: 'auto-import' }
          }
        });
        results.sections.created++;
        console.log(`[IMPORT-FULL] Created section "${section.title}" with embedding: ${!!embedding}`);
      } catch (err: any) {
        results.sections.errors.push(`${section.title}: ${err.message}`);
      }
    }
    
    console.log(`[IMPORT-FULL] Sections: created=${results.sections.created}, skipped=${results.sections.skipped}, instanceId=${instanceId || 'NULL'}`);
    
    // 4. Import structured config (fields, stages, etc) from analyzeBusinessPrompt
    // NOTE: Products are NOT imported here - they're managed separately via CSV import in Products UI
    if (configResult.success && configResult.config) {
      const cfg = configResult.config;
      
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

import { generateEmbedding, getRAGStats } from '../services/ragService.js';

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

// List configuration backups
router.get('/config/backups/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const instanceId = req.query.instance_id as string | undefined;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const where: any = { businessId };
    if (instanceId) {
      where.instanceId = instanceId;
    }

    const backups = await prisma.configurationBackup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        instanceId: true,
        description: true,
        backupType: true,
        version: true,
        createdAt: true
      }
    });

    res.json({ backups });
  } catch (error: any) {
    console.error('List backups error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single backup
router.get('/config/backup/:backupId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { backupId } = req.params;
    
    const backup = await prisma.configurationBackup.findFirst({
      where: { id: backupId },
      include: { business: { select: { userId: true, name: true } } }
    });
    
    if (!backup || backup.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    res.json({ backup: { ...backup, business: { name: backup.business.name } } });
  } catch (error: any) {
    console.error('Get backup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete backup
router.delete('/config/backup/:backupId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { backupId } = req.params;
    
    const backup = await prisma.configurationBackup.findFirst({
      where: { id: backupId },
      include: { business: { select: { userId: true } } }
    });
    
    if (!backup || backup.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    await prisma.configurationBackup.delete({ where: { id: backupId } });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete backup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore configuration from backup
router.post('/config/restore/:backupId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { backupId } = req.params;
    const { mode = 'replace' } = req.body; // 'replace' clears existing, 'merge' adds to existing
    
    const backup = await prisma.configurationBackup.findFirst({
      where: { id: backupId },
      include: { business: { select: { userId: true, id: true } } }
    });
    
    if (!backup || backup.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    const config = backup.configJson as any;
    const businessId = backup.business.id;
    const instanceId = backup.instanceId;

    const results = {
      prompt: { restored: false, error: null as string | null },
      tools: { restored: 0, errors: [] as string[] },
      sections: { restored: 0, errors: [] as string[] },
      extractionFields: { restored: 0, errors: [] as string[] },
      funnelStages: { restored: 0, errors: [] as string[] },
      deliveryZones: { restored: 0, errors: [] as string[] }
    };

    // If replace mode, clear existing configuration first (same logic as reset-config but without backup)
    if (mode === 'replace') {
      const instanceFilter = instanceId ? { instanceId } : {};
      const prompts = await prisma.agentPrompt.findMany({
        where: { businessId, ...instanceFilter },
        select: { id: true }
      });
      const promptIds = prompts.map(p => p.id);

      const transactions = instanceId ? [
        prisma.deliveryZone.deleteMany({ where: { businessId, instanceId } }),
        prisma.extractionField.deleteMany({ where: { businessId, instanceId } }),
        prisma.funnelStage.deleteMany({ where: { businessId, instanceId } }),
        prisma.promptSection.deleteMany({ where: { businessId, instanceId } }),
        prisma.agentFile.deleteMany({ where: { promptId: { in: promptIds } } }),
        prisma.agentTool.deleteMany({ where: { promptId: { in: promptIds } } })
      ] : [
        prisma.deliveryZone.deleteMany({ where: { businessId } }),
        prisma.extractionField.deleteMany({ where: { businessId } }),
        prisma.funnelStage.deleteMany({ where: { businessId } }),
        prisma.promptSection.deleteMany({ where: { businessId } }),
        prisma.agentFile.deleteMany({ where: { promptId: { in: promptIds } } }),
        prisma.agentTool.deleteMany({ where: { promptId: { in: promptIds } } })
      ];
      await prisma.$transaction(transactions);
    }

    // Restore prompt
    if (config.prompt) {
      try {
        const existingPrompt = await prisma.agentPrompt.findFirst({
          where: { businessId, ...(instanceId ? { instanceId } : { instanceId: null }) }
        });

        if (existingPrompt) {
          await prisma.agentPrompt.update({
            where: { id: existingPrompt.id },
            data: {
              prompt: config.prompt.prompt,
              bufferSeconds: config.prompt.bufferSeconds,
              historyLimit: config.prompt.historyLimit,
              splitMessages: config.prompt.splitMessages
            }
          });
        } else {
          await prisma.agentPrompt.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              prompt: config.prompt.prompt,
              bufferSeconds: config.prompt.bufferSeconds || 10,
              historyLimit: config.prompt.historyLimit || 15,
              splitMessages: config.prompt.splitMessages ?? true
            }
          });
        }
        results.prompt.restored = true;
      } catch (err: any) {
        results.prompt.error = err.message;
      }
    }

    // Restore sections
    if (config.sections?.length > 0) {
      for (const section of config.sections) {
        try {
          await prisma.promptSection.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              title: section.title,
              content: section.content,
              type: section.type || 'OTHER',
              isCore: section.isCore || false,
              priority: section.priority || 0,
              enabled: section.enabled ?? true
            }
          });
          results.sections.restored++;
        } catch (err: any) {
          results.sections.errors.push(`${section.title}: ${err.message}`);
        }
      }
    }

    // Restore extraction fields
    if (config.extractionFields?.length > 0) {
      for (const field of config.extractionFields) {
        try {
          await prisma.extractionField.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              fieldKey: field.fieldKey,
              fieldLabel: field.fieldLabel,
              fieldType: field.fieldType || 'text',
              description: field.description,
              required: field.required || false,
              order: field.order || 0
            }
          });
          results.extractionFields.restored++;
        } catch (err: any) {
          results.extractionFields.errors.push(`${field.fieldKey}: ${err.message}`);
        }
      }
    }

    // Restore funnel stages
    if (config.funnelStages?.length > 0) {
      for (const stage of config.funnelStages) {
        try {
          await prisma.funnelStage.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              name: stage.name,
              order: stage.order || 0,
              requiredFieldKeys: stage.requiredFieldKeys || [],
              blockedTopics: stage.blockedTopics || [],
              promptContext: stage.promptContext,
              autoTransition: stage.autoTransition || undefined
            }
          });
          results.funnelStages.restored++;
        } catch (err: any) {
          results.funnelStages.errors.push(`${stage.name}: ${err.message}`);
        }
      }
    }

    // Restore delivery zones
    if (config.deliveryZones?.length > 0) {
      for (const zone of config.deliveryZones) {
        try {
          await prisma.deliveryZone.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              name: zone.name,
              districts: zone.districts || [],
              cost: zone.cost || 0,
              deliveryTime: zone.deliveryTime,
              isActive: zone.isActive ?? true
            }
          });
          results.deliveryZones.restored++;
        } catch (err: any) {
          results.deliveryZones.errors.push(`${zone.name}: ${err.message}`);
        }
      }
    }

    // Restore tools (need to get prompt ID first)
    if (config.tools?.length > 0) {
      const prompt = await prisma.agentPrompt.findFirst({
        where: { businessId, ...(instanceId ? { instanceId } : { instanceId: null }) }
      });

      if (prompt) {
        for (const tool of config.tools) {
          try {
            await prisma.agentTool.create({
              data: {
                promptId: prompt.id,
                name: tool.name,
                description: tool.description,
                url: tool.url,
                method: tool.method || 'POST',
                headers: tool.headers,
                bodyTemplate: tool.bodyTemplate,
                parameters: tool.parameters,
                dynamicVariables: tool.dynamicVariables,
                enabled: true
              }
            });
            results.tools.restored++;
          } catch (err: any) {
            results.tools.errors.push(`${tool.name}: ${err.message}`);
          }
        }
      }
    }

    console.log(`[Config] Restored backup ${backupId} for business ${businessId}`);

    res.json({ success: true, results, mode });
  } catch (error: any) {
    console.error('Restore backup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export configuration to JSON
router.get('/config/export/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const instanceId = req.query.instance_id as string | undefined;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Build instance filter - if instanceId provided, include BOTH:
    // 1. Items with that specific instanceId
    // 2. Items with null instanceId (business-level fallback)
    // This ensures export includes instance-specific AND shared/business-level data
    const instanceFilter = instanceId 
      ? { OR: [{ instanceId }, { instanceId: null }] }
      : {};

    // Get prompt - match specific instance if provided
    const promptWhere: any = { businessId };
    if (instanceId) {
      promptWhere.instanceId = instanceId;
    }
    
    const prompt = await prisma.agentPrompt.findFirst({
      where: promptWhere,
      include: {
        tools: { where: { enabled: true } }
      }
    });

    // Get sections - filter by instanceId if provided
    const sections = await prisma.promptSection.findMany({
      where: { businessId, ...instanceFilter },
      select: {
        title: true,
        content: true,
        type: true,
        isCore: true,
        priority: true,
        enabled: true,
        instanceId: true
      }
    });

    // Get extraction fields - filter by instanceId if provided
    const extractionFields = await prisma.extractionField.findMany({
      where: { businessId, ...instanceFilter },
      select: {
        fieldKey: true,
        fieldLabel: true,
        fieldType: true,
        description: true,
        required: true,
        useForAppointment: true,
        order: true,
        enabled: true,
        instanceId: true
      }
    });

    // Get funnel stages - filter by instanceId if provided
    const funnelStages = await prisma.funnelStage.findMany({
      where: { businessId, ...instanceFilter },
      orderBy: { order: 'asc' },
      select: {
        name: true,
        order: true,
        description: true,
        promptContext: true,
        toolsAllowed: true,
        requiredFieldKeys: true,
        blockedTopics: true,
        autoTransition: true,
        instanceId: true
      }
    });

    // Get delivery zones - filter by instanceId if provided
    const deliveryZones = await prisma.deliveryZone.findMany({
      where: { businessId, ...instanceFilter },
      select: {
        name: true,
        districts: true,
        cost: true,
        deliveryTime: true,
        isActive: true,
        instanceId: true
      }
    });

    const config = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      businessName: business.name,
      instanceId: instanceId || null,
      prompt: prompt ? {
        prompt: prompt.prompt,
        bufferSeconds: prompt.bufferSeconds,
        historyLimit: prompt.historyLimit,
        splitMessages: prompt.splitMessages
      } : null,
      tools: prompt?.tools.map(t => ({
        name: t.name,
        description: t.description,
        url: t.url,
        method: t.method,
        headers: t.headers,
        bodyTemplate: t.bodyTemplate,
        parameters: t.parameters,
        dynamicVariables: t.dynamicVariables
      })) || [],
      sections,
      extractionFields,
      funnelStages,
      deliveryZones
    };

    res.json({ success: true, config });
  } catch (error: any) {
    console.error('Export config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import configuration from JSON
router.post('/config/import/:businessId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    const { config, mode = 'merge', instanceId } = req.body;
    
    if (!config || !config.version) {
      return res.status(400).json({ error: 'Invalid config format' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const results = {
      prompt: { imported: false, error: null as string | null },
      tools: { imported: 0, skipped: 0, errors: [] as string[] },
      sections: { imported: 0, skipped: 0, errors: [] as string[] },
      extractionFields: { imported: 0, skipped: 0, errors: [] as string[] },
      funnelStages: { imported: 0, skipped: 0, errors: [] as string[] },
      deliveryZones: { imported: 0, skipped: 0, errors: [] as string[] }
    };

    // Import prompt
    if (config.prompt) {
      try {
        const existingPrompt = await prisma.agentPrompt.findFirst({
          where: { businessId, ...(instanceId ? { instanceId } : { instanceId: null }) }
        });

        if (existingPrompt) {
          await prisma.agentPrompt.update({
            where: { id: existingPrompt.id },
            data: {
              prompt: config.prompt.prompt,
              bufferSeconds: config.prompt.bufferSeconds,
              historyLimit: config.prompt.historyLimit,
              splitMessages: config.prompt.splitMessages
            }
          });
        } else {
          await prisma.agentPrompt.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              prompt: config.prompt.prompt,
              bufferSeconds: config.prompt.bufferSeconds || 7,
              historyLimit: config.prompt.historyLimit || 10,
              splitMessages: config.prompt.splitMessages ?? true
            }
          });
        }
        results.prompt.imported = true;
      } catch (err: any) {
        results.prompt.error = err.message;
      }
    }

    // Import sections
    if (config.sections && Array.isArray(config.sections)) {
      for (const section of config.sections) {
        try {
          const existing = await prisma.promptSection.findFirst({
            where: { businessId, title: section.title, ...(instanceId ? { instanceId } : {}) }
          });

          if (existing && mode === 'merge') {
            results.sections.skipped++;
            continue;
          }

          if (existing && mode === 'replace') {
            await prisma.promptSection.delete({ where: { id: existing.id } });
          }

          await prisma.promptSection.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              title: section.title,
              content: section.content,
              type: section.type || 'OTHER',
              isCore: section.isCore || false,
              priority: section.priority || 0,
              enabled: section.enabled ?? true
            }
          });
          results.sections.imported++;
        } catch (err: any) {
          results.sections.errors.push(`${section.title}: ${err.message}`);
        }
      }
    }

    // Import extraction fields
    if (config.extractionFields && Array.isArray(config.extractionFields)) {
      for (const field of config.extractionFields) {
        try {
          const fieldKey = field.fieldKey || field.fieldName;
          const existing = await prisma.extractionField.findFirst({
            where: { 
              businessId, 
              fieldKey,
              ...(instanceId ? { instanceId } : { instanceId: null })
            }
          });

          if (existing && mode === 'merge') {
            results.extractionFields.skipped++;
            continue;
          }

          if (existing && mode === 'replace') {
            await prisma.extractionField.delete({ where: { id: existing.id } });
          }

          await prisma.extractionField.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              fieldKey,
              fieldLabel: field.fieldLabel || fieldKey,
              fieldType: field.fieldType || 'text',
              description: field.description || field.aiInstruction,
              required: field.required || false,
              useForAppointment: field.useForAppointment || false,
              order: field.order || 0,
              enabled: field.enabled ?? true
            }
          });
          results.extractionFields.imported++;
        } catch (err: any) {
          results.extractionFields.errors.push(`${field.fieldKey || field.fieldName}: ${err.message}`);
        }
      }
    }

    // Import funnel stages
    if (config.funnelStages && Array.isArray(config.funnelStages)) {
      for (const stage of config.funnelStages) {
        try {
          const existing = await prisma.funnelStage.findFirst({
            where: { 
              businessId, 
              name: stage.name,
              ...(instanceId ? { instanceId } : { instanceId: null })
            }
          });

          if (existing && mode === 'merge') {
            results.funnelStages.skipped++;
            continue;
          }

          if (existing && mode === 'replace') {
            await prisma.funnelStage.delete({ where: { id: existing.id } });
          }

          await prisma.funnelStage.create({
            data: {
              businessId,
              instanceId: instanceId || null,
              name: stage.name,
              order: stage.order || 0,
              description: stage.description,
              promptContext: stage.promptContext,
              toolsAllowed: stage.toolsAllowed || [],
              requiredFieldKeys: stage.requiredFieldKeys || stage.requiredFields || [],
              blockedTopics: stage.blockedTopics || [],
              autoTransition: stage.autoTransition || (stage.autoAdvance ? { enabled: true } : undefined)
            }
          });
          results.funnelStages.imported++;
        } catch (err: any) {
          results.funnelStages.errors.push(`${stage.name}: ${err.message}`);
        }
      }
    }

    // Import delivery zones
    if (config.deliveryZones && Array.isArray(config.deliveryZones)) {
      for (const zone of config.deliveryZones) {
        try {
          const existing = await prisma.deliveryZone.findFirst({
            where: { businessId, name: zone.name }
          });

          if (existing && mode === 'merge') {
            results.deliveryZones.skipped++;
            continue;
          }

          if (existing && mode === 'replace') {
            await prisma.deliveryZone.delete({ where: { id: existing.id } });
          }

          await prisma.deliveryZone.create({
            data: {
              businessId,
              name: zone.name,
              districts: zone.districts || zone.areas || [],
              cost: zone.cost || zone.deliveryCost || 0,
              deliveryTime: zone.deliveryTime || zone.estimatedTime,
              isActive: zone.isActive ?? true
            }
          });
          results.deliveryZones.imported++;
        } catch (err: any) {
          results.deliveryZones.errors.push(`${zone.name}: ${err.message}`);
        }
      }
    }

    res.json({ success: true, results });
  } catch (error: any) {
    console.error('Import config error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
