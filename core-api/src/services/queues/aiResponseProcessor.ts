import { Worker, Job } from 'bullmq';
import { AIResponseJobData, QUEUE_NAMES, getQueueConnection, getAIResponseQueue } from './index.js';
import prisma from '../prisma.js';
import { isOpenAIConfigured, getOpenAIClient, logTokenUsage, getDefaultModel } from '../openaiService.js';
import { replacePromptVariables } from '../promptVariables.js';
import { generateWithAgentV2, buildBusinessContext, buildConversationHistory, isAgentV2Available } from '../agentV2Service.js';
import { searchProductsIntelligent } from '../productSearch.js';
import axios from 'axios';
import OpenAI from 'openai';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '20', 10);
const QUEUE_ADD_TIMEOUT = 5000;

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
      priority: priorityMap[data.priority || 'normal']
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
  const { businessId, contactPhone, contactName, messages, phone, instanceId, instanceBackendId } = job.data;
  
  console.log(`[AI Worker] Processing job ${job.id} for business ${businessId}, contact ${contactPhone}`);
  
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
  
  let backendId = instanceBackendId;
  if (!backendId && instanceId) {
    const instance = await prisma.whatsAppInstance.findUnique({
      where: { id: instanceId }
    });
    if (instance?.instanceBackendId) {
      backendId = instance.instanceBackendId;
    }
  }
  if (!backendId) {
    backendId = `biz_${businessId.substring(0, 8)}`;
  }
  
  if (business.agentVersion === 'v2') {
    try {
      const v2Available = await isAgentV2Available();
      if (v2Available) {
        return await processWithAgentV2Worker(business, messages, contactPhone, contactName, phone, backendId);
      }
    } catch (v2Error: any) {
      console.error('[AI Worker] Agent V2 error, falling back to V1:', v2Error.message);
    }
  }
  
  return await processWithAgentV1Worker(business, messages, contactPhone, contactName, phone, backendId);
}

async function processWithAgentV2Worker(
  business: any,
  messages: string[],
  contactPhone: string,
  contactName: string,
  phone: string,
  instanceBackendId: string
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
    await logTokenUsage({
      businessId: business.id,
      userId: business.userId,
      feature: 'agent_v2_worker',
      model: result.model || 'gpt-4o-mini',
      promptTokens: Math.floor(result.tokens_used * 0.7),
      completionTokens: Math.floor(result.tokens_used * 0.3),
      totalTokens: result.tokens_used
    });
  }
  
  const aiResponse = result.response || '';
  
  if (instanceBackendId && aiResponse) {
    await sendWhatsAppResponse(instanceBackendId, phone, aiResponse, business);
  }
  
  return { response: aiResponse, tokensUsed: result.tokens_used };
}

async function processWithAgentV1Worker(
  business: any,
  messages: string[],
  contactPhone: string,
  contactName: string,
  phone: string,
  instanceBackendId: string
): Promise<{ response: string; tokensUsed?: number }> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured');
  }
  
  const openai = getOpenAIClient();
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
  
  const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content
    }))
  ];
  
  const model = getDefaultModel();
  const completion = await openai.chat.completions.create({
    model,
    messages: openaiMessages,
    max_tokens: 1000,
    temperature: 0.7
  });
  
  const aiResponse = completion.choices[0]?.message?.content || '';
  const tokensUsed = completion.usage?.total_tokens;
  
  if (completion.usage) {
    await logTokenUsage({
      businessId: business.id,
      userId: business.userId,
      feature: 'agent_v1_worker',
      model,
      promptTokens: completion.usage.prompt_tokens,
      completionTokens: completion.usage.completion_tokens,
      totalTokens: completion.usage.total_tokens
    });
  }
  
  if (instanceBackendId && aiResponse) {
    await sendWhatsAppResponse(instanceBackendId, phone, aiResponse, business);
  }
  
  return { response: aiResponse, tokensUsed };
}

async function sendWhatsAppResponse(
  instanceBackendId: string,
  phone: string,
  message: string,
  business: any
): Promise<void> {
  try {
    const instance = business.instances?.find((i: any) => i.instanceBackendId === instanceBackendId);
    
    if (instance?.provider === 'META_CLOUD' && instance?.metaCredential) {
      console.log(`[AI Worker] Sending via Meta Cloud API`);
    } else {
      await axios.post(`${WA_API_URL}/instances/${instanceBackendId}/sendMessage`, {
        to: phone,
        message
      }, { timeout: 30000 });
    }
    
    console.log(`[AI Worker] Response sent to ${phone}`);
  } catch (error: any) {
    console.error(`[AI Worker] Failed to send WhatsApp response:`, error.message);
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
      concurrency: WORKER_CONCURRENCY
    }
  );

  aiResponseWorker.on('completed', (job, result) => {
    console.log(`[AI Worker] Job ${job.id} completed, response length: ${result?.response?.length || 0}`);
  });

  aiResponseWorker.on('failed', (job, error) => {
    console.error(`[AI Worker] Job ${job?.id} failed:`, error.message);
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
