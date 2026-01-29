import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../services/prisma';
import eventLogger from '../services/eventLogger';
import { dispatchAgentMessage } from '../services/webhookService';
import { getOutboundMessageQueue, OutboundMessageJobData } from '../services/queues/index';
import { processWithOrchestrator, OrchestratorInput, toolRegistry } from '../services/agent/index.js';
import { ContextBuilder, loadBusinessContext, loadConversationContext } from '../services/agent/prompts/contextBuilder.js';
import { ToolContext, ToolAvailabilityContext, ToolDefinitionContext } from '../services/agent/core/types.js';
import { loadCustomToolsForBusiness } from '../services/agent/tools/customToolAdapter.js';

const router = Router();

console.log('[EXTERNAL-API] Routes module loaded - registering /api/v1/* endpoints');

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
    const { to, message, mediaUrl, mediaType, priority = 'normal', sync = false } = req.body;
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
    const queue = getOutboundMessageQueue();
    
    if (!queue || sync === true) {
      return await sendMessageSync(req, res, business, instance, cleanTo, message, mediaUrl, mediaType);
    }
    
    if (instance.provider === 'BAILEYS' && !instance.instanceBackendId) {
      return res.status(500).json({ 
        error: 'Instancia Baileys no configurada correctamente',
        hint: 'La instancia no tiene un backend ID asignado. Por favor, recrea la instancia.'
      });
    }
    
    if (instance.provider === 'META_CLOUD') {
      const metaCred = instance.metaCredential;
      if (!metaCred || !metaCred.accessToken || !metaCred.phoneNumberId) {
        return res.status(400).json({ error: 'Instancia META no configurada correctamente' });
      }
    }
    
    if (instance.provider === 'META_COEXIST') {
      const coexistCred = instance.metaCoexistCredential;
      if (!coexistCred) {
        return res.status(400).json({ error: 'Instancia META Coexist no configurada correctamente' });
      }
      const accessToken = coexistCred.systemAccessToken || coexistCred.userAccessToken;
      if (!accessToken || !coexistCred.phoneNumberId) {
        return res.status(400).json({ 
          error: 'Credenciales META Coexist incompletas',
          hint: 'Falta phoneNumberId - use el endpoint de reparación para configurarlo'
        });
      }
    }
    
    const jobId = `msg_${uuidv4()}`;
    const jobData: OutboundMessageJobData = {
      jobId,
      businessId: business.id,
      instanceId: instance.id,
      to: cleanTo,
      message,
      mediaUrl,
      mediaType,
      provider: instance.provider as 'BAILEYS' | 'META_CLOUD' | 'META_COEXIST',
      instanceBackendId: instance.instanceBackendId,
      metaCredential: instance.metaCredential ? {
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId
      } : undefined,
      metaCoexistCredential: instance.metaCoexistCredential ? {
        accessToken: instance.metaCoexistCredential.systemAccessToken || instance.metaCoexistCredential.userAccessToken,
        phoneNumberId: instance.metaCoexistCredential.phoneNumberId
      } : undefined,
      phoneNumber: instance.phoneNumber,
      enqueuedAt: Date.now(),
      priority: priority as 'high' | 'normal' | 'low',
      source: 'external_api'
    };
    
    const priorityValue = priority === 'high' ? 1 : priority === 'low' ? 10 : 5;
    
    await queue.add(jobId, jobData, {
      jobId,
      priority: priorityValue
    });
    
    await eventLogger.info('EXTERNAL_API', `Mensaje encolado para ${cleanTo}`, {
      businessId: business.id,
      details: { to: cleanTo, hasMedia: !!mediaUrl, jobId, priority }
    });
    
    res.status(202).json({
      success: true,
      queued: true,
      jobId,
      to: cleanTo,
      status: 'pending',
      statusUrl: `/api/external/message-status/${jobId}`
    });
    
  } catch (error: any) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      error: error.message,
      hint: 'Si el problema persiste, contacte soporte tecnico'
    });
  }
});

async function sendMessageSync(req: ApiKeyRequest, res: Response, business: any, instance: any, cleanTo: string, message: string, mediaUrl?: string, mediaType?: string) {
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
    let payload: any = { to: cleanTo, message };
    
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
    
    await prisma.messageLog.create({
      data: {
        businessId: business.id,
        instanceId: instance.id,
        sender: instance.phoneNumber || business.id,
        recipient: cleanTo,
        message: message || (mediaUrl ? `[Media: ${mediaType || 'file'}]` : ''),
        direction: 'outbound',
        mediaUrl: mediaUrl || null,
        providerMessageId: messageId,
        metadata: { source: 'external_api', mediaType, sync: true }
      }
    });
    
    const now = new Date();
    await prisma.contact.upsert({
      where: { businessId_phone: { businessId: business.id, phone: cleanTo } },
      create: { businessId: business.id, phone: cleanTo, name: cleanTo, firstMessageAt: now, lastMessageAt: now, messageCount: 1 },
      update: { lastMessageAt: now, messageCount: { increment: 1 } }
    });
    
    await dispatchAgentMessage(business.id, cleanTo, message || '', mediaUrl ? [mediaUrl] : undefined, ['external_api'], instance.id);
    
    return res.json({ success: true, messageId, to: cleanTo, sync: true });
    
  } else if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
    const credential = instance.provider === 'META_CLOUD' ? instance.metaCredential : instance.metaCoexistCredential;
    const accessToken = instance.provider === 'META_CLOUD' ? credential?.accessToken : (credential?.systemAccessToken || credential?.userAccessToken);
    const phoneNumberId = credential?.phoneNumberId;
    
    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({ error: 'Instancia META no configurada correctamente' });
    }
    
    let payload: any;
    if (mediaUrl) {
      const type = mediaType || 'image';
      payload = { messaging_product: 'whatsapp', to: cleanTo, type, [type]: { link: mediaUrl, caption: message || undefined } };
    } else {
      payload = { messaging_product: 'whatsapp', to: cleanTo, type: 'text', text: { body: message } };
    }
    
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    
    const messageId = response.data.messages?.[0]?.id;
    
    await prisma.messageLog.create({
      data: {
        businessId: business.id,
        instanceId: instance.id,
        sender: instance.phoneNumber || business.id,
        recipient: cleanTo,
        message: message || (mediaUrl ? `[Media: ${mediaType || 'file'}]` : ''),
        direction: 'outbound',
        mediaUrl: mediaUrl || null,
        providerMessageId: messageId,
        metadata: { source: 'external_api', provider: instance.provider, mediaType, sync: true }
      }
    });
    
    const now = new Date();
    await prisma.contact.upsert({
      where: { businessId_phone: { businessId: business.id, phone: cleanTo } },
      create: { businessId: business.id, phone: cleanTo, name: cleanTo, firstMessageAt: now, lastMessageAt: now, messageCount: 1 },
      update: { lastMessageAt: now, messageCount: { increment: 1 } }
    });
    
    await dispatchAgentMessage(business.id, cleanTo, message || '', mediaUrl ? [mediaUrl] : undefined, ['external_api'], instance.id);
    
    return res.json({ success: true, messageId, to: cleanTo, sync: true });
    
  } else {
    return res.status(400).json({ error: 'Proveedor de WhatsApp no soportado' });
  }
}

