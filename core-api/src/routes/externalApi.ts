import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import prisma from '../services/prisma';
import eventLogger from '../services/eventLogger';
import { dispatchAgentMessage } from '../services/webhookService';

const router = Router();

interface ApiKeyRequest extends Request {
  businessId?: string;
  business?: any;
  instanceId?: string;
  instance?: any;
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function validateApiKey(req: ApiKeyRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'API key requerida',
        hint: 'Incluye tu API key en el header: Authorization: Bearer efk_...'
      });
    }
    
    const apiKey = authHeader.substring(7);
    
    if (!apiKey.startsWith('efk_')) {
      return res.status(401).json({ error: 'Formato de API key invalido' });
    }
    
    const apiKeyHash = hashApiKey(apiKey);
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { apiKeyHash },
      include: {
        metaCredential: true,
        business: {
          include: {
            user: {
              select: {
                id: true,
                subscriptionTier: true,
                isPro: true,
                proBonusExpiresAt: true
              }
            }
          }
        }
      }
    });
    
    if (instance) {
      const user = instance.business.user;
      const hasProAccess = user.isPro || 
        (user.proBonusExpiresAt && user.proBonusExpiresAt > new Date()) ||
        user.subscriptionTier === 'PRO' ||
        user.subscriptionTier === 'ENTERPRISE';
      
      if (!hasProAccess) {
        return res.status(403).json({ 
          error: 'Esta API requiere plan PRO o superior',
          tier: user.subscriptionTier
        });
      }
      
      req.businessId = instance.business.id;
      req.business = { ...instance.business, instances: [instance] };
      req.instanceId = instance.id;
      req.instance = instance;
      return next();
    }
    
    const business = await prisma.business.findFirst({
      where: { apiKeyHash },
      include: {
        instances: {
          where: { 
            isActive: true,
            status: { in: ['open', 'CONNECTED', 'connected'] }
          },
          take: 1,
          include: {
            metaCredential: true
          }
        },
        user: {
          select: {
            id: true,
            subscriptionTier: true,
            isPro: true,
            proBonusExpiresAt: true
          }
        }
      }
    });
    
    if (!business) {
      return res.status(401).json({ error: 'API key invalida o revocada' });
    }
    
    const user = business.user;
    const hasProAccess = user.isPro || 
      (user.proBonusExpiresAt && user.proBonusExpiresAt > new Date()) ||
      user.subscriptionTier === 'PRO' ||
      user.subscriptionTier === 'ENTERPRISE';
    
    if (!hasProAccess) {
      return res.status(403).json({ 
        error: 'Esta API requiere plan PRO o superior',
        tier: user.subscriptionTier
      });
    }
    
    req.businessId = business.id;
    req.business = business;
    req.instanceId = business.instances[0]?.id;
    req.instance = business.instances[0];
    next();
  } catch (error: any) {
    console.error('API key validation error:', error);
    res.status(500).json({ error: 'Error validando API key' });
  }
}

