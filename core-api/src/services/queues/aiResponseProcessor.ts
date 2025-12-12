import { Worker, Job } from 'bullmq';
import { AIResponseJobData, QUEUE_NAMES, getQueueConnection, getAIResponseQueue } from './index.js';
import prisma from '../prisma.js';
import { isOpenAIConfigured, callOpenAI, getModelForAgent, ChatMessage, logTokenUsage } from '../openaiService.js';
import { replacePromptVariables } from '../promptVariables.js';
import { generateWithAgentV2, buildBusinessContext, buildConversationHistory, isAgentV2Available } from '../agentV2Service.js';
import { searchProductsIntelligent } from '../productSearch.js';
import { parseAgentOutputToWhatsAppEvents, calculateTypingDelay, WhatsAppEvent } from '../agentOutputParser.js';
import { MetaCloudAPI } from '../metaCloud.js';
import { scheduleFollowUp } from '../followUpService.js';
import axios from 'axios';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
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
  
  const jobId = `ai-${data.businessId}-${data.contactPhone}-${Date.now()}`;
  
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
  const { businessId, contactPhone, contactName, messages, phone, instanceId, instanceBackendId, bufferId, providerMessageId, provider } = job.data;
  
  console.log(`[AI Worker] Processing job ${job.id} for business ${businessId}, contact ${contactPhone}, provider=${provider || 'unknown'}, providerMessageId=${providerMessageId || 'none'}`);
  
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
      promptMaster: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: { include: { metaCredential: true } },
      user: { select: { isPro: true } }
    }
  });
  
  if (!business) {
    if (bufferId) {
      await prisma.messageBuffer.delete({ where: { id: bufferId } }).catch(() => {});
    }
    throw new Error(`Business ${businessId} not found`);
  }
  
  if (!business.botEnabled) {
    if (bufferId) {
      await prisma.messageBuffer.delete({ where: { id: bufferId } }).catch(() => {});
    }
    return { response: '' };
  }
  
  const targetInstanceId = instanceId || business.instances?.[0]?.id;
  
  // Mark message as read BEFORE processing (shows blue checkmarks after buffer expires)
  if (provider === 'META_CLOUD' && providerMessageId && targetInstanceId) {
    try {
      const targetInstance = business.instances?.find((i: any) => i.id === targetInstanceId);
      if (targetInstance?.metaCredential) {
        const metaClient = new MetaCloudAPI({
          phoneNumberId: targetInstance.metaCredential.phoneNumberId,
          accessToken: targetInstance.metaCredential.accessToken,
          businessAccountId: targetInstance.metaCredential.businessAccountId
        });
        await metaClient.markMessageAsRead(providerMessageId);
        console.log(`[AI Worker] Meta Cloud: Marked message ${providerMessageId} as read for instance ${targetInstanceId}`);
      }
    } catch (markErr: any) {
      console.error(`[AI Worker] Failed to mark Meta message as read:`, markErr.message);
    }
  } else if (provider === 'BAILEYS' && phone) {
    // Baileys marks entire chat as read via WA API
    try {
      await axios.post(`${WA_API_URL}/instance/${instanceBackendId || targetInstanceId}/markAsRead`, {
        phone: contactPhone
      }).catch(() => {});
      console.log(`[AI Worker] Baileys: Marked chat as read for ${contactPhone}`);
    } catch (markErr: any) {
      console.error(`[AI Worker] Failed to mark Baileys chat as read:`, markErr.message);
    }
  }
  
  let result: { response: string; tokensUsed?: number };
  
  if (business.agentVersion === 'v2') {
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
  const historyLimit = business.promptMaster?.historyLimit || 10;
  
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
    dynamicVariables: t.dynamicVariables,
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
  
  const promptConfig = business.promptMaster;
  const historyLimit = promptConfig?.historyLimit || 10;
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
    });
  }
  
  systemPrompt = replacePromptVariables(systemPrompt, business.timezone || 'America/Lima');
  
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
  
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content
    }))
  ];
  
  const modelConfig = await getModelForAgent('v1', business.openaiModel);
  
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

