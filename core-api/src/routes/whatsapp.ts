import { Router, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireEmailVerified } from '../middleware/billing.js';
import { MetaCloudService } from '../services/metaCloud.js';

const router = Router();
const WA_API_URL = process.env.WA_API_URL || 'http://localhost:5000';
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';

function getPublicWebhookUrl(path: string): string {
  if (process.env.PUBLIC_API_URL) {
    return `${process.env.PUBLIC_API_URL}${path}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/api${path}`;
  }
  return `${CORE_API_URL}${path}`;
}

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

router.post('/create', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, webhook, phoneNumber } = req.body;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existing = await prisma.whatsAppInstance.findFirst({
      where: { businessId }
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Instance already exists for this business' });
    }
    
    const instanceId = `biz_${businessId.substring(0, 8)}`;
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    const webhookUrl = webhook || `${coreApiUrl}/webhook/${businessId}`;
    
    const waResponse = await axios.post(`${WA_API_URL}/instances`, {
      instanceId,
      webhook: webhookUrl
    });
    
    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        instanceBackendId: instanceId,
        status: 'pending_qr',
        phoneNumber: phoneNumber || null
      }
    });
    
    res.status(201).json({
      instance,
      waInstance: waResponse.data
    });
  } catch (error: any) {
    console.error('Create WA instance error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create WhatsApp instance' });
  }
});

router.post('/create-meta', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { 
      businessId, 
      name,
      accessToken, 
      metaBusinessId, 
      phoneNumberId, 
      appId, 
      appSecret,
      phoneNumber
    } = req.body;
    
    if (!businessId || !accessToken || !metaBusinessId || !phoneNumberId || !appId || !appSecret) {
      return res.status(400).json({ 
        error: 'Missing required fields: businessId, accessToken, metaBusinessId, phoneNumberId, appId, appSecret' 
      });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existing = await prisma.whatsAppInstance.findFirst({
      where: { businessId }
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Instance already exists for this business. Delete it first.' });
    }
    
    const metaService = new MetaCloudService({
      accessToken,
      phoneNumberId,
      businessId: metaBusinessId
    });
    
    let phoneInfo;
    try {
      phoneInfo = await metaService.getPhoneNumberInfo();
    } catch (error: any) {
      console.error('Meta API validation failed:', error.response?.data || error.message);
      return res.status(400).json({ 
        error: 'Invalid Meta credentials. Please check your access token and phone number ID.',
        details: error.response?.data?.error?.message || error.message
      });
    }
    
    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        name: name || 'Meta WhatsApp',
        provider: 'META_CLOUD',
        instanceBackendId: null,
        phoneNumber: phoneInfo.display_phone_number || phoneNumber || phoneInfo.verified_name,
        status: 'connected',
        isActive: true,
        lastConnection: new Date(),
        metaCredential: {
          create: {
            accessToken,
            businessId: metaBusinessId,
            phoneNumberId,
            appId,
            appSecret
          }
        }
      },
      include: { metaCredential: true }
    });
    
    const webhookUrl = getPublicWebhookUrl(`/webhook/meta/${instance.id}`);
    
    res.status(201).json({
      instance: {
        id: instance.id,
        name: instance.name,
        provider: instance.provider,
        phoneNumber: instance.phoneNumber,
        status: instance.status,
        webhookVerifyToken: instance.metaCredential?.webhookVerifyToken
      },
      webhookUrl,
      instructions: `Configure your Meta App webhook to: ${webhookUrl} with verify token: ${instance.metaCredential?.webhookVerifyToken}`
    });
  } catch (error: any) {
    console.error('Create Meta instance error:', error);
    res.status(500).json({ error: 'Failed to create Meta WhatsApp instance' });
  }
});

router.get('/instances/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instances = await prisma.whatsAppInstance.findMany({
      where: { businessId: req.params.businessId },
      include: { metaCredential: { select: { webhookVerifyToken: true, phoneNumberId: true } } },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json(instances.map(inst => ({
      id: inst.id,
      name: inst.name,
      provider: inst.provider,
      phoneNumber: inst.phoneNumber,
      status: inst.status,
      isActive: inst.isActive,
      lastConnection: inst.lastConnection,
      createdAt: inst.createdAt,
      webhookUrl: inst.provider === 'META_CLOUD' ? getPublicWebhookUrl(`/webhook/meta/${inst.id}`) : null,
      webhookVerifyToken: inst.metaCredential?.webhookVerifyToken
    })));
  } catch (error) {
    console.error('Get instances error:', error);
    res.status(500).json({ error: 'Failed to get instances' });
  }
});

