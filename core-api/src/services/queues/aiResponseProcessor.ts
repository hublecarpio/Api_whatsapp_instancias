import { Worker, Job } from 'bullmq';
import { AIResponseJobData, QUEUE_NAMES, getQueueConnection, getAIResponseQueue } from './index.js';
import prisma from '../prisma.js';
import { isOpenAIConfigured, callOpenAI, getModelForAgent, ChatMessage, logTokenUsage, checkUserTokenLimit, getOpenAIClient, getClientForModel } from '../openaiService.js';
import { replacePromptVariables } from '../promptVariables.js';
import { generateWithAgentV2, buildBusinessContext, buildConversationHistory, isAgentV2Available } from '../agentV2Service.js';
import { searchProductsIntelligent } from '../productSearch.js';
import { parseAgentOutputToWhatsAppEvents, calculateTypingDelay, WhatsAppEvent } from '../agentOutputParser.js';
import { MetaCloudService } from '../metaCloud.js';
import { scheduleFollowUp } from '../followUpService.js';
import { analyzeAndUpdateLeadStage } from '../leadStageService.js';
import axios from 'axios';
import eventLogger from '../eventLogger.js';
import { processWithOrchestrator, OrchestratorInput } from '../agent/index.js';
import { queueAgentResponse, isQueueAvailable, sendAgentResponseDirect } from '../whatsappSender.js';

const USE_V3_AGENT = process.env.USE_V3_AGENT === 'true';
import { dispatchAgentMessage, dispatchToolCall } from '../webhookService.js';
import { retrieveRelevantSections, formatSectionsForPrompt } from '../ragService.js';
import { processDataExtraction, getExtractedDataForContact, getAppointmentFieldsData } from '../dataExtractionService.js';
import { getContactStageStatus, buildStageContextForPrompt, checkAndAdvanceStage } from '../funnelStageService.js';
import { 
  getOrderToolDefinitions, 
  handleAgregarProducto, 
  handleConsultarPedido, 
  handleConfirmarEntrega,
  findActiveOrder,
  OrderToolContext 
} from '../tools/orderTools.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

// Environment detection for debugging production vs Replit
const IS_REPLIT = process.env.REPL_ID ? true : false;
const ENV_NAME = IS_REPLIT ? 'REPLIT' : 'PRODUCTION';
const HAS_REDIS = !!process.env.REDIS_URL;

function logAI(tag: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const envTag = `[${ENV_NAME}]`;
  const redisTag = HAS_REDIS ? '[REDIS]' : '[NO-REDIS]';
  const fullTag = `[AI-${tag}]`;
  if (data) {
    console.log(`${timestamp} ${envTag} ${redisTag} ${fullTag} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${timestamp} ${envTag} ${redisTag} ${fullTag} ${message}`);
  }
}

interface ToolLogData {
  businessId: string;
  toolId?: string;
  toolName: string;
  contactPhone: string;
  request: any;
  response: any;
  status: 'success' | 'error';
  duration: number;
  error?: string;
}

async function logCustomToolExecution(data: ToolLogData): Promise<void> {
  try {
    // Log to ToolLog table if we have a toolId
    if (data.toolId) {
      await prisma.toolLog.create({
        data: {
          toolId: data.toolId,
          businessId: data.businessId,
          contactPhone: data.contactPhone || null,
          request: data.request || {},
          response: data.response || null,
          status: data.status,
          duration: data.duration || null
        }
      });
    }
    
    // Also log to event logger for analytics
    await eventLogger.toolExecuted(
      data.businessId,
      data.toolName,
      data.status === 'success',
      data.duration || 0
    );
    
    console.log(`[Tool Log] Logged ${data.status} execution of ${data.toolName} (${data.duration}ms)`);
  } catch (err) {
    console.error(`[Tool Log] Failed to log tool execution:`, err);
  }
}
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '40', 10);
const QUEUE_ADD_TIMEOUT = 5000;
const LOCK_DURATION = 120000;

let aiResponseWorker: Worker<AIResponseJobData> | null = null;

export function isAIWorkerRunning(): boolean {
  return aiResponseWorker !== null && aiResponseWorker.isRunning();
}

