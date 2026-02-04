import { Worker, Job } from 'bullmq';
import { ReminderJobData, QUEUE_NAMES, getReminderQueue, getQueueConnection } from './index.js';
import prisma from '../prisma.js';
import axios from 'axios';
import { MetaCloudService } from '../metaCloud.js';
import { isOpenAIConfigured, callOpenAI, getModelForAgent, ChatMessage } from '../openaiService.js';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { getDay, getHours, setHours, setMinutes, setSeconds, setMilliseconds, addDays } from 'date-fns';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

interface TemplateData {
  name: string;
  language: string;
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters?: Array<{ type: string; text?: string }>;
  }>;
  bodyText?: string;
}

async function checkWindowStatus(businessId: string, contactPhone: string): Promise<{
  requiresTemplate: boolean;
  provider: string | null;
  hoursSinceLastMessage: number | null;
}> {
  const instance = await prisma.whatsAppInstance.findFirst({
    where: { businessId },
    include: { metaCredential: true, metaCoexistCredential: true }
  });
  
  // Both META_CLOUD and META_COEXIST use Meta Graph API and require templates outside 24h window
  if (!instance || (instance.provider !== 'META_CLOUD' && instance.provider !== 'META_COEXIST')) {
    return { requiresTemplate: false, provider: instance?.provider || null, hoursSinceLastMessage: null };
  }
  
  const cleanPhone = contactPhone.replace(/\D/g, '');
  
  const lastInboundMessage = await prisma.messageLog.findFirst({
    where: {
      businessId,
      sender: cleanPhone,
      direction: 'inbound'
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!lastInboundMessage) {
    console.log(`[REMINDER] No inbound message found for ${cleanPhone} - requiresTemplate=true`);
    return { requiresTemplate: true, provider: instance.provider, hoursSinceLastMessage: null };
  }
  
  const hoursSinceLastMessage = (Date.now() - lastInboundMessage.createdAt.getTime()) / (1000 * 60 * 60);
  const requiresTemplate = hoursSinceLastMessage >= 24;
  
  console.log(`[REMINDER] Window check for ${cleanPhone}: ${hoursSinceLastMessage.toFixed(2)}h since last inbound, requiresTemplate=${requiresTemplate}`);
  
  return { requiresTemplate, provider: instance.provider, hoursSinceLastMessage };
}

async function getDefaultTemplate(businessId: string): Promise<TemplateData | null> {
  const instance = await prisma.whatsAppInstance.findFirst({
    where: { businessId, provider: { in: ['META_CLOUD', 'META_COEXIST'] } },
    include: { metaCredential: true, metaCoexistCredential: true }
  });
  
  // Check for credentials from either provider
  const credential = instance?.metaCredential || instance?.metaCoexistCredential;
  if (!instance || !credential) return null;
  
  // For templates, we need metaCredential (templates are stored per metaCredential)
  // Note: META_COEXIST might share templates with META_CLOUD credential if linked
  const credentialId = instance.metaCredential?.id;
  if (!credentialId) return null;
  
  const template = await prisma.metaTemplate.findFirst({
    where: { 
      credentialId,
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
    include: { agentPrompts: true }
  });
  
  if (!business || !isOpenAIConfigured()) {
    const templates = [
      'Hola! Solo queria dar seguimiento a nuestra conversacion anterior. Tienes alguna pregunta?',
      'Hola! Me gustaria saber si pudiste revisar la informacion que te envie. Estoy aqui para ayudarte.',
      'Hola! Espero que estes bien. Solo queria recordarte que estamos disponibles si necesitas algo.'
    ];
    return templates[Math.min(attemptNumber - 1, templates.length - 1)];
  }
  
  const recentMessages = await prisma.messageLog.findMany({
    where: {
      businessId,
      OR: [{ sender: contactPhone }, { recipient: contactPhone }]
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  
  const conversationContext = recentMessages
    .reverse()
    .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.message}`)
    .join('\n');
  
  const pressureDescriptions = [
    'muy sutil y amigable, solo un recordatorio casual',
    'amigable pero mostrando interes genuino en ayudar',
    'directo y profesional, enfatizando el valor de la oferta',
    'con sentido de urgencia moderado',
    'enfatizando escasez u oportunidad limitada'
  ];
  
  const pressureDesc = pressureDescriptions[Math.min(pressureLevel - 1, 4)];
  
  const modelConfig = await getModelForAgent('v1', business.openaiModel);
  
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Eres un asistente de ventas de ${business.name}. 
Genera un mensaje de seguimiento corto (1-2 oraciones) para un cliente que no ha respondido.
Este es el intento #${attemptNumber} de contacto.
El tono debe ser: ${pressureDesc}.
El mensaje debe continuar naturalmente la conversacion anterior.
NO uses saludos largos. NO uses emojis. Maximo 50 palabras.`
    },
    {
      role: 'user',
      content: `Conversacion reciente:\n${conversationContext || 'Sin mensajes previos'}\n\nGenera el mensaje de seguimiento:`
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
  const zonedNow = toZonedTime(now, timezone);
  const hour = getHours(zonedNow);
  const day = getDay(zonedNow);
  
  if (!config.weekendsEnabled && (day === 0 || day === 6)) {
    return false;
  }
  
  return hour >= config.allowedStartHour && hour < config.allowedEndHour;
}

function getNextAllowedTime(config: any, timezone: string = 'America/Lima'): Date {
  const now = new Date();
  let zonedNow = toZonedTime(now, timezone);
  const hour = getHours(zonedNow);
  const day = getDay(zonedNow);
  const isWeekend = day === 0 || day === 6;
  
  if (!config.weekendsEnabled && isWeekend) {
    const daysUntilMonday = day === 0 ? 1 : 2;
    let adjustedZoned = addDays(zonedNow, daysUntilMonday);
    adjustedZoned = setHours(adjustedZoned, config.allowedStartHour);
    adjustedZoned = setMinutes(adjustedZoned, 0);
    adjustedZoned = setSeconds(adjustedZoned, 0);
    adjustedZoned = setMilliseconds(adjustedZoned, 0);
    return fromZonedTime(adjustedZoned, timezone);
  }
  
  if (hour < config.allowedStartHour) {
    let adjustedZoned = setHours(zonedNow, config.allowedStartHour);
    adjustedZoned = setMinutes(adjustedZoned, 0);
    adjustedZoned = setSeconds(adjustedZoned, 0);
    adjustedZoned = setMilliseconds(adjustedZoned, 0);
    return fromZonedTime(adjustedZoned, timezone);
  }
  
  if (hour >= config.allowedEndHour) {
    let adjustedZoned = addDays(zonedNow, 1);
    adjustedZoned = setHours(adjustedZoned, config.allowedStartHour);
    adjustedZoned = setMinutes(adjustedZoned, 0);
    adjustedZoned = setSeconds(adjustedZoned, 0);
    adjustedZoned = setMilliseconds(adjustedZoned, 0);
    return fromZonedTime(adjustedZoned, timezone);
  }
  
  return now;
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

async function processReminderJob(job: Job<ReminderJobData>): Promise<void> {
  const { reminderId, businessId, contactPhone, attemptNumber } = job.data;
  
  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId },
    include: {
      business: {
        include: {
          instances: true,
          followUpConfigs: true
        }
      }
    }
  });
  
  if (!reminder || reminder.status !== 'pending') {
    console.log(`Reminder ${reminderId} not found or not pending, skipping`);
    return;
  }
  
  // CRITICAL: Check if bot is globally disabled for this business
  if (!reminder.business.botEnabled) {
    console.log(`[REMINDER] Skipping ${reminderId} - business botEnabled=false`);
    await prisma.reminder.update({
      where: { id: reminderId },
      data: { status: 'skipped' }
    });
    return;
  }
  
  const config = reminder.business.followUpConfigs?.find((c: any) => 
    c.instanceId === reminder.instanceId || !c.instanceId
  ) || reminder.business.followUpConfigs?.[0];
  
  // Skip ALL auto reminders when follow-up config is disabled (not just type='auto')
  if (config && !config.enabled) {
    console.log(`[REMINDER] Skipping ${reminderId} - followUpConfig.enabled=false`);
    await prisma.reminder.update({
      where: { id: reminderId },
      data: { status: 'skipped' }
    });
    return;
  }
  
  const businessTimezone = reminder.business.timezone || 'America/Lima';
  
  if (config && !(await isWithinAllowedHours(config, businessTimezone))) {
    const nextAllowed = getNextAllowedTime(config, businessTimezone);
    
    await prisma.reminder.update({
      where: { id: reminderId },
      data: { scheduledAt: nextAllowed }
    });
    
    const queue = getReminderQueue();
    if (queue) {
      await queue.add(
        `reminder-${reminderId}`,
        job.data,
        { delay: Math.max(0, nextAllowed.getTime() - Date.now()) }
      );
    }
    console.log(`[REMINDER] Rescheduled ${reminderId} to ${nextAllowed.toISOString()} (outside allowed hours in ${businessTimezone})`);
    return;
  }
  
  if (config) {
    const todayAttempts = await getTodayAttemptCount(businessId, contactPhone);
    if (todayAttempts >= config.maxDailyAttempts) {
      await prisma.reminder.update({
        where: { id: reminderId },
        data: { status: 'max_daily_reached' }
      });
      return;
    }
  }
  
  // Use the specific instance from the reminder, or fall back to the first connected instance
  let instance = reminder.instanceId 
    ? reminder.business.instances.find((i: any) => i.id === reminder.instanceId)
    : reminder.business.instances.find((i: any) => i.status === 'CONNECTED') || reminder.business.instances[0];
  
  if (!instance) {
    console.log(`No WhatsApp instance for business ${businessId} (reminderInstanceId: ${reminder.instanceId})`);
    throw new Error(`No WhatsApp instance for business ${businessId}`);
  }
  
  console.log(`[REMINDER] Using instance ${instance.id} (${instance.name || instance.phoneNumber}) for reminder ${reminderId}`);
  
  const windowStatus = await checkWindowStatus(businessId, contactPhone);
  
  let message = reminder.messageTemplate || reminder.generatedMessage;
  let usedTemplate: TemplateData | null = null;
  
  if (windowStatus.requiresTemplate && (windowStatus.provider === 'META_CLOUD' || windowStatus.provider === 'META_COEXIST')) {
    const templateData = await getDefaultTemplate(businessId);
    if (!templateData) {
      console.log(`No approved template for Meta Cloud business ${businessId}`);
      await prisma.reminder.update({
        where: { id: reminderId },
        data: { status: 'no_template' }
      });
      return;
    }
    usedTemplate = templateData;
    message = templateData.bodyText || `[Template: ${templateData.name}]`;
  } else if (!message) {
    let pressureLevel = config?.pressureLevel || 1;
    
    if (config && Array.isArray(config.followUpSteps)) {
      const stepIndex = attemptNumber - 1;
      const step = (config.followUpSteps as any[])[stepIndex];
      if (step && typeof step.pressureLevel === 'number') {
        pressureLevel = step.pressureLevel;
      }
    }
    
    message = await generateFollowUpMessage(
      businessId,
      contactPhone,
      attemptNumber,
      pressureLevel
    );
  }
  
  const cleanPhone = contactPhone.replace(/\D/g, '');
  
  // Handle Meta Cloud API (both META_CLOUD and META_COEXIST)
  if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
    let accessToken: string;
    let phoneNumberId: string;
    let businessId: string;
    
    if (instance.provider === 'META_COEXIST') {
      const coexistCred = await prisma.metaCoexistCredential.findFirst({
        where: { instanceId: instance.id }
      });
      if (!coexistCred) {
        throw new Error(`No Meta Coexist credentials for instance ${instance.id}`);
      }
      accessToken = coexistCred.systemAccessToken || coexistCred.userAccessToken;
      phoneNumberId = coexistCred.phoneNumberId;
      businessId = coexistCred.metaBusinessId;
    } else {
      const metaCred = await prisma.metaCredential.findFirst({
        where: { instanceId: instance.id }
      });
      if (!metaCred) {
        throw new Error(`No Meta Cloud credentials for instance ${instance.id}`);
      }
      accessToken = metaCred.accessToken;
      phoneNumberId = metaCred.phoneNumberId;
      businessId = metaCred.businessId;
    }
    
    const metaService = new MetaCloudService({
      accessToken,
      phoneNumberId,
      businessId
    });
    
    if (usedTemplate) {
      await metaService.sendTemplate({
        to: cleanPhone,
        templateName: usedTemplate.name,
        language: usedTemplate.language,
        components: usedTemplate.components
      });
    } else {
      await metaService.sendMessage({ to: cleanPhone, text: message });
    }
  } else {
    if (!instance.instanceBackendId) {
      throw new Error(`No Baileys backend ID for instance ${instance.id}`);
    }
    
    await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
      to: cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`,
      message
    });
  }
  
  await prisma.messageLog.create({
    data: {
      businessId,
      instanceId: instance.id,
      direction: 'outbound',
      recipient: cleanPhone,
      message,
      metadata: {
        type: 'reminder',
        reminderId,
        attemptNumber,
        provider: instance.provider,
        usedTemplate: usedTemplate?.name || null
      }
    }
  });
  
  await prisma.reminder.update({
    where: { id: reminderId },
    data: {
      status: 'executed',
      executedAt: new Date(),
      generatedMessage: message
    }
  });
  
  console.log(`Reminder executed: ${reminderId} to ${cleanPhone} via ${instance.provider}${usedTemplate ? ` (template: ${usedTemplate.name})` : ''}`);
}

let reminderWorker: Worker<ReminderJobData> | null = null;

export function startReminderWorker(): Worker<ReminderJobData> {
  if (reminderWorker) {
    return reminderWorker;
  }

  reminderWorker = new Worker<ReminderJobData>(
    QUEUE_NAMES.REMINDERS,
    async (job) => {
      try {
        // Handle the repeatable checker job
        if (job.name === 'reminder-checker') {
          const added = await checkAndSchedulePendingReminders();
          if (added > 0) {
            console.log(`[REMINDER] Checker found and scheduled ${added} pending reminders`);
          }
          return;
        }
        
        // Handle regular reminder jobs
        await processReminderJob(job);
      } catch (error: any) {
        if (job.data.reminderId) {
          console.error(`Failed to process reminder ${job.data.reminderId}:`, error.message);
          
          await prisma.reminder.update({
            where: { id: job.data.reminderId },
            data: { status: 'failed' }
          });
        }
        
        throw error;
      }
    },
    {
      connection: getQueueConnection(),
      concurrency: 5,
      limiter: {
        max: 30,
        duration: 60000
      }
    }
  );

  reminderWorker.on('completed', (job) => {
    console.log(`Reminder job ${job.id} completed`);
  });

  reminderWorker.on('failed', (job, error) => {
    console.error(`Reminder job ${job?.id} failed:`, error.message);
  });

  console.log('Reminder worker started with BullMQ');
  return reminderWorker;
}

export async function stopReminderWorker(): Promise<void> {
  if (reminderWorker) {
    await reminderWorker.close();
    reminderWorker = null;
    console.log('Reminder worker stopped');
  }
}

export async function schedulePendingReminders(): Promise<void> {
  const queue = getReminderQueue();
  if (!queue) {
    console.log('Reminder queue not initialized, skipping pending reminders');
    return;
  }
  
  // Schedule immediate pending reminders
  await checkAndSchedulePendingReminders();
  
  // Add a repeatable job that checks for pending reminders every minute (backup mechanism)
  const existingRepeatable = await queue.getRepeatableJobs();
  const hasChecker = existingRepeatable.some(j => j.name === 'reminder-checker');
  
  if (!hasChecker) {
    await queue.add(
      'reminder-checker',
      { type: 'check' } as any,
      {
        repeat: {
          every: 60000 // Every 60 seconds
        },
        jobId: 'reminder-checker-repeatable'
      }
    );
    console.log('[REMINDER] Added repeatable reminder checker job (every 60s)');
  }
}

async function checkAndSchedulePendingReminders(): Promise<number> {
  const queue = getReminderQueue();
  if (!queue) return 0;
  
  const pendingReminders = await prisma.reminder.findMany({
    where: {
      status: 'pending',
      scheduledAt: { lte: new Date() }
    },
    take: 100
  });
  
  let added = 0;
  for (const reminder of pendingReminders) {
    const existingJob = await queue.getJob(`reminder-${reminder.id}`);
    if (!existingJob) {
      await queue.add(
        `reminder-${reminder.id}`,
        {
          reminderId: reminder.id,
          businessId: reminder.businessId,
          contactPhone: reminder.contactPhone,
          attemptNumber: reminder.attemptNumber,
          type: reminder.type as 'auto' | 'manual'
        },
        { jobId: `reminder-${reminder.id}` }
      );
      added++;
    }
  }
  
  if (added > 0) {
    console.log(`[REMINDER] Scheduled ${added} pending reminders to queue`);
  }
  return added;
}