router.get('/me', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const business = req.business;
    const instance = req.instance;
    
    res.json({
      businessId: business.id,
      businessName: business.name,
      instanceId: instance?.id || null,
      instanceName: instance?.name || null,
      whatsappConnected: !!instance && ['open', 'CONNECTED', 'connected'].includes(instance.status),
      whatsappPhone: instance?.phoneNumber || null,
      provider: instance?.provider || null
    });
  } catch (error: any) {
    console.error('API /me error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/send-message', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { to, message, mediaUrl, mediaType } = req.body;
    const business = req.business;
    const instance = req.instance;
    
    if (!to) {
      return res.status(400).json({ error: 'Campo "to" (numero de telefono) es requerido' });
    }
    
    if (!message && !mediaUrl) {
      return res.status(400).json({ error: 'Campo "message" o "mediaUrl" es requerido' });
    }
    
    if (!instance) {
      return res.status(400).json({ error: 'No hay instancia de WhatsApp asociada a esta API key' });
    }
    
    if (!['open', 'CONNECTED', 'connected'].includes(instance.status)) {
      return res.status(400).json({ error: 'La instancia de WhatsApp no esta conectada', status: instance.status });
    }
    
    const cleanTo = to.replace(/\D/g, '');
    
    if (instance.provider === 'BAILEYS') {
      const waApiUrl = process.env.WA_API_URL || 'http://localhost:8080';
      const baileysInstanceId = instance.instanceBackendId;
      
      if (!baileysInstanceId) {
        return res.status(500).json({ 
          error: 'Instancia Baileys no configurada correctamente',
          hint: 'La instancia no tiene un backend ID asignado. Por favor, recrea la instancia.'
        });
      }
      
      let endpoint = `/instances/${baileysInstanceId}/sendMessage`;
      let payload: any = {
        to: cleanTo,
        message: message
      };
      
      if (mediaUrl) {
        if (mediaType === 'image' || mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          endpoint = `/instances/${baileysInstanceId}/sendImage`;
          payload = { to: cleanTo, imageUrl: mediaUrl, caption: message || '' };
        } else if (mediaType === 'video' || mediaUrl.match(/\.(mp4|mov|avi)$/i)) {
          endpoint = `/instances/${baileysInstanceId}/sendVideo`;
          payload = { to: cleanTo, videoUrl: mediaUrl, caption: message || '' };
        } else if (mediaType === 'audio' || mediaUrl.match(/\.(mp3|ogg|wav|m4a)$/i)) {
          endpoint = `/instances/${baileysInstanceId}/sendAudio`;
          payload = { to: cleanTo, audioUrl: mediaUrl };
        } else if (mediaType === 'document' || mediaUrl.match(/\.(pdf|doc|docx|xls|xlsx)$/i)) {
          endpoint = `/instances/${baileysInstanceId}/sendFile`;
          payload = { to: cleanTo, fileUrl: mediaUrl, caption: message || '', fileName: 'document' };
        }
      }
      
      const response = await axios.post(`${waApiUrl}${endpoint}`, payload);
      const messageId = response.data.messageId || response.data.key?.id;
      
      // Register message in MessageLog (like agent message)
      await prisma.messageLog.create({
        data: {
          businessId: business.id,
          instanceId: instance.id,
          sender: instance.phoneNumber || business.id,
          recipient: cleanTo,
          message: message || (mediaUrl ? `[Media: ${mediaType || 'file'}]` : ''),
          direction: 'OUTGOING',
          mediaUrl: mediaUrl || null,
          providerMessageId: messageId,
          metadata: { source: 'external_api', mediaType }
        }
      });
      
      // Update or create contact
      const now = new Date();
      await prisma.contact.upsert({
        where: {
          businessId_phone: { businessId: business.id, phone: cleanTo }
        },
        create: {
          businessId: business.id,
          phone: cleanTo,
          name: cleanTo,
          firstMessageAt: now,
          lastMessageAt: now,
          messageCount: 1
        },
        update: {
          lastMessageAt: now,
          messageCount: { increment: 1 }
        }
      });
      
      // Dispatch webhook for external integrations
      await dispatchAgentMessage(
        business.id,
        cleanTo,
        message || '',
        mediaUrl ? [mediaUrl] : undefined,
        ['external_api']
      );
      
      await eventLogger.info('EXTERNAL_API', `Mensaje enviado via API a ${cleanTo}`, {
        businessId: business.id,
        details: { to: cleanTo, hasMedia: !!mediaUrl, messageId }
      });
      
      res.json({
        success: true,
        messageId,
        to: cleanTo
      });
      
    } else if (instance.provider === 'META_CLOUD') {
      const metaCred = instance.metaCredential;
      
      if (!metaCred || !metaCred.accessToken || !metaCred.phoneNumberId) {
        return res.status(400).json({ error: 'Instancia META no configurada correctamente' });
      }
      
      const metaToken = metaCred.accessToken;
      const phoneNumberId = metaCred.phoneNumberId;
      
      let payload: any;
      
      if (mediaUrl) {
        const type = mediaType || 'image';
        payload = {
          messaging_product: 'whatsapp',
          to: cleanTo,
          type,
          [type]: {
            link: mediaUrl,
            caption: message || undefined
          }
        };
      } else {
        payload = {
          messaging_product: 'whatsapp',
          to: cleanTo,
          type: 'text',
          text: { body: message }
        };
      }
      
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${metaToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const messageId = response.data.messages?.[0]?.id;
      
      // Register message in MessageLog (like agent message)
      await prisma.messageLog.create({
        data: {
          businessId: business.id,
          instanceId: instance.id,
          sender: instance.phoneNumber || business.id,
          recipient: cleanTo,
          message: message || (mediaUrl ? `[Media: ${mediaType || 'file'}]` : ''),
          direction: 'OUTGOING',
          mediaUrl: mediaUrl || null,
          providerMessageId: messageId,
          metadata: { source: 'external_api', provider: 'META_CLOUD', mediaType }
        }
      });
      
      // Update or create contact
      const now = new Date();
      await prisma.contact.upsert({
        where: {
          businessId_phone: { businessId: business.id, phone: cleanTo }
        },
        create: {
          businessId: business.id,
          phone: cleanTo,
          name: cleanTo,
          firstMessageAt: now,
          lastMessageAt: now,
          messageCount: 1
        },
        update: {
          lastMessageAt: now,
          messageCount: { increment: 1 }
        }
      });
      
      // Dispatch webhook for external integrations
      await dispatchAgentMessage(
        business.id,
        cleanTo,
        message || '',
        mediaUrl ? [mediaUrl] : undefined,
        ['external_api']
      );
      
      await eventLogger.info('EXTERNAL_API', `Mensaje enviado via API META a ${cleanTo}`, {
        businessId: business.id,
        details: { to: cleanTo, hasMedia: !!mediaUrl, messageId }
      });
      
      res.json({
        success: true,
        messageId,
        to: cleanTo
      });
    } else {
      return res.status(400).json({ error: 'Proveedor de WhatsApp no soportado' });
    }
    
  } catch (error: any) {
    console.error('API send-message error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error enviando mensaje',
      details: error.response?.data?.error || error.message
    });
  }
});

