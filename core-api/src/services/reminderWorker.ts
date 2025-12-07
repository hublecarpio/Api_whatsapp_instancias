import prisma from './prisma.js';
import axios from 'axios';
import OpenAI from 'openai';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';

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
  
  if (!business?.openaiApiKey) {
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
  
  const openai = new OpenAI({ apiKey: business.openaiApiKey });
  
  const response = await openai.chat.completions.create({
    model: business.openaiModel || 'gpt-4.1-mini',
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
      if (!instance?.instanceBackendId) {
        console.log(`No WhatsApp instance for business ${reminder.businessId}`);
        continue;
      }
      
      let message = reminder.messageTemplate || reminder.generatedMessage;
      
      if (!message) {
        message = await generateFollowUpMessage(
          reminder.businessId,
          reminder.contactPhone,
          reminder.attemptNumber,
          config?.pressureLevel || 1
        );
      }
      
      await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/sendMessage`, {
        to: reminder.contactPhone.includes('@') ? reminder.contactPhone : `${reminder.contactPhone}@s.whatsapp.net`,
        message
      });
      
      await prisma.messageLog.create({
        data: {
          businessId: reminder.businessId,
          instanceId: instance.id,
          direction: 'outbound',
          recipient: reminder.contactPhone,
          message,
          metadata: {
            type: 'reminder',
            reminderId: reminder.id,
            attemptNumber: reminder.attemptNumber
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
      
      console.log(`Reminder executed: ${reminder.id} to ${reminder.contactPhone}`);
      
    } catch (error) {
      console.error(`Failed to process reminder ${reminder.id}:`, error);
      
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
