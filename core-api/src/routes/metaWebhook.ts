import { Router, Request, Response } from 'express';
import prisma, { withRetry } from '../services/prisma.js';
import { MetaCloudService, MetaWebhookPayload, ParsedMessage, ParsedStatus, fetchCatalogProductDetails } from '../services/metaCloud.js';
import { processIncomingMessage } from '../services/messageIngest.js';
import { uploadBuffer, isS3Configured } from '../services/storage.js';
import { dispatchUserMessage, dispatchMediaUpdate } from '../services/webhookService.js';
import { webhookLogger, logWebhookEvent } from '../services/logger.js';
import { getRedisConnection, isRedisAvailable } from '../services/redis.js';
import { getMediaDownloadQueue, MediaDownloadJobData } from '../services/queues/index.js';

const router = Router();

type MetaProviderType = 'META_CLOUD' | 'META_COEXIST' | 'META_MANAGED';

// Redis-based deduplication with TTL (atomic SET NX)
const DEDUP_TTL_SECONDS = 300; // 5 minutes
const processedMessages = new Map<string, number>(); // In-memory fallback
const MAX_MEMORY_ENTRIES = 5000;

async function isMessageAlreadyProcessed(messageId: string): Promise<boolean> {
  if (!messageId) return false;
  
  const dedupKey = `meta_webhook_dedup:${messageId}`;
  
  // Try Redis first with ATOMIC SET NX EX (prevents race conditions)
  if (isRedisAvailable()) {
    try {
      const redis = getRedisConnection();
      // SET key value EX ttl NX - returns 'OK' if set, null if key already exists
      const result = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      
      if (result === null) {
        // Key already existed - duplicate
        console.log(`[DEDUP-REDIS] Message ${messageId} already processed, skipping`);
        return true;
      }
      // Key was set - first time processing
      return false;
    } catch (err) {
      console.warn('[DEDUP] Redis error, falling back to memory:', err);
    }
  }
  
  // Fallback to in-memory with LRU-style cleanup
  const now = Date.now();
  
  // Check if already processed
  if (processedMessages.has(messageId)) {
    const timestamp = processedMessages.get(messageId)!;
    if (now - timestamp < DEDUP_TTL_SECONDS * 1000) {
      console.log(`[DEDUP-MEM] Message ${messageId} already processed, skipping`);
      return true;
    }
    // Expired entry, will be updated below
  }
  
  // Cleanup old entries BEFORE adding (prevents unbounded growth)
  if (processedMessages.size >= MAX_MEMORY_ENTRIES) {
    const cutoff = now - (DEDUP_TTL_SECONDS * 1000);
    let deleted = 0;
    for (const [key, ts] of processedMessages.entries()) {
      if (ts < cutoff) {
        processedMessages.delete(key);
        deleted++;
      }
      // Stop after cleaning enough
      if (deleted >= 1000) break;
    }
    // If still too large, remove oldest entries
    if (processedMessages.size >= MAX_MEMORY_ENTRIES) {
      const entries = Array.from(processedMessages.entries())
        .sort((a, b) => a[1] - b[1])
        .slice(0, 1000);
      for (const [key] of entries) {
        processedMessages.delete(key);
      }
    }
  }
  
  // Mark as processed
  processedMessages.set(messageId, now);
  
  return false;
}

const GLOBAL_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token_2024';

async function findInstanceByPhoneNumberId(phoneNumberId: string) {
  return withRetry(async () => {
    const metaCredential = await prisma.metaCredential.findFirst({
      where: { phoneNumberId },
      include: { 
        instance: { 
          include: { business: true } 
        } 
      }
    });
    
    if (metaCredential?.instance) {
      return {
        instance: metaCredential.instance,
        accessToken: metaCredential.accessToken,
        phoneNumberId: metaCredential.phoneNumberId,
        businessId: metaCredential.businessId,
        providerType: 'META_CLOUD' as MetaProviderType
      };
    }
    
    const metaCoexistCredential = await prisma.metaCoexistCredential.findFirst({
      where: { phoneNumberId },
      include: { 
        instance: { 
          include: { business: true } 
        } 
      }
    });
    
    if (metaCoexistCredential?.instance) {
      return {
        instance: metaCoexistCredential.instance,
        accessToken: metaCoexistCredential.systemAccessToken || metaCoexistCredential.userAccessToken,
        phoneNumberId: metaCoexistCredential.phoneNumberId,
        businessId: metaCoexistCredential.metaBusinessId,
        wabaId: metaCoexistCredential.wabaId,
        platformBusinessId: metaCoexistCredential.instance.businessId,
        providerType: 'META_COEXIST' as MetaProviderType
      };
    }
    
    const metaManagedCredential = await (prisma as any).metaManagedCredential.findFirst({
      where: { phoneNumberId },
      include: { 
        instance: { 
          include: { business: true } 
        } 
      }
    });
    
    if (metaManagedCredential?.instance) {
      return {
        instance: metaManagedCredential.instance,
        accessToken: process.env.PLATFORM_ACCESS_TOKEN || '',
        phoneNumberId: metaManagedCredential.phoneNumberId,
        businessId: metaManagedCredential.instance.businessId,
        wabaId: process.env.PLATFORM_WABA_ID || '',
        platformBusinessId: metaManagedCredential.instance.businessId,
        providerType: 'META_MANAGED' as MetaProviderType
      };
    }
    
    return null;
  });
}

