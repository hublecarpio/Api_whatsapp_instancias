import prisma from './prisma.js';
import axios from 'axios';
import { MetaCloudService } from './metaCloud.js';
import { isOpenAIConfigured, getOpenAIClient, getDefaultModel, logTokenUsage } from './openaiService.js';

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
  const instance = await prisma.whatsAppInstance.findFirst({
    where: { 
      businessId,
      isActive: true,
      status: 'connected'
    },
    include: { metaCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
  
  if (instance) return instance;
  
  return prisma.whatsAppInstance.findFirst({
    where: { 
      businessId,
      isActive: true
    },
    include: { metaCredential: true },
    orderBy: { lastConnection: 'desc' }
  });
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
      
      const businessTimezone = reminder.business.timezone || 'America/Lima';
      
      if (config && !(await isWithinAllowedHours(config, businessTimezone))) {
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
      
      const instance = await getActiveInstance(reminder.businessId);
      if (!instance) {
        console.log(`[REMINDER] No active WhatsApp instance for business ${reminder.businessId} - skipping reminder ${reminder.id}`);
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
            data: { status: 'no_template' }
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
          console.log(`[REMINDER] No Meta credentials for instance ${instance.id} - skipping`);
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
          console.log(`No Baileys backend ID for instance ${instance.id}`);
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

function getDelayForAttempt(config: any, attemptNumber: number): number {
  if (config.followUpSteps && Array.isArray(config.followUpSteps)) {
    const step = config.followUpSteps[attemptNumber - 1];
    if (step && typeof step.delayMinutes === 'number') {
      return step.delayMinutes;
    }
  }
  
  if (attemptNumber === 1) return config.firstDelayMinutes;
  if (attemptNumber === 2) return config.secondDelayMinutes;
  return config.thirdDelayMinutes;
}

function getMaxAttempts(config: any): number {
  if (config.followUpSteps && Array.isArray(config.followUpSteps)) {
    return config.followUpSteps.length;
  }
  return config.maxDailyAttempts;
}

export async function checkInactiveContacts(): Promise<void> {
  const configs = await prisma.followUpConfig.findMany({
    where: { enabled: true },
    include: { business: { include: { instances: true } } }
  });
  
  for (const config of configs) {
    if (!config.business.botEnabled) continue;
    
    const now = new Date();
    const triggerMode = (config as any).triggerMode || 'user';
    const stopOnReply = (config as any).stopOnReply !== false;
    const maxAttempts = getMaxAttempts(config);
    
    let contactsToCheck = new Map<string, { lastMessageTime: Date; direction: string }>();
    
    if (triggerMode === 'user' || triggerMode === 'any') {
      const recentInbound = await prisma.messageLog.findMany({
        where: {
          businessId: config.businessId,
          direction: 'inbound',
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      recentInbound.forEach(msg => {
        if (msg.sender && !contactsToCheck.has(msg.sender)) {
          contactsToCheck.set(msg.sender, { lastMessageTime: msg.createdAt, direction: 'inbound' });
        }
      });
    }
    
    if (triggerMode === 'agent' || triggerMode === 'any') {
      const recentOutbound = await prisma.messageLog.findMany({
        where: {
          businessId: config.businessId,
          direction: 'outbound',
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      recentOutbound.forEach(msg => {
        if (msg.recipient) {
          const existing = contactsToCheck.get(msg.recipient);
          if (!existing || msg.createdAt > existing.lastMessageTime) {
            contactsToCheck.set(msg.recipient, { lastMessageTime: msg.createdAt, direction: 'outbound' });
          }
        }
      });
    }
    
    for (const [contactPhone, { lastMessageTime, direction }] of contactsToCheck) {
      let referenceTime: Date;
      
      if (triggerMode === 'user') {
        const lastOutbound = await prisma.messageLog.findFirst({
          where: {
            businessId: config.businessId,
            recipient: contactPhone,
            direction: 'outbound',
            createdAt: { gt: lastMessageTime }
          },
          orderBy: { createdAt: 'desc' }
        });
        
        if (!lastOutbound) continue;
        referenceTime = lastOutbound.createdAt;
      } else if (triggerMode === 'agent') {
        const lastOutbound = await prisma.messageLog.findFirst({
          where: {
            businessId: config.businessId,
            recipient: contactPhone,
            direction: 'outbound'
          },
          orderBy: { createdAt: 'desc' }
        });
        
        if (!lastOutbound) continue;
        referenceTime = lastOutbound.createdAt;
      } else {
        const lastMessage = await prisma.messageLog.findFirst({
          where: {
            businessId: config.businessId,
            OR: [
              { sender: contactPhone },
              { recipient: contactPhone }
            ]
          },
          orderBy: { createdAt: 'desc' }
        });
        
        if (!lastMessage) continue;
        referenceTime = lastMessage.createdAt;
      }
      
      const timeSinceReference = now.getTime() - referenceTime.getTime();
      const minutesSinceReference = timeSinceReference / (60 * 1000);
      
      if (minutesSinceReference < config.firstDelayMinutes) continue;
      
      if (stopOnReply && triggerMode !== 'user') {
        const clientRepliedAfter = await prisma.messageLog.findFirst({
          where: {
            businessId: config.businessId,
            sender: contactPhone,
            direction: 'inbound',
            createdAt: { gt: referenceTime }
          }
        });
        
        if (clientRepliedAfter) continue;
      } else if (triggerMode === 'user') {
        const clientRepliedAfter = await prisma.messageLog.findFirst({
          where: {
            businessId: config.businessId,
            sender: contactPhone,
            direction: 'inbound',
            createdAt: { gt: referenceTime }
          }
        });
        
        if (clientRepliedAfter) continue;
      }
      
      const existingReminder = await prisma.reminder.findFirst({
        where: {
          businessId: config.businessId,
          contactPhone,
          status: 'pending'
        }
      });
      
      if (existingReminder) continue;
      
      const todayAttempts = await getTodayAttemptCount(config.businessId, contactPhone);
      if (todayAttempts >= maxAttempts) continue;
      
      const delayMinutes = getDelayForAttempt(config, todayAttempts + 1);
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
      
      console.log(`Auto-reminder (${triggerMode} mode) scheduled for ${contactPhone} at ${scheduledAt}`);
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