export async function queueAIResponse(data: AIResponseJobData): Promise<string | null> {
  const queue = getAIResponseQueue();
  if (!queue) {
    console.log('[AI Queue] Queue not initialized, processing synchronously');
    return null;
  }
  
  if (!isAIWorkerRunning()) {
    console.log('[AI Queue] Worker not running, processing synchronously');
    return null;
  }
  
  // Use deterministic jobId based on bufferId OR message content hash to prevent duplicate processing
  // This ensures both agent.ts timeout and expiredBufferProcessor don't create duplicate jobs
  const dedupeKey = data.bufferId 
    ? `buffer-${data.bufferId}` 
    : `msg-${data.businessId}-${data.contactPhone}-${data.messages.join('|').slice(0, 100)}`;
  const jobId = `ai-${dedupeKey}`;
  
  // Check if job already exists to avoid duplicate processing
  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'active') {
        console.log(`[AI Queue] Job ${jobId} already exists in state ${state}, skipping duplicate`);
        return jobId;
      }
    }
  } catch (checkError) {
    // Ignore check errors, proceed with add
  }
  
  const priorityMap = {
    high: 1,
    normal: 5,
    low: 10
  };
  
  try {
    const addPromise = queue.add('process-ai-response', data, {
      jobId,
      priority: priorityMap[data.priority || 'normal'],
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      }
    });
    
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Queue add timeout')), QUEUE_ADD_TIMEOUT);
    });
    
    try {
      await Promise.race([addPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
    
    const running = isAIWorkerRunning();
    if (!running) {
      console.warn(`[AI Queue] Worker stopped after queuing job ${jobId} - job will be processed when worker restarts`);
    }
    
    console.log(`[AI Queue] Job queued: ${jobId} (concurrency: ${WORKER_CONCURRENCY}, workerRunning: ${running})`);
    return jobId;
  } catch (error: any) {
    console.error(`[AI Queue] Failed to queue job, processing synchronously:`, error.message);
    return null;
  }
}

async function processAIResponse(job: Job<AIResponseJobData>): Promise<{ response: string; tokensUsed?: number }> {
  const { businessId, contactPhone, contactName, messages, phone, instanceId, instanceBackendId, bufferId, providerMessageId, providerMessageIds, provider } = job.data;
  
  // Support both single ID (legacy) and multiple IDs (buffered messages)
  const allMessageIds = providerMessageIds?.length ? providerMessageIds : (providerMessageId ? [providerMessageId] : []);
  
  console.log(`[AI Worker] Processing job ${job.id} for business ${businessId}, contact ${contactPhone}, provider=${provider || 'unknown'}, messageIds=${allMessageIds.length}`);
  
  if (bufferId) {
    await prisma.messageBuffer.update({
      where: { id: bufferId },
      data: { processingUntil: new Date(Date.now() + 600000) }
    }).catch(() => {});
  }
  
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      policy: true,
      agentPrompts: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: { include: { metaCredential: true, metaCoexistCredential: true } },
      user: { select: { isPro: true, id: true, subscriptionStatus: true } },
      deliveryZones: { where: { isActive: true }, orderBy: { order: 'asc' } }
    }
  });
  
  if (!business) {
    if (bufferId) {
      await prisma.messageBuffer.delete({ where: { id: bufferId } }).catch(() => {});
    }
    throw new Error(`Business ${businessId} not found`);
  }
  
  // Normalize phone for database lookup (remove non-digits and WhatsApp suffixes)
  const normalizedPhone = contactPhone.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
  
  // Check if bot is globally disabled but contact has test mode enabled
  if (!business.botEnabled) {
    const contact = await prisma.contact.findUnique({
      where: { businessId_phone: { businessId, phone: normalizedPhone } }
    });
    
    if (!contact?.botTestEnabled) {
      console.log(`[AI Worker] Bot globally disabled for business ${businessId}, contact ${normalizedPhone} has no test mode, skipping`);
      if (bufferId) {
        await prisma.messageBuffer.delete({ where: { id: bufferId } }).catch(() => {});
      }
      return { response: '' };
    }
    console.log(`[AI Worker] Bot test mode enabled for contact ${normalizedPhone}, processing despite global disable`);
  }
  
  const tokenCheck = await checkUserTokenLimit(business.userId);
  if (!tokenCheck.canUseAI) {
    console.log(`[AI Worker] User ${business.userId} blocked: ${tokenCheck.message}`);
    if (bufferId) {
      await prisma.messageBuffer.delete({ where: { id: bufferId } }).catch(() => {});
    }
    return { response: '' };
  }
  
  const targetInstanceId = instanceId || business.instances?.[0]?.id;
  
  // Mark ALL messages as read BEFORE processing (shows blue checkmarks after buffer expires)
  if (provider === 'META_CLOUD' && allMessageIds.length > 0 && targetInstanceId) {
    try {
      const targetInstance = business.instances?.find((i: any) => i.id === targetInstanceId);
      if (targetInstance?.metaCredential) {
        const metaClient = new MetaCloudService({
          phoneNumberId: targetInstance.metaCredential.phoneNumberId,
          accessToken: targetInstance.metaCredential.accessToken,
          businessId: targetInstance.metaCredential.businessId
        });
        // Mark all buffered messages as read
        for (const msgId of allMessageIds) {
          try {
            await metaClient.markMessageAsRead(msgId);
          } catch (e) {
            // Continue marking other messages even if one fails
          }
        }
        console.log(`[AI Worker] Meta Cloud: Marked ${allMessageIds.length} message(s) as read for instance ${targetInstanceId}`);
      }
    } catch (markErr: any) {
      console.error(`[AI Worker] Failed to mark Meta messages as read:`, markErr.message);
    }
  } else if (provider === 'BAILEYS' && phone) {
    // Baileys marks entire chat as read via WA API
    try {
      await axios.post(`${WA_API_URL}/instances/${instanceBackendId || targetInstanceId}/markAsRead`, {
        from: contactPhone
      }).catch(() => {});
      console.log(`[AI Worker] Baileys: Marked chat as read for ${contactPhone}`);
    } catch (markErr: any) {
      console.error(`[AI Worker] Failed to mark Baileys chat as read:`, markErr.message);
    }
  }
  
  let result: { response: string; tokensUsed?: number };
  
  const useV3 = USE_V3_AGENT || business.agentVersion === 'v3';
  const phoneMask = contactPhone.length > 4 ? `***${contactPhone.slice(-4)}` : '****';
  const DEBUG_AGENT = process.env.DEBUG_AGENT_V3 === 'true';
  
  console.log(`[AI Worker] ═══════════════════════════════════════════════════════`);
  console.log(`[AI Worker] AGENT DECISION: USE_V3_AGENT=${USE_V3_AGENT}, agentVersion=${business.agentVersion}, useV3=${useV3}`);
  console.log(`[AI Worker] Context: business=${business.name}, phone=${phoneMask}, instanceId=${targetInstanceId?.slice(0, 8) || 'none'}`);
  console.log(`[AI Worker] Messages: ${messages.length}`);
  console.log(`[AI Worker] ═══════════════════════════════════════════════════════`);
  
  if (useV3) {
    try {
      console.log(`[AI Worker V3] ▶ Starting V3 processing...`);
      const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
      
      // Fetch latest message with media analysis from MessageLog
      const latestMessageWithMedia = await prisma.messageLog.findFirst({
        where: {
          businessId,
          sender: normalizedPhone,
          direction: 'inbound',
        },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true, message: true, createdAt: true }
      });
      
      console.log(`[AI Worker V3] [AUDIO-DEBUG] Searching for latest message: businessId=${businessId?.slice(0, 8)}, sender=${normalizedPhone}`);
      console.log(`[AI Worker V3] [AUDIO-DEBUG] Found message: createdAt=${latestMessageWithMedia?.createdAt}, hasMetadata=${!!latestMessageWithMedia?.metadata}, messagePreview="${(latestMessageWithMedia?.message || '').substring(0, 100)}..."`);
      
      // Build triggerContext from latest message's metadata
      const msgMeta = latestMessageWithMedia?.metadata as any;
      const triggerContext: { mediaAnalysis?: string; geminiVoucherResult?: any } = {};
      
      console.log(`[AI Worker V3] [AUDIO-DEBUG] Metadata keys: ${msgMeta ? Object.keys(msgMeta).join(', ') : 'null'}`);
      console.log(`[AI Worker V3] [AUDIO-DEBUG] mediaAnalysis in metadata: ${msgMeta?.mediaAnalysis ? 'YES (len=' + msgMeta.mediaAnalysis.length + ')' : 'NO'}`);
      
      if (msgMeta?.mediaAnalysis) {
        triggerContext.mediaAnalysis = msgMeta.mediaAnalysis;
        console.log(`[AI Worker V3] Found mediaAnalysis from latest message: ${msgMeta.mediaAnalysis.substring(0, 100)}...`);
      }
      
      if (msgMeta?.voucherValidation) {
        triggerContext.geminiVoucherResult = {
          isPaymentProof: msgMeta.voucherValidation.isPaymentProof,
          isValid: msgMeta.voucherValidation.isValid,
          brand: msgMeta.voucherValidation.brand,
          amount: msgMeta.voucherValidation.amount,
          currency: msgMeta.voucherValidation.currency,
          operationCode: msgMeta.voucherValidation.operationCode,
          confidence: msgMeta.voucherValidation.confidence,
          reason: msgMeta.voucherValidation.reason,
          imageUrl: msgMeta.voucherValidation.imageUrl
        };
        console.log(`[AI Worker V3] Found voucherValidation: isPaymentProof=${msgMeta.voucherValidation.isPaymentProof}, amount=${msgMeta.voucherValidation.amount}`);
      }
      
      const v3Input: OrchestratorInput = {
        businessId,
        instanceId: targetInstanceId || null,
        contactPhone: normalizedPhone,
        contactName: contactName || 'Cliente',
        messages: messages.map((m, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: m })),
        triggerContext: Object.keys(triggerContext).length > 0 ? triggerContext : undefined,
        config: {
          model: (business as any).v3Llm1Model || (business as any).openaiModel || 'gpt-4.1-mini',
          llm1Model: (business as any).v3Llm1Model || (business as any).openaiModel || 'gpt-4.1-mini',
          llm1Provider: ((business as any).v3Llm1Provider || 'openai') as 'openai' | 'openrouter',
          llm2Model: (business as any).v3Llm2Model || 'gpt-4.1',
          llm2Provider: ((business as any).v3Llm2Provider || 'openai') as 'openai' | 'openrouter',
          temperature: 0.7,
          maxTokens: 2000,
          maxToolCalls: 5
        }
      };
      
      console.log(`[AI Worker V3] Input: phone=${phoneMask}, instanceId=${v3Input.instanceId?.slice(0, 8) || 'null'}, msgCount=${v3Input.messages.length}, hasTriggerContext=${!!v3Input.triggerContext}`);
      console.log(`[AI Worker V3] Model config: LLM1=${v3Input.config?.llm1Model}/${v3Input.config?.llm1Provider}, LLM2=${v3Input.config?.llm2Model}/${v3Input.config?.llm2Provider}`);
      
      const v3StartTime = Date.now();
      const v3Result = await processWithOrchestrator(v3Input);
      const v3Duration = Date.now() - v3StartTime;
      
      result = { response: v3Result.response, tokensUsed: v3Result.tokensUsed?.total };
      
      console.log(`[AI Worker V3] ═══════════════════════════════════════════════════════`);
      console.log(`[AI Worker V3] ✓ V3 COMPLETED in ${v3Duration}ms`);
      console.log(`[AI Worker V3] Tools executed: ${v3Result.toolsExecuted?.length || 0} - ${v3Result.toolsExecuted?.map(t => `${t.name}(${t.success ? 'OK' : 'FAIL'})`).join(', ') || 'none'}`);
      console.log(`[AI Worker V3] Tokens: prompt=${v3Result.tokensUsed?.prompt || 0}, completion=${v3Result.tokensUsed?.completion || 0}`);
      console.log(`[AI Worker V3] LLM calls: ${v3Result.metadata?.llmCalls || 0}, model: ${v3Result.metadata?.model || 'unknown'}`);
      console.log(`[AI Worker V3] Response length: ${result.response?.length || 0} chars`);
      console.log(`[AI Worker V3] ═══════════════════════════════════════════════════════`);
      
      if (targetInstanceId && result.response) {
        await sendWhatsAppResponse(targetInstanceId, phone, result.response, business);
      }
    } catch (v3Error: any) {
      console.error(`[AI Worker V3] ═══════════════════════════════════════════════════════`);
      console.error(`[AI Worker V3] ✗ V3 FAILED - Falling back to V1`);
      console.error(`[AI Worker V3] Error: ${v3Error.message}`);
      console.error(`[AI Worker V3] Stack: ${v3Error.stack}`);
      console.error(`[AI Worker V3] ═══════════════════════════════════════════════════════`);
      result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
    }
  } else if (business.agentVersion === 'v2') {
    try {
      const v2Available = await isAgentV2Available();
      if (v2Available) {
        result = await processWithAgentV2Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
      } else {
        result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
      }
    } catch (v2Error: any) {
      console.error('[AI Worker] Agent V2 error, falling back to V1:', v2Error.message);
      result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
    }
  } else {
    result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
  }
  
  if (bufferId) {
    await prisma.messageBuffer.delete({ where: { id: bufferId } }).catch(() => {});
    console.log(`[AI Worker] Buffer ${bufferId} deleted after successful processing`);
  }
  
  // NOTE: Automatic tag updates by IA are disabled
  // Tags are now manual-only. Only funnel stages are updated automatically.
  // The analyzeAndUpdateLeadStage function updated tags automatically, which is no longer desired.
  // Funnel stages continue to be updated automatically via checkAndAdvanceStage below.
    
  // Extract custom data from conversation asynchronously
  setImmediate(async () => {
    try {
      const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
      console.log(`[AI Worker] Extracting custom data for ${normalizedPhone}`);
      await processDataExtraction(businessId, normalizedPhone, targetInstanceId);
      
      // Check if contact can advance to next funnel stage after data extraction
      await checkAndAdvanceStage(businessId, normalizedPhone, targetInstanceId);
    } catch (err: any) {
      console.error('[AI Worker] Data extraction failed:', err.message);
    }
  });
  
  return result;
}

