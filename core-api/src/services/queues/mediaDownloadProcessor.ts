import { Worker, Job } from 'bullmq';
import axios from 'axios';
import prisma from '../prisma.js';
import { QUEUE_NAMES, MediaDownloadJobData, getQueueConnection, getMediaDownloadQueue } from './index.js';
import { MetaCloudService, getCircuitBreakerState } from '../metaCloud.js';
import { uploadBuffer, isS3Configured } from '../storage.js';
import { dispatchMediaUpdate, dispatchUserMessage } from '../webhookService.js';
import { geminiService } from '../gemini.js';

const MAX_MEDIA_DOWNLOAD_ATTEMPTS = 5;
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';
const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';
const CIRCUIT_BREAKER_RETRY_DELAY = 35000; // 35 seconds - wait for CB to enter half-open

let mediaDownloadWorker: Worker | null = null;

async function scheduleMediaRetry(
  jobData: MediaDownloadJobData,
  delay: number,
  logPrefix: string
): Promise<boolean> {
  const { messageLogId, mediaId, attemptNumber } = jobData;
  
  const mediaQueue = getMediaDownloadQueue();
  if (!mediaQueue) {
    console.error(`${logPrefix} Cannot schedule retry - queue not initialized`);
    return false;
  }
  
  // Check current attempt count in DB to prevent duplicate re-queues
  const existingLog = await prisma.messageLog.findUnique({
    where: { id: messageLogId },
    select: { metadata: true }
  });
  const scheduledAttempt = ((existingLog?.metadata as any)?.mediaDownloadScheduledAttempt) || 0;
  const currentAttempt = Math.max(attemptNumber, scheduledAttempt);
  
  if (currentAttempt >= MAX_MEDIA_DOWNLOAD_ATTEMPTS) {
    console.log(`${logPrefix} Max attempts (${MAX_MEDIA_DOWNLOAD_ATTEMPTS}) reached, not re-queueing`);
    return false;
  }
  
  const nextAttempt = currentAttempt + 1;
  
  // Use deterministic jobId to prevent duplicates
  const jobId = `media-${messageLogId}-attempt-${nextAttempt}`;
  
  // Check if job already exists and is active
  const existingJob = await mediaQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    // Only skip if job is waiting, delayed, or active
    if (state === 'waiting' || state === 'delayed' || state === 'active') {
      console.log(`${logPrefix} Job ${jobId} already ${state}, skipping duplicate`);
      return true;
    }
    // Remove failed/completed stale jobs to allow re-queue
    console.log(`${logPrefix} Removing stale job ${jobId} (state: ${state})`);
    try {
      await existingJob.remove();
    } catch (e) {
      console.warn(`${logPrefix} Failed to remove stale job: ${(e as Error).message}`);
    }
  }
  
  // Add job to queue FIRST - this is the source of truth
  try {
    await mediaQueue.add(jobId, {
      ...jobData,
      attemptNumber: nextAttempt
    }, {
      jobId, // Deterministic ID prevents duplicates
      delay,
      priority: 2,
      removeOnComplete: true,
      removeOnFail: true
    });
  } catch (addError: any) {
    // If job already exists (race condition), consider it a success
    if (addError.message?.includes('already exists')) {
      console.log(`${logPrefix} Job ${jobId} added by concurrent worker, OK`);
      return true;
    }
    console.error(`${logPrefix} Failed to add job: ${addError.message}`);
    return false;
  }
  
  // Update metadata AFTER successful enqueue (queue is source of truth)
  try {
    const existingMetadata = (existingLog?.metadata as Record<string, any>) || {};
    await prisma.messageLog.update({
      where: { id: messageLogId },
      data: {
        metadata: {
          ...existingMetadata,
          mediaPending: true,
          mediaDownloadAttempt: attemptNumber,
          mediaDownloadNextRetry: new Date(Date.now() + delay).toISOString(),
          mediaDownloadScheduledAttempt: nextAttempt
        }
      }
    });
  } catch (dbError) {
    // Job is already queued, DB update failure is not critical
    console.warn(`${logPrefix} Failed to update metadata (job is queued): ${(dbError as Error).message}`);
  }
  
  console.log(`${logPrefix} Scheduled retry ${nextAttempt}/${MAX_MEDIA_DOWNLOAD_ATTEMPTS} in ${delay/1000}s (jobId: ${jobId})`);
  return true;
}

