import { Worker, Job } from 'bullmq';
import { AIResponseJobData, QUEUE_NAMES, getQueueConnection, getAIResponseQueue } from './index.js';
import prisma from '../prisma.js';
import { isOpenAIConfigured, callOpenAI, getModelForAgent, ChatMessage, logTokenUsage, checkUserTokenLimit } from '../openaiService.js';
import { replacePromptVariables } from '../promptVariables.js';
import { generateWithAgentV2, buildBusinessContext, buildConversationHistory, isAgentV2Available } from '../agentV2Service.js';
import { searchProductsIntelligent } from '../productSearch.js';
import { parseAgentOutputToWhatsAppEvents, calculateTypingDelay, WhatsAppEvent } from '../agentOutputParser.js';
import { MetaCloudService } from '../metaCloud.js';
import { scheduleFollowUp } from '../followUpService.js';
import { analyzeAndUpdateLeadStage } from '../leadStageService.js';
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
      promptMaster: { include: { tools: { where: { enabled: true } } } },
      products: true,
      instances: { include: { metaCredential: true } },
      user: { select: { isPro: true, id: true, subscriptionStatus: true } }
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
  
  // Analyze and update lead stage after agent response (complete interaction cycle)
  if (result.response) {
    setImmediate(async () => {
      try {
        const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
        console.log(`[AI Worker] Updating lead stage after agent response for ${normalizedPhone}`);
        const stageResult = await analyzeAndUpdateLeadStage(businessId, normalizedPhone);
        if (stageResult.success) {
          console.log(`[AI Worker] Lead stage updated to "${stageResult.newStage}" (confidence: ${stageResult.confidence})`);
        }
      } catch (err: any) {
        console.error('[AI Worker] Post-response lead stage update failed:', err.message);
      }
    });
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
  
  // Get current lead stage for context
  const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
  const currentTagAssignment = await prisma.tagAssignment.findUnique({
    where: {
      businessId_contactPhone: {
        businessId: business.id,
        contactPhone: normalizedPhone
      }
    },
    include: { tag: true }
  });
  const currentLeadStage = currentTagAssignment?.tag?.name || null;
  
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
  
  // Get current lead stage for context
  const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
  const currentTagAssignment = await prisma.tagAssignment.findUnique({
    where: {
      businessId_contactPhone: {
        businessId: business.id,
        contactPhone: normalizedPhone
      }
    },
    include: { tag: true }
  });
  const currentLeadStage = currentTagAssignment?.tag?.name || null;
  
  const promptConfig = business.promptMaster;
  const historyLimit = promptConfig?.historyLimit || 10;
  const userTools = promptConfig?.tools || [];
  
  let systemPrompt = promptConfig?.prompt || 'Eres un asistente de atención al cliente amable y profesional.';
  
  const businessObjective = business.businessObjective || 'SALES';
  
  if (businessObjective === 'APPOINTMENTS') {
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
  
  if (productCount > 20) {
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
  if (businessObjective === 'APPOINTMENTS') {
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
    
    openaiTools.push({
      type: 'function',
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
              description: 'Nombre del cliente'
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
            }
          },
          required: ['fecha_hora', 'nombre_cliente']
        }
      }
    });
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
  
  const { getOpenAIClient, logTokenUsage: logTokens } = await import('../openaiService.js');
  const openai = getOpenAIClient();
  
  const chatParams: any = {
    model: modelConfig.model,
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
        
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(searchResult.products.map((p: any) => ({
            id: p.id,
            title: p.title,
            price: `${currencySymbol}${p.price}`,
            stock: p.stock,
            description: p.description?.substring(0, 100)
          })))
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
        const nombreCliente = args.nombre_cliente;
        const servicio = args.servicio || '';
        const duracion = args.duracion_minutos || 60;
        const notas = args.notas || '';
        
        console.log(`[AI Worker] Scheduling appointment for ${fechaHora}, client: ${nombreCliente}`);
        
        try {
          const response = await axios.post(
            `${process.env.CORE_API_URL || 'http://localhost:3001'}/appointments/internal/schedule`,
            {
              businessId: business.id,
              dateTime: fechaHora,
              clientName: nombreCliente,
              clientPhone: contactPhone.replace(/\D/g, ''),
              service: servicio,
              durationMinutes: duracion,
              notes: notas
            },
            {
              headers: { 'X-Internal-Secret': process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me' }
            }
          );
          
          if (response.data.success) {
            const apt = response.data.appointment;
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Cita agendada exitosamente:\n- Fecha: ${apt.date}\n- Hora: ${apt.time}\n- Cliente: ${nombreCliente}\n- Servicio: ${servicio || 'General'}`
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
      }
    }
    
    chatParams.messages.push(...toolMessages);
    delete chatParams.tools;
    delete chatParams.tool_choice;
    
    completion = await openai.chat.completions.create(chatParams);
    totalTokens += completion.usage?.total_tokens || 0;
  }
  
  const aiResponse = completion.choices[0]?.message?.content || '';
  
  await logTokens({
    businessId: business.id,
    userId: business.userId,
    feature: 'agent_v1_worker',
    model: modelConfig.model,
    promptTokens: Math.floor(totalTokens * 0.7),
    completionTokens: Math.floor(totalTokens * 0.3),
    totalTokens
  }).catch(err => console.error('[AI Worker] Token logging failed:', err.message));
  
  if (instanceId && aiResponse) {
    await sendWhatsAppResponse(instanceId, phone, aiResponse, business);
  }
  
  return { response: aiResponse, tokensUsed: totalTokens };
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
      user: { select: { isPro: true, id: true, subscriptionStatus: true } }
    }
  });
  
  if (!business) {
    throw new Error(`Business ${businessId} not found`);
  }
  
  if (!business.botEnabled) {
    return { response: '' };
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
      try {
        const normalizedPhone = contactPhone.replace(/\D/g, '').replace(/:.*$/, '');
        console.log(`[AI Direct] Updating lead stage after agent response for ${normalizedPhone}`);
        const stageResult = await analyzeAndUpdateLeadStage(businessId, normalizedPhone);
        if (stageResult.success) {
          console.log(`[AI Direct] Lead stage updated to "${stageResult.newStage}" (confidence: ${stageResult.confidence})`);
        }
      } catch (err: any) {
        console.error('[AI Direct] Post-response lead stage update failed:', err.message);
      }
    });
  }
  
  return result;
}
