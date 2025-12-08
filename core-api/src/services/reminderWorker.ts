import prisma from './prisma.js';
import axios from 'axios';
import { MetaCloudService } from './metaCloud.js';
import { isOpenAIConfigured, getOpenAIClient, getDefaultModel, logTokenUsage } from './openaiService.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

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

export async function processReminders(): Promise<void> {
  const now = new Date();
  
  const pendingReminders = await prisma.reminder.findMany({
    where: {
      status: 'pending',
      scheduledAt: { lte: now }
    },
    include: {
      business: {
        include: {
          instances: true,
          followUpConfig: true
        }
      }
    },
    take: 50
  });
  
  for (const reminder of pendingReminders) {
    try {
      const config = reminder.business.followUpConfig;
      
      if (config && !config.enabled && reminder.type === 'auto') {
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'skipped' }
        });
        continue;
      }
      
      if (config && !(await isWithinAllowedHours(config))) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(config.allowedStartHour, 0, 0, 0);
        
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { scheduledAt: tomorrow }
        });
        continue;
      }
      
      if (config) {
        const todayAttempts = await getTodayAttemptCount(reminder.businessId, reminder.contactPhone);
        if (todayAttempts >= config.maxDailyAttempts) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'max_daily_reached' }
          });
          continue;
        }
      }
      
      const instance = reminder.business.instances[0];
      if (!instance) {
        console.log(`No WhatsApp instance for business ${reminder.businessId}`);
        continue;
      }
      
      const windowStatus = await checkWindowStatus(reminder.businessId, reminder.contactPhone);
      
      let message = reminder.messageTemplate || reminder.generatedMessage;
      let usedTemplate: TemplateData | null = null;
      
      if (windowStatus.requiresTemplate && windowStatus.provider === 'META_CLOUD') {
        const templateData = await getDefaultTemplate(reminder.businessId);
        if (!templateData) {
          console.log(`No approved template for Meta Cloud business ${reminder.businessId} - cannot send reminder outside 24h window`);
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'no_template' }
          });
          continue;
        }
        usedTemplate = templateData;
        message = templateData.bodyText || `[Template: ${templateData.name}]`;
      } else if (!message) {
        message = await generateFollowUpMessage(
          reminder.businessId,
          reminder.contactPhone,
          reminder.attemptNumber,
          config?.pressureLevel || 1
        );
      }
      
      const cleanPhone = reminder.contactPhone.replace(/\D/g, '');
      
      if (instance.provider === 'META_CLOUD') {
        const metaCred = await prisma.metaCredential.findFirst({
          where: { instanceId: instance.id }
        });
        
        if (!metaCred) {
          console.log(`No Meta credentials for instance ${instance.id}`);
          continue;
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
          console.log(`No Baileys backend ID for instance ${instance.id}`);
          continue;
        }
        
        await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
          to: cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`,
          message
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
          generatedMessage: message
        }
      });
      
      console.log(`Reminder executed: ${reminder.id} to ${cleanPhone} via ${instance.provider}${usedTemplate ? ` (template: ${usedTemplate.name})` : ''}`);
      
    } catch (error: any) {
      let errorMessage = error?.message || 'Unknown error';
      let metaErrorDetails = null;
      
      if (error?.response?.data) {
        metaErrorDetails = error.response.data;
        errorMessage = `Meta API Error: ${JSON.stringify(metaErrorDetails)}`;
      }
      
      console.error(`Failed to process reminder ${reminder.id}:`, {
        error: errorMessage,
        contactPhone: reminder.contactPhone,
        businessId: reminder.businessId,
        provider: reminder.business.instances[0]?.provider,
        metaError: metaErrorDetails
      });
      
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: 'failed' }
      });
    }
  }
}

export async function checkInactiveContacts(): Promise<void> {
  const configs = await prisma.followUpConfig.findMany({
    where: { enabled: true },
    include: { business: { include: { instances: true } } }
  });
  
  for (const config of configs) {
    if (!config.business.botEnabled) continue;
    
    const now = new Date();
    const firstDelayTime = new Date(now.getTime() - config.firstDelayMinutes * 60 * 1000);
    
    const recentInbound = await prisma.messageLog.findMany({
      where: {
        businessId: config.businessId,
        direction: 'inbound',
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const contactsWithInbound = new Map<string, Date>();
    recentInbound.forEach(msg => {
      if (msg.sender && !contactsWithInbound.has(msg.sender)) {
        contactsWithInbound.set(msg.sender, msg.createdAt);
      }
    });
    
    for (const [contactPhone, lastInboundTime] of contactsWithInbound) {
      const lastOutbound = await prisma.messageLog.findFirst({
        where: {
          businessId: config.businessId,
          recipient: contactPhone,
          direction: 'outbound',
          createdAt: { gt: lastInboundTime }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      if (!lastOutbound) continue;
      
      const timeSinceOutbound = now.getTime() - lastOutbound.createdAt.getTime();
      const minutesSinceOutbound = timeSinceOutbound / (60 * 1000);
      
      if (minutesSinceOutbound < config.firstDelayMinutes) continue;
      
      const lastInboundAfterOurs = await prisma.messageLog.findFirst({
        where: {
          businessId: config.businessId,
          sender: contactPhone,
          direction: 'inbound',
          createdAt: { gt: lastOutbound.createdAt }
        }
      });
      
      if (lastInboundAfterOurs) continue;
      
      const existingReminder = await prisma.reminder.findFirst({
        where: {
          businessId: config.businessId,
          contactPhone,
          status: 'pending'
        }
      });
      
      if (existingReminder) continue;
      
      const todayAttempts = await getTodayAttemptCount(config.businessId, contactPhone);
      if (todayAttempts >= config.maxDailyAttempts) continue;
      
      let delayMinutes = config.firstDelayMinutes;
      if (todayAttempts === 1) delayMinutes = config.secondDelayMinutes;
      else if (todayAttempts >= 2) delayMinutes = config.thirdDelayMinutes;
      
      const scheduledAt = new Date(now.getTime() + delayMinutes * 60 * 1000);
      
      await prisma.reminder.create({
        data: {
          businessId: config.businessId,
          contactPhone,
          scheduledAt,
          type: 'auto',
          attemptNumber: todayAttempts + 1,
          configId: config.id
        }
      });
      
      console.log(`Auto-reminder scheduled for ${contactPhone} at ${scheduledAt}`);
    }
  }
}

let workerInterval: NodeJS.Timeout | null = null;

export function startReminderWorker(): void {
  console.log('Starting reminder worker...');
  
  workerInterval = setInterval(async () => {
    try {
      await processReminders();
      await checkInactiveContacts();
    } catch (error) {
      console.error('Reminder worker error:', error);
    }
  }, 60000);
  
  setTimeout(async () => {
    try {
      await processReminders();
      await checkInactiveContacts();
    } catch (error) {
      console.error('Initial reminder check error:', error);
    }
  }, 5000);
}

export function stopReminderWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('Reminder worker stopped');
  }
}