async function processWithAgentV2Worker(
  business: any,
  messages: string[],
  contactPhone: string,
  contactName: string,
  phone: string,
  instanceId: string | undefined
): Promise<{ response: string; tokensUsed?: number }> {
  // Get the correct prompt config for this instance
  const promptConfigV2 = 
    (instanceId && business.agentPrompts?.find((p: any) => p.instanceId === instanceId)) ||
    business.agentPrompts?.find((p: any) => !p.instanceId) ||
    business.agentPrompts?.[0];
  const historyLimit = promptConfigV2?.historyLimit || 10;
  
  // Get current lead stage for context (now supports multiple tags)
  const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
  const currentTagAssignments = await prisma.tagAssignment.findMany({
    where: {
      businessId: business.id,
      contactPhone: normalizedPhone
    },
    include: { tag: true }
  });
  // Use first tag for backward compatibility
  const currentLeadStage = currentTagAssignments.length > 0 ? currentTagAssignments[0].tag?.name || null : null;
  
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
  
  const userTools = promptConfigV2?.tools || [];
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
    promptConfigV2?.prompt,
    toolsConfig
  );
  
  const combinedMessage = messages.join('\n');
  
  // Inject lead stage into business context custom_prompt
  if (currentLeadStage) {
    businessContext.custom_prompt = (businessContext.custom_prompt || '') + 
      `\n\n## Etapa comercial actual del cliente: ${currentLeadStage}\nConsidera esta etapa al responder y guía la conversación hacia el siguiente paso del proceso comercial.`;
  }
  
  const result = await generateWithAgentV2({
    business_context: businessContext,
    conversation_history: conversationHistory,
    current_message: combinedMessage,
    sender_phone: contactPhone,
    sender_name: contactName || undefined
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Agent V2 failed to generate response');
  }
  
  if (result.tokens_used) {
    logTokenUsage({
      businessId: business.id,
      userId: business.userId,
      feature: 'agent_v2_worker',
      model: result.model || 'gpt-4o-mini',
      promptTokens: Math.floor(result.tokens_used * 0.7),
      completionTokens: Math.floor(result.tokens_used * 0.3),
      totalTokens: result.tokens_used
    }).catch(err => console.error('[AI Worker] Token logging failed:', err.message));
  }
  
  const aiResponse = result.response || '';
  
  if (instanceId && aiResponse) {
    await sendWhatsAppResponse(instanceId, phone, aiResponse, business);
  }
  
  return { response: aiResponse, tokensUsed: result.tokens_used };
}