router.get('/message-status/:jobId', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { jobId } = req.params;
    const queue = getOutboundMessageQueue();
    
    if (!queue) {
      return res.status(503).json({ error: 'Queue service not available' });
    }
    
    const job = await queue.getJob(jobId);
    
    if (!job) {
      const messageLog = await prisma.messageLog.findFirst({
        where: {
          businessId: req.business.id,
          metadata: { path: ['queueJobId'], equals: jobId }
        },
        select: { id: true, providerMessageId: true, createdAt: true }
      });
      
      if (messageLog) {
        return res.json({
          jobId,
          status: 'completed',
          messageId: messageLog.providerMessageId,
          completedAt: messageLog.createdAt
        });
      }
      
      return res.status(404).json({ error: 'Job not found', jobId });
    }
    
    const state = await job.getState();
    const progress = job.progress;
    
    let response: any = {
      jobId,
      status: state,
      to: job.data.to,
      enqueuedAt: new Date(job.data.enqueuedAt).toISOString(),
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts
    };
    
    if (state === 'completed') {
      const returnValue = job.returnvalue as any;
      response.messageId = returnValue?.messageId;
      response.completedAt = job.finishedOn ? new Date(job.finishedOn).toISOString() : null;
    }
    
    if (state === 'failed') {
      response.error = job.failedReason;
      response.failedAt = job.finishedOn ? new Date(job.finishedOn).toISOString() : null;
    }
    
    res.json(response);
    
  } catch (error: any) {
    console.error('API message-status error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error obteniendo estado del mensaje',
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

router.get('/orders/:orderId', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        businessId: req.businessId
      },
      include: {
        items: true
      }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    res.json({ order });
  } catch (error: any) {
    console.error('API get order error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { 
      contactPhone, 
      contactName, 
      items, 
      shippingAddress, 
      shippingCity, 
      shippingCountry,
      notes
    } = req.body;
    
    if (!contactPhone) {
      return res.status(400).json({ error: 'contactPhone es requerido' });
    }
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items es requerido (array de productos)' });
    }
    
    const cleanPhone = contactPhone.replace(/\D/g, '');
    
    const business = await prisma.business.findUnique({
      where: { id: req.businessId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }
    
    const productIds = items.map((i: any) => i.productId).filter(Boolean);
    const products = productIds.length > 0 
      ? await prisma.product.findMany({
          where: { id: { in: productIds }, businessId: req.businessId }
        })
      : [];
    
    const productMap = new Map(products.map(p => [p.id, p]));
    let totalAmount = 0;
    
    const orderItems = items.map((item: any) => {
      const product = item.productId ? productMap.get(item.productId) : null;
      let unitPrice = item.unitPrice ?? product?.price ?? 0;
      const quantity = item.quantity || 1;
      const variation = item.variation || null;
      
      if (product && variation && product.variations?.length > 0) {
        const varIndex = product.variations.findIndex(
          (v: string) => v.toLowerCase() === variation.toLowerCase()
        );
        if (varIndex !== -1 && product.pricePerVariation?.[varIndex] != null) {
          unitPrice = product.pricePerVariation[varIndex];
        }
      }
      
      totalAmount += unitPrice * quantity;
      
      return {
        productId: item.productId || null,
        productTitle: item.productTitle || product?.title || 'Producto',
        variation,
        quantity,
        unitPrice,
        imageUrl: item.imageUrl || product?.imageUrl || null
      };
    });
    
    const order = await prisma.order.create({
      data: {
        businessId: req.businessId!,
        instanceId: req.instanceId || null,
        contactPhone: cleanPhone,
        contactName: contactName || null,
        shippingAddress: shippingAddress || null,
        shippingCity: shippingCity || null,
        shippingCountry: shippingCountry || null,
        totalAmount,
        currencyCode: business.currencyCode || 'PEN',
        currencySymbol: business.currencySymbol || 'S/.',
        status: 'AWAITING_VOUCHER',
        notes: notes || null,
        items: {
          create: orderItems
        }
      },
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Order created: ${order.id} for phone ${cleanPhone}`);
    
    res.status(201).json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        totalAmount: order.totalAmount,
        currencySymbol: order.currencySymbol,
        contactPhone: order.contactPhone,
        contactName: order.contactName,
        items: order.items,
        createdAt: order.createdAt
      },
      message: 'Pedido creado exitosamente. Esperando comprobante de pago.'
    });
  } catch (error: any) {
    console.error('API create order error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/orders/:orderId/status', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { status, notes, deliveryAgentId, deliveryAgentName } = req.body;
    
    const validStatuses = [
      'AWAITING_VOUCHER', 
      'PAID', 
      'PROCESSING', 
      'SHIPPED', 
      'DELIVERED', 
      'CANCELLED', 
      'REFUNDED'
    ];
    
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Estado no valido',
        validStatuses
      });
    }
    
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        businessId: req.businessId
      }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    const allowedTransitions: Record<string, string[]> = {
      'AWAITING_VOUCHER': ['PAID', 'CANCELLED'],
      'PAID': ['PROCESSING', 'CANCELLED', 'REFUNDED'],
      'PROCESSING': ['SHIPPED', 'CANCELLED', 'REFUNDED'],
      'SHIPPED': ['DELIVERED', 'CANCELLED', 'REFUNDED'],
      'DELIVERED': ['REFUNDED'],
      'CANCELLED': [],
      'REFUNDED': []
    };
    
    const currentStatus = order.status;
    const allowedNextStatuses = allowedTransitions[currentStatus] || [];
    
    if (!allowedNextStatuses.includes(status)) {
      return res.status(400).json({
        error: `Transicion de estado no permitida: ${currentStatus} → ${status}`,
        currentStatus,
        requestedStatus: status,
        allowedTransitions: allowedNextStatuses,
        hint: allowedNextStatuses.length > 0 
          ? `Desde ${currentStatus} solo puedes ir a: ${allowedNextStatuses.join(', ')}`
          : `El estado ${currentStatus} es final y no permite mas cambios`
      });
    }
    
    const updateData: any = { status };
    
    if (status === 'PAID' && !order.paidAt) {
      updateData.paidAt = new Date();
    }
    if (status === 'SHIPPED' && !order.shippedAt) {
      updateData.shippedAt = new Date();
    }
    if (status === 'DELIVERED' && !order.deliveredAt) {
      updateData.deliveredAt = new Date();
    }
    if (notes) {
      updateData.notes = notes;
    }
    if (deliveryAgentId) {
      updateData.deliveryAgentId = deliveryAgentId;
    }
    if (deliveryAgentName) {
      updateData.deliveryAgentName = deliveryAgentName;
    }
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Order ${orderId} status changed to ${status}`);
    
    res.json({
      success: true,
      order: updatedOrder,
      message: `Estado del pedido actualizado a ${status}`
    });
  } catch (error: any) {
    console.error('API update order status error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:orderId/confirm', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { notes } = req.body;
    
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        businessId: req.businessId
      },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (order.status !== 'AWAITING_VOUCHER') {
      return res.status(400).json({ 
        error: 'Solo se pueden confirmar pedidos en estado AWAITING_VOUCHER',
        currentStatus: order.status
      });
    }
    
    if (!order.voucherImageUrl) {
      return res.status(400).json({ 
        error: 'No se ha recibido comprobante de pago para este pedido',
        hint: 'El cliente debe enviar el voucher primero, o use POST /orders/:orderId/voucher para adjuntarlo'
      });
    }
    
    const updateData: any = {
      status: 'PAID',
      paidAt: new Date()
    };
    
    if (notes) {
      updateData.notes = notes;
    }
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Order ${orderId} payment confirmed`);
    
    res.json({
      success: true,
      order: updatedOrder,
      message: 'Pago confirmado exitosamente'
    });
  } catch (error: any) {
    console.error('API confirm order error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:orderId/voucher', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { 
      voucherImageUrl, 
      amount,
      paymentMethod,
      operationCode,
      brand,
      notes: voucherNotes
    } = req.body;
    
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ 
        error: 'amount es requerido (monto del voucher en numeros)',
        hint: 'Ejemplo: { "amount": 50.00, "voucherImageUrl": "...", "paymentMethod": "YAPE" }'
      });
    }
    
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        businessId: req.businessId
      },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (!['AWAITING_VOUCHER', 'PAID'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Solo se pueden agregar vouchers a pedidos en estado AWAITING_VOUCHER o PAID (pago parcial)',
        currentStatus: order.status
      });
    }
    
    const currentPaidAmount = order.paidAmount || 0;
    const newPaidAmount = currentPaidAmount + amount;
    const totalAmount = order.totalAmount || 0;
    const newPendingAmount = Math.max(0, totalAmount - newPaidAmount);
    
    const paymentRecord = {
      amount,
      paymentMethod: paymentMethod || 'TRANSFERENCIA',
      operationCode: operationCode || null,
      brand: brand || null,
      imageUrl: voucherImageUrl || null,
      notes: voucherNotes || null,
      timestamp: new Date().toISOString()
    };
    
    const existingNotes = order.notes ? (typeof order.notes === 'string' ? JSON.parse(order.notes) : order.notes) : {};
    const paymentHistory = existingNotes.paymentHistory || [];
    paymentHistory.push(paymentRecord);
    
    const updatedNotes = {
      ...existingNotes,
      paymentHistory,
      lastVoucherAmount: amount,
      lastPaymentMethod: paymentMethod || 'TRANSFERENCIA'
    };
    
    const updateData: any = {
      paidAmount: newPaidAmount,
      pendingAmount: newPendingAmount,
      lastVoucherAmount: amount,
      voucherReceivedAt: new Date(),
      notes: JSON.stringify(updatedNotes)
    };
    
    if (voucherImageUrl) {
      updateData.voucherImageUrl = voucherImageUrl;
    }
    
    const isFullyPaid = newPaidAmount >= totalAmount;
    if (isFullyPaid) {
      updateData.status = 'PAID';
      updateData.paidAt = new Date();
    }
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Voucher added to order ${orderId}: ${order.currencySymbol}${amount} (${paymentMethod || 'TRANSFERENCIA'}). Total paid: ${order.currencySymbol}${newPaidAmount}/${totalAmount}`);
    
    res.json({
      success: true,
      order: updatedOrder,
      payment: {
        voucherAmount: amount,
        paymentMethod: paymentMethod || 'TRANSFERENCIA',
        operationCode: operationCode || null,
        previousPaidAmount: currentPaidAmount,
        newPaidAmount,
        totalAmount,
        pendingAmount: newPendingAmount,
        isFullyPaid,
        paymentCount: paymentHistory.length
      },
      message: isFullyPaid 
        ? `Pago completado! Total pagado: ${order.currencySymbol}${newPaidAmount}`
        : `Pago parcial registrado. Pagado: ${order.currencySymbol}${newPaidAmount} de ${order.currencySymbol}${totalAmount}. Pendiente: ${order.currencySymbol}${newPendingAmount}`
    });
  } catch (error: any) {
    console.error('API attach voucher error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// HISTORIAL DE PAGOS
// GET /orders/:orderId/payments - Ver todos los vouchers/pagos del pedido
// ============================================================================
router.get('/orders/:orderId/payments', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId: req.businessId },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    const notes = order.notes ? (typeof order.notes === 'string' ? JSON.parse(order.notes) : order.notes) : {};
    const paymentHistory = notes.paymentHistory || [];
    
    const totalPaid = paymentHistory.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
    
    res.json({
      success: true,
      orderId,
      summary: {
        totalAmount: order.totalAmount,
        paidAmount: order.paidAmount || 0,
        pendingAmount: order.pendingAmount || (order.totalAmount - (order.paidAmount || 0)),
        paymentCount: paymentHistory.length,
        isFullyPaid: (order.paidAmount || 0) >= order.totalAmount
      },
      payments: paymentHistory,
      currencySymbol: order.currencySymbol
    });
  } catch (error: any) {
    console.error('API get payments error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/orders/:orderId', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        businessId: req.businessId
      }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (!['AWAITING_VOUCHER', 'CANCELLED'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Solo se pueden eliminar pedidos en estado AWAITING_VOUCHER o CANCELLED',
        currentStatus: order.status
      });
    }
    
    await prisma.orderItem.deleteMany({
      where: { orderId }
    });
    
    await prisma.order.delete({
      where: { id: orderId }
    });
    
    console.log(`[EXTERNAL API] Order ${orderId} deleted`);
    
    res.json({
      success: true,
      message: 'Pedido eliminado exitosamente'
    });
  } catch (error: any) {
    console.error('API delete order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// MODIFICAR PRODUCTOS DEL PEDIDO
// PUT /orders/:orderId/items - Reemplaza todos los items del pedido
// ============================================================================
router.put('/orders/:orderId/items', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { items } = req.body;
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items es requerido (array de productos)' });
    }
    
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId: req.businessId },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (!['AWAITING_VOUCHER', 'PAID'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Solo se pueden modificar pedidos en estado AWAITING_VOUCHER o PAID',
        currentStatus: order.status
      });
    }
    
    const productIds = items.map((i: any) => i.productId).filter(Boolean);
    const products = productIds.length > 0 
      ? await prisma.product.findMany({
          where: { id: { in: productIds }, businessId: req.businessId }
        })
      : [];
    
    const productMap = new Map(products.map(p => [p.id, p]));
    let subtotalAmount = 0;
    
    const orderItems = items.map((item: any) => {
      const product = item.productId ? productMap.get(item.productId) : null;
      let unitPrice = item.unitPrice ?? product?.price ?? 0;
      const quantity = item.quantity || 1;
      const variation = item.variation || null;
      
      if (product && variation && product.variations?.length > 0) {
        const varIndex = product.variations.findIndex(
          (v: string) => v.toLowerCase() === variation.toLowerCase()
        );
        if (varIndex !== -1 && product.pricePerVariation?.[varIndex] != null) {
          unitPrice = product.pricePerVariation[varIndex];
        }
      }
      
      subtotalAmount += unitPrice * quantity;
      
      return {
        orderId,
        productId: item.productId || null,
        productTitle: item.productTitle || product?.title || 'Producto',
        variation,
        quantity,
        unitPrice,
        imageUrl: item.imageUrl || product?.imageUrl || null
      };
    });
    
    const shippingCost = order.shippingCost || 0;
    const totalAmount = subtotalAmount + shippingCost;
    const pendingAmount = totalAmount - (order.paidAmount || 0);
    
    await prisma.orderItem.deleteMany({ where: { orderId } });
    
    await prisma.orderItem.createMany({ data: orderItems });
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        subtotalAmount,
        totalAmount,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0
      },
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Order ${orderId} items updated, new total: ${totalAmount}`);
    
    res.json({
      success: true,
      order: updatedOrder,
      summary: {
        subtotal: subtotalAmount,
        shippingCost,
        total: totalAmount,
        paidAmount: order.paidAmount || 0,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0
      },
      message: 'Productos del pedido actualizados'
    });
  } catch (error: any) {
    console.error('API update order items error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// AGREGAR PRODUCTO AL PEDIDO
// POST /orders/:orderId/items - Agrega un producto sin eliminar los existentes
// ============================================================================
router.post('/orders/:orderId/items', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { productId, productTitle, variation, quantity = 1, unitPrice, imageUrl } = req.body;
    
    if (!productId && !productTitle) {
      return res.status(400).json({ error: 'productId o productTitle es requerido' });
    }
    
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId: req.businessId },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (!['AWAITING_VOUCHER', 'PAID'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Solo se pueden modificar pedidos en estado AWAITING_VOUCHER o PAID',
        currentStatus: order.status
      });
    }
    
    let product: any = null;
    if (productId) {
      product = await prisma.product.findFirst({
        where: { id: productId, businessId: req.businessId }
      });
    }
    
    let finalUnitPrice = unitPrice ?? product?.price ?? 0;
    const finalTitle = productTitle || product?.title || 'Producto';
    const finalImageUrl = imageUrl || product?.imageUrl || null;
    const finalVariation = variation || null;
    
    if (product && finalVariation && product.variations?.length > 0) {
      const varIndex = product.variations.findIndex(
        (v: string) => v.toLowerCase() === finalVariation.toLowerCase()
      );
      if (varIndex !== -1 && product.pricePerVariation?.[varIndex] != null) {
        finalUnitPrice = product.pricePerVariation[varIndex];
      }
    }
    
    const newItem = await prisma.orderItem.create({
      data: {
        orderId,
        productId: productId || null,
        productTitle: finalTitle,
        variation: finalVariation,
        quantity,
        unitPrice: finalUnitPrice,
        imageUrl: finalImageUrl
      }
    });
    
    const subtotalAmount = (order.subtotalAmount || order.totalAmount - (order.shippingCost || 0)) + (finalUnitPrice * quantity);
    const shippingCost = order.shippingCost || 0;
    const totalAmount = subtotalAmount + shippingCost;
    const pendingAmount = totalAmount - (order.paidAmount || 0);
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        subtotalAmount,
        totalAmount,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0
      },
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Item added to order ${orderId}: ${finalTitle} x${quantity}`);
    
    res.json({
      success: true,
      order: updatedOrder,
      addedItem: newItem,
      summary: {
        subtotal: subtotalAmount,
        shippingCost,
        total: totalAmount,
        paidAmount: order.paidAmount || 0,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0
      },
      message: 'Producto agregado al pedido'
    });
  } catch (error: any) {
    console.error('API add order item error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ELIMINAR PRODUCTO DEL PEDIDO
// DELETE /orders/:orderId/items/:itemId
// ============================================================================
router.delete('/orders/:orderId/items/:itemId', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId, itemId } = req.params;
    
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId: req.businessId },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (!['AWAITING_VOUCHER', 'PAID'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Solo se pueden modificar pedidos en estado AWAITING_VOUCHER o PAID',
        currentStatus: order.status
      });
    }
    
    const item = order.items.find(i => i.id === itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item no encontrado en el pedido' });
    }
    
    if (order.items.length === 1) {
      return res.status(400).json({ 
        error: 'No se puede eliminar el ultimo producto. Use DELETE /orders/:orderId para cancelar el pedido completo'
      });
    }
    
    await prisma.orderItem.delete({ where: { id: itemId } });
    
    const itemTotal = item.unitPrice * item.quantity;
    const subtotalAmount = (order.subtotalAmount || order.totalAmount - (order.shippingCost || 0)) - itemTotal;
    const shippingCost = order.shippingCost || 0;
    const totalAmount = subtotalAmount + shippingCost;
    const pendingAmount = totalAmount - (order.paidAmount || 0);
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        subtotalAmount,
        totalAmount,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0
      },
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Item ${itemId} removed from order ${orderId}`);
    
    res.json({
      success: true,
      order: updatedOrder,
      removedItem: item,
      summary: {
        subtotal: subtotalAmount,
        shippingCost,
        total: totalAmount,
        paidAmount: order.paidAmount || 0,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0
      },
      message: 'Producto eliminado del pedido'
    });
  } catch (error: any) {
    console.error('API remove order item error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// CAMBIAR ZONA DE ENVIO
// PATCH /orders/:orderId/shipping
// ============================================================================
router.patch('/orders/:orderId/shipping', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { deliveryZoneId, shippingAddress, shippingCity, shippingCost: manualShippingCost } = req.body;
    
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId: req.businessId },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    if (!['AWAITING_VOUCHER', 'PAID'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Solo se pueden modificar pedidos en estado AWAITING_VOUCHER o PAID',
        currentStatus: order.status
      });
    }
    
    const updateData: any = {};
    let newShippingCost = order.shippingCost || 0;
    let zoneName = null;
    
    if (deliveryZoneId) {
      const zone = await prisma.deliveryZone.findFirst({
        where: { id: deliveryZoneId, businessId: req.businessId }
      });
      
      if (!zone) {
        return res.status(404).json({ error: 'Zona de envio no encontrada' });
      }
      
      const subtotal = order.subtotalAmount || (order.totalAmount - (order.shippingCost || 0));
      
      if (zone.freeAbove && zone.freeAbove > 0 && subtotal >= zone.freeAbove) {
        newShippingCost = 0;
      } else {
        newShippingCost = zone.cost || 0;
      }
      
      zoneName = zone.name;
      updateData.deliveryZoneId = deliveryZoneId;
      updateData.deliveryZoneName = zone.name;
    } else if (manualShippingCost !== undefined) {
      newShippingCost = manualShippingCost;
    }
    
    if (shippingAddress) updateData.shippingAddress = shippingAddress;
    if (shippingCity) updateData.shippingCity = shippingCity;
    
    const subtotalAmount = order.subtotalAmount || (order.totalAmount - (order.shippingCost || 0));
    const totalAmount = subtotalAmount + newShippingCost;
    const pendingAmount = totalAmount - (order.paidAmount || 0);
    
    updateData.shippingCost = newShippingCost;
    updateData.subtotalAmount = subtotalAmount;
    updateData.totalAmount = totalAmount;
    updateData.pendingAmount = pendingAmount > 0 ? pendingAmount : 0;
    
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: { items: true }
    });
    
    console.log(`[EXTERNAL API] Order ${orderId} shipping updated to zone: ${zoneName || 'manual'}, cost: ${newShippingCost}`);
    
    res.json({
      success: true,
      order: updatedOrder,
      summary: {
        subtotal: subtotalAmount,
        shippingCost: newShippingCost,
        total: totalAmount,
        paidAmount: order.paidAmount || 0,
        pendingAmount: pendingAmount > 0 ? pendingAmount : 0,
        zoneName
      },
      message: zoneName 
        ? `Zona de envio actualizada a "${zoneName}" (${order.currencySymbol || 'S/.'}${newShippingCost})`
        : 'Costo de envio actualizado'
    });
  } catch (error: any) {
    console.error('API update order shipping error:', error);
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
    const { limit = 100, inStock, search } = req.query;
    
    const where: any = { businessId: req.businessId };
    if (inStock === 'true') where.stock = { gt: 0 };
    
    let products;
    
    if (search && typeof search === 'string' && search.trim()) {
      const searchTerm = search.trim().toLowerCase();
      const words = searchTerm.split(/\s+/).filter(w => w.length >= 2);
      
      const orConditions: any[] = [];
      
      orConditions.push(
        { title: { contains: searchTerm, mode: 'insensitive' } },
        { description: { contains: searchTerm, mode: 'insensitive' } }
      );
      
      for (const word of words) {
        orConditions.push(
          { title: { contains: word, mode: 'insensitive' } },
          { description: { contains: word, mode: 'insensitive' } }
        );
      }
      
      const variationMatches = words.length > 0 ? words : [searchTerm];
      for (const term of variationMatches) {
        orConditions.push({ variations: { has: term } });
      }
      
      where.OR = orConditions;
      
      const allProducts = await prisma.product.findMany({
        where,
        take: Math.min(Number(limit) * 3, 500)
      });
      
      const scored = allProducts.map(p => {
        let score = 0;
        const titleLower = (p.title || '').toLowerCase();
        const descLower = (p.description || '').toLowerCase();
        const allText = `${titleLower} ${descLower}`;
        
        if (titleLower === searchTerm) score += 100;
        if (titleLower.includes(searchTerm)) score += 50;
        if (descLower.includes(searchTerm)) score += 20;
        
        for (const word of words) {
          if (titleLower.includes(word)) score += 10;
          if (descLower.includes(word)) score += 5;
        }
        
        const variationsLower = (p.variations || []).map((v: string) => v.toLowerCase());
        for (const word of words) {
          if (variationsLower.some((v: string) => v.includes(word))) score += 8;
        }
        
        return { product: p, score };
      });
      
      scored.sort((a, b) => b.score - a.score);
      products = scored.slice(0, Math.min(Number(limit), 500)).map(s => s.product);
    } else {
      products = await prisma.product.findMany({
        where,
        take: Math.min(Number(limit), 500),
        orderBy: { title: 'asc' }
      });
    }
    
    res.json({ 
      products: products.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        variations: p.variations,
        pricePerVariation: p.pricePerVariation,
        stock: p.stock,
        stockPerVariation: p.stockPerVariation,
        imageUrl: p.imageUrl,
        imageUrls: p.imageUrls
      }))
    });
  } catch (error: any) {
    console.error('API products error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/business-info', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const instanceId = req.instanceId;
    
const [business, deliveryZones, funnelStages, extractionFields, ragSections] = await Promise.all([
      prisma.business.findUnique({
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
      }),
      prisma.deliveryZone.findMany({
        where: {
          businessId: req.businessId,
          OR: [
            { instanceId: instanceId },
            { instanceId: null }
          ]
        },
        select: {
          id: true,
          name: true,
          districts: true,
          cost: true,
          deliveryTime: true,
          instanceId: true
        },
        orderBy: { name: 'asc' }
      }),
      prisma.funnelStage.findMany({
        where: {
          businessId: req.businessId,
          OR: [
            { instanceId: instanceId },
            { instanceId: null }
          ]
        },
        select: {
          id: true,
          name: true,
          order: true,
          requiredFieldKeys: true,
          blockedTopics: true,
          description: true,
          promptContext: true,
          toolsAllowed: true,
          instanceId: true
        },
        orderBy: { order: 'asc' }
      }),
      prisma.extractionField.findMany({
        where: {
          businessId: req.businessId,
          OR: [
            { instanceId: instanceId },
            { instanceId: null }
          ]
        },
        select: {
          id: true,
          fieldKey: true,
          fieldLabel: true,
          fieldType: true,
          description: true,
          required: true,
          order: true,
          instanceId: true
        },
        orderBy: { order: 'asc' }
      }),
      prisma.promptSection.findMany({
        where: {
          businessId: req.businessId,
          OR: [
            { instanceId: instanceId },
            { instanceId: null }
          ],
          enabled: true
        },
        select: {
          id: true,
          title: true,
          type: true,
          content: true,
          priority: true,
          isCore: true,
          keywords: true,
          instanceId: true
        },
        orderBy: [
          { isCore: 'desc' },
          { priority: 'desc' },
          { type: 'asc' }
        ]
      })
    ]);
    
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
      followUpConfigs: business.followUpConfigs,
      deliveryZones,
      funnelStages,
      extractionFields,
      ragSections
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

interface MetaCredentialsResult {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  credentialId: string;
  provider: 'META_CLOUD' | 'META_COEXIST';
}

function getMetaCredentials(instance: any): MetaCredentialsResult | null {
  if (instance.provider === 'META_CLOUD' && instance.metaCredential) {
    return {
      accessToken: instance.metaCredential.accessToken,
      phoneNumberId: instance.metaCredential.phoneNumberId,
      wabaId: instance.metaCredential.businessId,
      credentialId: instance.metaCredential.id,
      provider: 'META_CLOUD'
    };
  }
  
  if (instance.provider === 'META_COEXIST' && instance.metaCoexistCredential) {
    return {
      accessToken: instance.metaCoexistCredential.systemAccessToken || instance.metaCoexistCredential.userAccessToken,
      phoneNumberId: instance.metaCoexistCredential.phoneNumberId,
      wabaId: instance.metaCoexistCredential.wabaId,
      credentialId: instance.metaCoexistCredential.id,
      provider: 'META_COEXIST'
    };
  }
  
  return null;
}

function buildTemplateCredentialWhere(creds: MetaCredentialsResult): { credentialId?: string; coexistCredentialId?: string } {
  if (creds.provider === 'META_CLOUD') {
    return { credentialId: creds.credentialId };
  } else {
    return { coexistCredentialId: creds.credentialId };
  }
}

// Auto-migrate old templates that were saved with wrong credential field
async function migrateCoexistTemplates(coexistCredentialId: string): Promise<number> {
  // Find templates that have this coexistCredentialId stored in the wrong field (credentialId)
  const wrongTemplates = await prisma.metaTemplate.findMany({
    where: {
      credentialId: coexistCredentialId,
      coexistCredentialId: null
    }
  });
  
  if (wrongTemplates.length > 0) {
    console.log(`[MIGRATE] Found ${wrongTemplates.length} templates with wrong credential field, migrating...`);
    
    for (const t of wrongTemplates) {
      await prisma.metaTemplate.update({
        where: { id: t.id },
        data: {
          coexistCredentialId: coexistCredentialId,
          credentialId: null
        }
      });
    }
    
    console.log(`[MIGRATE] Migrated ${wrongTemplates.length} templates to coexistCredentialId`);
  }
  
  return wrongTemplates.length;
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
    
    // Auto-migrate old templates for META_COEXIST instances
    let migrated = 0;
    if (creds.provider === 'META_COEXIST') {
      migrated = await migrateCoexistTemplates(creds.credentialId);
    }
    
    const whereClause = buildTemplateCredentialWhere(creds);
    
    const templates = await prisma.metaTemplate.findMany({
      where: whereClause,
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
      
      const credentialWhere = buildTemplateCredentialWhere(creds);
      const credentialData = creds.provider === 'META_CLOUD' 
        ? { credentialId: creds.credentialId }
        : { coexistCredentialId: creds.credentialId };
      
      const existing = await prisma.metaTemplate.findFirst({
        where: { ...credentialWhere, name: mt.name }
      });
      
      let template;
      if (existing) {
        template = await prisma.metaTemplate.update({
          where: { id: existing.id },
          data: {
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
          }
        });
      } else {
        template = await prisma.metaTemplate.create({
          data: {
            ...credentialData,
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
      }
      
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
    const { templateName, to, variables, headerVariables, headerMedia, priority = 'high', sync = false } = req.body;
    
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
        ...buildTemplateCredentialWhere(creds),
        name: templateName,
        status: 'APPROVED'
      }
    });
    
    if (!template) {
      return res.status(404).json({ error: 'Plantilla aprobada no encontrada' });
    }
    
    const cleanTo = to.replace(/\D/g, '');
    
    const templateComponents: any[] = [];
    
    if (headerMedia) {
      const mediaType = headerMedia.type?.toLowerCase() || 'document';
      const mediaParam: any = { type: mediaType };
      
      if (mediaType === 'document') {
        mediaParam.document = { 
          link: headerMedia.link,
          filename: headerMedia.filename || 'document.pdf'
        };
      } else if (mediaType === 'image') {
        mediaParam.image = { link: headerMedia.link };
      } else if (mediaType === 'video') {
        mediaParam.video = { link: headerMedia.link };
      }
      
      templateComponents.push({
        type: 'header',
        parameters: [mediaParam]
      });
    } else if (headerVariables && headerVariables.length > 0) {
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
    
    const queue = getOutboundMessageQueue();
    const business = req.business;
    const instance = req.instance;
    
    if (!queue || sync) {
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
          direction: 'outbound',
          recipient: cleanTo,
          message: `[Template: ${template.name}]`,
          metadata: { 
            provider: req.instance.provider,
            template: template.name,
            variables,
            viaExternalApi: true,
            sync: true
          }
        }
      });
      
      return res.json({
        success: true,
        messageId: response.data.messages?.[0]?.id,
        template: template.name,
        sync: true
      });
    }
    
    const jobId = `tpl_${uuidv4()}`;
    const jobData: OutboundMessageJobData = {
      jobId,
      businessId: business.id,
      instanceId: instance.id,
      to: cleanTo,
      provider: instance.provider as 'META_CLOUD' | 'META_COEXIST',
      metaCredential: instance.metaCredential ? {
        accessToken: instance.metaCredential.accessToken,
        phoneNumberId: instance.metaCredential.phoneNumberId
      } : undefined,
      metaCoexistCredential: instance.metaCoexistCredential ? {
        accessToken: instance.metaCoexistCredential.systemAccessToken || instance.metaCoexistCredential.userAccessToken,
        phoneNumberId: instance.metaCoexistCredential.phoneNumberId
      } : undefined,
      phoneNumber: instance.phoneNumber,
      enqueuedAt: Date.now(),
      priority: priority as 'high' | 'normal' | 'low',
      source: 'external_api',
      templateData: {
        name: template.name,
        language: template.language,
        components: templateComponents.length > 0 ? templateComponents : undefined
      }
    };
    
    const priorityValue = priority === 'high' ? 1 : priority === 'low' ? 10 : 5;
    
    await queue.add(jobId, jobData, {
      jobId,
      priority: priorityValue,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 }
    });
    
    await eventLogger.info('EXTERNAL_API', `Template "${template.name}" encolado para ${cleanTo}`, {
      businessId: business.id,
      details: { to: cleanTo, template: template.name, jobId, priority }
    });
    
    res.status(202).json({
      success: true,
      queued: true,
      jobId,
      to: cleanTo,
      template: template.name,
      status: 'pending',
      statusUrl: `/api/external/message-status/${jobId}`
    });
    
  } catch (error: any) {
    console.error('API send template error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error al enviar plantilla',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

router.post('/templates/create', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { name, language, category, headerType, headerText, headerMediaUrl, bodyText, footerText, buttons } = req.body;
    
    if (!name || !bodyText) {
      return res.status(400).json({ error: 'name y bodyText son requeridos' });
    }
    
    const creds = getMetaCredentials(req.instance);
    
    if (!creds) {
      return res.status(400).json({ 
        error: 'Esta instancia no soporta plantillas',
        hint: 'Las plantillas solo estan disponibles para instancias Meta Cloud o Meta Coexist'
      });
    }
    
    const components: any[] = [];
    
    if (headerType && headerType !== 'NONE') {
      const headerComponent: any = { type: 'HEADER', format: headerType };
      if (headerType === 'TEXT' && headerText) {
        headerComponent.text = headerText;
      } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType) && headerMediaUrl) {
        headerComponent.example = { header_handle: [headerMediaUrl] };
      }
      components.push(headerComponent);
    }
    
    const bodyVariables = bodyText.match(/\{\{(\d+)\}\}/g) || [];
    const bodyComponent: any = { type: 'BODY', text: bodyText };
    if (bodyVariables.length > 0) {
      bodyComponent.example = {
        body_text: [bodyVariables.map((_: any, i: number) => `ejemplo${i + 1}`)]
      };
    }
    components.push(bodyComponent);
    
    if (footerText) {
      components.push({ type: 'FOOTER', text: footerText });
    }
    
    if (buttons && buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: buttons.map((btn: any) => ({
          type: btn.type || 'QUICK_REPLY',
          text: btn.text,
          ...(btn.url && { url: btn.url }),
          ...(btn.phone_number && { phone_number: btn.phone_number })
        }))
      });
    }
    
    const templateName = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    
    const response = await axios.post(
      `${META_API_URL}/${creds.wabaId}/message_templates`,
      {
        name: templateName,
        language: language || 'es',
        category: category || 'UTILITY',
        components
      },
      {
        headers: { 
          Authorization: `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const credentialData = creds.provider === 'META_CLOUD' 
      ? { credentialId: creds.credentialId }
      : { coexistCredentialId: creds.credentialId };
    
    const template = await prisma.metaTemplate.create({
      data: {
        ...credentialData,
        metaTemplateId: response.data.id,
        name: templateName,
        language: language || 'es',
        category: category || 'UTILITY',
        status: 'PENDING',
        components,
        headerType: headerType || null,
        bodyText,
        footerText: footerText || null,
        buttons: buttons || null
      }
    });
    
    res.status(201).json({
      success: true,
      template: {
        id: template.id,
        name: template.name,
        status: template.status,
        language: template.language,
        category: template.category
      },
      message: 'Plantilla creada y enviada para aprobacion de Meta'
    });
  } catch (error: any) {
    console.error('API create template error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error al crear plantilla',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

router.post('/chat', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { message, messages, contactPhone, contactName, useV3 } = req.body;
    
    if (!message && (!messages || !Array.isArray(messages))) {
      return res.status(400).json({ 
        error: 'Se requiere "message" (string) o "messages" (array)' 
      });
    }
    
    if (!contactPhone) {
      return res.status(400).json({ error: 'Se requiere "contactPhone"' });
    }
    
    const businessId = req.businessId!;
    const instanceId = req.instanceId;
    
    const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = messages 
      ? messages.map((m: any) => ({ role: m.role || 'user', content: m.content || m }))
      : [{ role: 'user' as const, content: message }];
    
    const USE_V3_AGENT = process.env.USE_V3_AGENT === 'true';
    const shouldUseV3 = useV3 === true || USE_V3_AGENT;
    
    if (shouldUseV3) {
      try {
        const { processWithOrchestrator } = await import('../services/agent/index.js');
        
        const input = {
          businessId,
          instanceId: instanceId || null,
          contactPhone: contactPhone.replace(/\D/g, ''),
          contactName: contactName || 'API User',
          messages: chatMessages,
          config: {
            model: req.body.model || 'gpt-4o-mini',
            temperature: req.body.temperature || 0.7,
            maxTokens: req.body.maxTokens || 2000,
            maxToolCalls: req.body.maxToolCalls || 5
          }
        };
        
        const result = await processWithOrchestrator(input);
        
        return res.json({
          success: true,
          response: result.response,
          toolsExecuted: result.toolsExecuted,
          tokensUsed: result.tokensUsed,
          metadata: {
            ...result.metadata,
            version: 'v3',
            instanceId
          }
        });
      } catch (v3Error: any) {
        console.error('[API Chat] V3 error, falling back to V1:', v3Error.message);
      }
    }
    
    {
      const { processAIResponseDirect } = await import('../services/queues/aiResponseProcessor.js');
      
      const msgStrings = chatMessages.map(m => m.content);
      const result = await processAIResponseDirect({
        businessId,
        contactPhone: contactPhone.replace(/\D/g, ''),
        contactName: contactName || 'API User',
        messages: msgStrings,
        phone: contactPhone,
        instanceId
      });
      
      return res.json({
        success: true,
        response: result.response,
        tokensUsed: result.tokensUsed,
        metadata: {
          version: 'v1',
          instanceId
        }
      });
    }
  } catch (error: any) {
    console.error('[API Chat] Error:', error);
    res.status(500).json({ 
      error: 'Error al procesar mensaje',
      details: error.message
    });
  }
});