async function processMediaDownload(job: Job<MediaDownloadJobData>): Promise<void> {
  const { 
    messageLogId, 
    businessId, 
    instanceId, 
    mediaId, 
    mediaType, 
    mimetype, 
    provider, 
    accessToken, 
    phoneNumberId,
    contactPhone,
    attemptNumber 
  } = job.data;

  const logPrefix = `[MEDIA_DL] job=${job.id} messageLog=${messageLogId} mediaId=${mediaId} attempt=${attemptNumber}/${MAX_MEDIA_DOWNLOAD_ATTEMPTS}`;
  console.log(`${logPrefix} Starting media download...`);

  // Check circuit breaker state BEFORE attempting
  const cbState = getCircuitBreakerState(phoneNumberId);
  if (cbState.isOpen) {
    const timeToWait = Math.max(CIRCUIT_BREAKER_RETRY_DELAY - cbState.timeSinceLastFailure, 5000);
    console.log(`${logPrefix} Circuit breaker OPEN, scheduling retry with ${Math.round(timeToWait/1000)}s delay`);
    
    const scheduled = await scheduleMediaRetry(job.data, timeToWait, logPrefix);
    if (scheduled) {
      return; // Exit without error - retry is scheduled
    }
    throw new Error('META_CIRCUIT_BREAKER_OPEN');
  }

  try {
    const metaService = new MetaCloudService({
      accessToken,
      phoneNumberId,
      businessId: ''
    });

    const metaMediaUrl = await metaService.getMediaUrl(mediaId);
    console.log(`${logPrefix} Got Meta URL: ${metaMediaUrl?.substring(0, 60)}...`);

    let finalMediaUrl: string;

    if (isS3Configured()) {
      console.log(`${logPrefix} Downloading media from Meta...`);
      const mediaBuffer = await metaService.downloadMedia(metaMediaUrl);
      console.log(`${logPrefix} Downloaded ${mediaBuffer.length} bytes, uploading to S3...`);
      
      const uploadResult = await uploadBuffer(mediaBuffer, mimetype, businessId);
      
      if (uploadResult) {
        finalMediaUrl = uploadResult.url;
        console.log(`${logPrefix} Uploaded to S3: ${finalMediaUrl.substring(0, 60)}...`);
      } else {
        console.warn(`${logPrefix} S3 upload failed, using Meta URL as fallback`);
        finalMediaUrl = metaMediaUrl;
      }
    } else {
      console.log(`${logPrefix} S3 not configured, using Meta URL`);
      finalMediaUrl = metaMediaUrl;
    }

    // Merge with existing metadata
    const existingLog = await prisma.messageLog.findUnique({
      where: { id: messageLogId },
      select: { metadata: true }
    });
    const existingMetadata = (existingLog?.metadata as Record<string, any>) || {};
    
    await prisma.messageLog.update({
      where: { id: messageLogId },
      data: {
        mediaUrl: finalMediaUrl,
        metadata: {
          ...existingMetadata,
          mediaPending: false,
          mediaDownloadCompleted: true,
          mediaDownloadAttempt: attemptNumber,
          mediaDownloadCompletedAt: new Date().toISOString()
        }
      }
    });

    console.log(`${logPrefix} SUCCESS - MessageLog updated with mediaUrl`);
    
    // Process media with Gemini for AI agent context (with idempotency check)
    if (geminiService.isConfigured()) {
      const mediaTypes = ['audio', 'ptt', 'image', 'sticker', 'video'];
      if (mediaTypes.includes(mediaType)) {
        // Check if already processed to prevent duplicate analysis
        const logForGeminiCheck = await prisma.messageLog.findUnique({
          where: { id: messageLogId },
          select: { metadata: true }
        });
        const existingMeta = (logForGeminiCheck?.metadata as Record<string, any>) || {};
        
        if (existingMeta.mediaAnalysisAt) {
          console.log(`${logPrefix} Gemini analysis already done, skipping`);
        } else {
          try {
            const geminiStartTime = Date.now();
            console.log(`${logPrefix} Processing ${mediaType} with Gemini for AI context...`);
            const result = await geminiService.processMedia(finalMediaUrl, mediaType, '');
            const geminiElapsed = Date.now() - geminiStartTime;
            console.log(`${logPrefix} Gemini processing took ${geminiElapsed}ms`);
            
            if (result.success && result.text) {
              let mediaAnalysis = result.text;
              if (mediaType === 'audio' || mediaType === 'ptt') {
                mediaAnalysis = `[Transcripción de audio]: ${result.text}`;
              } else if (mediaType === 'image' || mediaType === 'sticker') {
                mediaAnalysis = `[Descripción de imagen]: ${result.text}`;
              } else if (mediaType === 'video') {
                mediaAnalysis = `[Descripción de video]: ${result.text}`;
              }
              
              // Re-fetch to get current state (avoid race conditions)
              const logForUpdate = await prisma.messageLog.findUnique({
                where: { id: messageLogId },
                select: { metadata: true, message: true }
              });
              const metadataForGemini = (logForUpdate?.metadata as Record<string, any>) || {};
              
              // Only append if not already present in message
              let updatedMessage = logForUpdate?.message || '';
              if (!updatedMessage.includes('[Transcripción de audio]') && 
                  !updatedMessage.includes('[Descripción de imagen]') &&
                  !updatedMessage.includes('[Descripción de video]')) {
                updatedMessage = updatedMessage 
                  ? `${updatedMessage}\n\n${mediaAnalysis}`
                  : mediaAnalysis;
              }
              
              // For images, also check if it's a payment voucher
              let voucherValidation: any = null;
              if (mediaType === 'image') {
                try {
                  // Get business currency for proper voucher validation
                  const business = await prisma.business.findUnique({
                    where: { id: businessId },
                    select: { currencyCode: true }
                  });
                  const currency = business?.currencyCode || 'PEN';
                  
                  console.log(`${logPrefix} Checking if image is a payment voucher (currency: ${currency})...`);
                  const voucherResult = await geminiService.validatePaymentVoucher(finalMediaUrl, { currency });
                  
                  // Save voucherValidation if it's a payment proof (even if not fully valid)
                  // This allows downstream tools to decide based on isPaymentProof
                  if (voucherResult.isPaymentProof) {
                    console.log(`${logPrefix} 🧾 VOUCHER DETECTED! Brand=${voucherResult.brand}, Amount=${voucherResult.amount}, Valid=${voucherResult.isValid}`);
                    voucherValidation = {
                      isPaymentProof: voucherResult.isPaymentProof,
                      isValid: voucherResult.isValid,
                      brand: voucherResult.brand,
                      amount: voucherResult.amount,
                      currency: voucherResult.currency,
                      operationCode: voucherResult.operationCode,
                      confidence: voucherResult.confidence,
                      reason: voucherResult.reason,
                      imageUrl: finalMediaUrl
                    };
                  } else {
                    console.log(`${logPrefix} Image is not a payment voucher: ${voucherResult.reason}`);
                  }
                } catch (voucherError: any) {
                  console.warn(`${logPrefix} Voucher validation failed (non-critical): ${voucherError.message}`);
                }
              }
              
              await prisma.messageLog.update({
                where: { id: messageLogId },
                data: {
                  message: updatedMessage,
                  metadata: {
                    ...metadataForGemini,
                    mediaAnalysis: result.text,
                    mediaAnalysisType: mediaType,
                    mediaAnalysisAt: new Date().toISOString(),
                    ...(voucherValidation ? { voucherValidation } : {})
                  }
                }
              });
              console.log(`${logPrefix} Gemini analysis complete and saved${voucherValidation ? ' (with voucher data)' : ''}`);
            }
          } catch (geminiError: any) {
            console.warn(`${logPrefix} Gemini processing failed (non-critical): ${geminiError.message}`);
          }
        }
      }
    }
    
    // Dispatch media_update webhook to notify external systems
    try {
      await dispatchMediaUpdate(
        businessId,
        contactPhone,
        messageLogId,
        finalMediaUrl,
        mediaType,
        instanceId
      );
      console.log(`${logPrefix} media_update webhook dispatched`);
    } catch (webhookError: any) {
      console.warn(`${logPrefix} Failed to dispatch media_update webhook: ${webhookError.message}`);
    }

    // Dispatch user_message webhook NOW that media is ready (Option B: wait for media)
    // Get message data for the webhook
    try {
      const messageForWebhook = await prisma.messageLog.findUnique({
        where: { id: messageLogId },
        select: {
          message: true,
          metadata: true,
          providerMessageId: true
        }
      });
      
      if (messageForWebhook) {
        const webhookMetadata = (messageForWebhook.metadata as Record<string, any>) || {};
        const pushName = webhookMetadata.pushName || '';
        const webhookMessage = messageForWebhook.message || '';
        
        await dispatchUserMessage(
          businessId,
          contactPhone,
          pushName,
          webhookMessage,
          mediaType,
          finalMediaUrl,
          {
            efficoreMessageId: messageLogId,
            metaMessageId: messageForWebhook.providerMessageId
          },
          instanceId
        );
        console.log(`${logPrefix} user_message webhook dispatched with mediaUrl`);
      }
    } catch (userWebhookError: any) {
      console.warn(`${logPrefix} Failed to dispatch user_message webhook: ${userWebhookError.message}`);
    }

    // Call AI agent now that media is ready
    // Get full message data for AI processing
    try {
      const fullMessageLog = await prisma.messageLog.findUnique({
        where: { id: messageLogId },
        select: {
          message: true,
          metadata: true,
          sender: true,
          providerMessageId: true
        }
      });

      // Check if bot is enabled (business level and contact level)
      const cleanPhone = contactPhone.replace(/\D/g, '');
      
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { botEnabled: true }
      });

      const contact = await prisma.contact.findUnique({
        where: {
          businessId_phone: { businessId, phone: cleanPhone }
        },
        select: { botDisabled: true, botTestEnabled: true }
      });

      if (fullMessageLog) {
        const msgMetadata = (fullMessageLog.metadata as Record<string, any>) || {};
        const pushName = msgMetadata.pushName || '';
        const messageText = fullMessageLog.message || '';
        const mediaAnalysis = msgMetadata.mediaAnalysis || '';
        const fullMessageForAgent = messageText + (mediaAnalysis ? `\n\n${mediaAnalysis}` : '');
        
        // Check if bot is enabled (same logic as processIncomingMessage)
        let shouldCallAI = true;
        
        if (!business?.botEnabled) {
          // Bot globally disabled, check if contact has test mode enabled
          if (!contact?.botTestEnabled) {
            shouldCallAI = false;
            console.log(`${logPrefix} Bot disabled for business, skipping AI`);
          }
        } else if (contact?.botDisabled) {
          // Bot globally enabled but disabled for this contact
          shouldCallAI = false;
          console.log(`${logPrefix} Bot disabled for contact ${cleanPhone}, skipping AI`);
        }
        
        if (shouldCallAI) {
          console.log(`${logPrefix} Calling AI agent with media ready...`);
          
          // AI agent receives ONLY the Gemini-processed text, not the raw S3 URL
          // The mediaAnalysis is already concatenated into fullMessageForAgent
          await axios.post(`${CORE_API_URL}/agent/think`, {
            business_id: businessId,
            instanceId,
            provider,
            phone: `${cleanPhone}@s.whatsapp.net`,
            phoneNumber: cleanPhone,
            contactName: pushName,
            user_message: fullMessageForAgent,
            providerMessageId: fullMessageLog.providerMessageId || undefined
          }, {
            headers: { 'X-Internal-Secret': INTERNAL_AGENT_SECRET },
            timeout: 30000
          });
          
          console.log(`${logPrefix} AI agent called successfully`);
        }
      }
    } catch (aiError: any) {
      console.error(`${logPrefix} Failed to call AI agent: ${aiError.message}`);
      // Non-fatal: media is already saved, AI failure shouldn't fail the job
    }

  } catch (error: any) {
    const errorMessage = error.message || 'Unknown error';
    const isCircuitBreakerOpen = errorMessage === 'META_CIRCUIT_BREAKER_OPEN';
    const isNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR'].some(
      code => errorMessage.includes(code) || error.code?.includes?.(code) || error.code === code
    );
    const isRetryable = isCircuitBreakerOpen || isNetworkError || error?.response?.status >= 500;

    console.error(`${logPrefix} FAILED: ${errorMessage}`, {
      isCircuitBreakerOpen,
      isNetworkError,
      isRetryable,
      code: error.code,
      status: error?.response?.status
    });

    // If retryable, use centralized retry scheduler
    if (isRetryable) {
      const backoffDelay = Math.min(5000 * Math.pow(2, attemptNumber - 1), 60000); // 5s, 10s, 20s, 40s, 60s
      const scheduled = await scheduleMediaRetry(job.data, backoffDelay, logPrefix);
      if (scheduled) {
        return; // Exit without error - retry is scheduled
      }
    }

    // Mark as permanently failed
    const existingLogOnFail = await prisma.messageLog.findUnique({
      where: { id: messageLogId },
      select: { metadata: true }
    });
    const existingMetadataOnFail = (existingLogOnFail?.metadata as Record<string, any>) || {};
    
    await prisma.messageLog.update({
      where: { id: messageLogId },
      data: {
        metadata: {
          ...existingMetadataOnFail,
          mediaPending: false,
          mediaDownloadFailed: true,
          mediaDownloadError: errorMessage,
          mediaDownloadAttempt: attemptNumber,
          mediaDownloadLastAttemptAt: new Date().toISOString(),
          mediaDownloadPermanentlyFailed: true
        }
      }
    });

    throw error;
  }
}