async function processWithAgentV1Worker(
  business: any,
  messages: string[],
  contactPhone: string,
  contactName: string,
  phone: string,
  instanceId: string | undefined
): Promise<{ response: string; tokensUsed?: number }> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured');
  }
  
  // Track tools executed for webhook dispatch
  const toolsExecuted: string[] = [];
  
  // Get current lead stage for context (now supports multiple tags)
  const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
  const currentTagAssignments = await prisma.tagAssignment.findMany({
    where: {
      businessId: business.id,
      contactPhone: normalizedPhone
    },
    include: { tag: true }
  });
  // Use first tag for backward compatibility
  const currentLeadStage = currentTagAssignments.length > 0 ? currentTagAssignments[0].tag?.name || null : null;
  
  // Get the correct prompt config for this instance
  // Priority: 1) Prompt specific to instanceId, 2) Shared prompt (instanceId=null), 3) First available
  const promptConfig = 
    (instanceId && business.agentPrompts?.find((p: any) => p.instanceId === instanceId)) ||
    business.agentPrompts?.find((p: any) => !p.instanceId) ||
    business.agentPrompts?.[0];
  const historyLimit = promptConfig?.historyLimit || 10;
  const userTools = promptConfig?.tools || [];
  
  let systemPrompt = promptConfig?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
  
  const businessObjective = business.businessObjective || 'SALES';
  
  if (businessObjective === 'APPOINTMENTS') {
    // Generate current date/time context for semantic interpretation
    const timezone = business.timezone || 'America/Lima';
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'long'
    });
    const formattedNow = formatter.format(now);
    
    // Calculate tomorrow's date in the same timezone
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowFormatter = new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long'
    });
    const formattedTomorrow = tomorrowFormatter.format(tomorrow);
    
    // ISO date for today
    const isoFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const todayISO = isoFormatter.format(now);
    const tomorrowISO = isoFormatter.format(tomorrow);
    
    systemPrompt += `\n\n## Contexto temporal (para interpretar fechas relativas)
- Fecha y hora actual: ${formattedNow}
- Zona horaria: ${timezone}
- Hoy en formato ISO: ${todayISO}
- Mañana: ${formattedTomorrow} (ISO: ${tomorrowISO})

IMPORTANTE para fechas:
- Cuando el cliente diga "mañana", usa la fecha ${tomorrowISO}
- Cuando diga "hoy", usa ${todayISO}
- Convierte SIEMPRE las fechas relativas a formato ISO 8601 (YYYY-MM-DDTHH:mm:ss) internamente
- NO preguntes al cliente por el formato de fecha, interpreta semánticamente lo que dice`;
    
    systemPrompt += `\n\n## Modo de operación: CITAS Y SERVICIOS
Tu objetivo principal es ayudar a los clientes a agendar citas y consultar disponibilidad de servicios.
- Ofrece horarios disponibles cuando el cliente quiera agendar
- Confirma los detalles de la cita (fecha, hora, servicio)
- Responde preguntas sobre los servicios ofrecidos
- NO intentes vender productos ni crear pedidos`;
  } else {
    systemPrompt += `\n\n## Modo de operación: VENTAS
Tu objetivo principal es ayudar a los clientes con sus compras y consultas sobre productos.`;
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
  
  try {
    const userQuery = messages.join(' ');
    const ragResult = await retrieveRelevantSections(business.id, userQuery, 5, instanceId);
    
    if (ragResult.coreSections.length > 0 || ragResult.ragSections.length > 0) {
      const ragContent = formatSectionsForPrompt(ragResult);
      systemPrompt += `\n\n${ragContent}`;
      console.log(`[AI] RAG: ${ragResult.coreSections.length} core + ${ragResult.ragSections.length} dynamic sections (~${ragResult.totalTokensEstimate} tokens)`);
    }
  } catch (ragError) {
    console.error('[AI] RAG retrieval failed, continuing without:', ragError);
  }
  
  const currencySymbol = business.currencySymbol || 'S/.';
  const productCount = business.products?.length || 0;
  
  if (businessObjective === 'SALES' && productCount > 0 && productCount <= 20) {
    systemPrompt += `\n\n## Catálogo de productos:`;
    business.products.forEach((product: any) => {
      systemPrompt += `\n- [ID:${product.id}] ${product.title}: ${currencySymbol}${product.price}`;
      if (product.stock !== undefined) {
        systemPrompt += ` (Stock: ${product.stock})`;
      }
      if (product.description) {
        systemPrompt += ` - ${product.description}`;
      }
    });
  }
  
  const agentFiles = await prisma.agentFile.findMany({
    where: { 
      prompt: { businessId: business.id },
      enabled: true 
    },
    orderBy: { order: 'asc' }
  });
  
  if (agentFiles.length > 0) {
    systemPrompt += `\n\n## Archivos disponibles para enviar:`;
    systemPrompt += `\nTienes acceso a ${agentFiles.length} archivos que puedes enviar al cliente cuando sea relevante.`;
    systemPrompt += `\nUsa la función enviar_archivo cuando el cliente pregunte por alguno de estos temas o cuando sea apropiado según el contexto:`;
    agentFiles.forEach((file: any) => {
      systemPrompt += `\n- [ID:${file.id}] ${file.name}`;
      if (file.description) systemPrompt += `: ${file.description}`;
      if (file.triggerKeywords) systemPrompt += ` (keywords: ${file.triggerKeywords})`;
      if (file.triggerContext) systemPrompt += ` | Enviar cuando: ${file.triggerContext}`;
    });
    systemPrompt += `\n\nIMPORTANTE: Cuando detectes que el cliente pregunta por algo relacionado a estos archivos (por keywords o contexto), usa enviar_archivo con el ID correspondiente.`;
  }
  
  systemPrompt = replacePromptVariables(systemPrompt, business.timezone || 'America/Lima');
  
  // Add lead stage context if available
  if (currentLeadStage) {
    systemPrompt += `\n\n## Etapa comercial actual del cliente: ${currentLeadStage}\nConsidera esta etapa al responder y guía la conversación hacia el siguiente paso del proceso comercial.`;
  }
  
  // Add funnel stage context if configured
  try {
    const funnelStatus = await getContactStageStatus(business.id, normalizedPhone);
    if (funnelStatus.currentStage) {
      const funnelContext = buildStageContextForPrompt(funnelStatus);
      systemPrompt += funnelContext;
    }
  } catch (funnelErr: any) {
    console.error('[AI Worker] Failed to get funnel stage context:', funnelErr.message);
  }
  
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
  
  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = 
    recentMessages.reverse().map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant' as const,
      content: msg.message || ''
    }));
  
  const combinedUserMessage = messages.join('\n');
  conversationHistory.push({ role: 'user', content: combinedUserMessage });
  
  const openaiTools: any[] = [];
  
  if (productCount > 3) {
    openaiTools.push({
      type: 'function',
      function: {
        name: 'buscar_producto',
        description: 'Busca productos en el catálogo por nombre o descripción.',
        parameters: {
          type: 'object',
          properties: {
            consulta: { type: 'string', description: 'Término de búsqueda' }
          },
          required: ['consulta']
        }
      }
    });
  }
  
  if (agentFiles.length > 0) {
    openaiTools.push({
      type: 'function',
      function: {
        name: 'enviar_archivo',
        description: 'Envía un archivo (documento, imagen, catálogo, etc.) al cliente.',
        parameters: {
          type: 'object',
          properties: {
            archivo_id: { type: 'string', description: 'ID del archivo a enviar' },
            mensaje_acompanante: { type: 'string', description: 'Mensaje breve que acompaña al archivo' }
          },
          required: ['archivo_id']
        }
      }
    });
  }
  
  // Add appointment tools for APPOINTMENTS mode
  let appointmentExtractionFields: any[] = [];
  let extractedContactData: Record<string, string> = {};
  
  if (businessObjective === 'APPOINTMENTS') {
    // Get custom extraction fields configured for appointments
    appointmentExtractionFields = await (prisma.extractionField as any).findMany({
      where: { businessId: business.id, enabled: true, useForAppointment: true },
      orderBy: { order: 'asc' }
    });
    
    // Get already extracted data for this contact
    extractedContactData = await getExtractedDataForContact(business.id, contactPhone.replace(/\D/g, ''));
    
    // Build context about available extracted data
    let extractedDataContext = '';
    if (Object.keys(extractedContactData).length > 0) {
      extractedDataContext = '\n\nDATOS YA CONOCIDOS DEL CLIENTE (no preguntes por estos):';
      for (const [key, value] of Object.entries(extractedContactData)) {
        extractedDataContext += `\n- ${key}: ${value}`;
      }
    }
    
    systemPrompt += extractedDataContext;
    
    openaiTools.push({
      type: 'function',
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
    
    // Build dynamic appointment tool with custom fields
    const appointmentProperties: Record<string, any> = {
      fecha_hora: {
        type: 'string',
        description: 'Fecha y hora de la cita en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss)'
      },
      servicio: {
        type: 'string',
        description: 'Tipo de servicio o cita'
      },
      duracion_minutos: {
        type: 'number',
        description: 'Duración de la cita en minutos (default: 60)'
      },
      notas: {
        type: 'string',
        description: 'Notas adicionales para la cita'
      },
      correo_invitado: {
        type: 'string',
        description: 'Correo electrónico del cliente para enviar invitación de Google Calendar. Solo pedir si es necesario para la cita.'
      },
      titulo_evento: {
        type: 'string',
        description: 'Título personalizado para el evento en Google Calendar (opcional)'
      },
      crear_meet: {
        type: 'boolean',
        description: 'Si es true, genera un link de Google Meet para la cita virtual (default: false)'
      }
    };
    
    // Add custom fields from extraction configuration
    const appointmentRequired: string[] = ['fecha_hora'];
    
    for (const field of appointmentExtractionFields) {
      // Skip if data already extracted
      if (extractedContactData[field.fieldKey]) {
        continue;
      }
      
      appointmentProperties[field.fieldKey] = {
        type: field.fieldType === 'number' ? 'number' : 'string',
        description: field.description || field.fieldLabel
      };
      
      if (field.required) {
        appointmentRequired.push(field.fieldKey);
      }
    }
    
    openaiTools.push({
      type: 'function',
      function: {
        name: 'agendar_cita',
        description: 'Agenda una cita con el cliente. El teléfono del cliente ya está disponible automáticamente, NO lo pidas. Solo solicita los datos que realmente necesitas según la descripción de cada campo.',
        parameters: {
          type: 'object',
          properties: appointmentProperties,
          required: appointmentRequired
        }
      }
    });
    
    console.log(`[AI Worker V1] Appointment tool configured with ${appointmentExtractionFields.length} custom fields, ${Object.keys(extractedContactData).length} already extracted`);
  }
  
  // Add order creation tool for SALES mode
  if (businessObjective === 'SALES') {
    // Get already extracted data for this contact (same as APPOINTMENTS mode)
    const salesExtractedData = await getExtractedDataForContact(business.id, contactPhone.replace(/\D/g, ''));
    
    // Add extracted data to prompt context so agent doesn't repeat questions
    if (Object.keys(salesExtractedData).length > 0) {
      let extractedDataContext = '\n\n## DATOS YA CONOCIDOS DEL CLIENTE (NO preguntes por estos):';
      for (const [key, value] of Object.entries(salesExtractedData)) {
        extractedDataContext += `\n- ${key}: ${value}`;
      }
      systemPrompt += extractedDataContext;
      console.log(`[AI Worker V1] SALES mode: ${Object.keys(salesExtractedData).length} extracted data fields added to context`);
    }
    
    // Get delivery zones for the business
    const deliveryZones = await prisma.deliveryZone.findMany({
      where: { businessId: business.id, isActive: true },
      select: { id: true, name: true, cost: true }
    });
    
    const zoneDescriptions = deliveryZones.length > 0
      ? deliveryZones.map(z => `${z.name} (envío: ${business.currencySymbol || 'S/.'}${z.cost})`).join(', ')
      : 'No hay zonas configuradas';
    
    openaiTools.push({
      type: 'function',
      function: {
        name: 'confirmar_pedido',
        description: `Registra un pedido cuando el cliente confirma su compra. Usa esta función SOLO cuando el cliente dice explícitamente "sí lo quiero", "confirmo", "procede con el pedido", etc. Zonas disponibles: ${zoneDescriptions}`,
        parameters: {
          type: 'object',
          properties: {
            producto: { 
              type: 'string', 
              description: 'Nombre exacto del producto que el cliente quiere comprar' 
            },
            cantidad: { 
              type: 'number', 
              description: 'Cantidad de productos (default: 1)' 
            },
            nombre_cliente: { 
              type: 'string', 
              description: 'Nombre completo del cliente' 
            },
            direccion: { 
              type: 'string', 
              description: 'Dirección completa de envío' 
            },
            zona_envio: { 
              type: 'string', 
              description: 'Zona o distrito de envío para calcular costo' 
            },
            metodo_pago: { 
              type: 'string', 
              enum: ['YAPE', 'PLIN', 'TRANSFERENCIA', 'EFECTIVO', 'OTRO'],
              description: 'Método de pago preferido por el cliente' 
            },
            notas: { 
              type: 'string', 
              description: 'Notas adicionales del pedido (opcional)' 
            }
          },
          required: ['producto', 'nombre_cliente', 'direccion']
        }
      }
    });
    
    openaiTools.push({
      type: 'function',
      function: {
        name: 'agregar_producto_orden',
        description: 'Agrega un producto adicional a la orden activa del cliente. Usa esta función cuando el cliente ya tiene un pedido y quiere agregar más productos.',
        parameters: {
          type: 'object',
          properties: {
            producto: { 
              type: 'string', 
              description: 'Nombre del producto a agregar' 
            },
            cantidad: { 
              type: 'number', 
              description: 'Cantidad a agregar (default: 1)' 
            }
          },
          required: ['producto']
        }
      }
    });
    
    openaiTools.push({
      type: 'function',
      function: {
        name: 'consultar_pedido',
        description: 'Consulta el estado actual del pedido del cliente. Usa esta función cuando el cliente pregunta por su pedido, cuánto debe, qué productos tiene, etc.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    });
    
    openaiTools.push({
      type: 'function',
      function: {
        name: 'confirmar_entrega',
        description: 'Marca el pedido como entregado. Usa esta función cuando el cliente confirma que recibió su pedido.',
        parameters: {
          type: 'object',
          properties: {
            notas: { 
              type: 'string', 
              description: 'Notas sobre la entrega (opcional)' 
            }
          },
          required: []
        }
      }
    });
    
    console.log(`[AI Worker V1] Order tools added for SALES mode: confirmar_pedido, agregar_producto_orden, consultar_pedido, confirmar_entrega`);
  }
  
  // Add custom tools from business configuration
  for (const customTool of userTools) {
    const parameters: any = {
      type: 'object',
      properties: {} as Record<string, any>,
      required: [] as string[],
      additionalProperties: false
    };
    
    if (customTool.parameters && Array.isArray(customTool.parameters)) {
      for (const param of customTool.parameters) {
        const typeMap: Record<string, string> = {
          'string': 'string',
          'number': 'number',
          'integer': 'integer',
          'boolean': 'boolean',
          'array': 'array',
          'object': 'object'
        };
        parameters.properties[param.name] = {
          type: typeMap[param.type] || 'string',
          description: param.description || param.name
        };
        if (param.required) {
          parameters.required.push(param.name);
        }
      }
    }
    
    openaiTools.push({
      type: 'function',
      function: {
        name: `custom_${customTool.name}`,
        description: customTool.description || `Custom tool: ${customTool.name}`,
        parameters
      }
    });
    
    console.log(`[AI Worker V1] Added custom tool: custom_${customTool.name}`);
  }
  
  const modelConfig = await getModelForAgent('v1', business.openaiModel);
  
  if (openaiTools.length === 0) {
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      }))
    ];
    
    const result = await callOpenAI({
      model: modelConfig.model,
      messages: chatMessages,
      reasoningEffort: modelConfig.reasoningEffort,
      maxTokens: 1000,
      temperature: 0.7,
      maxHistoryTokens: 3000,
      context: {
        businessId: business.id,
        userId: business.userId,
        feature: 'agent_v1_worker'
      }
    });
    
    const aiResponse = result.content;
    const tokensUsed = result.usage?.totalTokens;
    
    if (instanceId && aiResponse) {
      await sendWhatsAppResponse(instanceId, phone, aiResponse, business);
    }
    
    return { response: aiResponse, tokensUsed };
  }
  
  const { client: openai, normalizedModel } = getClientForModel(modelConfig.model);
  
  const chatParams: any = {
    model: normalizedModel,
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory
    ],
    max_tokens: 1000,
    temperature: 0.7,
    tools: openaiTools,
    tool_choice: 'auto'
  };
  
  let completion = await openai.chat.completions.create(chatParams);
  let totalTokens = completion.usage?.total_tokens || 0;
  
  let maxIterations = 5;
  let iteration = 0;
  
  while (completion.choices[0]?.message?.tool_calls && iteration < maxIterations) {
    iteration++;
    const toolCalls = completion.choices[0].message.tool_calls;
    const toolMessages: any[] = [completion.choices[0].message];
    
    for (const toolCall of toolCalls) {
      const fn = (toolCall as any).function;
      const toolName = fn.name;
      
      if (toolName === 'buscar_producto') {
        const args = JSON.parse(fn.arguments);
        const searchResult = await searchProductsIntelligent(business.id, args.consulta || '', 5);
        
        const productResults = searchResult.products.map((p: any) => {
          // If product has variations, include them with their specific prices
          let variaciones = null;
          if (p.variations && p.variations.length > 0) {
            variaciones = p.variations.map((v: string, i: number) => ({
              nombre: v,
              precio: `${currencySymbol}${p.pricePerVariation?.[i] || p.price}`,
              precio_numerico: p.pricePerVariation?.[i] || p.price,
              stock: p.stockPerVariation?.[i] ?? p.stock
            }));
          }
          
          // Determine the price to show - if matched a variation, show that price
          let precioMostrar = p.price;
          if (p.matchedVariationIndex !== undefined && p.pricePerVariation?.[p.matchedVariationIndex]) {
            precioMostrar = p.pricePerVariation[p.matchedVariationIndex];
          }
          
          return {
            id: p.id,
            nombre: p.title,
            precio: `${currencySymbol}${precioMostrar}`,
            precio_numerico: precioMostrar,
            variacion_encontrada: p.matchedVariation || null,
            variaciones: variaciones,
            stock: p.matchedVariationIndex !== undefined && p.stockPerVariation ? 
              p.stockPerVariation[p.matchedVariationIndex] : p.stock,
            disponible: p.available,
            descripcion: p.description?.substring(0, 100),
            imagen_url: p.imageUrl || null
          };
        });
        
        // Build mejor_coincidencia with proper price handling for variations
        let mejorCoincidencia: any = null;
        if (searchResult.bestMatch) {
          const bm = searchResult.bestMatch;
          // If matched a variation, use its specific price; otherwise use base price
          let precioFinal = bm.price;
          let variacionInfo = '';
          if (bm.matchedVariation !== undefined && bm.matchedVariationIndex !== undefined) {
            // Use variation-specific price if available
            if (bm.pricePerVariation && bm.pricePerVariation[bm.matchedVariationIndex]) {
              precioFinal = bm.pricePerVariation[bm.matchedVariationIndex];
            }
            variacionInfo = bm.matchedVariation;
          }
          mejorCoincidencia = {
            id: bm.id,
            nombre: bm.title,
            precio: `${currencySymbol}${precioFinal}`,
            precio_numerico: precioFinal,
            variacion: variacionInfo || null,
            stock: bm.matchedVariationIndex !== undefined && bm.stockPerVariation ? 
              bm.stockPerVariation[bm.matchedVariationIndex] : bm.stock,
            disponible: bm.available,
            similitud: Math.round(bm.similarity * 100) + '%'
          };
        }
        
        const result: any = {
          productos_encontrados: productResults,
          coincidencia_exacta: searchResult.exactMatch,
          mejor_coincidencia: mejorCoincidencia
        };
        
        // Add instruction for sending image if best match has image (same format as enviar_archivo)
        if (searchResult.bestMatch?.imageUrl) {
          result.instruccion = `IMPORTANTE: Incluye esta URL en tu respuesta para enviar la foto del producto: ${searchResult.bestMatch.imageUrl}`;
          result.imagen_producto = {
            url: searchResult.bestMatch.imageUrl,
            nombre: searchResult.bestMatch.title
          };
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      } else if (toolName === 'enviar_archivo') {
        const args = JSON.parse(fn.arguments);
        const archivo = agentFiles.find((f: any) => f.id === args.archivo_id);
        
        if (archivo) {
          const mensajeAcompanante = args.mensaje_acompanante || '';
          const responseText = mensajeAcompanante 
            ? `${mensajeAcompanante}\n[MEDIA:${archivo.fileUrl}]`
            : `[MEDIA:${archivo.fileUrl}]`;
          
          if (instanceId) {
            await sendWhatsAppResponse(instanceId, phone, responseText, business);
          }
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Archivo "${archivo.name}" enviado exitosamente al cliente.`
          });
        } else {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: Archivo con ID ${args.archivo_id} no encontrado.`
          });
        }
      } else if (toolName === 'consultar_disponibilidad') {
        const args = JSON.parse(fn.arguments);
        const fecha = args.fecha;
        
        console.log(`[AI Worker] Checking availability for ${fecha}`);
        
        try {
          const response = await axios.get(
            `${process.env.CORE_API_URL || 'http://localhost:3001'}/appointments/internal/availability`,
            {
              params: { businessId: business.id, date: fecha },
              headers: { 'X-Internal-Secret': process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me' }
            }
          );
          
          const slots = response.data.slots || [];
          const formattedSlots = slots.map((s: any) => `${s.time} - ${s.available ? 'Disponible' : 'Ocupado'}`).join('\n');
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: slots.length > 0 
              ? `Horarios para ${fecha}:\n${formattedSlots}`
              : `No hay horarios configurados para ${fecha}. El negocio puede no tener disponibilidad ese día.`
          });
        } catch (err: any) {
          console.error('[AI Worker] Availability check failed:', err.message);
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error al consultar disponibilidad: ${err.message}`
          });
        }
      } else if (toolName === 'agendar_cita') {
        const args = JSON.parse(fn.arguments);
        const fechaHora = args.fecha_hora;
        const servicio = args.servicio || '';
        const duracion = args.duracion_minutos || 60;
        const notas = args.notas || '';
        const correoInvitado = args.correo_invitado || '';
        const tituloEvento = args.titulo_evento || '';
        const crearMeet = args.crear_meet === true;
        const normalizedPhone = contactPhone.replace(/\D/g, '');
        
        // Use extracted name if not provided in args, or fall back to contact name
        const nombreCliente = args.nombre || extractedContactData['nombre'] || 
                              extractedContactData['nombre_cliente'] || contactName || 'Cliente';
        
        console.log(`[AI Worker] Scheduling appointment for ${fechaHora}, client: ${nombreCliente}, meet: ${crearMeet}`);
        
        // Save any new extracted data from the tool call
        const newDataToSave: Record<string, string> = {};
        for (const [key, value] of Object.entries(args)) {
          if (value && typeof value === 'string' && 
              !['fecha_hora', 'servicio', 'duracion_minutos', 'notas', 'correo_invitado', 'titulo_evento', 'crear_meet'].includes(key)) {
            newDataToSave[key] = value;
          }
        }
        
        if (Object.keys(newDataToSave).length > 0) {
          try {
            for (const [key, value] of Object.entries(newDataToSave)) {
              await (prisma.contactExtractedData as any).upsert({
                where: {
                  businessId_contactPhone_fieldKey: {
                    businessId: business.id,
                    contactPhone: normalizedPhone,
                    fieldKey: key
                  }
                },
                create: {
                  businessId: business.id,
                  contactPhone: normalizedPhone,
                  fieldKey: key,
                  fieldValue: value,
                  confidence: 1.0,
                  source: 'tool'
                },
                update: {
                  fieldValue: value,
                  confidence: 1.0,
                  source: 'tool'
                }
              });
            }
            console.log(`[AI Worker] Saved ${Object.keys(newDataToSave).length} extracted fields from appointment tool`);
          } catch (saveErr: any) {
            console.error('[AI Worker] Failed to save extracted data:', saveErr.message);
          }
        }
        
        try {
          const response = await axios.post(
            `${process.env.CORE_API_URL || 'http://localhost:3001'}/appointments/internal/schedule`,
            {
              businessId: business.id,
              scheduledAt: fechaHora,
              contactName: nombreCliente,
              contactPhone: normalizedPhone,
              service: servicio,
              durationMinutes: duracion,
              notes: notas,
              guestEmail: correoInvitado || undefined,
              eventTitle: tituloEvento || undefined,
              createMeetLink: crearMeet
            },
            {
              headers: { 'X-Internal-Secret': process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me' }
            }
          );
          
          if (response.data.success) {
            const apt = response.data.appointment;
            const aptDate = new Date(apt.scheduledAt);
            const businessTimezone = business.timezone || 'America/Lima';
            const fechaFormateada = aptDate.toLocaleDateString('es-PE', { 
              weekday: 'long', 
              day: 'numeric', 
              month: 'long', 
              year: 'numeric',
              timeZone: businessTimezone
            });
            const horaFormateada = aptDate.toLocaleTimeString('es-PE', { 
              hour: '2-digit', 
              minute: '2-digit',
              timeZone: businessTimezone
            });
            
            let confirmationMsg = `Cita agendada exitosamente:\n- Fecha: ${fechaFormateada}\n- Hora: ${horaFormateada}\n- Cliente: ${nombreCliente}\n- Servicio: ${servicio || 'General'}`;
            
            if (response.data.meetingUrl) {
              confirmationMsg += `\n- Link de Meet: ${response.data.meetingUrl}`;
            }
            if (correoInvitado) {
              confirmationMsg += `\n- Invitación enviada a: ${correoInvitado}`;
            }
            
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: confirmationMsg
            });
          } else {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `No se pudo agendar la cita: ${response.data.error || 'Horario no disponible'}`
            });
          }
        } catch (err: any) {
          console.error('[AI Worker] Appointment scheduling failed:', err.message);
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error al agendar cita: ${err.response?.data?.error || err.message}`
          });
        }
      } else if (toolName === 'confirmar_pedido') {
        // Handle order creation tool
        const args = JSON.parse(fn.arguments);
        const normalizedPhone = contactPhone.replace(/\D/g, '');
        
        console.log(`[AI Worker] Creating order via confirmar_pedido tool:`, args);
        
        try {
          // Validate required fields
          if (!args.producto || args.producto.trim() === '') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: 'Error: Falta el nombre del producto. Pregunta al cliente qué producto desea.'
            });
            continue;
          }
          
          if (!args.nombre_cliente || args.nombre_cliente.trim() === '') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: 'Error: Falta el nombre del cliente. Pregunta su nombre antes de confirmar el pedido.'
            });
            continue;
          }
          
          if (!args.direccion || args.direccion.trim() === '') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: 'Error: Falta la dirección de envío. Pregunta la dirección antes de confirmar el pedido.'
            });
            continue;
          }
          
          const quantity = Math.max(1, parseInt(args.cantidad) || 1);
          
          // Import order service dynamically to avoid circular dependencies
          const { createOrder, findProductWithScope } = await import('../orderService.js');
          
          // Find the product using proper scope (supports variations and instance)
          const matchedProduct = await findProductWithScope(business.id, args.producto, instanceId);
          
          if (!matchedProduct) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: No se encontró el producto "${args.producto}" en el catálogo. Por favor verifica el nombre exacto.`
            });
            continue;
          }
          
          // Find delivery zone (by name or districts)
          let shippingCost = 0;
          let zoneId: string | null = null;
          let zoneWarning = '';
          
          const zones = await prisma.deliveryZone.findMany({
            where: { businessId: business.id, isActive: true }
          });
          
          if (zones.length > 0) {
            if (args.zona_envio) {
              const searchZone = args.zona_envio.toLowerCase().trim();
              
              // Try matching by zone name first
              let matchedZone = zones.find(z => 
                z.name.toLowerCase().includes(searchZone) ||
                searchZone.includes(z.name.toLowerCase())
              );
              
              // If not found, try matching in districts array
              if (!matchedZone) {
                matchedZone = zones.find(z => 
                  z.districts?.some((d: string) => 
                    d.toLowerCase().includes(searchZone) ||
                    searchZone.includes(d.toLowerCase())
                  )
                );
              }
              
              if (matchedZone) {
                shippingCost = matchedZone.cost || 0;
                zoneId = matchedZone.id;
              } else {
                zoneWarning = ` (Nota: zona "${args.zona_envio}" no encontrada, envío sin costo adicional)`;
              }
            } else {
              zoneWarning = ' (Nota: no se especificó zona de envío)';
            }
          }
          
          const unitPrice = matchedProduct.price;
          
          // Create the order
          const orderResult = await createOrder({
            businessId: business.id,
            instanceId: instanceId || null,
            contactPhone: normalizedPhone,
            contactName: args.nombre_cliente || contactName || 'Cliente',
            shippingAddress: args.direccion || '',
            shippingCity: args.zona_envio || null,
            items: [{
              productId: matchedProduct.id,
              productTitle: matchedProduct.title,
              quantity: quantity,
              unitPrice: unitPrice,
              imageUrl: matchedProduct.imageUrl || null
            }],
            shippingCost: shippingCost,
            deliveryZoneId: zoneId,
            source: 'agent_tool'
          });
          
          if (orderResult.success && orderResult.orderId) {
            const orderId = orderResult.orderId;
            const currSym = business.currencySymbol || 'S/.';
            const subtotal = unitPrice * quantity;
            const total = subtotal + shippingCost;
            
            // Save extracted data for future reference
            const dataToSave = [
              { key: 'nombre_cliente', value: args.nombre_cliente },
              { key: 'direccion', value: args.direccion },
              { key: 'producto', value: matchedProduct.title },
              { key: 'zona_envio', value: args.zona_envio },
              { key: 'metodo_pago', value: args.metodo_pago }
            ].filter(d => d.value);
            
            for (const data of dataToSave) {
              await prisma.contactExtractedData.upsert({
                where: {
                  businessId_contactPhone_fieldKey: {
                    businessId: business.id,
                    contactPhone: normalizedPhone,
                    fieldKey: data.key
                  }
                },
                create: {
                  businessId: business.id,
                  contactPhone: normalizedPhone,
                  fieldKey: data.key,
                  fieldValue: data.value,
                  confidence: 1.0,
                  source: 'order_tool'
                },
                update: {
                  fieldValue: data.value,
                  confidence: 1.0,
                  source: 'order_tool',
                  updatedAt: new Date()
                }
              });
            }
            
            toolsExecuted.push('confirmar_pedido');
            
            const variationInfo = matchedProduct.variation ? ` (${matchedProduct.variation})` : '';
            const confirmationMsg = `Pedido #${orderId.slice(-6).toUpperCase()} creado exitosamente.${zoneWarning}