// ============ RAG SECTIONS ENDPOINTS ============

router.get('/rag-sections', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const instanceId = req.instanceId;
    const { type, isCore } = req.query;
    
    const where: any = {
      businessId: req.businessId,
      OR: [
        { instanceId: instanceId },
        { instanceId: null }
      ],
      enabled: true
    };
    
    if (type) where.type = type;
    if (isCore === 'true') where.isCore = true;
    if (isCore === 'false') where.isCore = false;
    
    const sections = await prisma.promptSection.findMany({
      where,
      select: {
        id: true,
        title: true,
        type: true,
        content: true,
        priority: true,
        isCore: true,
        keywords: true,
        instanceId: true
      },
      orderBy: [
        { isCore: 'desc' },
        { priority: 'desc' },
        { type: 'asc' }
      ]
    });
    
    res.json({ sections });
  } catch (error: any) {
    console.error('API rag-sections error:', error);
    res.status(500).json({ error: error.message });
  }
});

const ragSectionSearchHandler = async (req: ApiKeyRequest, res: Response) => {
  console.log('[API] rag-sections/search called:', { method: req.method, businessId: req.businessId });
  try {
    const instanceId = req.instanceId;
    const params = req.method === 'GET' ? req.query : req.body;
    const { query, limit = 5, includeCore = true } = params;
    
    console.log('[API] rag-sections/search params:', { query, limit, includeCore });
    
    if (!query) {
      return res.status(400).json({ error: 'Campo "query" es requerido' });
    }
    
    const where: any = {
      businessId: req.businessId,
      OR: [
        { instanceId: instanceId },
        { instanceId: null }
      ],
      enabled: true
    };
    
    const allSections = await prisma.promptSection.findMany({
      where,
      select: {
        id: true,
        title: true,
        type: true,
        content: true,
        priority: true,
        isCore: true,
        keywords: true,
        instanceId: true
      },
      orderBy: [
        { isCore: 'desc' },
        { priority: 'desc' }
      ]
    });
    
    const coreSections = includeCore ? allSections.filter(s => s.isCore) : [];
    const searchableSections = allSections.filter(s => !s.isCore);
    
    const queryLower = query.toLowerCase();
    const scored = searchableSections.map(section => {
      let score = 0;
      
      if (section.title.toLowerCase().includes(queryLower)) score += 10;
      if (section.content.toLowerCase().includes(queryLower)) score += 5;
      
      const keywords = section.keywords || [];
      for (const kw of keywords) {
        if (queryLower.includes(kw.toLowerCase()) || kw.toLowerCase().includes(queryLower)) {
          score += 3;
        }
      }
      
      score += section.priority;
      
      return { ...section, score };
    });
    
    scored.sort((a, b) => b.score - a.score);
    const topMatches = scored.slice(0, Number(limit)).filter(s => s.score > 0);
    
    res.json({
      coreSections,
      matchedSections: topMatches,
      totalCoreTokens: coreSections.reduce((acc, s) => acc + Math.ceil(s.content.length / 4), 0),
      totalMatchedTokens: topMatches.reduce((acc, s) => acc + Math.ceil(s.content.length / 4), 0)
    });
  } catch (error: any) {
    console.error('API rag-sections/search error:', error);
    res.status(500).json({ error: error.message });
  }
};

