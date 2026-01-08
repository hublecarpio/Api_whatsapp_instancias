import { Router, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireEmailVerified } from '../middleware/billing.js';
import { MetaCloudService } from '../services/metaCloud.js';
import { recordInstanceEvent, getInstanceHistory, cleanupOrphanedInstance, validateAndCleanInstances } from '../services/instanceHistory.js';
import { scheduleFollowUp } from '../services/followUpService.js';

const router = Router();
const WA_API_URL = process.env.WA_API_URL || 'http://localhost:8080';
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:3001';

function generateInstanceApiKey(): { apiKey: string; apiKeyHash: string; apiKeyPrefix: string } {
  const apiKey = `efk_${crypto.randomBytes(32).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const apiKeyPrefix = apiKey.substring(0, 12);
  return { apiKey, apiKeyHash, apiKeyPrefix };
}

function generateWebhookSecret(): string {
  return `whs_${crypto.randomBytes(16).toString('hex')}`;
}

// Only 3 user tiers: BASIC, PRO, ENTERPRISE
const INSTANCE_LIMITS: Record<string, number> = {
  BASIC: 2,
  PRO: 10,
  ENTERPRISE: 10
};

async function getInstanceLimit(userId: string): Promise<{ limit: number; tier: string; currentCount: number; businessId: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { 
      subscriptionTier: true, 
      isPro: true,
      businesses: { 
        select: { 
          id: true,
          _count: { select: { instances: true } }
        },
        take: 1
      }
    }
  });
  
  if (!user) {
    return { limit: 1, tier: 'BASIC', currentCount: 0, businessId: null };
  }
  
  const activeSubscription = await prisma.subscription.findFirst({
    where: { 
      userId, 
      status: 'ACTIVE',
      OR: [
        { endsAt: null },
        { endsAt: { gt: new Date() } }
      ]
    },
    orderBy: { createdAt: 'desc' },
    select: { tier: true }
  });
  
  const tier = activeSubscription?.tier || user.subscriptionTier || 'BASIC';
  const limit = INSTANCE_LIMITS[tier] || 1;
  const business = user.businesses[0];
  const currentCount = business?._count?.instances || 0;
  
  return { limit, tier, currentCount, businessId: business?.id || null };
}

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

async function getUserWithRole(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, parentUserId: true }
  });
}

async function checkBusinessAccess(userId: string, businessId: string, role?: string, parentUserId?: string | null) {
  if (role === 'ASESOR' && parentUserId) {
    return prisma.business.findFirst({ where: { id: businessId, userId: parentUserId } });
  }
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

async function checkAdvisorContactAccess(userId: string, businessId: string, phone: string): Promise<boolean> {
  const assignment = await prisma.contactAssignment.findFirst({
    where: { userId, businessId, contactPhone: phone }
  });
  return !!assignment;
}

function normalizeArgentinePhone(phone: string): string {
  const clean = phone.replace(/\D/g, '');
  
  if (clean.startsWith('549') && clean.length >= 12) {
    return clean;
  }
  
  if (clean.startsWith('54') && !clean.startsWith('549') && clean.length >= 11) {
    const areaAndNumber = clean.substring(2);
    if (areaAndNumber.startsWith('11') || 
        areaAndNumber.startsWith('2') || 
        areaAndNumber.startsWith('3')) {
      return '549' + areaAndNumber;
    }
  }
  
  return clean;
}

router.get('/instances', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const userInfo = await getUserWithRole(req.userId!);
    const business = await checkBusinessAccess(req.userId!, businessId as string, userInfo?.role, userInfo?.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instances = await prisma.whatsAppInstance.findMany({
      where: { businessId: businessId as string },
      include: { metaCredential: { select: { id: true, phoneNumberId: true } } },
      orderBy: { createdAt: 'asc' }
    });
    
    const { limit, tier, currentCount } = await getInstanceLimit(req.userId!);
    
    res.json({
      instances,
      limits: {
        current: currentCount,
        max: limit,
        tier,
        canAddMore: currentCount < limit
      }
    });
  } catch (error: any) {
    console.error('List instances error:', error.message);
    res.status(500).json({ error: 'Failed to list instances' });
  }
});

router.get('/instances/:instanceId/api-config', async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const userInfo = await getUserWithRole(req.userId!);
    const business = await checkBusinessAccess(req.userId!, businessId as string, userInfo?.role, userInfo?.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    res.json({
      instanceId: instance.id,
      instanceName: instance.name,
      apiKeyPrefix: instance.apiKeyPrefix,
      webhookUrl: instance.webhookUrl,
      webhookSecret: instance.webhookSecret,
      webhookEvents: instance.webhookEvents || [],
      hasApiKey: !!instance.apiKeyHash
    });
  } catch (error: any) {
    console.error('Get instance API config error:', error.message);
    res.status(500).json({ error: 'Failed to get API configuration' });
  }
});

router.post('/instances/:instanceId/regenerate-api-key', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    const { apiKey, apiKeyHash, apiKeyPrefix } = generateInstanceApiKey();
    
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { apiKeyHash, apiKeyPrefix }
    });
    
    res.json({
      apiKey,
      apiKeyPrefix,
      message: 'API key regenerated successfully. Save this key - it will not be shown again.'
    });
  } catch (error: any) {
    console.error('Regenerate API key error:', error.message);
    res.status(500).json({ error: 'Failed to regenerate API key' });
  }
});

router.put('/instances/:instanceId', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    const { name, businessObjective, botEnabled } = req.body;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (businessObjective !== undefined) updateData.businessObjective = businessObjective;
    if (botEnabled !== undefined) updateData.botEnabled = botEnabled;
    
    const updated = await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: updateData
    });
    
    res.json(updated);
  } catch (error: any) {
    console.error('Update instance error:', error.message);
    res.status(500).json({ error: 'Failed to update instance' });
  }
});

router.put('/instances/:instanceId/webhook', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    const { webhookUrl, webhookEvents } = req.body;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    const webhookSecret = instance.webhookSecret || generateWebhookSecret();
    
    const validEvents = ['user_message', 'agent_message', 'stage_change', 'state_change', 'tool_call'];
    const filteredEvents = Array.isArray(webhookEvents) 
      ? webhookEvents.filter((e: string) => validEvents.includes(e))
      : undefined;
    
    const updateData: any = { 
      webhookUrl: webhookUrl || null, 
      webhookSecret 
    };
    
    if (filteredEvents !== undefined) {
      updateData.webhookEvents = filteredEvents;
    }
    
    const updated = await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: updateData
    });
    
    res.json({
      webhookUrl: updated.webhookUrl,
      webhookSecret: updated.webhookSecret,
      webhookEvents: updated.webhookEvents,
      message: 'Webhook configuration updated'
    });
  } catch (error: any) {
    console.error('Update webhook error:', error.message);
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

router.post('/instances/add', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, name, provider, phoneNumber, copyFromInstanceId, metaCredentials } = req.body;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    if (provider === 'BAILEYS' && !phoneNumber) {
      return res.status(400).json({ error: 'El numero de telefono es obligatorio para instancias Baileys' });
    }
    
    if (provider === 'META_CLOUD' && metaCredentials) {
      if (!metaCredentials.appId || !metaCredentials.appSecret || !metaCredentials.accessToken || !metaCredentials.phoneNumberId || !metaCredentials.wabaId) {
        return res.status(400).json({ error: 'App ID, App Secret, Access Token, Phone Number ID y WABA ID son obligatorios para Meta Cloud' });
      }
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const { limit, tier, currentCount } = await getInstanceLimit(req.userId!);
    
    if (currentCount >= limit) {
      return res.status(403).json({ 
        error: `Has alcanzado el limite de ${limit} instancia(s) para tu plan ${tier}. Actualiza a PRO o Enterprise para mas numeros.`,
        code: 'INSTANCE_LIMIT_REACHED',
        limit,
        current: currentCount,
        tier
      });
    }
    
    const existingInstances = await prisma.whatsAppInstance.findMany({
      where: { businessId }
    });
    const instanceNumber = existingInstances.length + 1;
    const instanceName = name || `WhatsApp ${instanceNumber}`;
    const instanceBackendId = `biz_${businessId.substring(0, 8)}_${instanceNumber}`;
    
    const { apiKey, apiKeyHash, apiKeyPrefix } = generateInstanceApiKey();
    const instanceWebhookSecret = generateWebhookSecret();
    
    if (provider === 'META_CLOUD') {
      const hasCredentials = metaCredentials && metaCredentials.appId && metaCredentials.appSecret && metaCredentials.accessToken && metaCredentials.phoneNumberId && metaCredentials.wabaId;
      
      const instance = await prisma.whatsAppInstance.create({
        data: {
          businessId,
          instanceNumber,
          name: instanceName,
          provider: 'META_CLOUD',
          status: hasCredentials ? 'connected' : 'pending_credentials',
          phoneNumber: phoneNumber || null,
          apiKeyHash,
          apiKeyPrefix,
          webhookSecret: instanceWebhookSecret
        }
      });
      
      if (hasCredentials) {
        await prisma.metaCredential.create({
          data: {
            instanceId: instance.id,
            accessToken: metaCredentials.accessToken,
            phoneNumberId: metaCredentials.phoneNumberId,
            businessId: metaCredentials.wabaId,
            appId: metaCredentials.appId,
            appSecret: metaCredentials.appSecret
          }
        });
        
        await recordInstanceEvent({
          instanceId: instance.id,
          businessId,
          eventType: 'CREATED',
          newProvider: 'META_CLOUD',
          newStatus: 'connected',
          details: `New Meta Cloud instance "${instanceName}" created with credentials`
        });
        
        return res.status(201).json({ instance: { ...instance, status: 'connected' }, apiKey });
      }
      
      await recordInstanceEvent({
        instanceId: instance.id,
        businessId,
        eventType: 'CREATED',
        newProvider: 'META_CLOUD',
        newStatus: 'pending_credentials',
        details: `New Meta Cloud instance "${instanceName}" created`
      });
      
      return res.status(201).json({ instance, apiKey, requiresCredentials: true });
    }
    
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    const internalWebhookUrl = `${coreApiUrl}/webhook/${businessId}`;
    
    const waResponse = await axios.post(`${WA_API_URL}/instances`, {
      instanceId: instanceBackendId,
      webhook: internalWebhookUrl
    });
    
    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        instanceNumber,
        name: instanceName,
        instanceBackendId,
        status: 'pending_qr',
        phoneNumber: phoneNumber || null,
        apiKeyHash,
        apiKeyPrefix,
        webhookSecret: instanceWebhookSecret
      }
    });
    
    if (copyFromInstanceId) {
      const sourceInstance = await prisma.whatsAppInstance.findFirst({
        where: { id: copyFromInstanceId, businessId },
        include: { 
          followUpConfig: true,
          agentPrompt: { include: { tools: true } }
        }
      });
      
      if (sourceInstance?.followUpConfig) {
        await prisma.followUpConfig.create({
          data: {
            businessId,
            instanceId: instance.id,
            enabled: sourceInstance.followUpConfig.enabled,
            firstDelayMinutes: sourceInstance.followUpConfig.firstDelayMinutes,
            secondDelayMinutes: sourceInstance.followUpConfig.secondDelayMinutes,
            thirdDelayMinutes: sourceInstance.followUpConfig.thirdDelayMinutes,
            maxDailyAttempts: sourceInstance.followUpConfig.maxDailyAttempts,
            pressureLevel: sourceInstance.followUpConfig.pressureLevel,
            allowedStartHour: sourceInstance.followUpConfig.allowedStartHour,
            allowedEndHour: sourceInstance.followUpConfig.allowedEndHour,
            weekendsEnabled: sourceInstance.followUpConfig.weekendsEnabled,
            triggerMode: sourceInstance.followUpConfig.triggerMode,
            stopOnReply: sourceInstance.followUpConfig.stopOnReply,
            followUpSteps: sourceInstance.followUpConfig.followUpSteps ?? undefined,
            metaTemplateId: sourceInstance.followUpConfig.metaTemplateId,
            templateVariables: sourceInstance.followUpConfig.templateVariables ?? undefined,
            templateEnabled: sourceInstance.followUpConfig.templateEnabled
          }
        });
      }
      
      if (sourceInstance?.agentPrompt) {
        const newPrompt = await prisma.agentPrompt.create({
          data: {
            businessId,
            instanceId: instance.id,
            prompt: sourceInstance.agentPrompt.prompt,
            bufferSeconds: sourceInstance.agentPrompt.bufferSeconds,
            historyLimit: sourceInstance.agentPrompt.historyLimit,
            splitMessages: sourceInstance.agentPrompt.splitMessages
          }
        });
        
        const tools = sourceInstance.agentPrompt.tools;
        if (tools && tools.length > 0) {
          await prisma.agentTool.createMany({
            data: tools.map(tool => ({
              promptId: newPrompt.id,
              name: tool.name,
              description: tool.description,
              url: tool.url,
              method: tool.method,
              headers: tool.headers ?? undefined,
              bodyTemplate: tool.bodyTemplate ?? undefined,
              parameters: tool.parameters ?? undefined,
              dynamicVariables: tool.dynamicVariables ?? undefined,
              enabled: tool.enabled
            }))
          });
        }
      }
    }
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId,
      eventType: 'CREATED',
      newProvider: 'BAILEYS',
      newStatus: 'pending_qr',
      backendId: instanceBackendId,
      details: `New Baileys instance "${instanceName}" created`
    });
    
    res.status(201).json({
      instance,
      apiKey,
      waInstance: waResponse.data
    });
  } catch (error: any) {
    console.error('Add instance error:', error.response?.data || error.message);
    const errorMessage = error.response?.data?.error 
      || error.response?.data?.message 
      || error.message 
      || 'Failed to add WhatsApp instance';
    res.status(error.response?.status || 500).json({ error: errorMessage });
  }
});

router.delete('/instances/:instanceId', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string },
      include: { metaCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    if (instance.provider === 'BAILEYS' && instance.instanceBackendId) {
      try {
        await axios.delete(`${WA_API_URL}/instances/${instance.instanceBackendId}`);
      } catch (err) {
        console.log('Baileys instance cleanup failed (may not exist)');
      }
    }
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: businessId as string,
      eventType: 'DELETED',
      previousProvider: instance.provider,
      previousStatus: instance.status,
      phoneNumber: instance.phoneNumber,
      details: `Instance "${instance.name}" deleted`
    });
    
    if (instance.metaCredential) {
      await prisma.metaCredential.delete({ where: { instanceId: instance.id } }).catch(() => {});
    }
    
    await prisma.followUpConfig.deleteMany({ where: { instanceId: instance.id } });
    await prisma.agentPrompt.deleteMany({ where: { instanceId: instance.id } });
    await prisma.whatsAppInstance.delete({ where: { id: instance.id } });
    
    res.json({ success: true, message: `Instance "${instance.name}" deleted` });
  } catch (error: any) {
    console.error('Delete instance error:', error.message);
    res.status(500).json({ error: 'Failed to delete instance' });
  }
});

router.put('/instances/:instanceId/meta-credentials', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    const { accessToken, metaBusinessId, phoneNumberId, appId, appSecret, phoneNumber } = req.body;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    if (!accessToken || !metaBusinessId || !phoneNumberId || !appId || !appSecret) {
      return res.status(400).json({ error: 'All credential fields are required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string, provider: 'META_CLOUD' },
      include: { metaCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Meta Cloud instance not found' });
    }
    
    const metaService = new MetaCloudService({
      accessToken,
      phoneNumberId,
      businessId: metaBusinessId
    });
    
    try {
      const phoneInfo = await metaService.getPhoneNumberInfo();
      console.log('Meta credentials validated:', phoneInfo.verified_name || phoneInfo.display_phone_number);
    } catch (err: any) {
      console.error('Meta validation error:', err.response?.data || err.message);
      return res.status(400).json({ 
        error: 'Invalid Meta credentials',
        details: err.response?.data?.error?.message || err.message
      });
    }
    
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    const webhookUrl = `${coreApiUrl}/meta-webhook/${instanceId}`;
    const webhookVerifyToken = instance.metaCredential?.webhookVerifyToken || 
      require('crypto').randomBytes(24).toString('hex');
    
    if (instance.metaCredential) {
      await prisma.metaCredential.update({
        where: { instanceId: instance.id },
        data: {
          accessToken,
          businessId: metaBusinessId,
          phoneNumberId,
          appId,
          appSecret,
          webhookVerifyToken
        }
      });
    } else {
      await prisma.metaCredential.create({
        data: {
          instanceId: instance.id,
          accessToken,
          businessId: metaBusinessId,
          phoneNumberId,
          appId,
          appSecret,
          webhookVerifyToken
        }
      });
    }
    
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: {
        status: 'connected',
        phoneNumber: phoneNumber || null
      }
    });
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: businessId as string,
      eventType: 'CONNECTED',
      newStatus: 'connected',
      phoneNumber,
      details: 'Meta Cloud credentials configured successfully'
    });
    
    res.json({
      success: true,
      webhookUrl,
      webhookVerifyToken,
      message: 'Meta Cloud credentials updated successfully'
    });
  } catch (error: any) {
    console.error('Update Meta credentials error:', error.message);
    res.status(500).json({ error: 'Failed to update Meta credentials' });
  }
});

router.get('/instances/:instanceId/status', async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const userInfo = await getUserWithRole(req.userId!);
    const business = await checkBusinessAccess(req.userId!, businessId as string, userInfo?.role, userInfo?.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string },
      include: { metaCredential: true, metaCoexistCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    if (instance.provider === 'META_COEXIST') {
      const coexistCred = instance.metaCoexistCredential;
      if (!coexistCred) {
        return res.json({
          id: instance.id,
          name: instance.name,
          provider: instance.provider,
          status: 'pending_credentials',
          phoneNumber: instance.phoneNumber
        });
      }
      
      const globalWebhookToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token_2024';
      return res.json({
        id: instance.id,
        name: instance.name,
        provider: instance.provider,
        phoneNumber: coexistCred.displayPhone || instance.phoneNumber,
        status: coexistCred.coexistStatus === 'ACTIVE' ? 'connected' : instance.status,
        isActive: instance.isActive,
        lastConnection: instance.lastConnection,
        coexistenceEnabled: coexistCred.coexistenceEnabled,
        webhookUrl: getPublicWebhookUrl('/webhook/meta'),
        webhookVerifyToken: coexistCred.webhookVerifyToken || globalWebhookToken,
        metaInfo: {
          displayPhoneNumber: coexistCred.displayPhone,
          qualityRating: coexistCred.qualityRating || 'GREEN',
          wabaId: coexistCred.wabaId,
          phoneNumberId: coexistCred.phoneNumberId
        }
      });
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
        
        return res.json({
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
            displayPhoneNumber: phoneInfo.display_phone_number,
            qualityRating: phoneInfo.quality_rating,
            verifiedName: phoneInfo.verified_name
          }
        });
      } catch (err: any) {
        return res.json({
          id: instance.id,
          name: instance.name,
          provider: instance.provider,
          phoneNumber: instance.phoneNumber,
          status: 'error',
          error: 'Could not verify Meta connection'
        });
      }
    }
    
    if (!instance.instanceBackendId) {
      return res.json({
        id: instance.id,
        name: instance.name,
        provider: instance.provider,
        status: 'not_created',
        phoneNumber: instance.phoneNumber
      });
    }
    
    try {
      const waResponse = await axios.get(`${WA_API_URL}/instances/${instance.instanceBackendId}/status`);
      const waStatus = waResponse.data?.data?.status || waResponse.data?.status || instance.status;
      
      if (waStatus !== instance.status) {
        await prisma.whatsAppInstance.update({
          where: { id: instance.id },
          data: { status: waStatus }
        });
      }
      
      return res.json({
        id: instance.id,
        name: instance.name,
        provider: instance.provider,
        status: waStatus,
        phoneNumber: instance.phoneNumber || waResponse.data?.data?.phoneNumber,
        isActive: instance.isActive,
        lastConnection: instance.lastConnection,
        instanceBackendId: instance.instanceBackendId
      });
    } catch (err) {
      return res.json({
        id: instance.id,
        name: instance.name,
        provider: instance.provider,
        status: instance.status || 'disconnected',
        phoneNumber: instance.phoneNumber,
        isActive: instance.isActive
      });
    }
  } catch (error: any) {
    console.error('Get instance status error:', error.message);
    res.status(500).json({ error: 'Failed to get instance status' });
  }
});

router.get('/instances/:instanceId/qr', async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const userInfo = await getUserWithRole(req.userId!);
    const business = await checkBusinessAccess(req.userId!, businessId as string, userInfo?.role, userInfo?.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string },
      include: { metaCoexistCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    // Meta providers don't use QR codes
    if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
      const status = instance.provider === 'META_COEXIST' && instance.metaCoexistCredential?.coexistStatus === 'ACTIVE'
        ? 'connected'
        : instance.status;
      return res.json({ 
        qr: null,
        status,
        message: 'Meta providers do not use QR codes. Connection is managed via Meta Business Suite.'
      });
    }
    
    if (!instance.instanceBackendId) {
      return res.status(400).json({ error: 'Instance has no backend connection' });
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
    console.error('Get instance QR error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

router.post('/instances/:instanceId/restart', async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const userInfo = await getUserWithRole(req.userId!);
    const business = await checkBusinessAccess(req.userId!, businessId as string, userInfo?.role, userInfo?.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string },
      include: { metaCoexistCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    // META_CLOUD and META_COEXIST don't need backend restart - they use Meta's API directly
    if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
      // For Meta providers, just update status to reflect it's connected
      const newStatus = instance.provider === 'META_COEXIST' && instance.metaCoexistCredential?.coexistStatus === 'ACTIVE' 
        ? 'connected' 
        : instance.status;
      
      await recordInstanceEvent({
        instanceId: instance.id,
        businessId: businessId as string,
        eventType: 'RECONNECTED',
        previousStatus: instance.status,
        newStatus,
        details: `Instance "${instance.name}" sync requested (Meta provider - no restart needed)`
      });
      
      return res.json({ success: true, message: 'Meta instance synced successfully' });
    }
    
    // BAILEYS provider needs backend connection
    if (!instance.instanceBackendId) {
      return res.status(400).json({ error: 'Instance has no backend connection' });
    }
    
    await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/restart`);
    
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { status: 'pending_qr' }
    });
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: businessId as string,
      eventType: 'RECONNECTED',
      previousStatus: instance.status,
      newStatus: 'pending_qr',
      details: `Instance "${instance.name}" restarted`
    });
    
    res.json({ success: true, message: 'Instance restarted' });
  } catch (error: any) {
    console.error('Restart instance error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to restart instance' });
  }
});