Resumen:
- Producto: ${matchedProduct.title}${variationInfo} x${quantity}
- Subtotal: ${currSym}${subtotal.toFixed(2)}
- Envío: ${currSym}${shippingCost.toFixed(2)}
- TOTAL: ${currSym}${total.toFixed(2)}
- Dirección: ${args.direccion}
- Estado: Esperando comprobante de pago

Informa al cliente el total y pídele que envíe su comprobante de pago.`;
            
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: confirmationMsg
            });
            
            console.log(`[AI Worker] Order created successfully: ${orderId}`);
          } else {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error al crear el pedido: ${orderResult.reason || 'Error desconocido'}`
            });
          }
        } catch (err: any) {
          console.error('[AI Worker] Order creation failed:', err.message);
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error al crear pedido: ${err.message}`
          });
        }
      } else if (toolName === 'agregar_producto_orden') {
        const args = JSON.parse(fn.arguments);
        const ctx: OrderToolContext = {
          businessId: business.id,
          instanceId: instanceId || null,
          contactPhone,
          contactName: contactName || 'Cliente',
          currencySymbol: business.currencySymbol || 'S/.'
        };
        
        const result = await handleAgregarProducto(args, ctx);
        
        if (result.toolExecuted) {
          toolsExecuted.push(result.toolExecuted);
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.content
        });
      } else if (toolName === 'consultar_pedido') {
        const ctx: OrderToolContext = {
          businessId: business.id,
          instanceId: instanceId || null,
          contactPhone,
          contactName: contactName || 'Cliente',
          currencySymbol: business.currencySymbol || 'S/.'
        };
        
        const result = await handleConsultarPedido(ctx);
        
        if (result.toolExecuted) {
          toolsExecuted.push(result.toolExecuted);
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.content
        });
      } else if (toolName === 'confirmar_entrega') {
        const args = JSON.parse(fn.arguments);
        const ctx: OrderToolContext = {
          businessId: business.id,
          instanceId: instanceId || null,
          contactPhone,
          contactName: contactName || 'Cliente',
          currencySymbol: business.currencySymbol || 'S/.'
        };
        
        const result = await handleConfirmarEntrega(args, ctx);
        
        if (result.toolExecuted) {
          toolsExecuted.push(result.toolExecuted);
        }
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.content
        });
      } else if (toolName.startsWith('custom_')) {
        // Handle custom tools
        const actualToolName = toolName.replace('custom_', '');
        const toolConfig = userTools.find((t: any) => t.name === actualToolName);
        
        if (!toolConfig) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: Custom tool "${actualToolName}" not found.`
          });
          continue;
        }
        
        console.log(`[AI Worker V1] Executing custom tool: ${actualToolName}`);
        
        let toolStartTime = Date.now();
        let requestBody: any = {};
        let method = 'POST';
        
        try {
          const args = JSON.parse(fn.arguments);
          if (toolConfig.bodyTemplate) {
            // Parse template as base object, then merge/override with args
            let baseTemplate: any = {};
            try {
              baseTemplate = typeof toolConfig.bodyTemplate === 'string'
                ? JSON.parse(toolConfig.bodyTemplate)
                : toolConfig.bodyTemplate;
            } catch {
              // If template is not valid JSON, use string interpolation fallback
              // First replace placeholders with proper JSON values, then try parsing
              let bodyStr = String(toolConfig.bodyTemplate);
              
              // Dynamic context variables
              const dynamicContext: Record<string, string> = {
                contactPhone: contactPhone.replace(/\D/g, ''),
                contactName: contactName || '',
                businessId: business.id,
                businessName: business.name || ''
              };
              
              // Combine args with dynamic context
              const allVars: Record<string, any> = { ...dynamicContext, ...args };
              
              // Replace placeholders with appropriate values
              // Strategy: use JSON.stringify for all values to ensure valid JSON output
              // This handles strings (adds quotes), numbers, booleans, arrays, objects correctly
              for (const [key, value] of Object.entries(allVars)) {
                // For quoted placeholders like "{{key}}", replace with JSON value
                const quotedRegex = new RegExp(`"\\{\\{${key}\\}\\}"`, 'g');
                bodyStr = bodyStr.replace(quotedRegex, JSON.stringify(value));
                
                // For unquoted placeholders like {{key}} - always use JSON.stringify
                // This ensures strings get proper quotes, arrays/objects get serialized correctly
                const unquotedRegex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                bodyStr = bodyStr.replace(unquotedRegex, JSON.stringify(value));
              }
              
              // Try parsing as JSON after interpolation
              try {
                requestBody = JSON.parse(bodyStr);
              } catch {
                requestBody = bodyStr;
              }
              baseTemplate = null;
            }
            
            if (baseTemplate !== null) {
              // Recursively interpolate placeholders in template values
              const interpolate = (obj: any): any => {
                if (typeof obj === 'string') {
                  // Check if entire value is a placeholder
                  const fullMatch = obj.match(/^\{\{(\w+)\}\}$/);
                  if (fullMatch) {
                    const key = fullMatch[1];
                    // Return the raw value (preserves type for arrays/objects)
                    if (key in args) return args[key];
                    // Check dynamic context
                    const dynamicContext: Record<string, string> = {
                      contactPhone: contactPhone.replace(/\D/g, ''),
                      contactName: contactName || '',
                      businessId: business.id,
                      businessName: business.name || ''
                    };
                    if (key in dynamicContext) return dynamicContext[key];
                    return obj; // Keep placeholder if not found
                  }
                  // Partial placeholders - string interpolation
                  let result = obj;
                  for (const [key, value] of Object.entries(args)) {
                    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                    const stringValue = (typeof value === 'object' && value !== null)
                      ? JSON.stringify(value)
                      : String(value);
                    result = result.replace(regex, stringValue);
                  }
                  // Also replace dynamic variables
                  if (toolConfig.dynamicVariables) {
                    const dynamicContext: Record<string, string> = {
                      contactPhone: contactPhone.replace(/\D/g, ''),
                      contactName: contactName || '',
                      businessId: business.id,
                      businessName: business.name || ''
                    };
                    for (const [key, value] of Object.entries(dynamicContext)) {
                      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                      result = result.replace(regex, value);
                    }
                  }
                  return result;
                } else if (Array.isArray(obj)) {
                  return obj.map(interpolate);
                } else if (typeof obj === 'object' && obj !== null) {
                  const result: any = {};
                  for (const [k, v] of Object.entries(obj)) {
                    result[k] = interpolate(v);
                  }
                  return result;
                }
                return obj;
              };
              
              requestBody = interpolate(baseTemplate);
            }
          } else {
            // If no template, use args directly
            requestBody = args;
          }
          
          // Parse headers - only default to JSON if body is an object
          let headers: Record<string, string> = {};
          if (typeof requestBody === 'object' && requestBody !== null) {
            headers['Content-Type'] = 'application/json';
          }
          if (toolConfig.headers) {
            const configHeaders = typeof toolConfig.headers === 'string' 
              ? JSON.parse(toolConfig.headers) 
              : toolConfig.headers;
            headers = { ...headers, ...configHeaders };
          }
          
          method = (toolConfig.method || 'POST').toUpperCase();
          const axiosConfig: any = {
            method,
            url: toolConfig.url,
            headers,
            timeout: 30000
          };
          
          if (method === 'GET') {
            axiosConfig.params = requestBody;
          } else {
            axiosConfig.data = requestBody;
          }
          
          console.log(`[AI Worker V1] Custom tool ${actualToolName}: ${method} ${toolConfig.url}`);
          
          toolStartTime = Date.now();
          const response = await axios(axiosConfig);
          const toolDuration = Date.now() - toolStartTime;
          
          const responseContent = typeof response.data === 'object' 
            ? JSON.stringify(response.data) 
            : String(response.data);
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: responseContent.substring(0, 4000) // Limit response size
          });
          
          console.log(`[AI Worker V1] Custom tool ${actualToolName} executed successfully in ${toolDuration}ms`);
          
          // Track tool for webhook
          toolsExecuted.push(actualToolName);
          
          // Log tool execution to database
          try {
            await logCustomToolExecution({
              businessId: business.id,
              toolId: toolConfig.id,
              toolName: actualToolName,
              contactPhone,
              request: { url: toolConfig.url, method, body: requestBody, headers },
              response: response.data,
              status: 'success',
              duration: toolDuration
            });
          } catch (logErr) {
            console.error(`[AI Worker V1] Failed to log tool execution:`, logErr);
          }
          
          // Dispatch tool_call webhook
          dispatchToolCall(
            business.id,
            contactPhone,
            actualToolName,
            requestBody,
            response.data,
            true
          ).catch(err => console.error('[AI Worker V1] Failed to dispatch tool_call webhook:', err.message));
          
        } catch (err: any) {
          const toolDuration = Date.now() - toolStartTime;
          console.error(`[AI Worker V1] Custom tool ${actualToolName} failed:`, err.message);
          
          // Log failed tool execution
          try {
            await logCustomToolExecution({
              businessId: business.id,
              toolId: toolConfig?.id,
              toolName: actualToolName,
              contactPhone,
              request: { url: toolConfig?.url, method, body: requestBody },
              response: null,
              status: 'error',
              duration: toolDuration,
              error: err.response?.data?.message || err.message
            });
          } catch (logErr) {
            console.error(`[AI Worker V1] Failed to log tool error:`, logErr);
          }
          
          // Dispatch tool_call webhook for failed execution
          dispatchToolCall(
            business.id,
            contactPhone,
            actualToolName,
            requestBody,
            { error: err.response?.data?.message || err.message },
            false
          ).catch(logErr => console.error('[AI Worker V1] Failed to dispatch tool_call webhook:', logErr));
          
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error executing ${actualToolName}: ${err.response?.data?.message || err.message}`
          });
        }
      }
    }
    
    chatParams.messages.push(...toolMessages);
    delete chatParams.tools;
    delete chatParams.tool_choice;
    
    completion = await openai.chat.completions.create(chatParams);
    totalTokens += completion.usage?.total_tokens || 0;
  }
  
  const aiResponse = completion.choices[0]?.message?.content || '';
  
  await logTokenUsage({
    businessId: business.id,
    userId: business.userId,
    feature: 'agent_v1_worker',
    model: normalizedModel,
    promptTokens: Math.floor(totalTokens * 0.7),
    completionTokens: Math.floor(totalTokens * 0.3),
    totalTokens
  }).catch((err: any) => console.error('[AI Worker] Token logging failed:', err.message));
  
  if (instanceId && aiResponse) {
    await sendWhatsAppResponse(instanceId, phone, aiResponse, business);
  }
  
  // Dispatch agent_message webhook
  if (aiResponse) {
    dispatchAgentMessage(
      business.id,
      contactPhone,
      aiResponse,
      undefined,
      toolsExecuted.length > 0 ? toolsExecuted : undefined,
      instanceId
    ).catch(err => console.error('[AI Worker] Failed to dispatch agent_message webhook:', err.message));
  }
  
  return { response: aiResponse, tokensUsed: totalTokens };
}

// Product images are now sent explicitly when the agent includes the URL from buscar_producto results
// (following the same pattern as enviar_archivo)

async function sendWithRetry(
  sendFn: () => Promise<any>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<{ success: boolean; result?: any; error?: string; attempts: number }> {
  let lastError: string = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await sendFn();
      return { success: true, result, attempts: attempt };
    } catch (error: any) {
      lastError = error.message || 'Unknown error';
      const errorCode = error.code || '';
      const httpStatus = error?.response?.status;
      
      const isRetryableCode = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']
        .includes(errorCode);
      const isRetryableMessage = lastError.includes('META_CIRCUIT_BREAKER_OPEN') || 
        lastError.includes('timeout') || lastError.includes('ETIMEDOUT');
      const isRetryableStatus = httpStatus && (httpStatus >= 500 || httpStatus === 429);
      const isRetryable = isRetryableCode || isRetryableMessage || isRetryableStatus;
      
      if (!isRetryable || attempt === maxRetries) {
        console.error(`[AI Worker] Send FAILED after ${attempt} attempts: ${lastError} (code=${errorCode}, status=${httpStatus})`);
        return { success: false, error: lastError, attempts: attempt };
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`[AI Worker] Retry ${attempt}/${maxRetries} in ${delay}ms: ${lastError}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return { success: false, error: lastError, attempts: maxRetries };
}

