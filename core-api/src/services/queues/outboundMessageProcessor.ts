import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import axios from 'axios';
import prisma from '../prisma.js';
import { dispatchAgentMessage } from '../webhookService.js';
import eventLogger from '../eventLogger.js';
import { QUEUE_NAMES, OutboundMessageJobData, getQueueConnection } from './index.js';

const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6389';

const RATE_LIMITS = {
  BAILEYS: { maxPerMinute: 60, maxPerSecond: 3 },
  META_CLOUD: { maxPerMinute: 80, maxPerSecond: 5 },
  META_COEXIST: { maxPerMinute: 80, maxPerSecond: 5 }
};

let rateLimitRedis: Redis | null = null;

function getRateLimitRedis(): Redis {
  if (!rateLimitRedis) {
    rateLimitRedis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true
    });
  }
  return rateLimitRedis;
}

async function checkRateLimit(businessId: string, provider: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  try {
    const redis = getRateLimitRedis();
    const now = Date.now();
    const minuteKey = `ratelimit:${businessId}:${provider}:minute:${Math.floor(now / 60000)}`;
    const secondKey = `ratelimit:${businessId}:${provider}:second:${Math.floor(now / 1000)}`;
    
    const limits = RATE_LIMITS[provider as keyof typeof RATE_LIMITS] || RATE_LIMITS.BAILEYS;
    
    const [minuteCount, secondCount] = await Promise.all([
      redis.incr(minuteKey),
      redis.incr(secondKey)
    ]);
    
    if (minuteCount === 1) await redis.expire(minuteKey, 60);
    if (secondCount === 1) await redis.expire(secondKey, 2);
    
    if (secondCount > limits.maxPerSecond) {
      return { allowed: false, retryAfterMs: 1000 };
    }
    
    if (minuteCount > limits.maxPerMinute) {
      const remainingSeconds = 60 - (Math.floor(now / 1000) % 60);
      return { allowed: false, retryAfterMs: remainingSeconds * 1000 };
    }
    
    return { allowed: true };
  } catch (error) {
    console.error('[RATE_LIMIT] Redis error, allowing request:', error);
    return { allowed: true };
  }
}

async function sendViaBaileys(data: OutboundMessageJobData): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { instanceBackendId, to, message, mediaUrl, mediaType } = data;
  
  if (!instanceBackendId) {
    return { success: false, error: 'No instanceBackendId for Baileys' };
  }
  
  let endpoint = `/instances/${instanceBackendId}/sendMessage`;
  let payload: any = { to, message };
  
  if (mediaUrl) {
    if (mediaType === 'image' || mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      endpoint = `/instances/${instanceBackendId}/sendImage`;
      payload = { to, imageUrl: mediaUrl, caption: message || '' };
    } else if (mediaType === 'video' || mediaUrl.match(/\.(mp4|mov|avi)$/i)) {
      endpoint = `/instances/${instanceBackendId}/sendVideo`;
      payload = { to, videoUrl: mediaUrl, caption: message || '' };
    } else if (mediaType === 'audio' || mediaUrl.match(/\.(mp3|ogg|wav|m4a)$/i)) {
      endpoint = `/instances/${instanceBackendId}/sendAudio`;
      payload = { to, audioUrl: mediaUrl };
    } else if (mediaType === 'document' || mediaUrl.match(/\.(pdf|doc|docx|xls|xlsx)$/i)) {
      endpoint = `/instances/${instanceBackendId}/sendFile`;
      payload = { to, fileUrl: mediaUrl, caption: message || '', fileName: 'document' };
    }
  }
  
  const response = await axios.post(`${WA_API_URL}${endpoint}`, payload, { timeout: 30000 });
  const messageId = response.data.messageId || response.data.key?.id;
  
  return { success: true, messageId };
}

async function sendViaMeta(data: OutboundMessageJobData): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { to, message, mediaUrl, mediaType } = data;
  const credential = data.metaCredential || data.metaCoexistCredential;
  
  if (!credential?.accessToken || !credential?.phoneNumberId) {
    return { success: false, error: 'No Meta credentials' };
  }
  
  let payload: any;
  
  if (mediaUrl) {
    const type = mediaType || 'image';
    payload = {
      messaging_product: 'whatsapp',
      to,
      type,
      [type]: {
        link: mediaUrl,
        caption: message || undefined
      }
    };
  } else {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    };
  }
  
  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${credential.phoneNumberId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );
  
  const messageId = response.data.messages?.[0]?.id;
  return { success: true, messageId };
}

