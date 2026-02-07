import { Worker, Job, Queue } from 'bullmq';
import { QUEUE_NAMES, getQueueConnection, getAIResponseQueue } from './index.js';
import { queueAIResponse, processAIResponseDirect } from './aiResponseProcessor.js';
import prisma from '../prisma.js';

let expiredBufferWorker: Worker | null = null;
let expiredBufferQueue: Queue | null = null;

export interface ExpiredBufferJobData {
  triggeredAt: number;
}

const BUFFER_LOCK_DURATION_MS = 5 * 60 * 1000;
const BUFFER_MAX_RETRIES = 5;

async function processExpiredBuffers(job: Job<ExpiredBufferJobData>): Promise<{ processed: number }> {
  try {
    const now = new Date();
    const lockUntil = new Date(Date.now() + BUFFER_LOCK_DURATION_MS);
    
    const expiredBuffers = await prisma.messageBuffer.findMany({
      where: {
        expiresAt: { lte: now },
        failedAt: null,
        OR: [
          { processingUntil: null },
          { processingUntil: { lt: now } }
        ]
      }
    });
    
    if (expiredBuffers.length === 0) {
      return { processed: 0 };
    }
    
    console.log(`[ExpiredBuffer] Found ${expiredBuffers.length} expired buffers`);
    
    let processedCount = 0;
    
    for (const buffer of expiredBuffers) {
      const bufferKey = `${buffer.businessId}:${buffer.contactPhone}`;
      
      if (buffer.retryCount >= BUFFER_MAX_RETRIES) {
        console.error(`[ExpiredBuffer] Buffer ${bufferKey} exceeded max retries (${buffer.retryCount}/${BUFFER_MAX_RETRIES}) - marking as dead letter`);
        await prisma.messageBuffer.update({
          where: { id: buffer.id },
          data: {
            failedAt: new Date(),
            failureReason: `Exceeded max retries (${BUFFER_MAX_RETRIES}). Last retry at ${now.toISOString()}`,
            processingUntil: new Date(Date.now() + 86400000 * 365)
          }
        }).catch(() => {});
        continue;
      }
      
      const claimed = await prisma.messageBuffer.updateMany({
        where: {
          id: buffer.id,
          failedAt: null,
          OR: [
            { processingUntil: null },
            { processingUntil: { lt: now } }
          ]
        },
        data: {
          processingUntil: lockUntil
        }
      });
      
      if (claimed.count === 0) {
        console.log(`[ExpiredBuffer] Buffer ${bufferKey} already claimed, skipping`);
        continue;
      }
      
      try {
        console.log(`[ExpiredBuffer] Processing expired buffer for ${bufferKey}`);
        const bufferData = buffer.messages as any;
        const messages = bufferData?.texts || (Array.isArray(bufferData) ? bufferData : []);
        const storedMessageIds = bufferData?.providerMessageIds || [];
        
        // Extract stored contact JID and name from buffer data
        const storedContactJid = bufferData?.contactJid;
        const storedContactName = bufferData?.contactName || '';
        const storedProvider = bufferData?.provider;
        const storedTraceId = bufferData?.traceId;
        
        const business = await prisma.business.findUnique({
          where: { id: buffer.businessId }
        });
        
        const instance = await prisma.whatsAppInstance.findFirst({
          where: { businessId: buffer.businessId }
        });
        
        if (!business || !instance) {
          console.log(`[ExpiredBuffer] Business or instance not found for ${bufferKey}`);
          await prisma.messageBuffer.delete({ where: { id: buffer.id } });
          continue;
        }
        
        // Check if bot is globally disabled but contact has test mode enabled
        if (!business.botEnabled) {
          const contact = await prisma.contact.findUnique({
            where: { businessId_phone: { businessId: buffer.businessId, phone: buffer.contactPhone } }
          });
          
          if (!contact?.botTestEnabled) {
            console.log(`[ExpiredBuffer] Bot disabled for business ${buffer.businessId}, deleting buffer`);
            await prisma.messageBuffer.delete({ where: { id: buffer.id } });
            continue;
          }
          console.log(`[ExpiredBuffer] Bot test mode enabled for contact ${buffer.contactPhone}, processing buffer`);
        }
        
        const contactSettings = await prisma.contactSettings.findFirst({
          where: {
            businessId: buffer.businessId,
            contactPhone: buffer.contactPhone
          }
        });
        
        // Use stored contactJid if available, otherwise construct from contactPhone
        // This ensures we send to the correct WhatsApp ID (including @lid if that was the original)
        const contactJid = storedContactJid || `${buffer.contactPhone}@s.whatsapp.net`;
        const contactName = storedContactName || contactSettings?.contactName || '';
        
        console.log(`[ExpiredBuffer] Using contactJid: ${contactJid} (stored: ${!!storedContactJid})`);
        
        const aiQueue = getAIResponseQueue();
        let queued = false;
        
        if (aiQueue) {
          const job = await queueAIResponse({
            businessId: buffer.businessId,
            contactPhone: buffer.contactPhone,
            contactName,
            messages,
            phone: contactJid,
            instanceId: instance.id,
            instanceBackendId: instance.instanceBackendId || undefined,
            priority: 'normal',
            bufferId: buffer.id,
            providerMessageIds: storedMessageIds,
            provider: storedProvider || instance.provider,
            traceId: storedTraceId
          });
          queued = !!job;
        }
        
        if (queued) {
          processedCount++;
          console.log(`[ExpiredBuffer] Buffer ${bufferKey} queued for processing (worker will delete on completion)`);
        } else {
          console.log(`[ExpiredBuffer] Queue unavailable, processing directly for ${bufferKey}`);
          try {
            await processAIResponseDirect({
              businessId: buffer.businessId,
              contactPhone: buffer.contactPhone,
              contactName,
              messages,
              phone: contactJid,
              instanceId: instance.id,
              instanceBackendId: instance.instanceBackendId || undefined,
              priority: 'normal'
            });
            await prisma.messageBuffer.delete({ where: { id: buffer.id } });
            processedCount++;
            console.log(`[ExpiredBuffer] Successfully processed buffer for ${bufferKey} directly`);
          } catch (directError: any) {
            const newRetryCount = (buffer.retryCount || 0) + 1;
            console.error(`[ExpiredBuffer] Direct processing failed for ${bufferKey} (retry ${newRetryCount}/${BUFFER_MAX_RETRIES}):`, directError.message);
            if (newRetryCount >= BUFFER_MAX_RETRIES) {
              await prisma.messageBuffer.update({
                where: { id: buffer.id },
                data: {
                  failedAt: new Date(),
                  failureReason: `Direct processing failed after ${newRetryCount} retries: ${directError.message?.substring(0, 400)}`,
                  retryCount: newRetryCount,
                  processingUntil: new Date(Date.now() + 86400000 * 365)
                }
              }).catch(() => {});
              console.error(`[ExpiredBuffer] Buffer ${bufferKey} marked as DEAD LETTER after ${newRetryCount} retries`);
            } else {
              await prisma.messageBuffer.update({
                where: { id: buffer.id },
                data: { processingUntil: null, retryCount: newRetryCount }
              }).catch(() => {});
              console.warn(`[ExpiredBuffer] Buffer ${bufferKey} retry ${newRetryCount}/${BUFFER_MAX_RETRIES} - will retry on next cycle`);
            }
          }
        }
      } catch (error: any) {
        const newRetryCount = (buffer.retryCount || 0) + 1;
        console.error(`[ExpiredBuffer] Error processing buffer ${bufferKey} (retry ${newRetryCount}/${BUFFER_MAX_RETRIES}):`, error.message);
        if (newRetryCount >= BUFFER_MAX_RETRIES) {
          await prisma.messageBuffer.update({
            where: { id: buffer.id },
            data: {
              failedAt: new Date(),
              failureReason: `Processing error after ${newRetryCount} retries: ${error.message?.substring(0, 400)}`,
              retryCount: newRetryCount,
              processingUntil: new Date(Date.now() + 86400000 * 365)
            }
          }).catch(() => {});
          console.error(`[ExpiredBuffer] Buffer ${bufferKey} marked as DEAD LETTER after ${newRetryCount} retries`);
        } else {
          await prisma.messageBuffer.update({
            where: { id: buffer.id },
            data: { processingUntil: null, retryCount: newRetryCount }
          }).catch(() => {});
        }
      }
    }
    
    return { processed: processedCount };
  } catch (error: any) {
    console.error('[ExpiredBuffer] Error in processExpiredBuffers:', error.message);
    throw error;
  }
}