async function sendWhatsAppResponse(
  instanceId: string,
  phone: string,
  message: string,
  business: any
): Promise<void> {
  try {
    const cleanPhone = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    
    console.log(`[AI Worker] sendWhatsAppResponse called for ${cleanPhone} via instance ${instanceId}`);
    
    if (isQueueAvailable()) {
      console.log(`[AI Worker] Using unified queue (queueAgentResponse) for ${cleanPhone}`);
      
      const result = await queueAgentResponse({
        businessId: business.id,
        instanceId,
        to: cleanPhone,
        response: message,
        splitMessages: true,
        priority: 'high'
      });
      
      if (result.success) {
        console.log(`[AI Worker] Queued ${result.jobIds?.length || 1} jobs for ${cleanPhone}`);
      } else {
        console.error(`[AI Worker] Failed to queue agent response: ${result.error}`);
      }
    } else {
      console.log(`[AI Worker] Redis not available, using direct send for ${cleanPhone}`);
      
      const result = await sendAgentResponseDirect({
        businessId: business.id,
        instanceId,
        to: cleanPhone,
        response: message,
        contactJid: phone
      });
      
      if (!result.success) {
        console.error(`[AI Worker] Direct send failed: ${result.error}`);
      }
    }
    
    await scheduleFollowUp(business.id, cleanPhone, 'ai', instanceId);
    
    console.log(`[AI Worker] Response flow completed for ${cleanPhone}`);
  } catch (error: any) {
    const errorDetails = error.response?.data 
      ? JSON.stringify(error.response.data) 
      : error.message;
    console.error(`[AI Worker] Failed to send WhatsApp response:`, {
      message: error.message,
      status: error.response?.status,
      details: errorDetails
    });
  }
}