router.get('/:businessId/status', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId },
      include: { metaCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    if (instance.provider === 'META_CLOUD') {
      if (!instance.metaCredential) {
        return res.status(500).json({ error: 'Meta credentials not found' });
      }
      
      try {
        const metaService = new MetaCloudService({
          accessToken: instance.metaCredential.accessToken,
          phoneNumberId: instance.metaCredential.phoneNumberId,
          businessId: instance.metaCredential.businessId
        });
        
        const phoneInfo = await metaService.getPhoneNumberInfo();
        
        res.json({
          id: instance.id,
          name: instance.name,
          provider: instance.provider,
          phoneNumber: phoneInfo.display_phone_number || instance.phoneNumber,
          status: 'connected',
          isActive: instance.isActive,
          lastConnection: instance.lastConnection,
          webhookUrl: getPublicWebhookUrl(`/webhook/meta/${instance.id}`),
          webhookVerifyToken: instance.metaCredential.webhookVerifyToken,
          metaInfo: {
            verifiedName: phoneInfo.verified_name,
            qualityRating: phoneInfo.quality_rating,
            codeVerificationStatus: phoneInfo.code_verification_status
          }
        });
      } catch (error: any) {
        console.error('Meta API check failed:', error.response?.data || error.message);
        res.json({
          id: instance.id,
          name: instance.name,
          provider: instance.provider,
          phoneNumber: instance.phoneNumber,
          status: 'error',
          error: 'Failed to verify Meta connection',
          webhookUrl: getPublicWebhookUrl(`/webhook/meta/${instance.id}`),
          webhookVerifyToken: instance.metaCredential.webhookVerifyToken
        });
      }
      return;
    }
    
    try {
      const waResponse = await axios.get(`${WA_API_URL}/instances/${instance.instanceBackendId}/status`);
      
      if (waResponse.data.status !== instance.status) {
        await prisma.whatsAppInstance.update({
          where: { id: instance.id },
          data: { 
            status: waResponse.data.status,
            phoneNumber: waResponse.data.phoneNumber,
            lastConnection: waResponse.data.status === 'open' ? new Date() : instance.lastConnection
          }
        });
      }
      
      res.json({
        ...instance,
        ...waResponse.data
      });
    } catch (err) {
      res.json({ ...instance, backendStatus: 'unreachable' });
    }
  } catch (error) {
    console.error('Get WA status error:', error);
    res.status(500).json({ error: 'Failed to get WhatsApp status' });
  }
});

router.get('/:businessId/qr', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    const waResponse = await axios.get(`${WA_API_URL}/instances/${instance.instanceBackendId}/qr`);
    
    const qrCode = waResponse.data?.data?.qrCode || waResponse.data?.qrCode || instance.qr;
    
    if (qrCode && qrCode !== instance.qr) {
      await prisma.whatsAppInstance.update({
        where: { id: instance.id },
        data: { qr: qrCode }
      });
    }
    
    res.json({ 
      qr: qrCode,
      status: waResponse.data?.data?.status || instance.status
    });
  } catch (error: any) {
    console.error('Get QR error:', error.response?.data || error.message);
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId }
    });
    if (instance?.qr) {
      return res.json({ qr: instance.qr, status: instance.status });
    }
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

router.post('/:businessId/send', async (req: AuthRequest, res: Response) => {
  try {
    const { to, message, imageUrl, videoUrl, audioUrl, fileUrl, fileName, mimeType } = req.body;
    
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId },
      include: { metaCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    const cleanTo = to.replace(/\D/g, '');
    let response;
    
    if (instance.provider === 'META_CLOUD') {
      if (!instance.metaCredential) {
        return res.status(500).json({ error: 'Meta credentials not found' });
      }
      
      const metaService = new MetaCloudService({
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId,
        businessId: instance.metaCredential.businessId
      });
      
      if (imageUrl) {
        response = await metaService.sendImageMessage(cleanTo, imageUrl, message);
      } else if (videoUrl) {
        response = await metaService.sendVideoMessage(cleanTo, videoUrl, message);
      } else if (audioUrl) {
        response = await metaService.sendAudioMessage(cleanTo, audioUrl);
      } else if (fileUrl) {
        response = await metaService.sendDocumentMessage(cleanTo, fileUrl, fileName, message);
      } else if (message) {
        response = await metaService.sendTextMessage(cleanTo, message);
      }
    } else {
      const recipient = `${cleanTo}@s.whatsapp.net`;
      let endpoint = 'sendMessage';
      let payload: any = { to: recipient, message };
      
      if (imageUrl) {
        endpoint = 'sendImage';
        payload = { to: recipient, url: imageUrl, caption: message };
      } else if (videoUrl) {
        endpoint = 'sendVideo';
        payload = { to: recipient, url: videoUrl, caption: message };
      } else if (audioUrl) {
        endpoint = 'sendAudio';
        payload = { to: recipient, url: audioUrl, ptt: true };
      } else if (fileUrl) {
        endpoint = 'sendFile';
        payload = { to: recipient, url: fileUrl, fileName: fileName || 'file', mimeType: mimeType || 'application/octet-stream' };
      }
      
      const waResponse = await axios.post(
        `${WA_API_URL}/instances/${instance.instanceBackendId}/${endpoint}`,
        payload
      );
      response = waResponse.data;
    }
    
    await prisma.messageLog.create({
      data: {
        businessId: req.params.businessId,
        instanceId: instance.id,
        direction: 'outbound',
        recipient: cleanTo,
        message: message || null,
        mediaUrl: imageUrl || videoUrl || audioUrl || fileUrl || null,
        metadata: { provider: instance.provider }
      }
    });
    
    res.json(response);
  } catch (error: any) {
    console.error('Send message error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.post('/:businessId/restart', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    const webhookUrl = `${coreApiUrl}/webhook/${req.params.businessId}`;
    
    const waResponse = await axios.post(
      `${WA_API_URL}/instances/${instance.instanceBackendId}/restart`,
      { webhook: webhookUrl }
    );
    
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { status: 'pending_qr', qr: null }
    });
    
    console.log(`Instance ${instance.instanceBackendId} restarted with webhook: ${webhookUrl}`);
    res.json(waResponse.data);
  } catch (error: any) {
    console.error('Restart instance error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to restart instance' });
  }
});

router.delete('/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: req.params.businessId }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    try {
      await axios.delete(`${WA_API_URL}/instances/${instance.instanceBackendId}`);
    } catch (err) {
      console.log('WA backend delete failed (maybe already deleted)');
    }
    
    await prisma.whatsAppInstance.delete({ where: { id: instance.id } });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete instance error:', error);
    res.status(500).json({ error: 'Failed to delete instance' });
  }
});

export default router;
