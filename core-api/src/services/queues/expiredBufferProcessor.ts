import { Worker, Job, Queue } from 'bullmq';
import { QUEUE_NAMES, getQueueConnection, getAIResponseQueue } from './index.js';
import { queueAIResponse, processAIResponseDirect } from './aiResponseProcessor.js';
import prisma from '../prisma.js';

let expiredBufferWorker: Worker | null = null;
let expiredBufferQueue: Queue | null = null;

export interface ExpiredBufferJobData {
  triggeredAt: number;
}

async function processExpiredBuffers(job: Job<ExpiredBufferJobData>): Promise<{ processed: number }> {
  console.log('[ExpiredBuffer] Checking for expired buffers...');
  
  try {
    const now = new Date();
    const lockUntil = new Date(Date.now() + 7200000);
    
    const expiredBuffers = await prisma.messageBuffer.findMany({
      where: {
        expiresAt: { lte: now },
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
      
      const claimed = await prisma.messageBuffer.updateMany({
        where: {
          id: buffer.id,
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
        const messages = buffer.messages as string[];
        
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
        
        if (!business.botEnabled) {
          console.log(`[ExpiredBuffer] Bot disabled for business ${buffer.businessId}, deleting buffer`);
          await prisma.messageBuffer.delete({ where: { id: buffer.id } });
          continue;
        }
        
        const contactSettings = await prisma.contactSettings.findFirst({
          where: {
            businessId: buffer.businessId,
            contactPhone: buffer.contactPhone
          }
        });
        
        const aiQueue = getAIResponseQueue();
        let queued = false;
        
        if (aiQueue) {
          const job = await queueAIResponse({
            businessId: buffer.businessId,
            contactPhone: buffer.contactPhone,
            contactName: contactSettings?.contactName || buffer.contactPhone,
            messages,
            phone: instance.phoneNumber || '',
            instanceId: instance.id,
            instanceBackendId: instance.instanceBackendId || undefined,
            priority: 'normal',
            bufferId: buffer.id
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
              contactName: contactSettings?.contactName || buffer.contactPhone,
              messages,
              phone: instance.phoneNumber || '',
              instanceId: instance.id,
              instanceBackendId: instance.instanceBackendId || undefined,
              priority: 'normal'
            });
            await prisma.messageBuffer.delete({ where: { id: buffer.id } });
            processedCount++;
            console.log(`[ExpiredBuffer] Successfully processed buffer for ${bufferKey} directly`);
          } catch (directError: any) {
            console.error(`[ExpiredBuffer] Direct processing failed for ${bufferKey}:`, directError.message);
            await prisma.messageBuffer.update({
              where: { id: buffer.id },
              data: { processingUntil: null }
            }).catch(() => {});
            console.warn(`[ExpiredBuffer] Buffer ${bufferKey} NOT deleted - will retry on next cycle`);
          }
        }
      } catch (error: any) {
        console.error(`[ExpiredBuffer] Error processing buffer ${bufferKey}:`, error.message);
        await prisma.messageBuffer.update({
          where: { id: buffer.id },
          data: { processingUntil: null }
        }).catch(() => {});
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