router.get('/rag-sections/search', validateApiKey, ragSectionSearchHandler);
router.post('/rag-sections/search', validateApiKey, ragSectionSearchHandler);

router.get('/rag-sections/:id', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const section = await prisma.promptSection.findFirst({
      where: {
        id: req.params.id,
        businessId: req.businessId
      }
    });
    
    if (!section) {
      return res.status(404).json({ error: 'Seccion no encontrada' });
    }
    
    res.json({ section });
  } catch (error: any) {
    console.error('API rag-sections/:id error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ FUNNEL STAGES ENDPOINTS ============

router.get('/funnel-stages', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const instanceId = req.instanceId;
    
    const stages = await prisma.funnelStage.findMany({
      where: {
        businessId: req.businessId,
        OR: [
          { instanceId: instanceId },
          { instanceId: null }
        ],
        isActive: true
      },
      select: {
        id: true,
        name: true,
        order: true,
        description: true,
        promptContext: true,
        requiredFieldKeys: true,
        blockedTopics: true,
        toolsAllowed: true,
        autoTransition: true,
        instanceId: true
      },
      orderBy: { order: 'asc' }
    });
    
    res.json({ stages });
  } catch (error: any) {
    console.error('API funnel-stages error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/funnel-stages/:id', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const stage = await prisma.funnelStage.findFirst({
      where: {
        id: req.params.id,
        businessId: req.businessId
      }
    });
    
    if (!stage) {
      return res.status(404).json({ error: 'Etapa no encontrada' });
    }
    
    res.json({ stage });
  } catch (error: any) {
    console.error('API funnel-stages/:id error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/contact-funnel-state/:phone', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  console.log('[API] contact-funnel-state called:', { phone: req.params.phone, businessId: req.businessId });
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    const instanceId = req.instanceId;
    const businessId = req.businessId!;
    
    const [contact, funnelState, extractedData, allStages] = await Promise.all([
      prisma.contact.findFirst({
        where: { businessId, phone }
      }),
      prisma.contactFunnelState.findFirst({
        where: { businessId, contactPhone: phone },
        include: { stage: true }
      }),
      prisma.contactExtractedData.findMany({
        where: { businessId, contactPhone: phone }
      }),
      prisma.funnelStage.findMany({
        where: {
          businessId,
          OR: [
            { instanceId: instanceId },
            { instanceId: null }
          ],
          isActive: true
        },
        orderBy: { order: 'asc' }
      })
    ]);
    
    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    
    const currentStage = funnelState?.stage;
    
    const extractedFields: Record<string, any> = {};
    for (const field of extractedData) {
      extractedFields[field.fieldKey] = {
        value: field.fieldValue,
        confidence: field.confidence,
        extractedAt: field.extractedAt
      };
    }
    
    const missingFields = currentStage?.requiredFieldKeys?.filter(
      (key: string) => !extractedFields[key]?.value
    ) || [];
    
    res.json({
      contactId: contact.id,
      contactName: contact.name,
      phone: contact.phone,
      currentStage: currentStage ? {
        id: currentStage.id,
        name: currentStage.name,
        order: currentStage.order,
        description: currentStage.description,
        promptContext: currentStage.promptContext,
        requiredFieldKeys: currentStage.requiredFieldKeys,
        blockedTopics: currentStage.blockedTopics,
        toolsAllowed: currentStage.toolsAllowed
      } : null,
      extractedFields,
      missingFields,
      canAdvance: missingFields.length === 0,
      allStages: allStages.map(s => ({
        id: s.id,
        name: s.name,
        order: s.order
      })),
      stateMetadata: funnelState?.metadata || {}
    });
  } catch (error: any) {
    console.error('API contact-funnel-state error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// AGENT V3 ENDPOINT - Invoke AI Agent with full context building
// ============================================================================

router.post('/agent/process', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { 
      contactPhone, 
      contactName = 'Cliente', 
      messages, 
      model = 'gpt-4o-mini',
      temperature = 0.7,
      maxTokens = 2000,
      maxToolCalls = 5,
      triggerContext
    } = req.body;

    if (!contactPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "contactPhone" es requerido' 
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "messages" es requerido (array con al menos un mensaje)' 
      });
    }

    // Validate and filter messages - only allow user/assistant roles
    const validRoles = ['user', 'assistant'];
    const validatedMessages = messages
      .filter((m: any) => validRoles.includes(m.role) && typeof m.content === 'string' && m.content.trim())
      .map((m: any) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.trim()
      }));

    if (validatedMessages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Ningún mensaje válido encontrado. Formato requerido: [{role: "user"|"assistant", content: "texto"}]'
      });
    }

    const phone = contactPhone.replace(/\D/g, '');
    
    let instanceId = req.instanceId || null;
    
    if (!instanceId && req.business?.instances?.length > 0) {
      instanceId = req.business.instances[0].id;
    }
    
    if (!instanceId) {
      const activeInstance = await prisma.whatsAppInstance.findFirst({
        where: { 
          businessId: req.businessId!,
          isActive: true,
          status: { in: ['open', 'CONNECTED', 'connected'] }
        }
      });
      if (activeInstance) {
        instanceId = activeInstance.id;
      }
    }
    
    console.log('[API-V3] Agent process called:', { businessId: req.businessId, instanceId });
    console.log('[API-V3] Processing:', { 
      phone, 
      contactName, 
      messageCount: validatedMessages.length,
      model,
      lastMessage: validatedMessages[validatedMessages.length - 1]?.content?.substring(0, 100)
    });

    const input: OrchestratorInput = {
      businessId: req.businessId!,
      instanceId,
      contactPhone: phone,
      contactName,
      messages: validatedMessages,
      triggerContext,
      config: {
        model,
        temperature,
        maxTokens,
        maxToolCalls
      }
    };

    console.log('[API-V3] Calling orchestrator...');
    const result = await processWithOrchestrator(input);
    const processingTime = Date.now() - startTime;

    console.log('[API-V3] Orchestrator completed:', {
      responseLength: result.response?.length,
      toolsExecuted: result.toolsExecuted?.length || 0,
      tokensUsed: result.tokensUsed?.total,
      processingTimeMs: processingTime
    });

    return res.json({
      success: true,
      response: result.response,
      toolsExecuted: result.toolsExecuted || [],
      tokensUsed: result.tokensUsed || { prompt: 0, completion: 0, total: 0 },
      metadata: {
        ...result.metadata,
        version: 'v3',
        processingTimeMs: processingTime,
        businessId: req.businessId,
        instanceId: req.instanceId
      }
    });
  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    console.error('[API-V3] Error processing agent request:', {
      error: error.message,
      stack: error.stack?.substring(0, 500),
      processingTimeMs: processingTime
    });
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno del agente',
      metadata: {
        version: 'v3',
        processingTimeMs: processingTime
      }
    });
  }
});