export function startAIResponseWorker(): Worker<AIResponseJobData> {
  if (aiResponseWorker) {
    logAI('WORKER', 'AI Worker already running, returning existing instance');
    return aiResponseWorker;
  }

  logAI('WORKER-START', `Starting AI Response Worker`, {
    environment: ENV_NAME,
    hasRedis: HAS_REDIS,
    redisUrl: process.env.REDIS_URL ? 'configured' : 'not configured',
    concurrency: WORKER_CONCURRENCY,
    lockDuration: LOCK_DURATION
  });

  const connection = getQueueConnection();
  
  aiResponseWorker = new Worker<AIResponseJobData>(
    QUEUE_NAMES.AI_RESPONSE,
    async (job) => {
      try {
        return await processAIResponse(job);
      } catch (error: any) {
        console.error(`[AI Worker] Job ${job.id} failed:`, error.message);
        throw error;
      }
    },
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
      lockDuration: LOCK_DURATION,
      stalledInterval: 60000,
      maxStalledCount: 2
    }
  );

  aiResponseWorker.on('completed', (job, result) => {
    logAI('JOB-COMPLETE', `Job completed`, {
      jobId: job.id,
      responseLength: result?.response?.length || 0,
      businessId: job.data?.businessId,
      contactPhone: job.data?.contactPhone,
      tokensUsed: result?.tokensUsed
    });
  });

  aiResponseWorker.on('failed', async (job, error) => {
    logAI('JOB-FAILED', `Job failed`, {
      jobId: job?.id,
      error: error.message,
      businessId: job?.data?.businessId,
      contactPhone: job?.data?.contactPhone,
      bufferId: job?.data?.bufferId,
      attemptsMade: job?.attemptsMade
    });
    if (job?.data?.bufferId) {
      const maxAttempts = job?.opts?.attempts || 3;
      const attemptsMade = job?.attemptsMade || 0;
      
      if (attemptsMade >= maxAttempts) {
        try {
          await prisma.messageBuffer.update({
            where: { id: job.data.bufferId },
            data: { 
              failedAt: new Date(),
              failureReason: error.message?.substring(0, 500) || 'Unknown error',
              retryCount: attemptsMade,
              processingUntil: new Date(Date.now() + 86400000 * 365)
            }
          });
          console.error(`[AI Worker] Buffer ${job.data.bufferId} FAILED after ${attemptsMade} attempts - requires manual intervention, error: ${error.message}`);
        } catch (e) {
          console.error(`[AI Worker] Failed to mark buffer ${job.data.bufferId} as failed:`, e);
        }
      } else {
        try {
          const backoffDelay = Math.pow(2, attemptsMade) * 5000;
          const extendedLock = new Date(Date.now() + backoffDelay + 600000);
          await prisma.messageBuffer.update({
            where: { id: job.data.bufferId },
            data: { 
              processingUntil: extendedLock,
              retryCount: attemptsMade
            }
          });
          console.log(`[AI Worker] Buffer ${job.data.bufferId} lock extended for retry, attempt ${attemptsMade}/${maxAttempts}`);
        } catch (e) {
          console.error(`[AI Worker] Failed to extend buffer lock:`, e);
        }
      }
    }
  });

  aiResponseWorker.on('error', (error) => {
    console.error('[AI Worker] Worker error:', error.message);
  });

  aiResponseWorker.on('closed', () => {
    console.log('[AI Worker] Worker closed');
  });

  logAI('WORKER-READY', `AI Worker started successfully`, {
    environment: ENV_NAME,
    concurrency: WORKER_CONCURRENCY,
    queueName: QUEUE_NAMES.AI_RESPONSE
  });
  return aiResponseWorker;
}