export function startMediaDownloadProcessor(): Worker | null {
  try {
    const connection = getQueueConnection();
    
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🖼️  MEDIA DOWNLOAD PROCESSOR - STARTING');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Queue: ${QUEUE_NAMES.MEDIA_DOWNLOAD}`);
    console.log(`   Concurrency: 3`);
    console.log(`   Rate Limit: 10 jobs/second`);
    console.log(`   Max Attempts: ${MAX_MEDIA_DOWNLOAD_ATTEMPTS}`);
    console.log('═══════════════════════════════════════════════════════════════');
    
    mediaDownloadWorker = new Worker<MediaDownloadJobData>(
      QUEUE_NAMES.MEDIA_DOWNLOAD,
      processMediaDownload,
      {
        connection,
        concurrency: 3,
        lockDuration: 120000,
        stalledInterval: 60000,
        limiter: {
          max: 10,
          duration: 1000
        }
      }
    );

    mediaDownloadWorker.on('completed', (job) => {
      const data = job.data;
      console.log(`[MEDIA_DL] ✅ Job ${job.id} COMPLETED - mediaId=${data.mediaId} type=${data.mediaType} contact=${data.contactPhone}`);
    });

    mediaDownloadWorker.on('failed', (job, err) => {
      const data = job?.data;
      console.error(`[MEDIA_DL] ❌ Job ${job?.id} FAILED after ${job?.attemptsMade} attempts:`, {
        error: err.message,
        mediaId: data?.mediaId,
        mediaType: data?.mediaType,
        contact: data?.contactPhone,
        businessId: data?.businessId
      });
    });

    mediaDownloadWorker.on('error', (err) => {
      console.error('[MEDIA_DL] ⚠️ Worker error:', err.message);
    });

    mediaDownloadWorker.on('active', (job) => {
      const data = job.data;
      console.log(`[MEDIA_DL] 🔄 Job ${job.id} ACTIVE - Starting download for mediaId=${data.mediaId} type=${data.mediaType}`);
    });

    console.log('[MEDIA_DL] ✅ Media download processor started successfully');
    return mediaDownloadWorker;
  } catch (error: any) {
    console.error('[MEDIA_DL] ❌ Failed to start processor:', error.message);
    console.error('[MEDIA_DL] Stack:', error.stack);
    return null;
  }
}

export function stopMediaDownloadProcessor(): void {
  if (mediaDownloadWorker) {
    mediaDownloadWorker.close();
    mediaDownloadWorker = null;
    console.log('[MEDIA_DL] Media download processor stopped');
  }
}
