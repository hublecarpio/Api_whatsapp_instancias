import { Worker, Job } from 'bullmq';
import { ReminderJobData, QUEUE_NAMES, getReminderQueue, getQueueConnection } from './index.js';
import prisma from '../prisma.js';
import axios from 'axios';
import { MetaCloudService } from '../metaCloud.js';
import { isOpenAIConfigured, getOpenAIClient, getDefaultModel, logTokenUsage } from '../openaiService.js';

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
    include: { metaCredential: true }
  });
  
  if (!instance || instance.provider !== 'META_CLOUD') {
    return { requiresTemplate: false, provider: instance?.provider || null, hoursSinceLastMessage: null };
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

async function getDefaultTemplate(businessId: string): Promise<TemplateData | null> {
  const instance = await prisma.whatsAppInstance.findFirst({
    where: { businessId, provider: 'META_CLOUD' },
    include: { metaCredential: true }
  });
  
  if (!instance?.metaCredential) return null;
  
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
  
  const openai = getOpenAIClient();
  const modelToUse = getDefaultModel();
  
  const response = await openai.chat.completions.create({
    model: modelToUse,
    messages: [
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
    ],
    max_tokens: 150,
    temperature: 0.7
  });
  
  if (response.usage) {
    await logTokenUsage({
      businessId,
      userId: business.userId,
      feature: 'follow_up',
      model: modelToUse,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens
    });
  }
  
  return response.choices[0]?.message?.content || 'Hola! Tienes alguna pregunta?';
}

async function isWithinAllowedHours(config: any): Promise<boolean> {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  
  if (!config.weekendsEnabled && (day === 0 || day === 6)) {
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

async function processReminderJob(job: Job<ReminderJobData>): Promise<void> {
  const { reminderId, businessId, contactPhone, attemptNumber } = job.data;
  
  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId },
    include: {
      business: {
        include: {
          instances: true,
          followUpConfig: true
        }
      }
    }
  });
  
  if (!reminder || reminder.status !== 'pending') {
    console.log(`Reminder ${reminderId} not found or not pending, skipping`);
    return;
  }
  
  const config = reminder.business.followUpConfig;
  
  if (config && !config.enabled && reminder.type === 'auto') {
    await prisma.reminder.update({
      where: { id: reminderId },
      data: { status: 'skipped' }
    });
    return;
  }
  
  if (config && !(await isWithinAllowedHours(config))) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(config.allowedStartHour, 0, 0, 0);
    
    await prisma.reminder.update({
      where: { id: reminderId },
      data: { scheduledAt: tomorrow }
    });
    
    const queue = getReminderQueue();
    if (queue) {
      await queue.add(
        `reminder-${reminderId}`,
        job.data,
        { delay: tomorrow.getTime() - Date.now() }
      );
    }
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
  
  const instance = reminder.business.instances[0];
  if (!instance) {
    console.log(`No WhatsApp instance for business ${businessId}`);
    throw new Error(`No WhatsApp instance for business ${businessId}`);
  }
  
  const windowStatus = await checkWindowStatus(businessId, contactPhone);
  
  let message = reminder.messageTemplate || reminder.generatedMessage;
  let usedTemplate: TemplateData | null = null;
  
  if (windowStatus.requiresTemplate && windowStatus.provider === 'META_CLOUD') {
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
    message = await generateFollowUpMessage(
      businessId,
      contactPhone,
      attemptNumber,
      config?.pressureLevel || 1
    );
  }
  
  const cleanPhone = contactPhone.replace(/\D/g, '');
  
  if (instance.provider === 'META_CLOUD') {
    const metaCred = await prisma.metaCredential.findFirst({
      where: { instanceId: instance.id }
    });
    
    if (!metaCred) {
      throw new Error(`No Meta credentials for instance ${instance.id}`);
    }
    
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
        await processReminderJob(job);
      } catch (error: any) {
        console.error(`Failed to process reminder ${job.data.reminderId}:`, error.message);
        
        await prisma.reminder.update({
          where: { id: job.data.reminderId },
          data: { status: 'failed' }
        });
        
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
  
  const pendingReminders = await prisma.reminder.findMany({
    where: {
      status: 'pending',
      scheduledAt: { lte: new Date() }
    },
    take: 100
  });
  
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
    }
  }
  
  console.log(`Scheduled ${pendingReminders.length} pending reminders to queue`);
}