async function sendWhatsAppResponse(
  instanceId: string,
  phone: string,
  message: string,
  business: any
): Promise<void> {
  try {
    const instance = business.instances?.find((i: any) => i.id === instanceId);
    const cleanPhone = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    
    if (!instance) {
      console.error(`[AI Worker] Instance ${instanceId} not found in business instances`);
      return;
    }
    
    const events = parseAgentOutputToWhatsAppEvents(message);
    console.log(`[AI Worker] Parsed ${events.length} events for ${cleanPhone}:`, events.map(e => e.type));
    
    const sentMedia: Array<{ type: string; url?: string }> = [];
    
    if (instance.provider === 'META_CLOUD' && instance.metaCredential) {
      console.log(`[AI Worker] Sending via Meta Cloud API to ${cleanPhone}`);
      const { MetaCloudService } = await import('../metaCloud.js');
      const metaService = new MetaCloudService({
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId,
        businessId: instance.metaCredential.businessId
      });
      
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        
        if (i > 0) {
          const delay = event.type === 'text' ? calculateTypingDelay(event.text || '') : 500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        try {
          if (event.type === 'text' && event.text) {
            await metaService.sendTextMessage(cleanPhone, event.text);
          } else if (event.type === 'image' && event.url) {
            await metaService.sendImageMessage(cleanPhone, event.url, event.caption);
            sentMedia.push({ type: 'image', url: event.url });
          } else if (event.type === 'video' && event.url) {
            await metaService.sendVideoMessage(cleanPhone, event.url, event.caption);
            sentMedia.push({ type: 'video', url: event.url });
          } else if (event.type === 'audio' && event.url) {
            await metaService.sendAudioMessage(cleanPhone, event.url);
            sentMedia.push({ type: 'audio', url: event.url });
          } else if (event.type === 'document' && event.url) {
            await metaService.sendDocumentMessage(cleanPhone, event.url, event.filename, event.caption);
            sentMedia.push({ type: 'document', url: event.url });
          }
        } catch (eventError: any) {
          console.error(`[AI Worker] Failed to send ${event.type} event:`, eventError.message);
        }
      }
      
      console.log(`[AI Worker] Meta Cloud: sent ${events.length} events to ${cleanPhone}`);
    } else if (instance.instanceBackendId) {
      const backendId = instance.instanceBackendId;
      
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        
        if (i > 0) {
          const delay = event.type === 'text' ? calculateTypingDelay(event.text || '') : 500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        try {
          if (event.type === 'text' && event.text) {
            await axios.post(`${WA_API_URL}/instances/${backendId}/sendMessage`, {
              to: phone,
              message: event.text
            }, { timeout: 30000 });
          } else if (event.type === 'image' && event.url) {
            await axios.post(`${WA_API_URL}/instances/${backendId}/sendImage`, {
              to: phone,
              url: event.url,
              caption: event.caption
            }, { timeout: 30000 });
            sentMedia.push({ type: 'image', url: event.url });
          } else if (event.type === 'video' && event.url) {
            await axios.post(`${WA_API_URL}/instances/${backendId}/sendVideo`, {
              to: phone,
              url: event.url,
              caption: event.caption
            }, { timeout: 30000 });
            sentMedia.push({ type: 'video', url: event.url });
          } else if (event.type === 'audio' && event.url) {
            await axios.post(`${WA_API_URL}/instances/${backendId}/sendAudio`, {
              to: phone,
              url: event.url
            }, { timeout: 30000 });
            sentMedia.push({ type: 'audio', url: event.url });
          } else if (event.type === 'document' && event.url) {
            await axios.post(`${WA_API_URL}/instances/${backendId}/sendFile`, {
              to: phone,
              url: event.url,
              caption: event.caption,
              filename: event.filename
            }, { timeout: 30000 });
            sentMedia.push({ type: 'document', url: event.url });
          }
        } catch (eventError: any) {
          console.error(`[AI Worker] Failed to send ${event.type} event via Baileys:`, eventError.message);
        }
      }
      
      console.log(`[AI Worker] Baileys: sent ${events.length} events to ${cleanPhone}`);
    } else {
      console.error(`[AI Worker] No valid send method for instance ${instanceId}`);
      return;
    }
    
    await prisma.messageLog.create({
      data: {
        businessId: business.id,
        instanceId: instance.id,
        direction: 'outbound',
        sender: instance.phoneNumber || 'bot',
        recipient: cleanPhone,
        message: message,
        metadata: { 
          source: 'ai_worker',
          provider: instance.provider || 'BAILEYS',
          agentVersion: business.agentVersion || 'v1',
          eventCount: events.length,
          sentMedia: sentMedia.length > 0 ? sentMedia : undefined
        }
      }
    });
    
    // Schedule follow-up after sending response
    await scheduleFollowUp(business.id, cleanPhone);
    
    console.log(`[AI Worker] Response sent and logged to ${cleanPhone}`);
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
    return aiResponseWorker;
  }

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
    console.log(`[AI Worker] Job ${job.id} completed, response length: ${result?.response?.length || 0}`);
  });

  aiResponseWorker.on('failed', async (job, error) => {
    console.error(`[AI Worker] Job ${job?.id} failed:`, error.message);
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

  console.log(`[AI Worker] Started with concurrency: ${WORKER_CONCURRENCY}`);
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
      promptMaster: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: { include: { metaCredential: true } },
      user: { select: { isPro: true } }
    }
  });
  
  if (!business) {
    throw new Error(`Business ${businessId} not found`);
  }
  
  if (!business.botEnabled) {
    return { response: '' };
  }
  
  const targetInstanceId = instanceId || business.instances?.[0]?.id;
  
  if (business.agentVersion === 'v2') {
    try {
      const v2Available = await isAgentV2Available();
      if (v2Available) {
        return await processWithAgentV2Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
      }
    } catch (v2Error: any) {
      console.error('[AI Direct] Agent V2 error, falling back to V1:', v2Error.message);
    }
  }
  
  return await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, targetInstanceId);
}
