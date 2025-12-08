import { Router, Request, Response } from 'express';
import prisma from '../services/prisma.js';
import { MetaCloudService, MetaWebhookPayload } from '../services/metaCloud.js';
import { processIncomingMessage } from '../services/messageIngest.js';

const router = Router();

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
      include: { metaCredential: true }
    });

    if (!instance || instance.provider !== 'META_CLOUD') {
      console.error('Instance not found or not META_CLOUD:', instanceId);
      return res.status(404).send('Instance not found');
    }

    if (!instance.metaCredential) {
      console.error('Meta credential not found for instance:', instanceId);
      return res.status(404).send('Credentials not found');
    }

    if (token !== instance.metaCredential.webhookVerifyToken) {
      console.error('Invalid verify token:', { expected: instance.metaCredential.webhookVerifyToken, received: token });
      return res.status(403).send('Invalid verify token');
    }

    console.log('Meta webhook verified successfully for instance:', instanceId);
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
        business: true
      }
    });

    if (!instance || instance.provider !== 'META_CLOUD') {
      console.error('Instance not found or not META_CLOUD:', instanceId);
      return;
    }

    if (!instance.metaCredential) {
      console.error('Meta credential not found for instance:', instanceId);
      return;
    }

    const parsed = MetaCloudService.parseWebhookMessage(payload);
    if (!parsed || parsed.messages.length === 0) {
      console.log('No messages to process');
      return;
    }

    if (parsed.phoneNumberId !== instance.metaCredential.phoneNumberId) {
      console.error('Phone number ID mismatch:', { 
        expected: instance.metaCredential.phoneNumberId, 
        received: parsed.phoneNumberId 
      });
      return;
    }

    const metaService = new MetaCloudService({
      accessToken: instance.metaCredential.accessToken,
      phoneNumberId: instance.metaCredential.phoneNumberId,
      businessId: instance.metaCredential.businessId
    });

    for (const msg of parsed.messages) {
      console.log('Processing Meta message:', { 
        from: msg.from, 
        type: msg.type,
        businessId: instance.businessId 
      });

      let mediaUrl: string | undefined;
      if (msg.mediaId) {
        try {
          const metaMediaUrl = await metaService.getMediaUrl(msg.mediaId);
          mediaUrl = metaMediaUrl;
        } catch (error) {
          console.error('Failed to get media URL:', error);
        }
      }

      await processIncomingMessage({
        businessId: instance.businessId,
        instanceId: instance.id,
        provider: 'META_CLOUD',
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

      try {
        await metaService.markMessageAsRead(msg.messageId);
      } catch (error) {
        console.error('Failed to mark message as read:', error);
      }
    }
  } catch (error: any) {
    console.error('Meta webhook processing error:', error);
  }
});

export default router;