router.get('/contacts', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { limit = 100, offset = 0, tag, stage, search } = req.query;
    
    const where: any = { businessId: req.businessId };
    
    if (tag) {
      where.tags = { has: tag as string };
    }
    
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string } }
      ];
    }
    
    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        take: Math.min(Number(limit), 500),
        skip: Number(offset),
        orderBy: { lastMessageAt: 'desc' },
        select: {
          id: true,
          phone: true,
          name: true,
          email: true,
          tags: true,
          notes: true,
          messageCount: true,
          lastMessageAt: true,
          createdAt: true,
          metadata: true
        }
      }),
      prisma.contact.count({ where })
    ]);
    
    res.json({
      contacts,
      total,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error: any) {
    console.error('API contacts error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/contacts/:phone', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { phone } = req.params;
    const cleanPhone = phone.replace(/\D/g, '');
    
    const contact = await prisma.contact.findFirst({
      where: { 
        businessId: req.businessId,
        phone: { contains: cleanPhone }
      }
    });
    
    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    
    const [orders, appointments] = await Promise.all([
      prisma.order.findMany({
        where: { businessId: req.businessId!, contactPhone: contact.phone },
        orderBy: { createdAt: 'desc' },
        take: 5
      }),
      prisma.appointment.findMany({
        where: { businessId: req.businessId!, contactPhone: contact.phone },
        orderBy: { scheduledAt: 'desc' },
        take: 5
      })
    ]);
    
    res.json({ ...contact, orders, appointments });
  } catch (error: any) {
    console.error('API contact detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/contacts/:phone', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { phone } = req.params;
    const { name, email, tags, notes, metadata } = req.body;
    const cleanPhone = phone.replace(/\D/g, '');
    
    const contact = await prisma.contact.findFirst({
      where: { 
        businessId: req.businessId,
        phone: { contains: cleanPhone }
      }
    });
    
    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (tags !== undefined) updateData.tags = tags;
    if (notes !== undefined) updateData.notes = notes;
    if (metadata !== undefined) {
      updateData.metadata = {
        ...(contact.metadata as any || {}),
        ...metadata
      };
    }
    
    const updated = await prisma.contact.update({
      where: { id: contact.id },
      data: updateData
    });
    
    res.json(updated);
  } catch (error: any) {
    console.error('API contact update error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/messages/:phone', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { phone } = req.params;
    const { limit = 50 } = req.query;
    const cleanPhone = phone.replace(/\D/g, '');
    
    const messages = await prisma.messageLog.findMany({
      where: {
        businessId: req.businessId,
        OR: [
          { sender: { contains: cleanPhone } },
          { recipient: { contains: cleanPhone } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit), 200),
      select: {
        id: true,
        sender: true,
        recipient: true,
        message: true,
        direction: true,
        mediaUrl: true,
        createdAt: true
      }
    });
    
    res.json({
      messages: messages.reverse(),
      phone: cleanPhone
    });
  } catch (error: any) {
    console.error('API messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { limit = 50, status } = req.query;
    
    const where: any = { businessId: req.businessId };
    if (status) where.status = status;
    
    const orders = await prisma.order.findMany({
      where,
      take: Math.min(Number(limit), 200),
      orderBy: { createdAt: 'desc' },
      include: {
        items: true
      }
    });
    
    res.json({ orders });
  } catch (error: any) {
    console.error('API orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/appointments', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { limit = 50, status, from, to } = req.query;
    
    const where: any = { businessId: req.businessId };
    if (status) where.status = status;
    if (from || to) {
      where.scheduledAt = {};
      if (from) where.scheduledAt.gte = new Date(from as string);
      if (to) where.scheduledAt.lte = new Date(to as string);
    }
    
    const appointments = await prisma.appointment.findMany({
      where,
      take: Math.min(Number(limit), 200),
      orderBy: { scheduledAt: 'asc' }
    });
    
    res.json({ appointments });
  } catch (error: any) {
    console.error('API appointments error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
