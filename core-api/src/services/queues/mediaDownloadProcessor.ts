import { Worker, Job } from 'bullmq';
import prisma from '../prisma.js';
import { QUEUE_NAMES, MediaDownloadJobData, getQueueConnection } from './index.js';
import { MetaCloudService } from '../metaCloud.js';
import { uploadBuffer, isS3Configured } from '../storage.js';

let mediaDownloadWorker: Worker | null = null;

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

  const logPrefix = `[MEDIA_DL] job=${job.id} messageLog=${messageLogId} mediaId=${mediaId} attempt=${attemptNumber}`;
  console.log(`${logPrefix} Starting media download...`);

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

  } catch (error: any) {
    const errorMessage = error.message || 'Unknown error';
    const isCircuitBreakerOpen = errorMessage === 'META_CIRCUIT_BREAKER_OPEN';
    const isNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].some(
      code => errorMessage.includes(code) || error.code === code
    );

    console.error(`${logPrefix} FAILED: ${errorMessage}`, {
      isCircuitBreakerOpen,
      isNetworkError,
      code: error.code,
      status: error?.response?.status
    });

    // Merge with existing metadata on failure
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
          mediaPending: true,
          mediaDownloadFailed: true,
          mediaDownloadError: errorMessage,
          mediaDownloadAttempt: attemptNumber,
          mediaDownloadLastAttemptAt: new Date().toISOString()
        }
      }
    });

    throw error;
  }
}

export function startMediaDownloadProcessor(): Worker | null {
  try {
    const connection = getQueueConnection();
    
    mediaDownloadWorker = new Worker<MediaDownloadJobData>(
      QUEUE_NAMES.MEDIA_DOWNLOAD,
      processMediaDownload,
      {
        connection,
        concurrency: 3,
        limiter: {
          max: 10,
          duration: 1000
        }
      }
    );

    mediaDownloadWorker.on('completed', (job) => {
      console.log(`[MEDIA_DL] Job ${job.id} completed successfully`);
    });

    mediaDownloadWorker.on('failed', (job, err) => {
      console.error(`[MEDIA_DL] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
    });

    mediaDownloadWorker.on('error', (err) => {
      console.error('[MEDIA_DL] Worker error:', err.message);
    });

    console.log('[MEDIA_DL] Media download processor started (concurrency: 3)');
    return mediaDownloadWorker;
  } catch (error: any) {
    console.error('[MEDIA_DL] Failed to start processor:', error.message);
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
