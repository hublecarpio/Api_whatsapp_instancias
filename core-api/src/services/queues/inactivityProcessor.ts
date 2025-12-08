import { Worker, Job } from 'bullmq';
import { InactivityCheckJobData, QUEUE_NAMES, getReminderQueue, getQueueConnection } from './index.js';
import prisma from '../prisma.js';

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

async function checkInactiveContactsForBusiness(businessId: string, configId: string): Promise<void> {
  const config = await prisma.followUpConfig.findUnique({
    where: { id: configId },
    include: { business: { include: { instances: true } } }
  });
  
  if (!config || !config.enabled || !config.business.botEnabled) {
    return;
  }
  
  await processInactiveContacts(config);
}

async function checkAllInactiveContacts(): Promise<void> {
  const configs = await prisma.followUpConfig.findMany({
    where: { enabled: true },
    include: { business: { include: { instances: true } } }
  });
  
  for (const config of configs) {
    if (!config.business.botEnabled) continue;
    
    try {
      await processInactiveContacts(config);
    } catch (error) {
      console.error(`Error processing inactivity for business ${config.businessId}:`, error);
    }
  }
}

async function processInactiveContacts(config: any): Promise<void> {
  const now = new Date();
  
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
    
    const reminder = await prisma.reminder.create({
      data: {
        businessId: config.businessId,
        contactPhone,
        scheduledAt,
        type: 'auto',
        attemptNumber: todayAttempts + 1,
        configId: config.id
      }
    });
    
    const queue = getReminderQueue();
    if (queue) {
      await queue.add(
        `reminder-${reminder.id}`,
        {
          reminderId: reminder.id,
          businessId: config.businessId,
          contactPhone,
          attemptNumber: todayAttempts + 1,
          type: 'auto'
        },
        {
          delay: delayMinutes * 60 * 1000,
          jobId: `reminder-${reminder.id}`
        }
      );
    }
    
    console.log(`Auto-reminder scheduled for ${contactPhone} at ${scheduledAt} via BullMQ`);
  }
}

let inactivityWorker: Worker<InactivityCheckJobData> | null = null;

export function startInactivityWorker(): Worker<InactivityCheckJobData> {
  if (inactivityWorker) {
    return inactivityWorker;
  }

  inactivityWorker = new Worker<InactivityCheckJobData>(
    QUEUE_NAMES.INACTIVITY_CHECK,
    async (job) => {
      if (job.data.businessId === 'all') {
        await checkAllInactiveContacts();
      } else {
        await checkInactiveContactsForBusiness(job.data.businessId, job.data.configId);
      }
    },
    {
      connection: getQueueConnection(),
      concurrency: 1
    }
  );

  inactivityWorker.on('completed', (job) => {
    if (job.name !== 'global-inactivity-check') {
      console.log(`Inactivity check job ${job.id} completed`);
    }
  });

  inactivityWorker.on('failed', (job, error) => {
    console.error(`Inactivity check job ${job?.id} failed:`, error.message);
  });

  console.log('Inactivity check worker started with BullMQ');
  return inactivityWorker;
}

export async function stopInactivityWorker(): Promise<void> {
  if (inactivityWorker) {
    await inactivityWorker.close();
    inactivityWorker = null;
    console.log('Inactivity worker stopped');
  }
}
