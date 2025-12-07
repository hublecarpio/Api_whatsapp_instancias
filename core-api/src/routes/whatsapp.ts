import { Router, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();
const WA_API_URL = process.env.WA_API_URL || 'http://localhost:5000';

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

router.post('/create', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, webhook } = req.body;
    
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
        status: 'pending_qr'
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

router.get('/:businessId/status', async (req: AuthRequest, res: Response) => {
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
      where: { businessId: req.params.businessId }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    let endpoint = 'sendMessage';
    let payload: any = { to, message };
    
    if (imageUrl) {
      endpoint = 'sendImage';
      payload = { to, url: imageUrl, caption: message };
    } else if (videoUrl) {
      endpoint = 'sendVideo';
      payload = { to, url: videoUrl, caption: message };
    } else if (audioUrl) {
      endpoint = 'sendAudio';
      payload = { to, url: audioUrl, ptt: true };
    } else if (fileUrl) {
      endpoint = 'sendFile';
      payload = { to, url: fileUrl, fileName: fileName || 'file', mimeType: mimeType || 'application/octet-stream' };
    }
    
    const waResponse = await axios.post(
      `${WA_API_URL}/instances/${instance.instanceBackendId}/${endpoint}`,
      payload
    );
    
    await prisma.messageLog.create({
      data: {
        businessId: req.params.businessId,
        instanceId: instance.id,
        direction: 'outbound',
        recipient: to,
        message: message || null,
        mediaUrl: imageUrl || videoUrl || audioUrl || fileUrl || null
      }
    });
    
    res.json(waResponse.data);
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
    
    const waResponse = await axios.post(
      `${WA_API_URL}/instances/${instance.instanceBackendId}/restart`
    );
    
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { status: 'pending_qr', qr: null }
    });
    
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
