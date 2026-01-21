import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import Redis from 'ioredis';

export const QUEUE_NAMES = {
  REMINDERS: 'efficore-reminders',
  MESSAGE_BUFFER: 'efficore-message-buffer',
  WHATSAPP_INCOMING: 'efficore-whatsapp-incoming',
  INACTIVITY_CHECK: 'efficore-inactivity-check',
  AI_RESPONSE: 'efficore-ai-response',
  EXPIRED_BUFFER: 'efficore-expired-buffer',
  OUTBOUND_MESSAGE: 'efficore-outbound-message',
  MEDIA_DOWNLOAD: 'efficore-media-download'
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

export interface MediaDownloadJobData {
  messageLogId: string;
  businessId: string;
  instanceId: string;
  mediaId: string;
  mediaType: string;
  mimetype: string;
  provider: 'META_CLOUD' | 'META_COEXIST';
  accessToken: string;
  phoneNumberId: string;
  contactPhone: string;
  attemptNumber: number;
}

let reminderQueue: Queue<ReminderJobData> | null = null;
let messageBufferQueue: Queue<MessageBufferJobData> | null = null;
let whatsappIncomingQueue: Queue<WhatsAppIncomingJobData> | null = null;
let inactivityCheckQueue: Queue<InactivityCheckJobData> | null = null;
let aiResponseQueue: Queue<AIResponseJobData> | null = null;
let outboundMessageQueue: Queue<OutboundMessageJobData> | null = null;
let mediaDownloadQueue: Queue<MediaDownloadJobData> | null = null;

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

  mediaDownloadQueue = new Queue<MediaDownloadJobData>(QUEUE_NAMES.MEDIA_DOWNLOAD, {
    connection: conn,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 3000
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
  
  console.log('BullMQ queues initialized (including Outbound Message and Media Download queues)');
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

export function getMediaDownloadQueue(): Queue<MediaDownloadJobData> | null {
  return mediaDownloadQueue;
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

// Diagnostic function to get queue statistics
export async function getQueuesStatus(): Promise<{
  redis: { connected: boolean; url: string };
  queues: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }>;
}> {
  const result: {
    redis: { connected: boolean; url: string };
    queues: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }>;
  } = {
    redis: { connected: false, url: REDIS_URL.replace(/:[^:@]+@/, ':***@') }, // Hide password
    queues: {}
  };

  try {
    const conn = getConnection();
    await conn.ping();
    result.redis.connected = true;
  } catch {
    result.redis.connected = false;
    return result;
  }

  const queues = [
    { name: 'reminders', queue: reminderQueue },
    { name: 'messageBuffer', queue: messageBufferQueue },
    { name: 'whatsappIncoming', queue: whatsappIncomingQueue },
    { name: 'inactivityCheck', queue: inactivityCheckQueue },
    { name: 'aiResponse', queue: aiResponseQueue },
    { name: 'outboundMessage', queue: outboundMessageQueue },
    { name: 'mediaDownload', queue: mediaDownloadQueue }
  ];

  for (const { name, queue } of queues) {
    if (queue) {
      try {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount()
        ]);
        result.queues[name] = { waiting, active, completed, failed, delayed };
      } catch (err) {
        result.queues[name] = { waiting: -1, active: -1, completed: -1, failed: -1, delayed: -1 };
      }
    }
  }

  return result;
}

// Log queue status on startup
export async function logQueuesStatus(): Promise<void> {
  const status = await getQueuesStatus();
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📊 BULLMQ QUEUES STATUS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Redis: ${status.redis.connected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
  console.log(`Redis URL: ${status.redis.url}`);
  console.log('───────────────────────────────────────────────────────────────');
  
  for (const [name, stats] of Object.entries(status.queues)) {
    const hasJobs = stats.waiting > 0 || stats.active > 0 || stats.delayed > 0;
    const icon = hasJobs ? '📬' : '📭';
    console.log(`${icon} ${name}: waiting=${stats.waiting} active=${stats.active} delayed=${stats.delayed} failed=${stats.failed}`);
  }
  console.log('═══════════════════════════════════════════════════════════════');
}

export async function closeQueues(): Promise<void> {
  const closeTasks: Promise<void>[] = [];
  
  if (reminderQueue) closeTasks.push(reminderQueue.close());
  if (messageBufferQueue) closeTasks.push(messageBufferQueue.close());
  if (whatsappIncomingQueue) closeTasks.push(whatsappIncomingQueue.close());
  if (inactivityCheckQueue) closeTasks.push(inactivityCheckQueue.close());
  if (aiResponseQueue) closeTasks.push(aiResponseQueue.close());
  if (outboundMessageQueue) closeTasks.push(outboundMessageQueue.close());
  if (mediaDownloadQueue) closeTasks.push(mediaDownloadQueue.close());
  
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
  mediaDownloadQueue = null;
  
  console.log('All queues closed');
}

export { Queue, Worker, Job, QueueEvents };