async function processOutboundMessage(job: Job<OutboundMessageJobData>): Promise<{ success: boolean; messageId?: string }> {
  const data = job.data;
  const startTime = Date.now();
  
  console.log(`[OUTBOUND_WORKER] Processing job ${data.jobId} for ${data.to} via ${data.provider}`);
  
  const rateCheck = await checkRateLimit(data.businessId, data.provider);
  if (!rateCheck.allowed) {
    console.log(`[OUTBOUND_WORKER] Rate limited, will retry in ${rateCheck.retryAfterMs}ms`);
    throw new Error(`RATE_LIMITED:${rateCheck.retryAfterMs}`);
  }
  
  let result: { success: boolean; messageId?: string; error?: string };
  
  if (data.provider === 'BAILEYS') {
    result = await sendViaBaileys(data);
  } else {
    result = await sendViaMeta(data);
  }
  
  if (!result.success) {
    throw new Error(result.error || 'Send failed');
  }
  
  await prisma.messageLog.create({
    data: {
      businessId: data.businessId,
      instanceId: data.instanceId,
      sender: data.phoneNumber || data.businessId,
      recipient: data.to,
      message: data.message || (data.mediaUrl ? `[Media: ${data.mediaType || 'file'}]` : ''),
      direction: 'outbound',
      mediaUrl: data.mediaUrl || null,
      providerMessageId: result.messageId,
      metadata: { 
        source: data.source, 
        provider: data.provider,
        mediaType: data.mediaType,
        queueJobId: data.jobId,
        processingTimeMs: Date.now() - startTime
      }
    }
  });
  
  const now = new Date();
  await prisma.contact.upsert({
    where: {
      businessId_phone: { businessId: data.businessId, phone: data.to }
    },
    create: {
      businessId: data.businessId,
      phone: data.to,
      name: data.to,
      firstMessageAt: now,
      lastMessageAt: now,
      messageCount: 1
    },
    update: {
      lastMessageAt: now,
      messageCount: { increment: 1 }
    }
  });
  
  await dispatchAgentMessage(
    data.businessId,
    data.to,
    data.message || '',
    data.mediaUrl ? [data.mediaUrl] : undefined,
    [data.source],
    data.instanceId
  );
  
  await eventLogger.info('OUTBOUND_MESSAGE', `Mensaje enviado via cola a ${data.to}`, {
    businessId: data.businessId,
    details: { 
      to: data.to, 
      hasMedia: !!data.mediaUrl, 
      messageId: result.messageId,
      source: data.source,
      provider: data.provider,
      processingTimeMs: Date.now() - startTime
    }
  });
  
  console.log(`[OUTBOUND_WORKER] Job ${data.jobId} completed in ${Date.now() - startTime}ms`);
  
  return { success: true, messageId: result.messageId };
}

let outboundWorker: Worker<OutboundMessageJobData> | null = null;

export function startOutboundMessageWorker(): Worker<OutboundMessageJobData> {
  if (outboundWorker) {
    return outboundWorker;
  }
  
  const connection = getQueueConnection();
  
  outboundWorker = new Worker<OutboundMessageJobData>(
    QUEUE_NAMES.OUTBOUND_MESSAGE,
    async (job) => {
      return await processOutboundMessage(job);
    },
    {
      connection,
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 1000
      }
    }
  );
  
  outboundWorker.on('completed', (job, result) => {
    console.log(`[OUTBOUND_WORKER] Job ${job.id} completed:`, result?.messageId);
  });
  
  outboundWorker.on('failed', (job, error) => {
    console.error(`[OUTBOUND_WORKER] Job ${job?.id} failed:`, error.message);
    
    if (error.message.startsWith('RATE_LIMITED:')) {
      const retryAfterMs = parseInt(error.message.split(':')[1]) || 1000;
      console.log(`[OUTBOUND_WORKER] Will retry after ${retryAfterMs}ms due to rate limit`);
    }
  });
  
  outboundWorker.on('error', (error) => {
    console.error('[OUTBOUND_WORKER] Worker error:', error);
  });
  
  console.log('[OUTBOUND_WORKER] Outbound message worker started with concurrency: 10');
  
  return outboundWorker;
}

export async function stopOutboundMessageWorker(): Promise<void> {
  if (outboundWorker) {
    await outboundWorker.close();
    outboundWorker = null;
    console.log('[OUTBOUND_WORKER] Worker stopped');
  }
  
  if (rateLimitRedis) {
    await rateLimitRedis.quit();
    rateLimitRedis = null;
  }
}

export { OutboundMessageJobData };