export async function stopAIResponseWorker(): Promise<void> {
  if (aiResponseWorker) {
    await aiResponseWorker.close();
    aiResponseWorker = null;
    console.log('[AI Worker] Stopped');
  }
}

export async function getAIQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  concurrency: number;
  workerRunning: boolean;
}> {
  const queue = getAIResponseQueue();
  if (!queue) {
    return { waiting: 0, active: 0, completed: 0, failed: 0, concurrency: WORKER_CONCURRENCY, workerRunning: false };
  }
  
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount()
  ]);
  
  return { waiting, active, completed, failed, concurrency: WORKER_CONCURRENCY, workerRunning: isAIWorkerRunning() };
}

export async function processAIResponseDirect(data: AIResponseJobData): Promise<{ response: string; tokensUsed?: number }> {
  const { businessId, contactPhone, contactName, messages, phone, instanceId } = data;
  
  console.log(`[AI Direct] Processing for business ${businessId}, contact ${contactPhone}`);
  
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      policy: true,
      agentPrompts: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: { include: { metaCredential: true, metaCoexistCredential: true } },
      user: { select: { isPro: true, id: true, subscriptionStatus: true } },
      deliveryZones: { where: { isActive: true }, orderBy: { order: 'asc' } }
    }
  });
  
  if (!business) {
    throw new Error(`Business ${businessId} not found`);
  }
  
  // Normalize phone for database lookup (remove non-digits and WhatsApp suffixes)
  const normalizedPhone = contactPhone.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
  
  // Check if bot is globally disabled but contact has test mode enabled
  if (!business.botEnabled) {
    const contact = await prisma.contact.findUnique({
      where: { businessId_phone: { businessId, phone: normalizedPhone } }
    });
    
    if (!contact?.botTestEnabled) {
      console.log(`[AI Direct] Bot globally disabled for business ${businessId}, contact ${normalizedPhone} has no test mode, skipping`);
      return { response: '' };
    }
    console.log(`[AI Direct] Bot test mode enabled for contact ${normalizedPhone}, processing despite global disable`);
  }
  
  const tokenCheck = await checkUserTokenLimit(business.userId);
  if (!tokenCheck.canUseAI) {
    console.log(`[AI Direct] User ${business.userId} blocked: ${tokenCheck.message}`);
    return { response: '' };
  }
  
  const targetInstanceId = instanceId || business.instances?.[0]?.id;
  
  let result: { response: string; tokensUsed?: number };
  
  const useV3 = USE_V3_AGENT || business.agentVersion === 'v3';
  
  if (useV3) {
    try {
      console.log(`[AI Direct] Using Agent V3 for business ${businessId}`);
      
      // Fetch latest message with media analysis from MessageLog
      const latestMessageWithMedia = await prisma.messageLog.findFirst({
        where: {
          businessId,
          sender: normalizedPhone,
          direction: 'inbound',
        },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true }
      });
      
      // Build triggerContext from latest message's metadata
      const msgMeta = latestMessageWithMedia?.metadata as any;
      const triggerContext: { mediaAnalysis?: string; geminiVoucherResult?: any } = {};
      
      if (msgMeta?.mediaAnalysis) {
        triggerContext.mediaAnalysis = msgMeta.mediaAnalysis;
        console.log(`[AI Direct V3] Found mediaAnalysis from latest message`);
      }
      
      if (msgMeta?.voucherValidation) {
        triggerContext.geminiVoucherResult = {
          isPaymentProof: msgMeta.voucherValidation.isPaymentProof,
          isValid: msgMeta.voucherValidation.isValid,
          brand: msgMeta.voucherValidation.brand,
          amount: msgMeta.voucherValidation.amount,
          currency: msgMeta.voucherValidation.currency,
          operationCode: msgMeta.voucherValidation.operationCode,
          confidence: msgMeta.voucherValidation.confidence,
          reason: msgMeta.voucherValidation.reason,
          imageUrl: msgMeta.voucherValidation.imageUrl
        };
        console.log(`[AI Direct V3] Found voucherValidation: isPaymentProof=${msgMeta.voucherValidation.isPaymentProof}`);
      }
      
      const v3Input: OrchestratorInput = {
        businessId,
        instanceId: targetInstanceId || null,
        contactPhone: normalizedPhone,
        contactName: contactName || 'Cliente',
        messages: messages.map((m, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: m })),
        triggerContext: Object.keys(triggerContext).length > 0 ? triggerContext : undefined,
        config: {
          model: (business as any).v3Llm1Model || (business as any).openaiModel || 'gpt-4.1-mini',
          llm1Model: (business as any).v3Llm1Model || (business as any).openaiModel || 'gpt-4.1-mini',
          llm1Provider: ((business as any).v3Llm1Provider || 'openai') as 'openai' | 'openrouter',
          llm2Model: (business as any).v3Llm2Model || 'gpt-4.1',
          llm2Provider: ((business as any).v3Llm2Provider || 'openai') as 'openai' | 'openrouter',
          temperature: 0.7,
          maxTokens: 2000,
          maxToolCalls: 5
        }
      };
      
      const v3Result = await processWithOrchestrator(v3Input);
      result = { response: v3Result.response, tokensUsed: v3Result.tokensUsed?.total };
      
      if (v3Result.toolsExecuted?.length) {
        console.log(`[AI Direct V3] Tools executed: ${v3Result.toolsExecuted.map(t => t.name).join(', ')}`);
      }
    } catch (v3Error: any) {
      console.error('[AI Direct] Agent V3 error, falling back to V1:', v3Error.message);
      result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
    }
  } else if (business.agentVersion === 'v2') {
    try {
      const v2Available = await isAgentV2Available();
      if (v2Available) {
        result = await processWithAgentV2Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
      } else {
        result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
      }
    } catch (v2Error: any) {
      console.error('[AI Direct] Agent V2 error, falling back to V1:', v2Error.message);
      result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
    }
  } else {
    result = await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
  }
  
  // Analyze and update lead stage after agent response (complete interaction cycle)
  if (result.response) {
    setImmediate(async () => {
      // NOTE: Automatic tag updates by IA are disabled
      // Tags are now manual-only. Only funnel stages are updated automatically.
      // try {
      //   const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
      //   console.log(`[AI Direct] Updating lead stage after agent response for ${normalizedPhone}`);
      //   const stageResult = await analyzeAndUpdateLeadStage(businessId, normalizedPhone);
      //   if (stageResult.success) {
      //     console.log(`[AI Direct] Lead stage updated to "${stageResult.newStage}" (confidence: ${stageResult.confidence})`);
      //   }
      // } catch (err: any) {
      //   console.error('[AI Direct] Post-response lead stage update failed:', err.message);
      // }
    });
  }
  
  return result;
}
