import { Router, Request, Response } from 'express';
import prisma from '../services/prisma.js';
import { MetaCloudService, MetaWebhookPayload } from '../services/metaCloud.js';
import { processIncomingMessage } from '../services/messageIngest.js';
import { uploadBuffer, isS3Configured } from '../services/storage.js';
import { dispatchUserMessage } from '../services/webhookService.js';

const router = Router();

type MetaProviderType = 'META_CLOUD' | 'META_COEXIST';

const GLOBAL_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token_2024';

async function findInstanceByPhoneNumberId(phoneNumberId: string) {
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
      providerType: 'META_COEXIST' as MetaProviderType
    };
  }
  
  return null;
}

async function processWebhookPayload(payload: MetaWebhookPayload) {
  const parsed = MetaCloudService.parseWebhookMessage(payload);
  if (!parsed || parsed.messages.length === 0) {
    console.log('[META WEBHOOK] No messages to process');
    return;
  }

  const instanceData = await findInstanceByPhoneNumberId(parsed.phoneNumberId);
  
  if (!instanceData) {
    console.error('[META WEBHOOK] No instance found for phone_number_id:', parsed.phoneNumberId);
    return;
  }

  const { instance, accessToken, phoneNumberId, businessId, providerType } = instanceData;

  console.log(`[META WEBHOOK] Found instance ${instance.id} (${providerType}) for phone ${parsed.phoneNumberId}`);

  const metaService = new MetaCloudService({
    accessToken,
    phoneNumberId,
    businessId
  });

  for (const msg of parsed.messages) {
    console.log(`[META WEBHOOK] Processing ${providerType} message:`, { 
      from: msg.from, 
      type: msg.type,
      businessId: instance.businessId 
    });

    let mediaUrl: string | undefined;
    if (msg.mediaId) {
      try {
        const metaMediaUrl = await metaService.getMediaUrl(msg.mediaId);
        
        if (isS3Configured()) {
          console.log('[META WEBHOOK] Downloading media from Meta to upload to S3...');
          const mediaBuffer = await metaService.downloadMedia(metaMediaUrl);
          const uploadResult = await uploadBuffer(
            mediaBuffer, 
            msg.mimetype || 'application/octet-stream', 
            instance.businessId
          );
          
          if (uploadResult) {
            mediaUrl = uploadResult.url;
            console.log('[META WEBHOOK] Media uploaded to S3:', mediaUrl);
          } else {
            console.error('[META WEBHOOK] Failed to upload to S3, using Meta URL');
            mediaUrl = metaMediaUrl;
          }
        } else {
          console.log('[META WEBHOOK] S3 not configured, using Meta URL directly');
          mediaUrl = metaMediaUrl;
        }
      } catch (error) {
        console.error('[META WEBHOOK] Failed to get/upload media:', error);
      }
    }

    await processIncomingMessage({
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
      location: msg.location
    });
    
    console.log(`[META WEBHOOK] Dispatching user_message webhook for business ${instance.businessId}, contact ${msg.from}`);
    dispatchUserMessage(
      instance.businessId,
      msg.from,
      msg.pushName || '',
      msg.caption || msg.text || '',
      msg.type,
      mediaUrl,
      undefined,
      instance.id
    ).catch(err => console.error('[META WEBHOOK] Failed to dispatch user_message webhook:', err.message));
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
  try {
    const payload: MetaWebhookPayload = req.body;
    
    console.log('[META WEBHOOK] Centralized event received:', { object: payload.object });
    
    res.status(200).send('EVENT_RECEIVED');
    
    await processWebhookPayload(payload);
  } catch (error: any) {
    console.error('[META WEBHOOK] Processing error:', error);
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