router.post('/instances/:instanceId/reset', requireEmailVerified, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { businessId } = req.query;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const userInfo = await getUserWithRole(req.userId!);
    const business = await checkBusinessAccess(req.userId!, businessId as string, userInfo?.role, userInfo?.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, businessId: businessId as string }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    
    // META_CLOUD and META_COEXIST cannot be reset via this endpoint - use disconnect instead
    if (instance.provider === 'META_CLOUD' || instance.provider === 'META_COEXIST') {
      return res.status(400).json({ 
        error: 'Meta instances cannot be reset. Use the disconnect option to change phone numbers.' 
      });
    }
    
    if (!instance.instanceBackendId) {
      return res.status(400).json({ error: 'Instance has no backend connection' });
    }
    
    await axios.post(`${WA_API_URL}/instances/${instance.instanceBackendId}/reset`);
    
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { 
        status: 'pending_qr',
        phoneNumber: null
      }
    });
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: businessId as string,
      eventType: 'SESSION_EXPIRED',
      previousStatus: instance.status,
      newStatus: 'pending_qr',
      phoneNumber: instance.phoneNumber,
      details: `Instance "${instance.name}" reset for new phone number`
    });
    
    res.json({ success: true, message: 'Instance reset successfully' });
  } catch (error: any) {
    console.error('Reset instance error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to reset instance' });
  }
});

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
      where: { businessId },
      include: { metaCredential: true }
    });
    
    if (existing) {
      await recordInstanceEvent({
        instanceId: existing.id,
        businessId,
        eventType: 'PROVIDER_CHANGED',
        previousProvider: existing.provider,
        newProvider: 'BAILEYS',
        previousStatus: existing.status,
        phoneNumber: existing.phoneNumber,
        backendId: existing.instanceBackendId,
        details: `Switching from ${existing.provider} to BAILEYS`
      });
      
      if (existing.provider === 'BAILEYS' && existing.instanceBackendId) {
        try {
          await axios.delete(`${WA_API_URL}/instances/${existing.instanceBackendId}`);
        } catch (err) {
          console.log('Previous Baileys instance cleanup failed (may not exist)');
        }
      }
      
      if (existing.metaCredential) {
        await prisma.metaCredential.delete({ where: { instanceId: existing.id } }).catch(() => {});
      }
      await prisma.whatsAppInstance.delete({ where: { id: existing.id } });
      console.log(`Cleaned up previous instance ${existing.id} before creating new Baileys instance`);
    }
    
    const instanceId = `biz_${businessId.substring(0, 8)}`;
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    const webhookUrl = webhook || `${coreApiUrl}/webhook/${businessId}`;
    
    const waResponse = await axios.post(`${WA_API_URL}/instances`, {
      instanceId,
      webhook: webhookUrl
    });
    
    const existingInstances = await prisma.whatsAppInstance.findMany({
      where: { businessId }
    });
    const legacyInstanceNumber = existingInstances.length + 1;
    
    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        instanceNumber: legacyInstanceNumber,
        instanceBackendId: instanceId,
        status: 'pending_qr',
        phoneNumber: phoneNumber || null
      }
    });
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId,
      eventType: 'CREATED',
      newProvider: 'BAILEYS',
      newStatus: 'pending_qr',
      backendId: instanceId,
      details: 'New Baileys instance created'
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
      where: { businessId },
      include: { metaCredential: true }
    });
    
    if (existing) {
      await recordInstanceEvent({
        instanceId: existing.id,
        businessId,
        eventType: 'PROVIDER_CHANGED',
        previousProvider: existing.provider,
        newProvider: 'META_CLOUD',
        previousStatus: existing.status,
        phoneNumber: existing.phoneNumber,
        backendId: existing.instanceBackendId,
        details: `Switching from ${existing.provider} to META_CLOUD`
      });
      
      if (existing.provider === 'BAILEYS' && existing.instanceBackendId) {
        try {
          await axios.delete(`${WA_API_URL}/instances/${existing.instanceBackendId}`);
        } catch (err) {
          console.log('Previous Baileys instance cleanup failed (may not exist)');
        }
      }
      
      if (existing.metaCredential) {
        await prisma.metaCredential.delete({ where: { instanceId: existing.id } }).catch(() => {});
      }
      await prisma.whatsAppInstance.delete({ where: { id: existing.id } });
      console.log(`Cleaned up previous instance ${existing.id} before creating Meta Cloud instance`);
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
    
    const existingInstances = await prisma.whatsAppInstance.findMany({
      where: { businessId }
    });
    const legacyInstanceNumber = existingInstances.length + 1;
    
    const instance = await prisma.whatsAppInstance.create({
      data: {
        businessId,
        instanceNumber: legacyInstanceNumber,
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
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId,
      eventType: 'CREATED',
      newProvider: 'META_CLOUD',
      newStatus: 'connected',
      phoneNumber: instance.phoneNumber,
      details: 'New Meta Cloud instance created'
    });
    
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
      include: { 
        metaCredential: { select: { webhookVerifyToken: true, phoneNumberId: true } },
        metaCoexistCredential: { select: { webhookVerifyToken: true, phoneNumberId: true, displayPhone: true, coexistStatus: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const globalWebhookToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'efficore_webhook_token_2024';
    
    res.json(instances.map(inst => ({
      id: inst.id,
      name: inst.name,
      provider: inst.provider,
      phoneNumber: inst.metaCoexistCredential?.displayPhone || inst.phoneNumber,
      status: inst.provider === 'META_COEXIST' && inst.metaCoexistCredential?.coexistStatus === 'ACTIVE' 
        ? 'connected' 
        : inst.status,
      isActive: inst.isActive,
      botEnabled: inst.botEnabled,
      businessObjective: inst.businessObjective,
      lastConnection: inst.lastConnection,
      createdAt: inst.createdAt,
      webhookUrl: inst.provider === 'META_CLOUD' 
        ? getPublicWebhookUrl(`/webhook/meta/${inst.id}`) 
        : inst.provider === 'META_COEXIST' 
          ? getPublicWebhookUrl('/webhook/meta') 
          : null,
      webhookVerifyToken: inst.metaCredential?.webhookVerifyToken || inst.metaCoexistCredential?.webhookVerifyToken || (inst.provider === 'META_COEXIST' ? globalWebhookToken : undefined)
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
    const { to, message, imageUrl, videoUrl, audioUrl, fileUrl, fileName, mimeType, instanceId } = req.body;
    
    const user = await getUserWithRole(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const business = await checkBusinessAccess(req.userId!, req.params.businessId, user.role, user.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (user.role === 'ASESOR') {
      const cleanPhone = to.replace(/\D/g, '');
      const hasAccess = await checkAdvisorContactAccess(req.userId!, req.params.businessId, cleanPhone);
      if (!hasAccess) {
        return res.status(403).json({ error: 'You do not have permission to message this contact' });
      }
    }
    
    const instanceWhere: any = { businessId: req.params.businessId };
    if (instanceId) {
      instanceWhere.id = instanceId;
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: instanceWhere,
      include: { metaCredential: true, metaCoexistCredential: true }
    });
    
    if (!instance) {
      return res.status(404).json({ error: 'No WhatsApp instance for this business' });
    }
    
    let cleanTo = to.replace(/\D/g, '');
    cleanTo = normalizeArgentinePhone(cleanTo);
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
    } else if (instance.provider === 'META_COEXIST') {
      if (!instance.metaCoexistCredential) {
        return res.status(500).json({ error: 'Meta Coexist credentials not found' });
      }
      
      if (instance.metaCoexistCredential.coexistStatus !== 'ACTIVE') {
        return res.status(400).json({ error: 'Meta Coexistence is not active. Please complete the setup first.' });
      }
      
      const metaService = new MetaCloudService({
        accessToken: instance.metaCoexistCredential.userAccessToken,
        phoneNumberId: instance.metaCoexistCredential.phoneNumberId,
        businessId: instance.metaCoexistCredential.wabaId
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
        metadata: { provider: instance.provider, source: 'manual_panel' }
      }
    });
    
    // Schedule follow-up after manual message
    await scheduleFollowUp(req.params.businessId, cleanTo, 'user', instance?.id);
    
    res.json(response);
  } catch (error: any) {
    const errorDetails = error.response?.data || error.message;
    console.error('Send message error:', errorDetails);
    
    // Extract meaningful error message for the user
    let userMessage = 'Failed to send message';
    let technicalDetails = '';
    
    if (error.response?.status === 404) {
      // Instance not found in WhatsApp backend - needs reconnection
      userMessage = 'WhatsApp no esta conectado';
      technicalDetails = 'La sesion de WhatsApp expiro o el servicio se reinicio. Por favor ve a la configuracion de WhatsApp y vuelve a escanear el codigo QR para reconectar.';
      
      // Update instance status to reflect disconnection
      try {
        await prisma.whatsAppInstance.updateMany({
          where: { businessId: req.params.businessId },
          data: { status: 'disconnected', qr: null }
        });
      } catch (updateErr) {
        console.error('Failed to update instance status:', updateErr);
      }
    } else if (error.response?.data) {
      const data = error.response.data;
      if (data.error) {
        userMessage = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
      }
      if (data.message) {
        technicalDetails = data.message;
      }
      if (data.details) {
        technicalDetails = data.details;
      }
    } else if (error.message) {
      technicalDetails = error.message;
    }
    
    res.status(error.response?.status || 500).json({ 
      error: userMessage,
      details: technicalDetails || undefined
    });
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
    
    const previousStatus = instance.status;
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { status: 'pending_qr', qr: null }
    });
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: req.params.businessId,
      eventType: 'RECONNECTED',
      previousStatus,
      newStatus: 'pending_qr',
      phoneNumber: instance.phoneNumber,
      backendId: instance.instanceBackendId,
      details: 'Instance restarted manually'
    });
    
    console.log(`Instance ${instance.instanceBackendId} restarted with webhook: ${webhookUrl}`);
    res.json(waResponse.data);
  } catch (error: any) {
    console.error('Restart instance error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to restart instance' });
  }
});

router.post('/:businessId/reset', async (req: AuthRequest, res: Response) => {
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
      `${WA_API_URL}/instances/${instance.instanceBackendId}/reset`
    );
    
    const previousStatus = instance.status;
    await prisma.whatsAppInstance.update({
      where: { id: instance.id },
      data: { status: 'pending_qr', qr: null, phoneNumber: null }
    });
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: req.params.businessId,
      eventType: 'DISCONNECTED',
      previousStatus,
      newStatus: 'pending_qr',
      phoneNumber: instance.phoneNumber,
      backendId: instance.instanceBackendId,
      details: 'Session reset to connect different WhatsApp number'
    });
    
    console.log(`Instance ${instance.instanceBackendId} session reset for new WhatsApp number`);
    res.json({ 
      success: true, 
      message: 'Session reset successfully. Scan QR to connect new WhatsApp number.',
      ...waResponse.data 
    });
  } catch (error: any) {
    console.error('Reset instance error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to reset instance session' });
  }
});

