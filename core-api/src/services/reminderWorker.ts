import prisma from './prisma.js';
import axios from 'axios';
import { MetaCloudService } from './metaCloud.js';
import { isOpenAIConfigured, callOpenAI, getModelForAgent, ChatMessage } from './openaiService.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

function cleanMarkdownForWhatsApp(text: string): string {
  let cleaned = text;
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

async function getActiveInstance(businessId: string) {
  // First try: active and connected
  const connectedInstance = await prisma.whatsAppInstance.findFirst({
    where: { 
      businessId,
      isActive: true,
      status: 'connected'
    },
    include: { metaCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (connectedInstance) return connectedInstance;
  
  // Second try: just active
  const activeInstance = await prisma.whatsAppInstance.findFirst({
    where: { 
      businessId,
      isActive: true
    },
    include: { metaCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (activeInstance) return activeInstance;
  
  // Third try: any instance for this business (regardless of isActive/status)
  const anyInstance = await prisma.whatsAppInstance.findFirst({
    where: { businessId },
    include: { metaCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (anyInstance) {
    console.log(`[REMINDER] Found instance ${anyInstance.id} for business ${businessId} (isActive=${anyInstance.isActive}, status=${anyInstance.status})`);
    return anyInstance;
  }
  
  // Final fallback: query WhatsApp API directly for Baileys instances
  try {
    const response = await axios.get(`${WA_API_URL}/instances`, { timeout: 5000 });
    const rawData = response.data?.instances || response.data;
    const instances = Array.isArray(rawData) ? rawData : [];
    
    // Find instance that matches this business (by backendId pattern)
    const businessPrefix = `biz_${businessId.substring(0, 8)}`;
    const waInstance = instances.find((inst: any) => 
      inst.id?.startsWith(businessPrefix) || inst.businessId === businessId
    );
    
    if (waInstance && waInstance.status === 'connected') {
      console.log(`[REMINDER] Found Baileys instance from WA API: ${waInstance.id} for business ${businessId}`);
      return {
        id: waInstance.id,
        businessId,
        provider: 'BAILEYS',
        instanceBackendId: waInstance.id,
        status: waInstance.status,
        isActive: true,
        metaCredential: null
      };
    }
  } catch (err: any) {
    console.log(`[REMINDER] Could not query WhatsApp API for instances: ${err.message}`);
  }
  
  return null;
}

async function checkWindowStatus(businessId: string, contactPhone: string): Promise<{
  requiresTemplate: boolean;
  provider: string | null;
  hoursSinceLastMessage: number | null;
}> {
  const instance = await getActiveInstance(businessId);
  
  if (!instance) {
    console.log(`[REMINDER] No active instance found for business ${businessId}`);
    return { requiresTemplate: false, provider: null, hoursSinceLastMessage: null };
  }
  
  if (instance.provider !== 'META_CLOUD') {
    return { requiresTemplate: false, provider: instance.provider, hoursSinceLastMessage: null };
  }
  
  const lastInboundMessage = await prisma.messageLog.findFirst({
    where: {
      businessId,
      sender: contactPhone,
      direction: 'inbound'
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!lastInboundMessage) {
    return { requiresTemplate: true, provider: 'META_CLOUD', hoursSinceLastMessage: null };
  }
  
  const hoursSinceLastMessage = (Date.now() - lastInboundMessage.createdAt.getTime()) / (1000 * 60 * 60);
  const requiresTemplate = hoursSinceLastMessage >= 24;
  
  return { requiresTemplate, provider: 'META_CLOUD', hoursSinceLastMessage };
}

interface TemplateData {
  name: string;
  language: string;
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters?: Array<{ type: string; text?: string }>;
  }>;
  bodyText?: string;
}

async function getDefaultTemplate(businessId: string): Promise<TemplateData | null> {
  const instance = await getActiveInstance(businessId);
  
  if (!instance || instance.provider !== 'META_CLOUD' || !instance.metaCredential) {
    console.log(`[REMINDER] No Meta Cloud instance with credentials for business ${businessId}`);
    return null;
  }
  
  const template = await prisma.metaTemplate.findFirst({
    where: { 
      credentialId: instance.metaCredential.id,
      status: 'APPROVED',
      category: { in: ['MARKETING', 'UTILITY'] }
    },
    orderBy: [{ category: 'asc' }, { updatedAt: 'desc' }]
  });
  
  if (!template) return null;
  
  let components: TemplateData['components'] = undefined;
  
  if (template.components) {
    let storedComponents: any[];
    
    if (typeof template.components === 'string') {
      try {
        storedComponents = JSON.parse(template.components);
      } catch {
        storedComponents = [];
      }
    } else if (Array.isArray(template.components)) {
      storedComponents = template.components;
    } else {
      storedComponents = [];
    }
    
    const parsedComponents: TemplateData['components'] = [];
    
    for (const comp of storedComponents) {
      const compType = comp.type?.toUpperCase();
      
      if (compType === 'HEADER' && comp.format === 'TEXT' && comp.text) {
        const matches = comp.text.match(/\{\{(\d+)\}\}/g) || [];
        if (matches.length > 0) {
          parsedComponents.push({
            type: 'header',
            parameters: matches.map(() => ({ type: 'text', text: 'Estimado cliente' }))
          });
        }
      } else if (compType === 'BODY' && comp.text) {
        const matches = comp.text.match(/\{\{(\d+)\}\}/g) || [];
        if (matches.length > 0) {
          parsedComponents.push({
            type: 'body',
            parameters: matches.map(() => ({ type: 'text', text: 'Cliente' }))
          });
        }
      }
    }
    
    if (parsedComponents.length > 0) {
      components = parsedComponents;
    }
  }
  
  return { 
    name: template.name, 
    language: template.language,
    components: components && components.length > 0 ? components : undefined,
    bodyText: template.bodyText || undefined
  };
}

async function generateFollowUpMessage(
  businessId: string,
  contactPhone: string,
  attemptNumber: number,
  pressureLevel: number
): Promise<string> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { promptMaster: true }
  });
  
  if (!business || !isOpenAIConfigured()) {
    const templates = [
      'Hola! Solo queria dar seguimiento a nuestra conversacion anterior. Tienes alguna pregunta?',
      'Hola! Me gustaria saber si pudiste revisar la informacion que te envie. Estoy aqui para ayudarte.',
      'Hola! Espero que estes bien. Solo queria recordarte que estamos disponibles si necesitas algo.'
    ];
    return templates[Math.min(attemptNumber - 1, templates.length - 1)];
  }
  
  // Fetch enriched contact context
  const [recentMessages, contact, pendingOrders, totalMessageCount] = await Promise.all([
    prisma.messageLog.findMany({
      where: {
        businessId,
        OR: [{ sender: contactPhone }, { recipient: contactPhone }]
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    }),
    prisma.contact.findFirst({
      where: { businessId, phone: contactPhone },
      include: { tags: { include: { tag: true } } }
    }),
    prisma.order.count({
      where: {
        businessId,
        customerPhone: contactPhone,
        status: { in: ['pending', 'confirmed'] }
      }
    }),
    prisma.messageLog.count({
      where: {
        businessId,
        OR: [{ sender: contactPhone }, { recipient: contactPhone }]
      }
    })
  ]);
  
  const conversationContext = recentMessages
    .reverse()
    .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.message}`)
    .join('\n');
  
  // Build enriched context
  const contactContext: string[] = [];
  
  if (contact) {
    if (contact.leadStage) {
      contactContext.push(`Etapa del lead: ${contact.leadStage}`);
    }
    if (contact.tags && contact.tags.length > 0) {
      const tagNames = contact.tags.map(t => t.tag?.name).filter(Boolean);
      if (tagNames.length > 0) {
        contactContext.push(`Tags: ${tagNames.join(', ')}`);
      }
    }
    if (contact.notes) {
      contactContext.push(`Notas: ${contact.notes.substring(0, 100)}`);
    }
  }
  
  if (pendingOrders > 0) {
    contactContext.push(`Tiene ${pendingOrders} pedido(s) pendiente(s)`);
  }
  
  contactContext.push(`Total de mensajes intercambiados: ${totalMessageCount}`);
  
  // Determine engagement level
  let engagementLevel = 'nuevo';
  if (totalMessageCount > 50) engagementLevel = 'cliente frecuente';
  else if (totalMessageCount > 20) engagementLevel = 'cliente regular';
  else if (totalMessageCount > 5) engagementLevel = 'cliente en desarrollo';
  
  contactContext.push(`Nivel de engagement: ${engagementLevel}`);
  
  const pressureDescriptions = [
    'muy sutil y amigable, solo un recordatorio casual',
    'amigable pero mostrando interes genuino en ayudar',
    'directo y profesional, enfatizando el valor de la oferta',
    'con sentido de urgencia moderado',
    'enfatizando escasez u oportunidad limitada'
  ];
  
  const pressureDesc = pressureDescriptions[Math.min(pressureLevel - 1, 4)];
  
  const modelConfig = await getModelForAgent('v1', business.openaiModel);
  
  const enrichedContext = contactContext.length > 0 
    ? `\n\nContexto del cliente:\n${contactContext.join('\n')}`
    : '';
  
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Eres un asistente de ventas de ${business.name}. 
Genera un mensaje de seguimiento corto (1-2 oraciones) para un cliente que no ha respondido.
Este es el intento #${attemptNumber} de contacto.
El tono debe ser: ${pressureDesc}.
El mensaje debe continuar naturalmente la conversacion anterior.
Adapta tu enfoque segun el contexto del cliente (etapa del lead, nivel de engagement, pedidos pendientes).
NO uses saludos largos. NO uses emojis. Maximo 50 palabras.`
    },
    {
      role: 'user',
      content: `Conversacion reciente:\n${conversationContext || 'Sin mensajes previos'}${enrichedContext}\n\nGenera el mensaje de seguimiento:`
    }
  ];
  
  const result = await callOpenAI({
    model: modelConfig.model,
    messages,
    reasoningEffort: modelConfig.reasoningEffort,
    maxTokens: 150,
    temperature: 0.7,
    maxHistoryTokens: 1000,
    context: {
      businessId,
      userId: business.userId,
      feature: 'follow_up'
    }
  });
  
  return result.content || 'Hola! Tienes alguna pregunta?';
}

async function isWithinAllowedHours(config: any, timezone: string = 'America/Lima'): Promise<boolean> {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short'
  });
  
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  
  if (!config.weekendsEnabled && isWeekend) {
    return false;
  }
  
  return hour >= config.allowedStartHour && hour < config.allowedEndHour;
}

async function getTodayAttemptCount(businessId: string, contactPhone: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  return prisma.reminder.count({
    where: {
      businessId,
      contactPhone,
      status: 'executed',
      executedAt: { gte: today }
    }
  });
}

const MAX_RETRY_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 120000; // 2 minutes

export async function processReminders(): Promise<void> {
  const now = new Date();
  const processingTimeout = new Date(now.getTime() - PROCESSING_TIMEOUT_MS);
  
  // Find reminders that are:
  // 1. Pending and due (scheduledAt <= now)
  // 2. Not being processed by another worker (processingAt is null OR timed out)
  // 3. Ordered by scheduledAt ASC (most urgent first)
  const pendingReminders = await prisma.reminder.findMany({
    where: {
      status: 'pending',
      scheduledAt: { lte: now },
      OR: [
        { processingAt: null },
        { processingAt: { lt: processingTimeout } }
      ]
    },
    include: {
      business: {
        include: {
          instances: true,
          followUpConfig: true
        }
      }
    },
    orderBy: { scheduledAt: 'asc' },
    take: 50
  });
  
  if (pendingReminders.length > 0) {
    console.log(`[REMINDER] Found ${pendingReminders.length} pending reminders to process`);
  }
  
  for (const reminder of pendingReminders) {
    // Use fresh timestamp for each reminder claim to prevent timeout during long processing
    const claimTime = new Date();
    const claimTimeout = new Date(claimTime.getTime() - PROCESSING_TIMEOUT_MS);
    
    // Claim this reminder by setting processingAt (atomic operation to prevent duplicates)
    const claimed = await prisma.reminder.updateMany({
      where: {
        id: reminder.id,
        status: 'pending',
        OR: [
          { processingAt: null },
          { processingAt: { lt: claimTimeout } }
        ]
      },
      data: { processingAt: claimTime }
    });
    
    // If we couldn't claim it, another worker got it first
    if (claimed.count === 0) {
      console.log(`[REMINDER] Reminder ${reminder.id} already claimed by another worker`);
      continue;
    }
    
    try {
      // Fetch fresh reminder data after claiming (for accurate retryCount)
      const freshReminder = await prisma.reminder.findUnique({
        where: { id: reminder.id }
      });
      if (!freshReminder) continue;
      
      const config = reminder.business.followUpConfig;
      
      if (config && !config.enabled && reminder.type === 'auto') {
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'skipped', processingAt: null }
        });
        continue;
      }
      
      const businessTimezone = reminder.business.timezone || 'America/Lima';
      
      if (config && !(await isWithinAllowedHours(config, businessTimezone))) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(config.allowedStartHour, 0, 0, 0);
        
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { scheduledAt: tomorrow, processingAt: null }
        });
        console.log(`[REMINDER] Rescheduled ${reminder.id} to ${tomorrow.toISOString()} (outside allowed hours)`);
        continue;
      }
      
      if (config) {
        const todayAttempts = await getTodayAttemptCount(reminder.businessId, reminder.contactPhone);
        if (todayAttempts >= config.maxDailyAttempts) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'max_daily_reached', processingAt: null }
          });
          continue;
        }
      }
      
      const instance = await getActiveInstance(reminder.businessId);
      if (!instance) {
        // Release lock and reschedule for later retry
        const retryAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { scheduledAt: retryAt, processingAt: null }
        });
        console.log(`[REMINDER] No active WhatsApp instance for business ${reminder.businessId} - rescheduled ${reminder.id} for ${retryAt.toISOString()}`);
        continue;
      }
      
      console.log(`[REMINDER] Processing reminder ${reminder.id} for ${reminder.contactPhone} via ${instance.provider} (instance: ${instance.id})`);
      
      const windowStatus = await checkWindowStatus(reminder.businessId, reminder.contactPhone);
      
      let message = reminder.messageTemplate || reminder.generatedMessage;
      let usedTemplate: TemplateData | null = null;
      
      console.log(`[REMINDER] Window status for ${reminder.contactPhone}: requiresTemplate=${windowStatus.requiresTemplate}, provider=${windowStatus.provider}, hours=${windowStatus.hoursSinceLastMessage}`);
      
      if (windowStatus.requiresTemplate && windowStatus.provider === 'META_CLOUD') {
        const templateData = await getDefaultTemplate(reminder.businessId);
        if (!templateData) {
          console.log(`[REMINDER] No approved template for Meta Cloud business ${reminder.businessId} - cannot send reminder outside 24h window`);
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'no_template', processingAt: null }
          });
          continue;
        }
        usedTemplate = templateData;
        message = templateData.bodyText || `[Template: ${templateData.name}]`;
        console.log(`[REMINDER] Using template: ${templateData.name}`);
      } else if (!message) {
        message = await generateFollowUpMessage(
          reminder.businessId,
          reminder.contactPhone,
          reminder.attemptNumber,
          config?.pressureLevel || 1
        );
        console.log(`[REMINDER] Generated follow-up message for attempt #${reminder.attemptNumber}`);
      }
      
      const cleanPhone = reminder.contactPhone.replace(/\D/g, '');
      
      if (instance.provider === 'META_CLOUD') {
        const metaCred = instance.metaCredential || await prisma.metaCredential.findFirst({
          where: { instanceId: instance.id }
        });
        
        if (!metaCred) {
          console.log(`[REMINDER] No Meta credentials for instance ${instance.id} - rescheduling`);
          const retryAt = new Date(Date.now() + 15 * 60 * 1000);
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { scheduledAt: retryAt, processingAt: null }
          });
          continue;
        }
        
        console.log(`[REMINDER] Sending via Meta Cloud to ${cleanPhone}`);
        
        const metaService = new MetaCloudService({
          accessToken: metaCred.accessToken,
          phoneNumberId: metaCred.phoneNumberId,
          businessId: metaCred.businessId
        });
        
        if (usedTemplate) {
          await metaService.sendTemplate({
            to: cleanPhone,
            templateName: usedTemplate.name,
            language: usedTemplate.language,
            components: usedTemplate.components
          });
          console.log(`[REMINDER] Template sent successfully to ${cleanPhone}`);
        } else {
          const cleanedMessage = cleanMarkdownForWhatsApp(message);
          await metaService.sendMessage({ to: cleanPhone, text: cleanedMessage });
          console.log(`[REMINDER] Message sent successfully to ${cleanPhone}`);
        }
      } else {
        if (!instance.instanceBackendId) {
          console.log(`[REMINDER] No Baileys backend ID for instance ${instance.id} - rescheduling`);
          const retryAt = new Date(Date.now() + 15 * 60 * 1000);
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { scheduledAt: retryAt, processingAt: null }
          });
          continue;
        }
        
        const cleanedMessage = cleanMarkdownForWhatsApp(message);
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`,
          message: cleanedMessage
        });
      }
      
      await prisma.messageLog.create({
        data: {
          businessId: reminder.businessId,
          instanceId: instance.id,
          direction: 'outbound',
          recipient: cleanPhone,
          message,
          metadata: {
            type: 'reminder',
            reminderId: reminder.id,
            attemptNumber: reminder.attemptNumber,
            provider: instance.provider,
            usedTemplate: usedTemplate?.name || null
          }
        }
      });
      
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: 'executed',
          executedAt: new Date(),
          processingAt: null,
          generatedMessage: message
        }
      });
      
      console.log(`[REMINDER] Executed: ${reminder.id} to ${cleanPhone} via ${instance.provider}${usedTemplate ? ` (template: ${usedTemplate.name})` : ''}${freshReminder.retryCount > 0 ? ` (after ${freshReminder.retryCount} retries)` : ''}`);
      
    } catch (error: any) {
      let errorMessage = error?.message || 'Unknown error';
      let metaErrorDetails = null;
      
      if (error?.response?.data) {
        metaErrorDetails = error.response.data;
        errorMessage = `Meta API Error: ${JSON.stringify(metaErrorDetails)}`;
      }
      
      // Use fresh data for retry count
      const latestReminder = await prisma.reminder.findUnique({ where: { id: reminder.id } });
      const currentRetryCount = latestReminder?.retryCount || 0;
      const shouldRetry = currentRetryCount < MAX_RETRY_ATTEMPTS;
      
      console.error(`[REMINDER] Failed to process reminder ${reminder.id} (retry ${currentRetryCount + 1}/${MAX_RETRY_ATTEMPTS}):`, {
        error: errorMessage,
        contactPhone: reminder.contactPhone,
        businessId: reminder.businessId,
        provider: reminder.business.instances[0]?.provider,
        metaError: metaErrorDetails,
        willRetry: shouldRetry
      });
      
      if (shouldRetry) {
        // Exponential backoff: 2min, 8min, 32min
        const retryDelayMs = Math.pow(4, currentRetryCount) * 2 * 60 * 1000;
        const nextRetryAt = new Date(Date.now() + retryDelayMs);
        
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { 
            retryCount: currentRetryCount + 1,
            lastError: errorMessage,
            processingAt: null,
            scheduledAt: nextRetryAt
          }
        });
        
        console.log(`[REMINDER] Scheduled retry for ${reminder.id} at ${nextRetryAt.toISOString()}`);
      } else {
        // Max retries reached, mark as failed
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { 
            status: 'failed',
            lastError: errorMessage,
            processingAt: null
          }
        });
        
        console.log(`[REMINDER] Max retries reached for ${reminder.id}, marked as failed`);
      }
    }
  }
}

// Note: getDelayForAttempt, getMaxAttempts, checkInactiveContacts removed
// Follow-ups are now scheduled event-driven via scheduleFollowUp() in followUpService.ts

let workerInterval: NodeJS.Timeout | null = null;

export interface ReminderStats {
  pending: number;
  executed: number;
  failed: number;
  skipped: number;
  stuckProcessing: number;
  scheduledToday: number;
  executedToday: number;
  failedToday: number;
  retryPending: number;
}

export async function getReminderStats(): Promise<ReminderStats> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const processingTimeout = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
  
  const [pending, executed, failed, skipped, stuckProcessing, scheduledToday, executedToday, failedToday, retryPending] = await Promise.all([
    prisma.reminder.count({ where: { status: 'pending' } }),
    prisma.reminder.count({ where: { status: 'executed' } }),
    prisma.reminder.count({ where: { status: 'failed' } }),
    prisma.reminder.count({ where: { status: 'skipped' } }),
    prisma.reminder.count({
      where: {
        status: 'pending',
        processingAt: { lt: processingTimeout, not: null }
      }
    }),
    prisma.reminder.count({
      where: { scheduledAt: { gte: today } }
    }),
    prisma.reminder.count({
      where: { status: 'executed', executedAt: { gte: today } }
    }),
    prisma.reminder.count({
      where: { status: 'failed', createdAt: { gte: today } }
    }),
    prisma.reminder.count({
      where: { status: 'pending', retryCount: { gt: 0 } }
    })
  ]);
  
  return { pending, executed, failed, skipped, stuckProcessing, scheduledToday, executedToday, failedToday, retryPending };
}

export async function getFailedRemindersDetails(limit: number = 20) {
  return prisma.reminder.findMany({
    where: { status: 'failed' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      contactPhone: true,
      contactName: true,
      attemptNumber: true,
      retryCount: true,
      lastError: true,
      scheduledAt: true,
      createdAt: true,
      business: { select: { name: true } }
    }
  });
}

export async function retryFailedReminder(reminderId: string): Promise<boolean> {
  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId }
  });
  
  if (!reminder || reminder.status !== 'failed') {
    return false;
  }
  
  await prisma.reminder.update({
    where: { id: reminderId },
    data: {
      status: 'pending',
      retryCount: 0,
      lastError: null,
      processingAt: null,
      scheduledAt: new Date()
    }
  });
  
  console.log(`[REMINDER] Manually retrying failed reminder ${reminderId}`);
  return true;
}

export function startReminderWorker(): void {
  console.log('[REMINDER] Starting worker (event-driven mode)...');
  
  workerInterval = setInterval(async () => {
    const startTime = Date.now();
    try {
      await processReminders();
      const duration = Date.now() - startTime;
      if (duration > 5000) {
        console.log(`[REMINDER] Worker cycle completed in ${duration}ms`);
      }
    } catch (error) {
      console.error('[REMINDER] Worker error:', error);
    }
  }, 60000);
  
  setTimeout(async () => {
    try {
      await processReminders();
      const stats = await getReminderStats();
      console.log(`[REMINDER] Initial check complete. Stats: pending=${stats.pending}, executed=${stats.executed}, failed=${stats.failed}, retryPending=${stats.retryPending}`);
    } catch (error) {
      console.error('[REMINDER] Initial check error:', error);
    }
  }, 5000);
}

export function stopReminderWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[REMINDER] Worker stopped');
  }
}