export function initializeExpiredBufferQueue(): Queue {
  if (expiredBufferQueue) {
    return expiredBufferQueue;
  }
  
  expiredBufferQueue = new Queue(QUEUE_NAMES.EXPIRED_BUFFER || 'expired-buffer', {
    connection: getQueueConnection()
  });
  
  return expiredBufferQueue;
}

export function getExpiredBufferQueue(): Queue | null {
  return expiredBufferQueue;
}

export async function scheduleExpiredBufferCheck(): Promise<void> {
  const queue = initializeExpiredBufferQueue();
  
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === 'check-expired-buffers') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  
  await queue.add(
    'check-expired-buffers',
    { triggeredAt: Date.now() },
    {
      repeat: {
        every: 5000
      },
      removeOnComplete: 100,
      removeOnFail: 50
    }
  );
  
  console.log('[ExpiredBuffer] Scheduled repeatable job every 5 seconds');
}

export function startExpiredBufferWorker(): Worker {
  if (expiredBufferWorker) {
    return expiredBufferWorker;
  }
  
  const connection = getQueueConnection();
  
  expiredBufferWorker = new Worker(
    QUEUE_NAMES.EXPIRED_BUFFER || 'expired-buffer',
    async (job) => {
      return await processExpiredBuffers(job);
    },
    {
      connection,
      concurrency: 1
    }
  );
  
  expiredBufferWorker.on('completed', (job, result) => {
    if (result.processed > 0) {
      console.log(`[ExpiredBuffer] Job completed, processed ${result.processed} buffers`);
    }
  });
  
  expiredBufferWorker.on('failed', (job, error) => {
    console.error(`[ExpiredBuffer] Job failed:`, error.message);
  });
  
  console.log('[ExpiredBuffer] Worker started');
  return expiredBufferWorker;
}

export async function stopExpiredBufferWorker(): Promise<void> {
  if (expiredBufferWorker) {
    await expiredBufferWorker.close();
    expiredBufferWorker = null;
    console.log('[ExpiredBuffer] Worker stopped');
  }
  
  if (expiredBufferQueue) {
    await expiredBufferQueue.close();
    expiredBufferQueue = null;
  }
}
