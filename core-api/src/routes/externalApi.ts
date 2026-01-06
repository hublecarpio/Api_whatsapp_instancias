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
        metaCoexistCredential: true,
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
            metaCredential: true,
            metaCoexistCredential: true
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
        ['external_api'],
        instance.id
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
        ['external_api'],
        instance.id
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
    } else if (instance.provider === 'META_COEXIST') {
      const coexistCred = instance.metaCoexistCredential;
      
      if (!coexistCred) {
        return res.status(400).json({ error: 'Instancia META Coexist no configurada correctamente' });
      }
      
      const accessToken = coexistCred.systemAccessToken || coexistCred.userAccessToken;
      const phoneNumberId = coexistCred.phoneNumberId;
      
      if (!accessToken || !phoneNumberId) {
        return res.status(400).json({ 
          error: 'Credenciales META Coexist incompletas',
          hint: 'Falta phoneNumberId - use el endpoint de reparación para configurarlo'
        });
      }
      
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
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const messageId = response.data.messages?.[0]?.id;
      
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
          metadata: { source: 'external_api', provider: 'META_COEXIST', mediaType }
        }
      });
      
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
      
      await dispatchAgentMessage(
        business.id,
        cleanTo,
        message || '',
        mediaUrl ? [mediaUrl] : undefined,
        ['external_api'],
        instance.id
      );
      
      await eventLogger.info('EXTERNAL_API', `Mensaje enviado via API META Coexist a ${cleanTo}`, {
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

router.get('/agent-config', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.businessId },
      include: {
        agentPrompts: {
          include: {
            tools: { where: { enabled: true } }
          }
        },
        policy: true
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }
    
    const agentConfig = business.agentPrompts?.[0];
    
    res.json({
      agentVersion: business.agentVersion || 'v1',
      botEnabled: business.botEnabled,
      prompt: agentConfig?.prompt || null,
      historyLimit: agentConfig?.historyLimit || 10,
      splitMessages: agentConfig?.splitMessages ?? true,
      tools: (agentConfig?.tools || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        endpoint: t.endpoint,
        method: t.method,
        enabled: t.enabled
      })),
      policy: business.policy ? {
        shippingPolicy: business.policy.shippingPolicy,
        refundPolicy: business.policy.refundPolicy,
        brandVoice: business.policy.brandVoice,
        allowedHours: business.policy.allowedHours
      } : null,
      businessObjective: business.businessObjective,
      timezone: business.timezone
    });
  } catch (error: any) {
    console.error('API agent-config error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/agent-config', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { 
      prompt, 
      historyLimit, 
      splitMessages, 
      botEnabled,
      agentVersion
    } = req.body;
    
    const updates: any = {};
    
    if (botEnabled !== undefined) {
      await prisma.business.update({
        where: { id: req.businessId },
        data: { botEnabled }
      });
    }
    
    if (agentVersion !== undefined && ['v1', 'v2'].includes(agentVersion)) {
      await prisma.business.update({
        where: { id: req.businessId },
        data: { agentVersion }
      });
    }
    
    const existingPrompt = await prisma.agentPrompt.findFirst({
      where: { businessId: req.businessId }
    });
    
    const promptData: any = {};
    if (prompt !== undefined) promptData.prompt = prompt;
    if (historyLimit !== undefined) promptData.historyLimit = historyLimit;
    if (splitMessages !== undefined) promptData.splitMessages = splitMessages;
    
    if (Object.keys(promptData).length > 0) {
      if (existingPrompt) {
        await prisma.agentPrompt.update({
          where: { id: existingPrompt.id },
          data: promptData
        });
      } else {
        await prisma.agentPrompt.create({
          data: {
            businessId: req.businessId!,
            prompt: prompt || 'Eres un asistente de atencion al cliente amable y profesional.',
            ...promptData
          }
        });
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Configuracion del agente actualizada'
    });
  } catch (error: any) {
    console.error('API agent-config update error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/products', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { limit = 100, category, inStock } = req.query;
    
    const where: any = { businessId: req.businessId };
    if (category) where.category = category;
    if (inStock === 'true') where.stock = { gt: 0 };
    
    const products = await prisma.product.findMany({
      where,
      take: Math.min(Number(limit), 500),
      orderBy: { title: 'asc' }
    });
    
    res.json({ 
      products: products.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        stock: p.stock,
        imageUrl: p.imageUrl
      }))
    });
  } catch (error: any) {
    console.error('API products error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/business-info', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.businessId },
      include: {
        instances: {
          select: {
            id: true,
            name: true,
            phoneNumber: true,
            provider: true,
            status: true,
            isActive: true
          }
        },
        followUpConfigs: {
          select: {
            id: true,
            instanceId: true,
            enabled: true,
            firstDelayMinutes: true,
            triggerMode: true
          }
        }
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }
    
    res.json({
      id: business.id,
      name: business.name,
      botEnabled: business.botEnabled,
      agentVersion: business.agentVersion,
      businessObjective: business.businessObjective,
      timezone: business.timezone,
      instances: business.instances,
      followUpConfigs: business.followUpConfigs
    });
  } catch (error: any) {
    console.error('API business-info error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/reminders', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { contactPhone, message, scheduledAt, type = 'manual' } = req.body;
    
    if (!contactPhone) {
      return res.status(400).json({ error: 'Campo "contactPhone" es requerido' });
    }
    
    if (!scheduledAt) {
      return res.status(400).json({ error: 'Campo "scheduledAt" es requerido (ISO 8601)' });
    }
    
    const cleanPhone = contactPhone.replace(/\D/g, '');
    const scheduledDate = new Date(scheduledAt);
    
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: 'Formato de fecha invalido. Use ISO 8601 (ej: 2024-01-15T10:30:00Z)' });
    }
    
    const contact = await prisma.contact.findFirst({
      where: { businessId: req.businessId, phone: cleanPhone }
    });
    
    const reminder = await prisma.reminder.create({
      data: {
        businessId: req.businessId!,
        instanceId: req.instanceId,
        contactPhone: cleanPhone,
        contactName: contact?.name || null,
        messageTemplate: message || null,
        scheduledAt: scheduledDate,
        type: type as any,
        status: 'pending',
        attemptNumber: 1
      }
    });
    
    res.json({
      success: true,
      reminder: {
        id: reminder.id,
        contactPhone: reminder.contactPhone,
        scheduledAt: reminder.scheduledAt,
        status: reminder.status
      }
    });
  } catch (error: any) {
    console.error('API reminders create error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/reminders', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { limit = 50, status, contactPhone } = req.query;
    
    const where: any = { businessId: req.businessId };
    if (status) where.status = status;
    if (contactPhone) where.contactPhone = (contactPhone as string).replace(/\D/g, '');
    
    const reminders = await prisma.reminder.findMany({
      where,
      take: Math.min(Number(limit), 200),
      orderBy: { scheduledAt: 'asc' }
    });
    
    res.json({ reminders });
  } catch (error: any) {
    console.error('API reminders error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/reminders/:id', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const reminder = await prisma.reminder.findFirst({
      where: { id, businessId: req.businessId }
    });
    
    if (!reminder) {
      return res.status(404).json({ error: 'Recordatorio no encontrado' });
    }
    
    await prisma.reminder.delete({ where: { id } });
    
    res.json({ success: true, message: 'Recordatorio eliminado' });
  } catch (error: any) {
    console.error('API reminders delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/contacts/:phone', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const cleanPhone = req.params.phone.replace(/\D/g, '');
    const { name, email, tags, notes, leadStage, botPaused } = req.body;
    
    const contact = await prisma.contact.findFirst({
      where: { businessId: req.businessId, phone: cleanPhone }
    });
    
    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (tags !== undefined) updateData.tags = tags;
    if (notes !== undefined) updateData.notes = notes;
    if (leadStage !== undefined) updateData.leadStage = leadStage;
    if (botPaused !== undefined) updateData.botPaused = botPaused;
    
    const updated = await prisma.contact.update({
      where: { id: contact.id },
      data: updateData
    });
    
    res.json({ success: true, contact: updated });
  } catch (error: any) {
    console.error('API contacts update error:', error);
    res.status(500).json({ error: error.message });
  }
});

const META_API_URL = 'https://graph.facebook.com/v21.0';

function getMetaCredentials(instance: any): { accessToken: string; phoneNumberId: string; wabaId: string; credentialId: string } | null {
  if (instance.provider === 'META_CLOUD' && instance.metaCredential) {
    return {
      accessToken: instance.metaCredential.accessToken,
      phoneNumberId: instance.metaCredential.phoneNumberId,
      wabaId: instance.metaCredential.businessId,
      credentialId: instance.metaCredential.id
    };
  }
  
  if (instance.provider === 'META_COEXIST' && instance.metaCoexistCredential) {
    return {
      accessToken: instance.metaCoexistCredential.systemAccessToken || instance.metaCoexistCredential.userAccessToken,
      phoneNumberId: instance.metaCoexistCredential.phoneNumberId,
      wabaId: instance.metaCoexistCredential.wabaId,
      credentialId: instance.metaCoexistCredential.id
    };
  }
  
  return null;
}

router.get('/templates', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const creds = getMetaCredentials(req.instance);
    
    if (!creds) {
      return res.status(400).json({ 
        error: 'Esta instancia no soporta plantillas',
        hint: 'Las plantillas solo estan disponibles para instancias Meta Cloud o Meta Coexist'
      });
    }
    
    const templates = await prisma.metaTemplate.findMany({
      where: { credentialId: creds.credentialId },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ 
      templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        bodyText: t.bodyText,
        headerType: t.headerType,
        lastSynced: t.lastSynced
      }))
    });
  } catch (error: any) {
    console.error('API templates error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/templates/sync', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const creds = getMetaCredentials(req.instance);
    
    if (!creds) {
      return res.status(400).json({ 
        error: 'Esta instancia no soporta plantillas',
        hint: 'Las plantillas solo estan disponibles para instancias Meta Cloud o Meta Coexist'
      });
    }
    
    const response = await axios.get(
      `${META_API_URL}/${creds.wabaId}/message_templates`,
      {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        params: { limit: 100 }
      }
    );
    
    const metaTemplates = response.data.data || [];
    const synced = [];
    
    for (const mt of metaTemplates) {
      const headerComponent = mt.components?.find((c: any) => c.type === 'HEADER');
      const bodyComponent = mt.components?.find((c: any) => c.type === 'BODY');
      const footerComponent = mt.components?.find((c: any) => c.type === 'FOOTER');
      const buttonsComponent = mt.components?.find((c: any) => c.type === 'BUTTONS');
      
      const template = await prisma.metaTemplate.upsert({
        where: {
          credentialId_name: {
            credentialId: creds.credentialId,
            name: mt.name
          }
        },
        update: {
          metaTemplateId: mt.id,
          language: mt.language || 'es',
          category: mt.category || 'UTILITY',
          status: mt.status || 'PENDING',
          components: mt.components || [],
          headerType: headerComponent?.format || null,
          bodyText: bodyComponent?.text || null,
          footerText: footerComponent?.text || null,
          buttons: buttonsComponent?.buttons || null,
          lastSynced: new Date()
        },
        create: {
          credentialId: creds.credentialId,
          metaTemplateId: mt.id,
          name: mt.name,
          language: mt.language || 'es',
          category: mt.category || 'UTILITY',
          status: mt.status || 'PENDING',
          components: mt.components || [],
          headerType: headerComponent?.format || null,
          bodyText: bodyComponent?.text || null,
          footerText: footerComponent?.text || null,
          buttons: buttonsComponent?.buttons || null
        }
      });
      
      synced.push({
        id: template.id,
        name: template.name,
        status: template.status
      });
    }
    
    res.json({ 
      synced: synced.length, 
      templates: synced,
      message: `Se sincronizaron ${synced.length} plantillas desde Meta`
    });
  } catch (error: any) {
    console.error('API templates sync error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error al sincronizar plantillas',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

router.post('/templates/send', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { templateName, to, variables, headerVariables } = req.body;
    
    if (!templateName || !to) {
      return res.status(400).json({ error: 'templateName y to son requeridos' });
    }
    
    const creds = getMetaCredentials(req.instance);
    
    if (!creds) {
      return res.status(400).json({ 
        error: 'Esta instancia no soporta plantillas',
        hint: 'Las plantillas solo estan disponibles para instancias Meta Cloud o Meta Coexist'
      });
    }
    
    const template = await prisma.metaTemplate.findFirst({
      where: {
        credentialId: creds.credentialId,
        name: templateName,
        status: 'APPROVED'
      }
    });
    
    if (!template) {
      return res.status(404).json({ error: 'Plantilla aprobada no encontrada' });
    }
    
    const cleanTo = to.replace(/\D/g, '');
    
    const templateComponents: any[] = [];
    
    if (headerVariables && headerVariables.length > 0) {
      templateComponents.push({
        type: 'header',
        parameters: headerVariables.map((v: string) => ({
          type: 'text',
          text: v
        }))
      });
    }
    
    if (variables && variables.length > 0) {
      templateComponents.push({
        type: 'body',
        parameters: variables.map((v: string) => ({
          type: 'text',
          text: v
        }))
      });
    }
    
    const response = await axios.post(
      `${META_API_URL}/${creds.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          components: templateComponents.length > 0 ? templateComponents : undefined
        }
      },
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    await prisma.messageLog.create({
      data: {
        businessId: req.businessId!,
        instanceId: req.instanceId,
        direction: 'OUTGOING',
        recipient: cleanTo,
        message: `[Template: ${template.name}]`,
        metadata: { 
          provider: req.instance.provider,
          template: template.name,
          variables,
          viaExternalApi: true
        }
      }
    });
    
    res.json({
      success: true,
      messageId: response.data.messages?.[0]?.id,
      template: template.name
    });
  } catch (error: any) {
    console.error('API send template error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error al enviar plantilla',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

export default router;
