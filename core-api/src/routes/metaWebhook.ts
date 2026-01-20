import { Router, Request, Response } from 'express';
import prisma, { withRetry } from '../services/prisma.js';
import { MetaCloudService, MetaWebhookPayload, ParsedMessage, ParsedStatus } from '../services/metaCloud.js';
import { processIncomingMessage } from '../services/messageIngest.js';
import { uploadBuffer, isS3Configured } from '../services/storage.js';
import { dispatchUserMessage } from '../services/webhookService.js';
import { webhookLogger, logWebhookEvent } from '../services/logger.js';
import { getRedisConnection, isRedisAvailable } from '../services/redis.js';

const router = Router();

type MetaProviderType = 'META_CLOUD' | 'META_COEXIST';

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
    
    return null;
  });
}

async function processWebhookPayload(payload: MetaWebhookPayload) {
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
    await processMessage(msg, instance, metaService, providerType);
  }

  for (const status of parsed.statuses) {
    await processStatusUpdate(status, instance, providerType);
  }
}

async function processMessage(
  msg: ParsedMessage, 
  instance: any, 
  metaService: MetaCloudService, 
  providerType: MetaProviderType
) {
  const startTime = Date.now();

  // DEDUPLICATION CHECK - prevent duplicate webhook events
  if (await isMessageAlreadyProcessed(msg.messageId)) {
    webhookLogger.info({
      messageId: msg.messageId,
      from: msg.from,
      reason: 'duplicate'
    }, 'Skipping duplicate message');
    return;
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
  if (msg.mediaId) {
    console.log(`[META WEBHOOK MEDIA] Processing ${msg.type} media: mediaId=${msg.mediaId}, mimetype=${msg.mimetype}, from=${msg.from}`);
    const mediaStartTime = Date.now();
    try {
      const metaMediaUrl = await metaService.getMediaUrl(msg.mediaId);
      console.log(`[META WEBHOOK MEDIA] Got Meta URL for ${msg.mediaId}: ${metaMediaUrl?.substring(0, 80)}...`);
      
      if (isS3Configured()) {
        webhookLogger.debug({ mediaId: msg.mediaId, type: msg.type }, 'Downloading media from Meta');
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
            metadata: { url: mediaUrl, mimetype: msg.mimetype }
          });
        } else {
          mediaUrl = metaMediaUrl;
          webhookLogger.warn({ mediaId: msg.mediaId }, 'Failed to upload to S3, using Meta URL');
        }
      } else {
        mediaUrl = metaMediaUrl;
      }
    } catch (error: any) {
      console.error(`[META WEBHOOK MEDIA] FAILED to process ${msg.type} mediaId=${msg.mediaId}: ${error.message}`, {
        status: error?.response?.status,
        data: error?.response?.data,
        code: error?.code
      });
      logWebhookEvent({
        eventType: 'error',
        phoneNumberId: metaService['credentials'].phoneNumberId,
        instanceId: instance.id,
        businessId: instance.businessId,
        provider: providerType,
        mediaId: msg.mediaId,
        error: error.message,
        duration: Date.now() - mediaStartTime
      });
    }
  } else if (['image', 'video', 'audio', 'sticker', 'document'].includes(msg.type)) {
    console.warn(`[META WEBHOOK MEDIA] Received ${msg.type} message but NO mediaId present! from=${msg.from}, messageId=${msg.messageId}`);
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
    order: msg.order
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
  }

  webhookLogger.debug({
    messageId: msg.messageId,
    from: msg.from,
    duration: Date.now() - startTime,
    processed: processed !== false
  }, 'Message processing complete');
}

async function processStatusUpdate(status: ParsedStatus, instance: any, providerType: MetaProviderType) {
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
  
  try {
    const payload: MetaWebhookPayload = req.body;
    
    if (!payload || typeof payload !== 'object') {
      console.error('[META WEBHOOK] ERROR: Invalid payload received');
      console.error('[META WEBHOOK] Payload value:', payload);
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
    processWebhookPayload(payload).catch(error => {
      console.error('[META WEBHOOK] BACKGROUND PROCESSING ERROR:', error);
      webhookLogger.error({ error: error.message, stack: error.stack }, 'Webhook background processing error');
    });
  } catch (error: any) {
    console.error('[META WEBHOOK] PROCESSING ERROR:', error);
    webhookLogger.error({ error: error.message, stack: error.stack }, 'Webhook processing error');
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
  try {
    const { instanceId } = req.params;
    const payload: MetaWebhookPayload = req.body;

    console.log('[META WEBHOOK] Instance-specific event:', { instanceId, object: payload.object });

    res.status(200).send('EVENT_RECEIVED');

    await processWebhookPayload(payload);
  } catch (error: any) {
    console.error('[META WEBHOOK] Processing error:', error);
  }
});

export default router;
