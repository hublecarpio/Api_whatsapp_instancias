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
// import { analyzeAndUpdateLeadStage } from '../leadStageService.js'; // DISABLED: Tags are now manual-only
import axios from 'axios';
import eventLogger from '../eventLogger.js';
import { dispatchAgentMessage, dispatchToolCall } from '../webhookService.js';
import { retrieveRelevantSections, formatSectionsForPrompt } from '../ragService.js';
import { processDataExtraction, getExtractedDataForContact, getAppointmentFieldsData } from '../dataExtractionService.js';
import { getContactStageStatus, buildStageContextForPrompt, checkAndAdvanceStage } from '../funnelStageService.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

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
    const instance = business.instances?.find((i: any) => i.id === instanceId);
    const cleanPhone = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    
    if (!instance) {
      console.error(`[AI Worker] Instance ${instanceId} not found in business instances`);
      return;
    }
    
    const events = parseAgentOutputToWhatsAppEvents(message);
    console.log(`[AI Worker] Parsed ${events.length} events for ${cleanPhone}:`, events.map(e => e.type));
    
    const sentMedia: Array<{ type: string; url?: string }> = [];
    
    const metaCredential = instance.metaCredential;
    const coexistCredential = instance.metaCoexistCredential;
    console.log(`[AI Worker] Instance ${instanceId}: provider=${instance.provider}, hasMetaCred=${!!metaCredential}, hasCoexistCred=${!!coexistCredential}`);
    
    if ((instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') && (metaCredential || coexistCredential)) {
      // Map credential fields correctly - MetaCoexistCredential uses different field names
      let accessToken: string;
      let phoneNumberId: string;
      let businessId: string;
      
      if (metaCredential) {
        accessToken = metaCredential.accessToken;
        phoneNumberId = metaCredential.phoneNumberId;
        businessId = metaCredential.businessId;
      } else if (coexistCredential) {
        // MetaCoexistCredential uses systemAccessToken (preferred) or userAccessToken
        accessToken = coexistCredential.systemAccessToken || coexistCredential.userAccessToken;
        phoneNumberId = coexistCredential.phoneNumberId;
        businessId = coexistCredential.metaBusinessId;
      } else {
        console.error(`[AI Worker] No valid credential found for instance ${instanceId}`);
        return;
      }
      
      console.log(`[AI Worker] Sending via Meta Cloud API (${instance.provider}) to ${cleanPhone}, phoneNumberId=${phoneNumberId}`);
      const { MetaCloudService } = await import('../metaCloud.js');
      const metaService = new MetaCloudService({
        accessToken,
        phoneNumberId,
        businessId
      });
      
      let successCount = 0;
      let failCount = 0;
      
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
              source: 'ai_worker',
              provider: instance.provider || 'BAILEYS',
              agentVersion: business.agentVersion || 'v1',
              type: event.type,
              ...(event.type !== 'text' && { mediaType: event.type, filename: event.filename })
            }
          }
        });
        
        console.log(`[AI Worker] Sending event ${i+1}/${events.length}: type=${event.type}, to=${cleanPhone}, logId=${messageLog.id}`);
        
        let sendResult: { success: boolean; result?: any; error?: string; attempts: number };
        
        if (event.type === 'text' && event.text) {
          sendResult = await sendWithRetry(() => metaService.sendTextMessage(cleanPhone, event.text!), 3, 1000);
        } else if (event.type === 'image' && event.url) {
          sendResult = await sendWithRetry(() => metaService.sendImageMessage(cleanPhone, event.url!, event.caption), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'image', url: event.url });
        } else if (event.type === 'video' && event.url) {
          sendResult = await sendWithRetry(() => metaService.sendVideoMessage(cleanPhone, event.url!, event.caption), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'video', url: event.url });
        } else if (event.type === 'audio' && event.url) {
          sendResult = await sendWithRetry(() => metaService.sendAudioMessage(cleanPhone, event.url!), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'audio', url: event.url });
        } else if (event.type === 'document' && event.url) {
          sendResult = await sendWithRetry(() => metaService.sendDocumentMessage(cleanPhone, event.url!, event.filename, event.caption), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'document', url: event.url });
        } else {
          sendResult = { success: false, error: 'Unknown event type', attempts: 0 };
        }
        
        const providerMessageId = sendResult.result?.messages?.[0]?.id;
        await prisma.messageLog.update({
          where: { id: messageLog.id },
          data: {
            deliveryStatus: sendResult.success ? 'sent' : 'failed',
            deliveryError: sendResult.error || null,
            deliveryAttempts: sendResult.attempts,
            providerMessageId: providerMessageId || null
          }
        });
        
        if (sendResult.success) {
          console.log(`[AI Worker] Event ${i+1} SUCCESS: messageId=${providerMessageId}, attempts=${sendResult.attempts}`);
          successCount++;
        } else {
          console.error(`[AI Worker] Event ${i+1} FAILED (${event.type}): ${sendResult.error}, attempts=${sendResult.attempts}`);
          failCount++;
        }
      }
      
      console.log(`[AI Worker] Meta Cloud COMPLETE: ${successCount}/${events.length} sent OK, ${failCount} failed, to=${cleanPhone}`);
    } else if (instance.instanceBackendId) {
      const backendId = instance.instanceBackendId;
      
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
              source: 'ai_worker',
              provider: 'BAILEYS',
              agentVersion: business.agentVersion || 'v1',
              type: event.type,
              ...(event.type !== 'text' && { mediaType: event.type, filename: event.filename })
            }
          }
        });
        
        let sendResult: { success: boolean; result?: any; error?: string; attempts: number };
        
        if (event.type === 'text' && event.text) {
          sendResult = await sendWithRetry(() => axios.post(`${WA_API_URL}/instances/${backendId}/sendMessage`, {
            to: phone,
            message: event.text
          }, { timeout: 30000 }), 3, 1000);
        } else if (event.type === 'image' && event.url) {
          sendResult = await sendWithRetry(() => axios.post(`${WA_API_URL}/instances/${backendId}/sendImage`, {
            to: phone,
            url: event.url,
            caption: event.caption
          }, { timeout: 30000 }), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'image', url: event.url });
        } else if (event.type === 'video' && event.url) {
          sendResult = await sendWithRetry(() => axios.post(`${WA_API_URL}/instances/${backendId}/sendVideo`, {
            to: phone,
            url: event.url,
            caption: event.caption
          }, { timeout: 30000 }), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'video', url: event.url });
        } else if (event.type === 'audio' && event.url) {
          sendResult = await sendWithRetry(() => axios.post(`${WA_API_URL}/instances/${backendId}/sendAudio`, {
            to: phone,
            url: event.url
          }, { timeout: 30000 }), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'audio', url: event.url });
        } else if (event.type === 'document' && event.url) {
          sendResult = await sendWithRetry(() => axios.post(`${WA_API_URL}/instances/${backendId}/sendFile`, {
            to: phone,
            url: event.url,
            caption: event.caption,
            filename: event.filename
          }, { timeout: 30000 }), 3, 1000);
          if (sendResult.success) sentMedia.push({ type: 'document', url: event.url });
        } else {
          sendResult = { success: false, error: 'Unknown event type', attempts: 0 };
        }
        
        await prisma.messageLog.update({
          where: { id: messageLog.id },
          data: {
            deliveryStatus: sendResult.success ? 'sent' : 'failed',
            deliveryError: sendResult.error || null,
            deliveryAttempts: sendResult.attempts
          }
        });
        
        if (!sendResult.success) {
          console.error(`[AI Worker] Baileys event FAILED (${event.type}): ${sendResult.error}`);
        }
      }
      
      console.log(`[AI Worker] Baileys: sent ${events.length} events to ${cleanPhone}`);
    } else {
      console.error(`[AI Worker] No valid send method for instance ${instanceId}, provider=${instance.provider}, hasBackendId=${!!instance.instanceBackendId}, hasMetaCred=${!!metaCredential}, hasCoexistCred=${!!coexistCredential}`);
      return;
    }
    
    // Schedule follow-up after sending response
    await scheduleFollowUp(business.id, cleanPhone, 'ai', instance?.id);
    
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
  
  if (business.agentVersion === 'v2') {
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
