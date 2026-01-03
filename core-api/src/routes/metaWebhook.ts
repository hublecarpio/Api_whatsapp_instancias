import { Router, Request, Response } from 'express';
import prisma from '../services/prisma.js';
import { MetaCloudService, MetaWebhookPayload } from '../services/metaCloud.js';
import { processIncomingMessage } from '../services/messageIngest.js';
import { uploadBuffer, isS3Configured } from '../services/storage.js';
import { dispatchUserMessage } from '../services/webhookService.js';

const router = Router();

type MetaProviderType = 'META_CLOUD' | 'META_COEXIST';

router.get('/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Meta webhook verification request:', { instanceId, mode, token });

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
      console.error('Instance not found:', instanceId);
      return res.status(404).send('Instance not found');
    }

    const isMetaCloud = instance.provider === 'META_CLOUD';
    const isMetaCoexist = instance.provider === 'META_COEXIST';

    if (!isMetaCloud && !isMetaCoexist) {
      console.error('Instance not a Meta provider:', instanceId, instance.provider);
      return res.status(404).send('Instance not found');
    }

    let expectedToken: string | undefined;
    if (isMetaCloud && instance.metaCredential) {
      expectedToken = instance.metaCredential.webhookVerifyToken;
    } else if (isMetaCoexist && instance.metaCoexistCredential) {
      expectedToken = instance.metaCoexistCredential.webhookVerifyToken;
    }

    if (!expectedToken) {
      console.error('No credentials found for instance:', instanceId);
      return res.status(404).send('Credentials not found');
    }

    if (token !== expectedToken) {
      console.error('Invalid verify token:', { expected: expectedToken, received: token });
      return res.status(403).send('Invalid verify token');
    }

    console.log('Meta webhook verified successfully for instance:', instanceId, instance.provider);
    res.status(200).send(challenge);
  } catch (error: any) {
    console.error('Meta webhook verification error:', error);
    res.status(500).send('Internal error');
  }
});

router.post('/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const payload: MetaWebhookPayload = req.body;

    console.log('Meta webhook event received:', { instanceId, object: payload.object });

    res.status(200).send('EVENT_RECEIVED');

    const instance = await prisma.whatsAppInstance.findUnique({
      where: { id: instanceId },
      include: { 
        metaCredential: true,
        metaCoexistCredential: true,
        business: true
      }
    });

    if (!instance) {
      console.error('Instance not found:', instanceId);
      return;
    }

    const isMetaCloud = instance.provider === 'META_CLOUD';
    const isMetaCoexist = instance.provider === 'META_COEXIST';

    if (!isMetaCloud && !isMetaCoexist) {
      console.error('Instance not a Meta provider:', instanceId, instance.provider);
      return;
    }

    let accessToken: string;
    let phoneNumberId: string;
    let businessId: string;
    let providerType: MetaProviderType;

    if (isMetaCloud && instance.metaCredential) {
      accessToken = instance.metaCredential.accessToken;
      phoneNumberId = instance.metaCredential.phoneNumberId;
      businessId = instance.metaCredential.businessId;
      providerType = 'META_CLOUD';
    } else if (isMetaCoexist && instance.metaCoexistCredential) {
      accessToken = instance.metaCoexistCredential.systemAccessToken || instance.metaCoexistCredential.userAccessToken;
      phoneNumberId = instance.metaCoexistCredential.phoneNumberId;
      businessId = instance.metaCoexistCredential.metaBusinessId;
      providerType = 'META_COEXIST';
    } else {
      console.error('No credentials found for instance:', instanceId);
      return;
    }

    const parsed = MetaCloudService.parseWebhookMessage(payload);
    if (!parsed || parsed.messages.length === 0) {
      console.log('No messages to process');
      return;
    }

    if (parsed.phoneNumberId !== phoneNumberId) {
      console.error('Phone number ID mismatch:', { 
        expected: phoneNumberId, 
        received: parsed.phoneNumberId 
      });
      return;
    }

    const metaService = new MetaCloudService({
      accessToken,
      phoneNumberId,
      businessId
    });

    for (const msg of parsed.messages) {
      console.log(`Processing ${providerType} message:`, { 
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
          console.error('Failed to get/upload media:', error);
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
      
      console.log(`[META WEBHOOK] Dispatching user_message webhook for business ${instance.businessId}, contact ${msg.from}, instance ${instance.id}`);
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
  } catch (error: any) {
    console.error('Meta webhook processing error:', error);
  }
});

export default router;
