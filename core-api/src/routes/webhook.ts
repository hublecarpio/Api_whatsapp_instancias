import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../services/prisma.js';

const router = Router();
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';

router.post('/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const { event, payload, instanceId } = req.body;
    const data = payload;
    
    console.log(`Webhook received for business ${businessId}:`, event);
    console.log('Webhook payload:', JSON.stringify(payload, null, 2));
    
    const business = await prisma.business.findUnique({
      where: { id: businessId }
    });
    
    if (!business) {
      console.log(`Business ${businessId} not found`);
      return res.status(404).json({ error: 'Business not found' });
    }
    
    switch (event) {
      case 'connection.open':
        await prisma.whatsAppInstance.updateMany({
          where: { businessId },
          data: { 
            status: 'open',
            lastConnection: new Date(),
            phoneNumber: data?.phoneNumber
          }
        });
        break;
        
      case 'connection.close':
        await prisma.whatsAppInstance.updateMany({
          where: { businessId },
          data: { status: 'closed' }
        });
        break;
        
      case 'qr.update':
        await prisma.whatsAppInstance.updateMany({
          where: { businessId },
          data: { 
            status: 'pending_qr',
            qr: data?.qr
          }
        });
        break;
        
      case 'message.received':
        if (data && (data.text || data.mediaUrl)) {
          const instance = await prisma.whatsAppInstance.findFirst({
            where: { businessId }
          });
          
          const contactPhone = data.phoneNumber || data.sender?.replace('@s.whatsapp.net', '') || data.from;
          const contactName = data.pushName || '';
          const contactJid = data.from;
          
          await prisma.messageLog.create({
            data: {
              businessId,
              instanceId: instance?.id,
              direction: 'inbound',
              sender: contactPhone,
              message: data.text || null,
              mediaUrl: data.mediaUrl || null,
              metadata: {
                ...data,
                contactPhone,
                contactName,
                contactJid
              }
            }
          });
          
          if (business.botEnabled && business.openaiApiKey && data.text) {
            try {
              await axios.post(`${CORE_API_URL}/agent/think`, {
                business_id: businessId,
                user_message: data.text,
                phone: contactJid,
                phoneNumber: contactPhone,
                contactName,
                instanceId: instance?.id
              });
            } catch (err: any) {
              console.error('Agent think failed:', err.response?.data || err.message);
            }
          }
        }
        break;
        
      case 'message.sent':
        break;
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