export async function processWebhookPayload(payload: MetaWebhookPayload) {
  const parsed = MetaCloudService.parseWebhookMessage(payload);
  
  if (!parsed) {
    webhookLogger.debug({ object: payload.object }, 'Ignored non-WhatsApp payload');
    return;
  }

  if (parsed.messages.length === 0 && parsed.statuses.length === 0) {
    webhookLogger.debug({ phoneNumberId: parsed.phoneNumberId }, 'No messages or statuses to process');
    return;
  }

  const instanceData = await findInstanceByPhoneNumberId(parsed.phoneNumberId);
  
  if (!instanceData) {
    const allCoexist = await prisma.metaCoexistCredential.findMany({
      select: { phoneNumberId: true, displayPhone: true, instanceId: true }
    });
    const allMeta = await prisma.metaCredential.findMany({
      select: { phoneNumberId: true, instanceId: true }
    });
    
    console.error('================================================================================');
    console.error('[META WEBHOOK] ERROR: No instance found for phone_number_id');
    console.error(`[META WEBHOOK] Searched for: ${parsed.phoneNumberId}`);
    console.error(`[META WEBHOOK] Display phone from webhook: ${parsed.displayPhoneNumber}`);
    console.error('[META WEBHOOK] Existing META_COEXIST credentials:', JSON.stringify(allCoexist.map(c => ({
      phoneNumberId: c.phoneNumberId || 'NULL',
      displayPhone: c.displayPhone,
      instanceId: c.instanceId
    })), null, 2));
    console.error('[META WEBHOOK] Existing META_CLOUD credentials:', JSON.stringify(allMeta.map(c => ({
      phoneNumberId: c.phoneNumberId || 'NULL',
      instanceId: c.instanceId
    })), null, 2));
    console.error('[META WEBHOOK] FIX: Use /auth/meta-coexist/repair/:instanceId endpoint to update phoneNumberId');
    console.error('================================================================================');
    
    logWebhookEvent({
      eventType: 'error',
      phoneNumberId: parsed.phoneNumberId,
      error: 'No instance found for phone_number_id',
      metadata: { 
        displayPhone: parsed.displayPhoneNumber,
        existingCoexistPhones: allCoexist.map(c => c.phoneNumberId),
        existingMetaPhones: allMeta.map(c => c.phoneNumberId)
      }
    });
    return;
  }

  const { instance, accessToken, phoneNumberId, businessId, providerType } = instanceData;

  webhookLogger.info({
    phoneNumberId: parsed.phoneNumberId,
    displayPhone: parsed.displayPhoneNumber,
    instanceId: instance.id,
    provider: providerType,
    businessId: instance.businessId,
    messageCount: parsed.messages.length,
    statusCount: parsed.statuses.length
  }, `Processing ${parsed.messages.length} messages and ${parsed.statuses.length} statuses`);

  const metaService = new MetaCloudService({
    accessToken,
    phoneNumberId,
    businessId
  });

  for (const msg of parsed.messages) {
    await processMessage(msg, instance, metaService, providerType, parsed.displayPhoneNumber);
  }

  for (const status of parsed.statuses) {
    await processStatusUpdate(status, instance, providerType);
  }
}