router.get('/agent/status', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { toolRegistry } = await import('../services/agent/index.js');
    const stats = toolRegistry.getStats();
    
    return res.json({
      success: true,
      version: 'v3',
      enabled: process.env.USE_V3_AGENT === 'true',
      businessId: req.businessId,
      instanceId: req.instanceId,
      toolRegistry: stats
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/agent/tools', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { toolRegistry } = await import('../services/agent/index.js');
    const allTools = toolRegistry.getAllToolNames();
    
    return res.json({
      success: true,
      tools: allTools,
      count: allTools.length,
      businessId: req.businessId
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// CONTEXT PREVIEW - Ver el prompt construido sin ejecutar LLM
// ============================================================================

router.post('/agent/context-preview', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { contactPhone, contactName = 'Cliente', messages = [] } = req.body;

    if (!contactPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "contactPhone" es requerido' 
      });
    }

    const phone = contactPhone.replace(/\D/g, '');
    const businessId = req.businessId!;
    
    let instanceId = req.instanceId || null;
    
    if (!instanceId && req.business?.instances?.length > 0) {
      instanceId = req.business.instances[0].id;
    }
    
    if (!instanceId) {
      const activeInstance = await prisma.whatsAppInstance.findFirst({
        where: { 
          businessId,
          isActive: true,
          status: { in: ['open', 'CONNECTED', 'connected'] }
        }
      });
      if (activeInstance) {
        instanceId = activeInstance.id;
      }
    }
    
    console.log('[API-V3] Context preview called:', { businessId, instanceId });

    // Load custom tools for this business first
    await loadCustomToolsForBusiness(businessId);

    // Load contexts
    const businessContext = await loadBusinessContext(businessId, instanceId);
    const convContextPartial = await loadConversationContext(businessId, phone, instanceId);
    
    const conversationContext = {
      ...convContextPartial,
      messages: messages.length > 0 ? messages : [{ role: 'user', content: '(preview sin mensajes)' }]
    };

    // Build context
    const contextBuilder = new ContextBuilder(
      businessContext,
      conversationContext,
      {}
    );
    
    const builtContext = await contextBuilder.build();

    // Get available tools
    const availabilityContext: ToolAvailabilityContext = {
      businessId,
      instanceId,
      hasActiveOrder: !!conversationContext.existingOrder,
      hasProducts: businessContext.products.length > 0,
      hasZones: businessContext.deliveryZones.length > 0,
      hasAppointments: businessContext.hasAppointments,
      businessObjective: businessContext.businessObjective
    };

    const definitionContext: ToolDefinitionContext = {
      hasActiveOrder: !!conversationContext.existingOrder,
      hasProducts: businessContext.products.length > 0,
      hasZones: businessContext.deliveryZones.length > 0,
      hasAppointments: businessContext.hasAppointments,
      zoneDescriptions: businessContext.deliveryZones.map((z: any) => z.name).join(', '),
      businessObjective: businessContext.businessObjective
    };

    const availableTools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);

    return res.json({
      success: true,
      systemPrompt: builtContext.systemPrompt,
      conversationMessages: builtContext.conversationMessages,
      availableTools: availableTools.map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description,
        parameters: t.function?.parameters
      })),
      metadata: {
        ...builtContext.metadata,
        businessName: businessContext.business?.name,
        businessObjective: businessContext.businessObjective,
        contactName: conversationContext.contact?.name || contactName,
        hasExistingOrder: !!conversationContext.existingOrder,
        orderId: conversationContext.existingOrder?.id,
        extractedDataCount: Object.keys(conversationContext.extractedData || {}).length,
        funnelStage: conversationContext.funnelStatus?.stage?.name
      }
    });
  } catch (error: any) {
    console.error('[API-V3] Error in context preview:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// EXECUTE TOOL - Ejecutar una herramienta directamente desde n8n
// ============================================================================

router.post('/agent/execute-tool', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  console.log('[API-V3] Execute tool called:', { businessId: req.businessId });
  
  try {
    const { toolName, args = {}, contactPhone, contactName = 'Cliente', bypassAvailabilityCheck = false } = req.body;

    if (!toolName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "toolName" es requerido' 
      });
    }

    if (!contactPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "contactPhone" es requerido' 
      });
    }

    const phone = contactPhone.replace(/\D/g, '');
    const businessId = req.businessId!;
    const instanceId = req.instanceId || null;

    // Load custom tools for this business
    await loadCustomToolsForBusiness(businessId);

    // Load context for tool execution
    const businessContext = await loadBusinessContext(businessId, instanceId);
    const convContext = await loadConversationContext(businessId, phone, instanceId);

    // Check tool availability (unless bypassed)
    if (!bypassAvailabilityCheck) {
      const availabilityContext: ToolAvailabilityContext = {
        businessId,
        instanceId,
        hasActiveOrder: !!convContext.existingOrder,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        businessObjective: businessContext.businessObjective
      };
      
      const availableTools = toolRegistry.getAvailableTools(availabilityContext);
      const toolAvailable = availableTools.some(t => t.name === toolName);
      
      if (!toolAvailable) {
        return res.status(400).json({
          success: false,
          error: `Herramienta "${toolName}" no está disponible para este contexto`,
          hint: 'Usa bypassAvailabilityCheck: true para forzar ejecución',
          availableTools: availableTools.map(t => t.name)
        });
      }
    }

    // Build tool context
    const toolContext: ToolContext = {
      businessId,
      instanceId,
      contactPhone: phone,
      contactName: convContext.contact?.name || contactName,
      currencySymbol: businessContext.currencySymbol,
      currencyCode: businessContext.currencyCode,
      business: businessContext.business,
      contact: convContext.contact,
      existingOrder: convContext.existingOrder,
      extractedData: convContext.extractedData || {},
      conversationMessages: []
    };

    console.log('[API-V3] Executing tool:', { toolName, args, phone });

    // Execute the tool
    const result = await toolRegistry.executeTool(toolName, args, toolContext);

    console.log('[API-V3] Tool execution result:', { toolName, success: result.success });

    return res.json({
      success: true,
      toolName,
      result: {
        success: result.success,
        content: result.content,
        data: result.data
      },
      context: {
        businessId,
        instanceId,
        contactPhone: phone,
        hasExistingOrder: !!convContext.existingOrder,
        orderId: convContext.existingOrder?.id
      }
    });
  } catch (error: any) {
    console.error('[API-V3] Error executing tool:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// LIST TOOLS WITH DETAILS - Lista las tools con sus parámetros
// ============================================================================

router.get('/agent/tools-detailed', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  try {
    const { contactPhone } = req.query;
    const businessId = req.businessId!;
    const instanceId = req.instanceId || null;

    // Load custom tools for this business first
    await loadCustomToolsForBusiness(businessId);

    // Load business context to determine available tools
    const businessContext = await loadBusinessContext(businessId, instanceId);
    
    let hasActiveOrder = false;
    if (contactPhone && typeof contactPhone === 'string') {
      const phone = contactPhone.replace(/\D/g, '');
      const convContext = await loadConversationContext(businessId, phone, instanceId);
      hasActiveOrder = !!convContext.existingOrder;
    }

    const availabilityContext: ToolAvailabilityContext = {
      businessId,
      instanceId,
      hasActiveOrder,
      hasProducts: businessContext.products.length > 0,
      hasZones: businessContext.deliveryZones.length > 0,
      hasAppointments: businessContext.hasAppointments,
      businessObjective: businessContext.businessObjective
    };

    const definitionContext: ToolDefinitionContext = {
      hasActiveOrder,
      hasProducts: businessContext.products.length > 0,
      hasZones: businessContext.deliveryZones.length > 0,
      hasAppointments: businessContext.hasAppointments,
      zoneDescriptions: businessContext.deliveryZones.map((z: any) => z.name).join(', '),
      businessObjective: businessContext.businessObjective
    };

    const tools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);

    return res.json({
      success: true,
      tools: tools.map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description,
        parameters: t.function?.parameters
      })),
      count: tools.length,
      context: {
        businessId,
        hasProducts: businessContext.products.length > 0,
        hasZones: businessContext.deliveryZones.length > 0,
        hasAppointments: businessContext.hasAppointments,
        businessObjective: businessContext.businessObjective
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// TOOL ORCHESTRATOR - LLM especializado decide y ejecuta tools
// ============================================================================

router.post('/agent/tool-orchestrator', validateApiKey, async (req: ApiKeyRequest, res: Response) => {
  console.log('[TOOL-ORCH] Tool orchestrator called:', { businessId: req.businessId });
  const startTime = Date.now();
  
  try {
    const { 
      contactPhone, 
      contactName = 'Cliente', 
      query, 
      messages = [],
      model = 'gpt-4o',
      maxIterations = 3
    } = req.body;

    if (!contactPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "contactPhone" es requerido' 
      });
    }

    if (!query) {
      return res.status(400).json({ 
        success: false, 
        error: 'Campo "query" es requerido' 
      });
    }

    const phone = contactPhone.replace(/\D/g, '');
    const businessId = req.businessId!;
    const instanceId = req.instanceId || null;

    // Load custom tools for this business
    await loadCustomToolsForBusiness(businessId);

    // Load contexts
    const businessContext = await loadBusinessContext(businessId, instanceId);
    const convContext = await loadConversationContext(businessId, phone, instanceId);

    // Build availability context for tools
    const availabilityContext: ToolAvailabilityContext = {
      businessId,
      instanceId,
      hasActiveOrder: !!convContext.existingOrder,
      hasProducts: businessContext.products.length > 0,
      hasZones: businessContext.deliveryZones.length > 0,
      hasAppointments: businessContext.hasAppointments,
      businessObjective: businessContext.businessObjective
    };

    const definitionContext: ToolDefinitionContext = {
      hasActiveOrder: !!convContext.existingOrder,
      hasProducts: businessContext.products.length > 0,
      hasZones: businessContext.deliveryZones.length > 0,
      hasAppointments: businessContext.hasAppointments,
      zoneDescriptions: businessContext.deliveryZones.map((z: any) => z.name).join(', '),
      businessObjective: businessContext.businessObjective
    };

    // Get available tools
    const openaiTools = toolRegistry.getOpenAITools(availabilityContext, definitionContext);
    console.log(`[TOOL-ORCH] Available tools: ${openaiTools.length} - ${openaiTools.map((t: any) => t.function?.name).join(', ')}`);

    if (openaiTools.length === 0) {
      return res.json({
        success: true,
        needsMoreData: false,
        toolsExecuted: [],
        suggestedResponse: 'No hay herramientas disponibles para este contexto.',
        metadata: { model, iterations: 0, processingTimeMs: Date.now() - startTime }
      });
    }

    // Build tool context for execution
    const toolContext: ToolContext = {
      businessId,
      instanceId,
      contactPhone: phone,
      contactName: convContext.contact?.name || contactName,
      currencySymbol: businessContext.currencySymbol,
      currencyCode: businessContext.currencyCode,
      business: businessContext.business,
      contact: convContext.contact,
      existingOrder: convContext.existingOrder,
      extractedData: convContext.extractedData,
      conversationMessages: messages.filter((m: any) => m.role === 'user' || m.role === 'assistant')
    };

    // Build context summary for the orchestrator
    const contextSummary = buildToolOrchestratorContext(businessContext, convContext, query);

    // System prompt for tool orchestrator - focused on deciding and executing tools
    const systemPrompt = `Eres un orquestador de herramientas especializado. Tu único trabajo es:
1. Analizar la query del usuario y el contexto disponible
2. Decidir qué herramienta(s) usar para satisfacer la solicitud
3. Ejecutar las herramientas con los parámetros correctos
4. Si falta información necesaria, indicar qué datos se necesitan

CONTEXTO DEL NEGOCIO Y CONVERSACIÓN:
${contextSummary}

REGLAS:
- Solo usa herramientas cuando sea necesario para la query
- Si no tienes todos los datos requeridos para una herramienta, NO la ejecutes
- En su lugar, indica qué información falta
- Si la query no requiere ninguna herramienta, responde indicándolo
- Sé preciso con los parámetros de las herramientas`;

    // Initialize LLM
    const { LLMFactory } = await import('../services/agent/core/llmAdapter.js');
    const llmProvider = LLMFactory.getProvider('openai');
    
    const llmMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...messages.filter((m: any) => m.role === 'user' || m.role === 'assistant'),
      { role: 'user', content: query }
    ];

    const llmConfig = {
      model,
      temperature: 0.3,
      maxTokens: 2000
    };

    const toolsExecuted: Array<{ name: string; success: boolean; result: any }> = [];
    let iterations = 0;
    let response = await llmProvider.chat(llmMessages, llmConfig, openaiTools);
    iterations++;

    // Tool execution loop
    while (response.finishReason === 'tool_calls' && response.toolCalls && iterations < maxIterations) {
      console.log(`[TOOL-ORCH] Iteration ${iterations}: executing ${response.toolCalls.length} tools`);

      const toolResults: any[] = [];

      for (const toolCall of response.toolCalls) {
        console.log(`[TOOL-ORCH] Executing: ${toolCall.name}`);
        
        const result = await toolRegistry.executeTool(
          toolCall.name,
          toolCall.arguments,
          toolContext
        );

        toolsExecuted.push({
          name: toolCall.name,
          success: result.success,
          result: result.data || result.content
        });

        toolResults.push({
          role: 'tool',
          content: result.content,
          tool_call_id: toolCall.id
        });
      }

      // Add assistant message with tool calls
      llmMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }))
      });
      llmMessages.push(...toolResults);

      // Continue loop
      response = await llmProvider.chat(llmMessages, llmConfig, openaiTools);
      iterations++;
    }

    const processingTimeMs = Date.now() - startTime;
    console.log(`[TOOL-ORCH] Completed: ${iterations} iterations, ${toolsExecuted.length} tools executed, ${processingTimeMs}ms`);

    // Analyze if we need more data
    const finalContent = response.content || '';
    const needsMoreData = detectMissingData(finalContent);

    return res.json({
      success: true,
      needsMoreData: needsMoreData.missing,
      missingFields: needsMoreData.fields,
      toolsExecuted,
      suggestedResponse: finalContent,
      metadata: {
        model,
        iterations,
        processingTimeMs,
        tokensUsed: response.usage?.totalTokens || 0
      }
    });

  } catch (error: any) {
    console.error('[TOOL-ORCH] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper: Build context summary for tool orchestrator
function buildToolOrchestratorContext(businessContext: any, convContext: any, query: string): string {
  const parts: string[] = [];

  // Business info
  if (businessContext.business) {
    parts.push(`Negocio: ${businessContext.business.name}`);
    parts.push(`Objetivo: ${businessContext.businessObjective || 'SALES'}`);
  }

  // Products summary
  if (businessContext.products.length > 0) {
    const productList = businessContext.products.slice(0, 10).map((p: any) => 
      `- ${p.title}: ${businessContext.currencySymbol}${p.price}${p.variations ? ` (${p.variations})` : ''}`
    ).join('\n');
    parts.push(`\nPRODUCTOS DISPONIBLES:\n${productList}`);
    if (businessContext.products.length > 10) {
      parts.push(`... y ${businessContext.products.length - 10} productos más`);
    }
  }

  // Delivery zones
  if (businessContext.deliveryZones.length > 0) {
    const zones = businessContext.deliveryZones.map((z: any) => 
      `- ${z.name}: ${businessContext.currencySymbol}${z.deliveryCost}`
    ).join('\n');
    parts.push(`\nZONAS DE ENTREGA:\n${zones}`);
  }

  // Existing order
  if (convContext.existingOrder) {
    const order = convContext.existingOrder;
    parts.push(`\nORDEN EXISTENTE:`);
    parts.push(`ID: ${order.id}, Estado: ${order.status}`);
    parts.push(`Total: ${businessContext.currencySymbol}${order.totalAmount}`);
    if (order.items) {
      parts.push(`Items: ${order.items.map((i: any) => i.productName).join(', ')}`);
    }
  }

  // Extracted data
  if (convContext.extractedData && Object.keys(convContext.extractedData).length > 0) {
    parts.push(`\nDATOS DEL CLIENTE:`);
    for (const [key, value] of Object.entries(convContext.extractedData)) {
      if (value) parts.push(`- ${key}: ${value}`);
    }
  }

  // Contact info
  if (convContext.contact) {
    parts.push(`\nCONTACTO: ${convContext.contact.name || 'Sin nombre'}, Tel: ${convContext.contact.phone}`);
  }

  return parts.join('\n');
}

// Helper: Detect if response indicates missing data
function detectMissingData(content: string): { missing: boolean; fields: string[] } {
  const missingIndicators = [
    /necesito\s+(saber|conocer|que me (digas|proporciones))/i,
    /falta\s+(el|la|información)/i,
    /cuál\s+es\s+(tu|su)/i,
    /podrías\s+(indicarme|decirme)/i,
    /requiero\s+(el|la|los|las)/i
  ];

  const fieldPatterns: { [key: string]: RegExp } = {
    'direccion': /direcci[oó]n|domicilio|ubicaci[oó]n/i,
    'telefono': /tel[eé]fono|n[uú]mero|celular/i,
    'nombre': /nombre|c[oó]mo te llamas/i,
    'metodoPago': /m[eé]todo de pago|forma de pago|c[oó]mo (pagar[aá]s|deseas pagar)/i,
    'zona': /zona|sector|[aá]rea de entrega/i,
    'producto': /producto|qu[eé] deseas|qu[eé] quieres/i,
    'cantidad': /cantidad|cu[aá]ntos|cu[aá]ntas/i
  };

  const missing = missingIndicators.some(pattern => pattern.test(content));
  const fields: string[] = [];

  if (missing) {
    for (const [field, pattern] of Object.entries(fieldPatterns)) {
      if (pattern.test(content)) {
        fields.push(field);
      }
    }
  }

  return { missing, fields };
}

export default router;