router.get('/:businessId/groups', async (req: AuthRequest, res: Response) => {
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
    
    if (instance.provider !== 'BAILEYS') {
      return res.status(400).json({ error: 'Group import is only available for Baileys instances' });
    }
    
    if (!instance.instanceBackendId) {
      return res.status(400).json({ error: 'Instance not properly configured' });
    }
    
    const waResponse = await axios.get(`${WA_API_URL}/instances/${instance.instanceBackendId}/groups`);
    res.json(waResponse.data);
  } catch (error: any) {
    console.error('Get groups error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

router.get('/:businessId/groups/:groupId/participants', async (req: AuthRequest, res: Response) => {
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
    
    if (instance.provider !== 'BAILEYS') {
      return res.status(400).json({ error: 'Group import is only available for Baileys instances' });
    }
    
    if (!instance.instanceBackendId) {
      return res.status(400).json({ error: 'Instance not properly configured' });
    }
    
    const waResponse = await axios.get(
      `${WA_API_URL}/instances/${instance.instanceBackendId}/groups/${encodeURIComponent(req.params.groupId)}/participants`
    );
    res.json(waResponse.data);
  } catch (error: any) {
    console.error('Get group participants error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch group participants' });
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
    
    await recordInstanceEvent({
      instanceId: instance.id,
      businessId: req.params.businessId,
      eventType: 'DELETED',
      previousProvider: instance.provider,
      previousStatus: instance.status,
      phoneNumber: instance.phoneNumber,
      backendId: instance.instanceBackendId,
      details: 'Instance deleted manually by user'
    });
    
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

router.get('/:businessId/history', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await getInstanceHistory(req.params.businessId, limit);
    
    res.json(history);
  } catch (error) {
    console.error('Get instance history error:', error);
    res.status(500).json({ error: 'Failed to get instance history' });
  }
});

router.post('/:businessId/validate', async (req: AuthRequest, res: Response) => {
  try {
    const business = await checkBusinessAccess(req.userId!, req.params.businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const results = await validateAndCleanInstances(req.params.businessId, WA_API_URL);
    
    res.json({
      message: 'Validation complete',
      ...results
    });
  } catch (error) {
    console.error('Validate instances error:', error);
    res.status(500).json({ error: 'Failed to validate instances' });
  }
});

const internalRouter = Router();

internalRouter.get('/baileys-instances', async (req, res) => {
  try {
    const internalSecret = req.headers['x-internal-secret'];
    const expectedSecret = process.env.INTERNAL_API_SECRET || 'internal-secret-key';
    
    if (internalSecret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const instances = await prisma.whatsAppInstance.findMany({
      where: { 
        provider: 'BAILEYS', 
        isActive: true,
        instanceBackendId: { not: null }
      },
      include: {
        business: {
          select: { id: true, name: true }
        }
      }
    });
    
    const result = instances.map(inst => ({
      id: inst.instanceBackendId,
      businessId: inst.business.id,
      webhook: `${CORE_API_URL}/webhook/${inst.business.id}`,
      status: inst.status,
      phoneNumber: inst.phoneNumber,
      lastConnection: inst.lastConnection
    }));
    
    console.log(`[Internal API] Returning ${result.length} active Baileys instances for restoration`);
    
    res.json({ instances: result });
  } catch (error) {
    console.error('Get baileys instances error:', error);
    res.status(500).json({ error: 'Failed to get Baileys instances' });
  }
});

// Map Baileys status to DB status (frontend uses open/closed/pending_qr)
function mapBaileysStatus(baileysStatus: string): string {
  const statusMap: Record<string, string> = {
    'connected': 'open',
    'disconnected': 'closed',
    'requires_qr': 'pending_qr',
    'connecting': 'connecting',
    'error': 'error'
  };
  return statusMap[baileysStatus] || baileysStatus;
}

// Sync endpoint - WhatsApp API reports its active instances to keep DB in sync
internalRouter.post('/sync-instances', async (req, res) => {
  try {
    const internalSecret = req.headers['x-internal-secret'];
    const expectedSecret = process.env.INTERNAL_API_SECRET || 'internal-secret-key';
    
    if (internalSecret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { instances } = req.body;
    
    if (!Array.isArray(instances)) {
      return res.status(400).json({ error: 'instances array required' });
    }
    
    console.log(`[Internal API] Syncing ${instances.length} Baileys instances from WhatsApp API`);
    
    const results = {
      updated: 0,
      notFound: 0,
      errors: [] as string[]
    };
    
    for (const inst of instances) {
      try {
        const { id, status, phoneNumber } = inst;
        
        if (!id) continue;
        
        const mappedStatus = mapBaileysStatus(status);
        
        const updated = await prisma.whatsAppInstance.updateMany({
          where: { instanceBackendId: id },
          data: {
            status: mappedStatus,
            isActive: true,
            lastConnection: mappedStatus === 'open' ? new Date() : undefined,
            phoneNumber: phoneNumber || undefined
          }
        });
        
        if (updated.count > 0) {
          results.updated++;
          console.log(`[Internal API] Synced instance ${id}: ${status} -> ${mappedStatus}`);
        } else {
          results.notFound++;
          console.log(`[Internal API] Instance ${id} not found in database`);
        }
      } catch (err: any) {
        results.errors.push(`${inst.id}: ${err.message}`);
      }
    }
    
    // Mark orphaned DB instances (in DB but not reported by WA API) as disconnected
    const reportedIds = instances.map((i: any) => i.id).filter(Boolean);
    if (reportedIds.length > 0) {
      const orphaned = await prisma.whatsAppInstance.updateMany({
        where: {
          provider: 'BAILEYS',
          isActive: true,
          instanceBackendId: { notIn: reportedIds }
        },
        data: { status: 'disconnected' }
      });
      
      if (orphaned.count > 0) {
        console.log(`[Internal API] Marked ${orphaned.count} orphaned instances as disconnected`);
      }
    }
    
    res.json({
      success: true,
      ...results
    });
  } catch (error: any) {
    console.error('Sync instances error:', error);
    res.status(500).json({ error: 'Failed to sync instances' });
  }
});

export { internalRouter };
export default router;
