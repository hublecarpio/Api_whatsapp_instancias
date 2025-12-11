import { Worker, Job } from 'bullmq';
import { MessageBufferJobData, QUEUE_NAMES, getMessageBufferQueue, getQueueConnection } from './index.js';
import prisma from '../prisma.js';

const pendingBuffers = new Map<string, NodeJS.Timeout>();

export interface BufferMessage {
  text: string;
  timestamp: number;
  mediaUrl?: string;
  mediaType?: string;
}

export async function addToMessageBuffer(
  businessId: string,
  contactPhone: string,
  instanceId: string,
  message: BufferMessage,
  bufferDelayMs: number = 10000
): Promise<void> {
  const bufferKey = `${businessId}:${contactPhone}`;
  
  if (pendingBuffers.has(bufferKey)) {
    clearTimeout(pendingBuffers.get(bufferKey)!);
  }
  
  const queue = getMessageBufferQueue();
  if (!queue) {
    console.log('Message buffer queue not initialized, skipping');
    return;
  }
  
  const existingJob = await queue.getJob(`buffer-${bufferKey}`);
  
  let messages: BufferMessage[] = [];
  
  if (existingJob) {
    messages = existingJob.data.messages || [];
    await existingJob.remove();
  }
  
  messages.push(message);
  
  const timeout = setTimeout(async () => {
    pendingBuffers.delete(bufferKey);
    
    const jobId = `buffer-${bufferKey}`;
    const existingJobInQueue = await queue.getJob(jobId);
    if (existingJobInQueue) {
      const state = await existingJobInQueue.getState();
      if (state === 'completed' || state === 'failed') {
        await existingJobInQueue.remove();
      } else {
        console.log(`[BUFFER] Job ${jobId} already exists in state ${state}, skipping`);
        return;
      }
    }
    
    await queue.add(
      `buffer-${bufferKey}`,
      {
        businessId,
        contactPhone,
        instanceId,
        messages
      },
      {
        jobId
      }
    );
  }, bufferDelayMs);
  
  pendingBuffers.set(bufferKey, timeout);
}

export async function flushBuffer(businessId: string, contactPhone: string): Promise<BufferMessage[]> {
  const bufferKey = `${businessId}:${contactPhone}`;
  
  if (pendingBuffers.has(bufferKey)) {
    clearTimeout(pendingBuffers.get(bufferKey)!);
    pendingBuffers.delete(bufferKey);
  }
  
  const queue = getMessageBufferQueue();
  if (!queue) {
    return [];
  }
  
  const existingJob = await queue.getJob(`buffer-${bufferKey}`);
  
  if (existingJob) {
    const messages = existingJob.data.messages || [];
    await existingJob.remove();
    return messages;
  }
  
  return [];
}

async function processMessageBuffer(job: Job<MessageBufferJobData>): Promise<void> {
  const { businessId, contactPhone, instanceId, messages } = job.data;
  
  if (!messages || messages.length === 0) {
    return;
  }
  
  const combinedMessage = messages.map(m => m.text).join('\n');
  
  console.log(`Processing buffered messages for ${contactPhone}: ${messages.length} messages combined`);
  
  const business = await prisma.business.findUnique({
    where: { id: businessId }
  });
  
  if (!business) {
    throw new Error(`Business ${businessId} not found`);
  }
  
  console.log(`Message buffer processed for ${contactPhone}: "${combinedMessage.substring(0, 100)}..."`);
}

let bufferWorker: Worker<MessageBufferJobData> | null = null;

export function startMessageBufferWorker(): Worker<MessageBufferJobData> {
  if (bufferWorker) {
    return bufferWorker;
  }

  bufferWorker = new Worker<MessageBufferJobData>(
    QUEUE_NAMES.MESSAGE_BUFFER,
    async (job) => {
      try {
        await processMessageBuffer(job);
      } catch (error: any) {
        console.error(`Failed to process message buffer:`, error.message);
        throw error;
      }
    },
    {
      connection: getQueueConnection(),
      concurrency: 10
    }
  );

  bufferWorker.on('completed', (job) => {
    console.log(`Message buffer job ${job.id} completed`);
  });

  bufferWorker.on('failed', (job, error) => {
    console.error(`Message buffer job ${job?.id} failed:`, error.message);
  });

  console.log('Message buffer worker started with BullMQ');
  return bufferWorker;
}

export async function stopMessageBufferWorker(): Promise<void> {
  for (const timeout of pendingBuffers.values()) {
    clearTimeout(timeout);
  }
  pendingBuffers.clear();
  
  if (bufferWorker) {
    await bufferWorker.close();
    bufferWorker = null;
    console.log('Message buffer worker stopped');
  }
}