async function processMessage(
  msg: ParsedMessage, 
  instance: any, 
  metaService: MetaCloudService, 
  providerType: MetaProviderType,
  businessPhoneNumber?: string
) {
  const startTime = Date.now();

  // [COEXIST-DEBUG] Log ALL incoming messages for debugging
  console.log(`[COEXIST-DEBUG] processMessage ENTRY`, JSON.stringify({
    messageId: msg.messageId,
    from: msg.from,
    type: msg.type,
    text: msg.text?.substring(0, 50),
    provider: providerType,
    businessPhone: businessPhoneNumber,
    instanceId: instance.id,
    businessId: instance.businessId,
    contextFrom: msg.contextFrom,
    contextMessageId: msg.contextMessageId,
    timestamp: new Date().toISOString()
  }));

  // DEDUPLICATION CHECK - prevent duplicate webhook events
  if (await isMessageAlreadyProcessed(msg.messageId)) {
    webhookLogger.info({
      messageId: msg.messageId,
      from: msg.from,
      reason: 'duplicate'
    }, 'Skipping duplicate message');
    return;
  }
  
  // COEXISTENCE MODE: Detect messages sent from WhatsApp App (not from API)
  // In coexistence, when business sends from app, msg.from == business phone number
  const normalizedFrom = msg.from?.replace(/\D/g, '') || '';
  const normalizedBusinessPhone = businessPhoneNumber?.replace(/\D/g, '') || '';
  const isBusinessOutbound = normalizedBusinessPhone && normalizedFrom === normalizedBusinessPhone;
  
  // [COEXIST-DEBUG] Log the business outbound detection logic
  console.log(`[COEXIST-DEBUG] Outbound detection`, JSON.stringify({
    messageId: msg.messageId,
    normalizedFrom,
    normalizedBusinessPhone,
    isBusinessOutbound,
    contextFrom: msg.contextFrom,
    provider: providerType
  }));
  
  if (isBusinessOutbound) {
    // This is a message sent by the business from WhatsApp App
    // Save it as outbound for context (CRM visibility + agent memory) but don't trigger AI
    // ONLY store if we can deterministically identify the recipient from contextFrom (reply context)
    const recipientPhone = msg.contextFrom?.replace(/\D/g, '') || '';
    
    console.log(`[COEXIST-DEBUG] isBusinessOutbound=TRUE`, JSON.stringify({
      messageId: msg.messageId,
      recipientPhone,
      hasRecipient: !!recipientPhone,
      text: msg.text?.substring(0, 50),
      type: msg.type
    }));
    
    if (!recipientPhone) {
      // Without contextFrom we can't reliably determine the recipient
      // This is expected for messages that aren't direct replies
      // The status.sent fallback will create a placeholder if needed
      console.log(`[COEXIST-DEBUG] NO recipientPhone - will use status.sent fallback`, JSON.stringify({
        messageId: msg.messageId,
        from: msg.from,
        type: msg.type
      }));
      webhookLogger.debug({
        messageId: msg.messageId,
        from: msg.from,
        type: msg.type
      }, 'WhatsApp App outbound message without contextFrom - will use status.sent fallback');
      return;
    }
    
    // Check if already exists (deduplication with status.sent handler)
    const existing = await prisma.messageLog.findFirst({
      where: { providerMessageId: msg.messageId, businessId: instance.businessId }
    });
    
    if (existing) {
      // Update placeholder with real content if needed
      if (existing.message?.includes('[Mensaje enviado desde WhatsApp App]')) {
        await prisma.messageLog.update({
          where: { id: existing.id },
          data: {
            message: msg.text || msg.caption || '[Multimedia desde WhatsApp App]',
            recipient: recipientPhone,
            mediaUrl: msg.mediaId ? `meta:${msg.mediaId}` : undefined,
            metadata: {
              ...(existing.metadata as any || {}),
              source: 'whatsapp_app',
              type: msg.type,
              updatedWithRealContent: true
            }
          }
        });
        webhookLogger.info({ messageId: msg.messageId }, 'Updated placeholder with real content');
      }
      return;
    }
    
    const createdLog = await prisma.messageLog.create({
      data: {
        businessId: instance.businessId,
        instanceId: instance.id,
        direction: 'outbound',
        sender: 'business',
        recipient: recipientPhone,
        message: msg.text || msg.caption || '[Multimedia desde WhatsApp App]',
        mediaUrl: msg.mediaId ? `meta:${msg.mediaId}` : undefined,
        providerMessageId: msg.messageId,
        metadata: {
          source: 'whatsapp_app',
          provider: providerType,
          type: msg.type,
          timestamp: msg.timestamp,
          pushName: msg.pushName
        }
      }
    });
    
    console.log(`[COEXIST-DEBUG] MessageLog CREATED for business outbound`, JSON.stringify({
      logId: createdLog.id,
      messageId: msg.messageId,
      recipient: recipientPhone,
      message: (msg.text || msg.caption || '[Multimedia]').substring(0, 50),
      direction: 'outbound',
      sender: 'business'
    }));
    
    webhookLogger.info({
      messageId: msg.messageId,
      from: msg.from,
      recipient: recipientPhone,
      type: msg.type,
      hasText: !!(msg.text || msg.caption)
    }, 'Stored WhatsApp App outbound message (coexistence mode)');
    
    return; // Don't process as inbound - no AI trigger
  }

  logWebhookEvent({
    eventType: 'message_received',
    phoneNumberId: metaService['credentials'].phoneNumberId,
    instanceId: instance.id,
    businessId: instance.businessId,
    provider: providerType,
    messageId: msg.messageId,
    from: msg.from,
    messageType: msg.type,
    mediaId: msg.mediaId,
    metadata: {
      pushName: msg.pushName,
      hasContext: !!msg.contextMessageId,
      isVoiceNote: msg.isVoiceNote,
      isAnimatedSticker: msg.isAnimatedSticker
    }
  });

  let mediaUrl: string | undefined;
  let mediaPendingData: { mediaId: string; mimetype: string; mediaType: string } | null = null;
  
  // MEDIA FLOW: Prefer async queue, fallback to sync if Redis unavailable
  if (msg.mediaId) {
    const mediaQueue = getMediaDownloadQueue();
    
    if (mediaQueue) {
      // ASYNC PATH: Queue for background download (preferred)
      console.log(`[META WEBHOOK MEDIA] Will queue async download for ${msg.type}: mediaId=${msg.mediaId}, from=${msg.from}`);
      
      mediaPendingData = {
        mediaId: msg.mediaId,
        mimetype: msg.mimetype || 'application/octet-stream',
        mediaType: msg.type
      };
      
      mediaUrl = undefined;
      // Note: logWebhookEvent will be called after successful enqueue in the second phase
    } else {
      // SYNC FALLBACK: No Redis available, download immediately with retries
      console.log(`[META WEBHOOK MEDIA] No queue available, downloading sync for ${msg.type}: mediaId=${msg.mediaId}`);
      const mediaStartTime = Date.now();
      const maxSyncRetries = 3;
      
      for (let attempt = 0; attempt <= maxSyncRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = 1500 * Math.pow(1.5, attempt - 1);
            console.log(`[META WEBHOOK MEDIA] Retry attempt ${attempt}/${maxSyncRetries} after ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
          }
          
          const metaMediaUrl = await metaService.getMediaUrl(msg.mediaId);
          console.log(`[META WEBHOOK MEDIA] Got Meta URL: ${metaMediaUrl?.substring(0, 80)}...`);
          
          if (isS3Configured()) {
            const mediaBuffer = await metaService.downloadMedia(metaMediaUrl);
            const uploadResult = await uploadBuffer(
              mediaBuffer, 
              msg.mimetype || 'application/octet-stream', 
              instance.businessId
            );
            
            if (uploadResult) {
              mediaUrl = uploadResult.url;
              logWebhookEvent({
                eventType: 'media_upload',
                phoneNumberId: metaService['credentials'].phoneNumberId,
                instanceId: instance.id,
                businessId: instance.businessId,
                provider: providerType,
                mediaId: msg.mediaId,
                mediaType: msg.type,
                duration: Date.now() - mediaStartTime,
                metadata: { url: mediaUrl, mimetype: msg.mimetype, syncFallback: true, attempts: attempt + 1 }
              });
            } else {
              mediaUrl = metaMediaUrl;
              console.warn(`[META WEBHOOK MEDIA] S3 upload failed, using Meta URL`);
            }
          } else {
            mediaUrl = metaMediaUrl;
          }
          break; // Success, exit retry loop
        } catch (error: any) {
          const isNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].some(
            code => error.message?.includes(code) || error.code === code
          );
          
          if (attempt < maxSyncRetries && isNetworkError) {
            console.warn(`[META WEBHOOK MEDIA] Sync download attempt ${attempt + 1} failed (retrying): ${error.message}`);
            continue;
          }
          
          console.error(`[META WEBHOOK MEDIA] Sync download failed after ${attempt + 1} attempts: ${error.message}`);
          // Save Meta URL as fallback (will expire, but better than nothing)
          try {
            const metaMediaUrl = await metaService.getMediaUrl(msg.mediaId);
            mediaUrl = metaMediaUrl;
            console.log(`[META WEBHOOK MEDIA] Using temporary Meta URL as fallback`);
          } catch {
            console.error(`[META WEBHOOK MEDIA] Could not get Meta URL either`);
          }
          break;
        }
      }
    }
  } else if (['image', 'video', 'audio', 'sticker', 'document'].includes(msg.type)) {
    console.warn(`[META WEBHOOK MEDIA] Received ${msg.type} message but NO mediaId present! from=${msg.from}, messageId=${msg.messageId}`);
  }

  // Skip AI if media is pending async download - AI will be called after media is ready
  const skipAI = !!mediaPendingData;
  
  // Fetch quoted message content if contextMessageId exists
  let quotedMessage: any = undefined;
  if (msg.contextMessageId) {
    try {
      const quotedLog = await prisma.messageLog.findFirst({
        where: {
          businessId: instance.businessId,
          providerMessageId: msg.contextMessageId
        },
        select: {
          id: true,
          message: true,
          direction: true,
          mediaUrl: true,
          metadata: true
        }
      });
      
      if (quotedLog) {
        const metadata = quotedLog.metadata as any || {};
        quotedMessage = {
          messageId: msg.contextMessageId,
          from: msg.contextFrom || (quotedLog.direction === 'inbound' ? metadata.contactPhone : 'business'),
          text: quotedLog.message || '',
          type: metadata.mediaType || metadata.type || 'text',
          mediaUrl: quotedLog.mediaUrl || undefined,
          caption: metadata.caption || undefined
        };
        console.log(`[META WEBHOOK] Quoted message resolved:`, {
          messageId: msg.contextMessageId,
          textPreview: quotedMessage.text?.substring(0, 50)
        });
      }
    } catch (err: any) {
      console.warn(`[META WEBHOOK] Failed to fetch quoted message:`, err.message);
    }
  }
  
  // Enrich referred product from catalog if present
  let enrichedReferredProduct = msg.referredProduct;
  if (msg.referredProduct?.productId) {
    const productRetailerId = msg.referredProduct.productId;
    
    console.log(`[META WEBHOOK] Enriching referred product:`, {
      catalogId: msg.referredProduct.catalogId,
      productId: productRetailerId
    });
    
    // Strategy 1: Try to find product in local database first (faster and more reliable)
    try {
      // Search for product by title containing the retailer ID or by exact title match
      // Since we don't have a retailer_id field, we search by title or description containing the SKU
      const localProduct = await prisma.product.findFirst({
        where: {
          businessId: instance.businessId,
          OR: [
            { title: { contains: productRetailerId, mode: 'insensitive' } },
            { description: { contains: productRetailerId, mode: 'insensitive' } },
            // Also try exact match on title (SKU is often the product title)
            { title: productRetailerId }
          ]
        },
        select: {
          id: true,
          title: true,
          description: true,
          price: true,
          imageUrl: true,
          imageUrls: true
        }
      });
      
      if (localProduct) {
        const currencySymbol = 'S/'; // Default, could get from business settings
        enrichedReferredProduct = {
          ...msg.referredProduct,
          title: localProduct.title,
          description: localProduct.description || undefined,
          price: localProduct.price,
          currency: currencySymbol,
          imageUrl: localProduct.imageUrl || localProduct.imageUrls?.[0] || undefined
        };
        console.log(`[META WEBHOOK] ✅ Referred product found in LOCAL DB:`, {
          productId: productRetailerId,
          localId: localProduct.id,
          title: localProduct.title,
          price: localProduct.price
        });
      }
    } catch (localErr: any) {
      console.warn(`[META WEBHOOK] Local product search failed:`, localErr.message);
    }
    
    // Strategy 2: If not found locally and we have catalogId, try Meta API
    if (!enrichedReferredProduct?.title && msg.referredProduct?.catalogId) {
      try {
        const serviceAccessToken = (metaService as any)['credentials']?.accessToken;
        if (serviceAccessToken) {
          const productDetails = await fetchCatalogProductDetails(
            serviceAccessToken,
            msg.referredProduct.catalogId,
            productRetailerId
          );
          
          if (productDetails) {
            enrichedReferredProduct = {
              ...msg.referredProduct,
              title: productDetails.title || msg.referredProduct.title,
              description: productDetails.description || msg.referredProduct.description,
              price: productDetails.price || msg.referredProduct.price,
              currency: productDetails.currency || msg.referredProduct.currency,
              imageUrl: productDetails.imageUrl || msg.referredProduct.imageUrl
            };
            console.log(`[META WEBHOOK] ✅ Referred product enriched from META API:`, {
              productId: productRetailerId,
              title: enrichedReferredProduct.title,
              price: enrichedReferredProduct.price
            });
          } else {
            console.warn(`[META WEBHOOK] ⚠️ Meta API returned no product details for:`, productRetailerId);
          }
        } else {
          console.warn(`[META WEBHOOK] ⚠️ No accessToken available for catalog lookup`);
        }
      } catch (metaErr: any) {
        console.warn(`[META WEBHOOK] Meta catalog API failed:`, metaErr.message);
      }
    }
    
    // Strategy 3: If all else fails, ensure at least productId is visible as title
    if (!enrichedReferredProduct?.title && productRetailerId !== 'unknown') {
      enrichedReferredProduct = {
        ...msg.referredProduct,
        title: `SKU: ${productRetailerId}`, // At least show the SKU as title
        description: undefined
      };
      console.log(`[META WEBHOOK] ⚠️ Using productId as fallback title:`, productRetailerId);
    }
  }
  
  const processed = await processIncomingMessage({
    businessId: instance.businessId,
    instanceId: instance.id,
    provider: providerType,
    from: msg.from,
    pushName: msg.pushName,
    messageId: msg.messageId,
    timestamp: msg.timestamp,
    type: msg.type,
    text: msg.text,
    mediaUrl,
    mimetype: msg.mimetype,
    caption: msg.caption,
    filename: msg.filename,
    location: msg.location,
    contextMessageId: msg.contextMessageId,
    contacts: msg.contacts,
    buttonPayload: msg.buttonPayload,
    interactiveId: msg.interactiveId,
    reaction: msg.reaction,
    order: msg.order,
    skipAI,
    quotedMessage,
    referredProduct: enrichedReferredProduct
  });
  
  // Only dispatch webhook if message was actually processed (not a duplicate in DB)
  if (processed !== false) {
    // Get the internal Efficore message ID from the database
    const messageLog = await prisma.messageLog.findFirst({
      where: {
        businessId: instance.businessId,
        providerMessageId: msg.messageId
      },
      select: { id: true }
    });
    
    // ASYNC MEDIA: Enqueue download for media messages (with fallback on failure)
    if (mediaPendingData && messageLog?.id) {
      const mediaQueue = getMediaDownloadQueue();
      let enqueueSuccess = false;
      
      if (mediaQueue) {
        try {
          const jobData: MediaDownloadJobData = {
            messageLogId: messageLog.id,
            businessId: instance.businessId,
            instanceId: instance.id,
            mediaId: mediaPendingData.mediaId,
            mediaType: mediaPendingData.mediaType,
            mimetype: mediaPendingData.mimetype,
            provider: providerType,
            accessToken: metaService['credentials'].accessToken,
            phoneNumberId: metaService['credentials'].phoneNumberId,
            contactPhone: msg.from,
            attemptNumber: 1
          };
          
          console.log(`[META WEBHOOK MEDIA] 📤 Enqueueing media job:`, {
            jobId: `media-${mediaPendingData.mediaId}`,
            mediaType: mediaPendingData.mediaType,
            mimetype: mediaPendingData.mimetype,
            contactPhone: msg.from,
            businessId: instance.businessId,
            instanceId: instance.id
          });
          
          await mediaQueue.add(`media-${mediaPendingData.mediaId}`, jobData, {
            delay: 500,
            priority: 1
          });
          
          enqueueSuccess = true;
          console.log(`[META WEBHOOK MEDIA] ✅ Job enqueued successfully: media-${mediaPendingData.mediaId}`);
          
          // Update messageLog to mark media as pending
          const existingLog = await prisma.messageLog.findUnique({
            where: { id: messageLog.id },
            select: { metadata: true }
          });
          const existingMetadata = (existingLog?.metadata as Record<string, any>) || {};
          
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              metadata: {
                ...existingMetadata,
                mediaPending: true,
                mediaId: mediaPendingData.mediaId,
                mediaType: mediaPendingData.mediaType,
                mimetype: mediaPendingData.mimetype
              }
            }
          });
          
          console.log(`[META WEBHOOK MEDIA] Enqueued async download for mediaId=${mediaPendingData.mediaId}`);
          
          logWebhookEvent({
            eventType: 'media_download',
            phoneNumberId: metaService['credentials'].phoneNumberId,
            instanceId: instance.id,
            businessId: instance.businessId,
            provider: providerType,
            mediaId: mediaPendingData.mediaId,
            mediaType: mediaPendingData.mediaType,
            metadata: { asyncDownload: true, status: 'queued' }
          });
        } catch (enqueueError: any) {
          console.error(`[META WEBHOOK MEDIA] Queue add failed: ${enqueueError.message}`);
          enqueueSuccess = false;
        }
      }
      
      // FALLBACK: If queue unavailable or enqueue failed, try sync download now
      if (!enqueueSuccess) {
        console.warn(`[META WEBHOOK MEDIA] Fallback sync download for mediaId=${mediaPendingData.mediaId}`);
        
        // Get existing metadata to preserve it
        const existingLogForFallback = await prisma.messageLog.findUnique({
          where: { id: messageLog.id },
          select: { metadata: true }
        });
        const existingMetadataForFallback = (existingLogForFallback?.metadata as Record<string, any>) || {};
        
        try {
          const metaMediaUrl = await metaService.getMediaUrl(mediaPendingData.mediaId);
          let finalUrl = metaMediaUrl;
          
          if (isS3Configured()) {
            const mediaBuffer = await metaService.downloadMedia(metaMediaUrl);
            const uploadResult = await uploadBuffer(mediaBuffer, mediaPendingData.mimetype, instance.businessId);
            if (uploadResult) {
              finalUrl = uploadResult.url;
            }
          }
          
          // Update messageLog with the media URL (merge with existing metadata)
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              mediaUrl: finalUrl,
              metadata: {
                ...existingMetadataForFallback,
                mediaPending: false,
                mediaId: mediaPendingData.mediaId,
                mediaDownloadFallback: true,
                mediaDownloadCompletedAt: new Date().toISOString()
              }
            }
          });
          console.log(`[META WEBHOOK MEDIA] Fallback download success: ${finalUrl.substring(0, 60)}...`);
          
          // Also update mediaUrl for the dispatchUserMessage below
          mediaUrl = finalUrl;
          
          // Dispatch media_update webhook for fallback downloads
          dispatchMediaUpdate(
            instance.businessId,
            msg.from,
            messageLog.id,
            finalUrl,
            mediaPendingData.mediaType,
            instance.id
          ).catch(err => console.warn(`[META WEBHOOK MEDIA] Failed to dispatch media_update: ${err.message}`));
        } catch (fallbackError: any) {
          console.error(`[META WEBHOOK MEDIA] Fallback download also failed: ${fallbackError.message}`);
          // Mark as failed so UI knows media is not available (merge metadata)
          await prisma.messageLog.update({
            where: { id: messageLog.id },
            data: {
              metadata: {
                ...existingMetadataForFallback,
                mediaPending: false,
                mediaDownloadFailed: true,
                mediaId: mediaPendingData.mediaId,
                mediaError: fallbackError.message
              }
            }
          });
        }
      }
    }
    
    // Build message text for webhook - handle special types like order
    let webhookMessage = msg.caption || msg.text || '';
    
    if (msg.type === 'order' && msg.order) {
      const orderItems = msg.order.items.map((item: any) => 
        `• ${item.productId} x${item.quantity} - ${item.currency} ${item.price.toFixed(2)}`
      ).join('\n');
      const totalAmount = msg.order.items.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
      const currency = msg.order.items[0]?.currency || 'USD';
      
      webhookMessage = `🛒 PEDIDO DEL CATÁLOGO\nCatálogo: ${msg.order.catalogId}\nProductos:\n${orderItems}\nTotal: ${currency} ${totalAmount.toFixed(2)}`;
    } else if (msg.type === 'location' && msg.location) {
      webhookMessage = `Ubicación: ${msg.location.latitude}, ${msg.location.longitude}`;
      if (msg.location.name) webhookMessage += ` (${msg.location.name})`;
    }
    
    // Only dispatch user_message webhook if media is NOT pending async download
    // If media is pending, mediaDownloadProcessor will dispatch after download completes with the mediaUrl
    if (!mediaPendingData) {
      dispatchUserMessage(
        instance.businessId,
        msg.from,
        msg.pushName || '',
        webhookMessage,
        msg.type,
        mediaUrl,
        { 
          order: msg.order || undefined,
          efficoreMessageId: messageLog?.id,
          metaMessageId: msg.messageId
        },
        instance.id
      ).catch(err => webhookLogger.error({ error: err.message }, 'Failed to dispatch user_message webhook'));
    } else {
      webhookLogger.debug({ messageId: msg.messageId }, 'Skipping user_message webhook - media pending, will dispatch after download');
    }
  }

  webhookLogger.debug({
    messageId: msg.messageId,
    from: msg.from,
    duration: Date.now() - startTime,
    processed: processed !== false
  }, 'Message processing complete');
}

async function processStatusUpdate(status: ParsedStatus, instance: any, providerType: MetaProviderType) {
  // [COEXIST-DEBUG] Log ALL status updates
  console.log(`[COEXIST-DEBUG] processStatusUpdate ENTRY`, JSON.stringify({
    status: status.status,
    messageId: status.messageId,
    recipientId: status.recipientId,
    provider: providerType,
    instanceId: instance.id,
    businessId: instance.businessId,
    conversationId: status.conversationId,
    originType: status.originType,
    timestamp: new Date().toISOString()
  }));
  
  logWebhookEvent({
    eventType: 'status_update',
    phoneNumberId: instance.phoneNumber,
    instanceId: instance.id,
    businessId: instance.businessId,
    provider: providerType,
    messageId: status.messageId,
    to: status.recipientId,
    status: status.status,
    metadata: {
      conversationId: status.conversationId,
      originType: status.originType,
      isBillable: status.isBillable,
      errorCode: status.errorCode,
      errorTitle: status.errorTitle,
      errorMessage: status.errorMessage
    }
  });

  try {
    const existingLog = await prisma.messageLog.findFirst({
      where: {
        businessId: instance.businessId,
        OR: [
          { providerMessageId: status.messageId },
          { metadata: { path: ['messageId'], equals: status.messageId } }
        ]
      }
    });
    
    if (existingLog) {
      const existingMetadata = (existingLog.metadata as Record<string, any>) || {};
      const updatedMetadata = {
        ...existingMetadata,
        deliveryStatus: status.status,
        deliveryTimestamp: status.timestamp,
        conversationId: status.conversationId,
        ...(status.errorCode && { errorCode: status.errorCode }),
        ...(status.errorMessage && { errorMessage: status.errorMessage })
      };
      
      await prisma.messageLog.update({
        where: { id: existingLog.id },
        data: { metadata: updatedMetadata }
      });
      
      webhookLogger.debug({
        messageId: status.messageId,
        status: status.status
      }, 'Message status updated');
    } else if (status.status === 'sent') {
      // Message sent from WhatsApp App (not from API) - create passive memory record
      // This captures business human responses for AI context
      const cleanRecipient = status.recipientId?.replace(/\D/g, '') || '';
      
      console.log(`[COEXIST-DEBUG] status.sent received (no existingLog)`, JSON.stringify({
        messageId: status.messageId,
        cleanRecipient,
        hasRecipient: !!cleanRecipient,
        provider: providerType
      }));
      
      if (cleanRecipient) {
        const createdLog = await prisma.messageLog.create({
          data: {
            businessId: instance.businessId,
            instanceId: instance.id,
            direction: 'outbound',
            sender: 'business',
            recipient: cleanRecipient,
            message: '[Mensaje enviado desde WhatsApp App]',
            providerMessageId: status.messageId,
            metadata: {
              source: 'whatsapp_app',
              provider: providerType,
              conversationId: status.conversationId,
              originType: status.originType,
              deliveryStatus: status.status,
              timestamp: status.timestamp
            }
          }
        });
        
        console.log(`[COEXIST-DEBUG] MessageLog CREATED via status.sent fallback`, JSON.stringify({
          logId: createdLog.id,
          messageId: status.messageId,
          recipient: cleanRecipient,
          message: '[Mensaje enviado desde WhatsApp App]',
          direction: 'outbound',
          sender: 'business'
        }));
        
        webhookLogger.info({
          messageId: status.messageId,
          recipientId: cleanRecipient,
          businessId: instance.businessId
        }, 'Created message log for WhatsApp App outbound message');
      } else {
        console.log(`[COEXIST-DEBUG] status.sent SKIPPED - no recipient`, JSON.stringify({
          messageId: status.messageId,
          recipientId: status.recipientId
        }));
      }
    } else {
      webhookLogger.debug({
        messageId: status.messageId,
        status: status.status
      }, 'No message log found for status update');
    }
  } catch (error: any) {
    webhookLogger.error({ 
      error: error.message, 
      messageId: status.messageId 
    }, 'Failed to update message status');
  }
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('[META WEBHOOK] Centralized verification request:', { mode, token: token ? '***' : 'none' });

    if (mode !== 'subscribe') {
      return res.status(400).send('Invalid mode');
    }

    if (token !== GLOBAL_WEBHOOK_VERIFY_TOKEN) {
      console.error('[META WEBHOOK] Invalid verify token');
      return res.status(403).send('Invalid verify token');
    }

    console.log('[META WEBHOOK] Centralized webhook verified successfully');
    res.status(200).send(challenge);
  } catch (error: any) {
    console.error('[META WEBHOOK] Verification error:', error);
    res.status(500).send('Internal error');
  }
});

// ============================================================================
// WEBHOOK RAW LOGS - Debug endpoint to query all raw Meta webhooks
// ============================================================================
router.get('/raw-logs', async (req: Request, res: Response) => {
  try {
    const { phoneNumberId, limit = '50', offset = '0', source = 'META' } = req.query;
    
    const where: any = { source: source as string };
    if (phoneNumberId) {
      where.phoneNumberId = phoneNumberId as string;
    }
    
    const logs = await prisma.webhookRawLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 50, 200),
      skip: parseInt(offset as string) || 0,
      select: {
        id: true,
        source: true,
        endpoint: true,
        phoneNumberId: true,
        businessId: true,
        messageCount: true,
        statusCount: true,
        processingError: true,
        processedAt: true,
        createdAt: true,
        body: true
      }
    });
    
    const total = await prisma.webhookRawLog.count({ where });
    
    res.json({
      success: true,
      data: logs,
      pagination: {
        total,
        limit: parseInt(limit as string) || 50,
        offset: parseInt(offset as string) || 0
      }
    });
  } catch (error: any) {
    console.error('[WEBHOOK RAW LOGS] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a single raw log by ID (full payload)
router.get('/raw-logs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const log = await prisma.webhookRawLog.findUnique({
      where: { id }
    });
    
    if (!log) {
      return res.status(404).json({ success: false, error: 'Log not found' });
    }
    
    res.json({ success: true, data: log });
  } catch (error: any) {
    console.error('[WEBHOOK RAW LOGS] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  
  console.log('='.repeat(80));
  console.log(`[META WEBHOOK] === INCOMING REQUEST @ ${timestamp} ===`);
  console.log('[META WEBHOOK] Method:', req.method);
  console.log('[META WEBHOOK] URL:', req.originalUrl);
  console.log('[META WEBHOOK] Content-Type:', req.headers['content-type']);
  console.log('[META WEBHOOK] User-Agent:', req.headers['user-agent']);
  console.log('[META WEBHOOK] X-Hub-Signature-256:', req.headers['x-hub-signature-256'] ? 'present' : 'missing');
  console.log('[META WEBHOOK] Body type:', typeof req.body);
  console.log('[META WEBHOOK] Body is null:', req.body === null);
  console.log('[META WEBHOOK] Body is undefined:', req.body === undefined);
  console.log('[META WEBHOOK] Body keys:', req.body ? Object.keys(req.body) : 'N/A');
  console.log('[META WEBHOOK] RAW PAYLOAD:', JSON.stringify(req.body, null, 2));
  console.log('='.repeat(80));
  
  // ========================================================================
  // CRITICAL: Save RAW webhook payload to DB BEFORE any processing
  // This ensures we never lose any Meta webhook events for debugging
  // ========================================================================
  let rawLogId: string | null = null;
  try {
    const payload = req.body as MetaWebhookPayload;
    const phoneNumberId = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const messageCount = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.length || 0;
    const statusCount = payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.length || 0;
    
    const rawLog = await prisma.webhookRawLog.create({
      data: {
        source: 'META',
        endpoint: req.originalUrl || '/webhook/meta',
        method: req.method || 'POST',
        headers: {
          'content-type': req.headers['content-type'],
          'user-agent': req.headers['user-agent'],
          'x-hub-signature-256': req.headers['x-hub-signature-256'] ? 'present' : 'missing'
        },
        queryParams: req.query || {},
        body: req.body || {},
        phoneNumberId: phoneNumberId || null,
        messageCount,
        statusCount
      }
    });
    rawLogId = rawLog.id;
    console.log(`[META WEBHOOK RAW] Saved raw log: ${rawLogId} (msgs=${messageCount}, statuses=${statusCount})`);
    
    // Highlight status-only webhooks for debugging delivered/read events
    if (statusCount > 0 && messageCount === 0) {
      console.log(`[META WEBHOOK STATUS] *** STATUS-ONLY WEBHOOK DETECTED ***`);
      console.log(`[META WEBHOOK STATUS] phoneNumberId: ${phoneNumberId}`);
      console.log(`[META WEBHOOK STATUS] Statuses:`, JSON.stringify(payload?.entry?.[0]?.changes?.[0]?.value?.statuses, null, 2));
    }
  } catch (rawLogError: any) {
    console.error('[META WEBHOOK RAW] Failed to save raw log:', rawLogError.message);
    // Don't fail the webhook - continue processing even if logging fails
  }
  // ========================================================================
  
  try {
    const payload: MetaWebhookPayload = req.body;
    
    if (!payload || typeof payload !== 'object') {
      console.error('[META WEBHOOK] ERROR: Invalid payload received');
      console.error('[META WEBHOOK] Payload value:', payload);
      // Update raw log with error
      if (rawLogId) {
        await prisma.webhookRawLog.update({
          where: { id: rawLogId },
          data: { processingError: 'Invalid payload - null or not object', processedAt: new Date() }
        }).catch(() => {});
      }
      res.status(200).send('EVENT_RECEIVED');
      return;
    }
    
    webhookLogger.info({
      timestamp,
      object: payload.object,
      entryCount: payload.entry?.length,
      wabaId: payload.entry?.[0]?.id,
      changes: payload.entry?.[0]?.changes?.map(c => ({
        field: c.field,
        phoneNumberId: c.value?.metadata?.phone_number_id,
        displayPhone: c.value?.metadata?.display_phone_number,
        messageCount: c.value?.messages?.length || 0,
        statusCount: c.value?.statuses?.length || 0
      }))
    }, 'Webhook event received');
    
    res.status(200).send('EVENT_RECEIVED');
    
    // Process in background - don't await to avoid blocking response
    processWebhookPayload(payload).then(async () => {
      // Mark raw log as processed successfully
      if (rawLogId) {
        await prisma.webhookRawLog.update({
          where: { id: rawLogId },
          data: { processedAt: new Date() }
        }).catch(() => {});
      }
    }).catch(async error => {
      console.error('[META WEBHOOK] BACKGROUND PROCESSING ERROR:', error);
      webhookLogger.error({ error: error.message, stack: error.stack }, 'Webhook background processing error');
      // Update raw log with error
      if (rawLogId) {
        await prisma.webhookRawLog.update({
          where: { id: rawLogId },
          data: { processingError: error.message, processedAt: new Date() }
        }).catch(() => {});
      }
    });
  } catch (error: any) {
    console.error('[META WEBHOOK] PROCESSING ERROR:', error);
    webhookLogger.error({ error: error.message, stack: error.stack }, 'Webhook processing error');
    // Update raw log with error
    if (rawLogId) {
      await prisma.webhookRawLog.update({
        where: { id: rawLogId },
        data: { processingError: error.message, processedAt: new Date() }
      }).catch(() => {});
    }
    if (!res.headersSent) {
      res.status(200).send('EVENT_RECEIVED');
    }
  }
});

router.get('/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('[META WEBHOOK] Instance-specific verification request:', { instanceId, mode });

    if (mode !== 'subscribe') {
      return res.status(400).send('Invalid mode');
    }

    const instance = await prisma.whatsAppInstance.findUnique({
      where: { id: instanceId },
      include: { 
        metaCredential: true,
        metaCoexistCredential: true
      }
    });

    if (!instance) {
      console.error('[META WEBHOOK] Instance not found:', instanceId);
      return res.status(404).send('Instance not found');
    }

    const isMetaCloud = instance.provider === 'META_CLOUD';
    const isMetaCoexist = instance.provider === 'META_COEXIST';

    if (!isMetaCloud && !isMetaCoexist) {
      console.error('[META WEBHOOK] Instance not a Meta provider:', instanceId);
      return res.status(404).send('Instance not found');
    }

    let expectedToken: string | undefined;
    if (isMetaCloud && instance.metaCredential) {
      expectedToken = instance.metaCredential.webhookVerifyToken;
    } else if (isMetaCoexist && instance.metaCoexistCredential) {
      expectedToken = instance.metaCoexistCredential.webhookVerifyToken;
    }

    if (!expectedToken) {
      console.error('[META WEBHOOK] No credentials found for instance:', instanceId);
      return res.status(404).send('Credentials not found');
    }

    if (token !== expectedToken) {
      console.error('[META WEBHOOK] Invalid verify token for instance');
      return res.status(403).send('Invalid verify token');
    }

    console.log('[META WEBHOOK] Instance webhook verified:', instanceId);
    res.status(200).send(challenge);
  } catch (error: any) {
    console.error('[META WEBHOOK] Verification error:', error);
    res.status(500).send('Internal error');
  }
});

router.post('/:instanceId', async (req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  console.log('='.repeat(80));
  console.log(`[META WEBHOOK /:instanceId] Event received at ${timestamp}`);
  console.log('[META WEBHOOK /:instanceId] RAW PAYLOAD:', JSON.stringify(req.body, null, 2));
  console.log('='.repeat(80));
  
  // ========================================================================
  // CRITICAL: Save RAW webhook payload to DB BEFORE any processing
  // ========================================================================
  let rawLogId: string | null = null;
  try {
    const { instanceId } = req.params;
    const payload = req.body as MetaWebhookPayload;
    const phoneNumberId = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const messageCount = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.length || 0;
    const statusCount = payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.length || 0;
    
    const rawLog = await prisma.webhookRawLog.create({
      data: {
        source: 'META_INSTANCE',
        endpoint: req.originalUrl || `/webhook/meta/${instanceId}`,
        method: req.method || 'POST',
        headers: {
          'content-type': req.headers['content-type'],
          'user-agent': req.headers['user-agent'],
          'x-hub-signature-256': req.headers['x-hub-signature-256'] ? 'present' : 'missing',
          'instanceId': instanceId
        },
        queryParams: req.query || {},
        body: req.body || {},
        phoneNumberId: phoneNumberId || null,
        messageCount,
        statusCount
      }
    });
    rawLogId = rawLog.id;
    console.log(`[META WEBHOOK RAW /:instanceId] Saved raw log: ${rawLogId} (msgs=${messageCount}, statuses=${statusCount})`);
  } catch (rawLogError: any) {
    console.error('[META WEBHOOK RAW /:instanceId] Failed to save raw log:', rawLogError.message);
  }
  // ========================================================================
  
  try {
    const { instanceId } = req.params;
    const payload: MetaWebhookPayload = req.body;

    console.log('[META WEBHOOK] Instance-specific event:', { instanceId, object: payload.object });

    res.status(200).send('EVENT_RECEIVED');

    // Process in background - don't await to avoid blocking response
    processWebhookPayload(payload).then(async () => {
      if (rawLogId) {
        await prisma.webhookRawLog.update({
          where: { id: rawLogId },
          data: { processedAt: new Date() }
        }).catch(() => {});
      }
    }).catch(async error => {
      console.error('[META WEBHOOK /:instanceId] BACKGROUND PROCESSING ERROR:', error);
      if (rawLogId) {
        await prisma.webhookRawLog.update({
          where: { id: rawLogId },
          data: { processingError: error.message, processedAt: new Date() }
        }).catch(() => {});
      }
    });
  } catch (error: any) {
    console.error('[META WEBHOOK] Processing error:', error);
    if (rawLogId) {
      await prisma.webhookRawLog.update({
        where: { id: rawLogId },
        data: { processingError: error.message, processedAt: new Date() }
      }).catch(() => {});
    }
  }
});

export default router;
