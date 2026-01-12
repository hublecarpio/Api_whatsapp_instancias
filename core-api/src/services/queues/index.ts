import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import Redis from 'ioredis';

export const QUEUE_NAMES = {
  REMINDERS: 'efficore-reminders',
  MESSAGE_BUFFER: 'efficore-message-buffer',
  WHATSAPP_INCOMING: 'efficore-whatsapp-incoming',
  INACTIVITY_CHECK: 'efficore-inactivity-check',
  AI_RESPONSE: 'efficore-ai-response',
  EXPIRED_BUFFER: 'efficore-expired-buffer',
  OUTBOUND_MESSAGE: 'efficore-outbound-message'
} as const;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6389';

let connection: Redis | null = null;

function getConnection(): Redis {
  if (!connection) {
    connection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
      retryStrategy: (times: number) => {
        if (times > 3) {
          return null;
        }
        return Math.min(times * 500, 2000);
      }
    });
    
    connection.on('error', (err) => {
      console.error('BullMQ Redis connection error:', err.message);
    });
  }
  return connection;
}

export interface ReminderJobData {
  reminderId: string;
  businessId: string;
  instanceId?: string;
  contactPhone: string;
  attemptNumber: number;
  type: 'auto' | 'manual';
}

export interface MessageBufferJobData {
  businessId: string;
  contactPhone: string;
  instanceId: string;
  messages: Array<{
    text: string;
    timestamp: number;
    mediaUrl?: string;
    mediaType?: string;
  }>;
}

export interface WhatsAppIncomingJobData {
  instanceId: string;
  businessId: string;
  from: string;
  message: string;
  messageId: string;
  timestamp: number;
  mediaUrl?: string;
  mediaType?: string;
  provider: 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST';
}

export interface InactivityCheckJobData {
  businessId: string;
  configId: string;
}

export interface AIResponseJobData {
  businessId: string;
  contactPhone: string;
  contactName: string;
  messages: string[];
  phone: string;
  instanceId?: string;
  instanceBackendId?: string;
  priority?: 'high' | 'normal' | 'low';
  bufferId?: string;
  providerMessageId?: string;
  providerMessageIds?: string[];
  provider?: string;
}

export interface OutboundMessageJobData {
  jobId: string;
  businessId: string;
  instanceId: string;
  to: string;
  message?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  provider: 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST';
  instanceBackendId?: string;
  metaCredential?: {
    accessToken: string;
    phoneNumberId: string;
  };
  metaCoexistCredential?: {
    accessToken: string;
    phoneNumberId: string;
  };
  phoneNumber?: string;
  enqueuedAt: number;
  priority: 'high' | 'normal' | 'low';
  source: 'external_api' | 'agent' | 'broadcast' | 'reminder';
  realFailures?: number;
}

let reminderQueue: Queue<ReminderJobData> | null = null;
let messageBufferQueue: Queue<MessageBufferJobData> | null = null;
let whatsappIncomingQueue: Queue<WhatsAppIncomingJobData> | null = null;
let inactivityCheckQueue: Queue<InactivityCheckJobData> | null = null;
let aiResponseQueue: Queue<AIResponseJobData> | null = null;
let outboundMessageQueue: Queue<OutboundMessageJobData> | null = null;

export function initializeQueues(): void {
  const conn = getConnection();
  
  reminderQueue = new Queue<ReminderJobData>(QUEUE_NAMES.REMINDERS, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      removeOnComplete: {
        age: 24 * 3600,
        count: 1000
      },
      removeOnFail: {
        age: 7 * 24 * 3600
      }
    }
  });

  messageBufferQueue = new Queue<MessageBufferJobData>(QUEUE_NAMES.MESSAGE_BUFFER, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      removeOnComplete: {
        age: 3600,
        count: 500
      },
      removeOnFail: {
        age: 24 * 3600
      }
    }
  });

  whatsappIncomingQueue = new Queue<WhatsAppIncomingJobData>(QUEUE_NAMES.WHATSAPP_INCOMING, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      },
      removeOnComplete: {
        age: 3600,
        count: 1000
      },
      removeOnFail: {
        age: 24 * 3600
      }
    }
  });

  inactivityCheckQueue = new Queue<InactivityCheckJobData>(QUEUE_NAMES.INACTIVITY_CHECK, {
    connection: conn,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: 'fixed',
        delay: 30000
      },
      removeOnComplete: true,
      removeOnFail: {
        age: 3600
      }
    }
  });

  aiResponseQueue = new Queue<AIResponseJobData>(QUEUE_NAMES.AI_RESPONSE, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      removeOnComplete: {
        age: 3600,
        count: 2000
      },
      removeOnFail: {
        age: 24 * 3600
      }
    }
  });

  outboundMessageQueue = new Queue<OutboundMessageJobData>(QUEUE_NAMES.OUTBOUND_MESSAGE, {
    connection: conn,
    defaultJobOptions: {
      attempts: 1000,
      backoff: {
        type: 'custom'
      },
      removeOnComplete: {
        age: 24 * 3600,
        count: 10000
      },
      removeOnFail: {
        age: 7 * 24 * 3600
      }
    }
  });
  
  console.log('BullMQ queues initialized (including Outbound Message queue)');
}

export function areQueuesInitialized(): boolean {
  return reminderQueue !== null && messageBufferQueue !== null && inactivityCheckQueue !== null;
}

export function getReminderQueue(): Queue<ReminderJobData> | null {
  return reminderQueue;
}

export function getMessageBufferQueue(): Queue<MessageBufferJobData> | null {
  return messageBufferQueue;
}

export function getInactivityCheckQueue(): Queue<InactivityCheckJobData> | null {
  return inactivityCheckQueue;
}

export function getAIResponseQueue(): Queue<AIResponseJobData> | null {
  return aiResponseQueue;
}

export function getOutboundMessageQueue(): Queue<OutboundMessageJobData> | null {
  return outboundMessageQueue;
}

export function getQueueConnection(): Redis {
  return getConnection();
}

export async function scheduleInactivityChecks(): Promise<void> {
  const queue = getInactivityCheckQueue();
  if (!queue) {
    console.log('Inactivity check queue not initialized, skipping');
    return;
  }
  const existingJobs = await queue.getRepeatableJobs();
  
  for (const job of existingJobs) {
    if (job.name === 'global-inactivity-check') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  
  await queue.add(
    'global-inactivity-check',
    { businessId: 'all', configId: 'global' },
    {
      repeat: {
        every: 60000
      },
      jobId: 'global-inactivity-check'
    }
  );
  
  console.log('Scheduled global inactivity check every 60 seconds');
}

export async function closeQueues(): Promise<void> {
  const closeTasks: Promise<void>[] = [];
  
  if (reminderQueue) closeTasks.push(reminderQueue.close());
  if (messageBufferQueue) closeTasks.push(messageBufferQueue.close());
  if (whatsappIncomingQueue) closeTasks.push(whatsappIncomingQueue.close());
  if (inactivityCheckQueue) closeTasks.push(inactivityCheckQueue.close());
  if (aiResponseQueue) closeTasks.push(aiResponseQueue.close());
  if (outboundMessageQueue) closeTasks.push(outboundMessageQueue.close());
  
  await Promise.all(closeTasks);
  
  if (connection) {
    try {
      await connection.quit();
    } catch (error) {
    }
    connection = null;
  }
  
  reminderQueue = null;
  messageBufferQueue = null;
  whatsappIncomingQueue = null;
  inactivityCheckQueue = null;
  aiResponseQueue = null;
  outboundMessageQueue = null;
  
  console.log('All queues closed');
}

export { Queue, Worker, Job, QueueEvents };
