import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, industry, logoUrl } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Business name is required' });
    }
    
    const business = await prisma.business.create({
      data: {
        userId: req.userId!,
        name,
        description,
        industry,
        logoUrl,
        agentPrompts: {
          create: {
            prompt: '',
            bufferSeconds: 10,
            historyLimit: 15,
            splitMessages: true
          }
        }
      }
    });
    
    res.status(201).json(business);
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    let businesses = await prisma.business.findMany({
      where: { userId: req.userId },
      include: {
        instances: true,
        _count: { select: { products: true, messages: true } }
      }
    });
    
    // Auto-heal: Create default business if user has none (fixes orphaned users from Google OAuth etc)
    if (businesses.length === 0 && req.userId) {
      console.log(`[Business] Auto-creating default business for orphaned user ${req.userId}`);
      
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { name: true }
      });
      
      const newBusiness = await prisma.business.create({
        data: {
          userId: req.userId,
          name: 'Mi Empresa',
          description: 'Configura los datos de tu empresa',
          botEnabled: true,
          agentPrompts: {
            create: {
              prompt: '',
              bufferSeconds: 10,
              historyLimit: 15,
              splitMessages: true
            }
          }
        },
        include: {
          instances: true,
          _count: { select: { products: true, messages: true } }
        }
      });
      
      console.log(`[Business] Created default business ${newBusiness.id} for user ${req.userId}`);
      businesses = [newBusiness];
    }
    
    res.json(businesses);
  } catch (error) {
    console.error('Get businesses error:', error);
    res.status(500).json({ error: 'Failed to get businesses' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: {
        instances: true,
        policy: true,
        agentPrompts: true,
        _count: { select: { products: true, messages: true } }
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json(business);
  } catch (error) {
    console.error('Get business error:', error);
    res.status(500).json({ error: 'Failed to get business' });
  }
});

router.get('/:id/delivery-zones', async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const deliveryZones = await prisma.deliveryZone.findMany({
      where: { businessId: req.params.id, isActive: true },
      orderBy: { order: 'asc' }
    });
    
    res.json(deliveryZones);
  } catch (error) {
    console.error('Get delivery zones error:', error);
    res.status(500).json({ error: 'Failed to get delivery zones' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, industry, logoUrl, agentVersion, timezone, currencyCode, currencySymbol, businessObjective, onboardingCompleted, onboardingSkipped, openaiModel } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // Check if user has Enterprise plan before allowing V2 activation
    if (agentVersion === 'v2' && existing.agentVersion !== 'v2') {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { isPro: true, proBonusExpiresAt: true }
      });
      
      const hasEnterprise = user?.isPro || (user?.proBonusExpiresAt && user.proBonusExpiresAt > new Date());
      
      if (!hasEnterprise) {
        return res.status(403).json({ error: 'V2 Enterprise Pro requiere plan Enterprise activo. Contacta a soporte para solicitarlo.' });
      }
    }
    
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (industry !== undefined) updateData.industry = industry;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (currencyCode !== undefined) updateData.currencyCode = currencyCode;
    if (currencySymbol !== undefined) updateData.currencySymbol = currencySymbol;
    if (businessObjective !== undefined && ['SALES', 'APPOINTMENTS'].includes(businessObjective)) {
      updateData.businessObjective = businessObjective;
    }
    if (agentVersion !== undefined && ['v1', 'v2'].includes(agentVersion)) {
      updateData.agentVersion = agentVersion;
    }
    if (onboardingCompleted !== undefined) updateData.onboardingCompleted = onboardingCompleted;
    if (onboardingSkipped !== undefined) updateData.onboardingSkipped = onboardingSkipped;
    if (openaiModel !== undefined) updateData.openaiModel = openaiModel;
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: updateData
    });
    
    res.json(business);
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({ error: 'Failed to update business' });
  }
});

router.put('/:id/model', async (req: AuthRequest, res: Response) => {
  try {
    const { model } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { openaiModel: model }
    });
    
    console.log(`[BUSINESS] Model updated for ${business.id}: ${model}`);
    res.json({ id: business.id, model: business.openaiModel });
  } catch (error) {
    console.error('Update model error:', error);
    res.status(500).json({ error: 'Failed to update model' });
  }
});

router.get('/:id/openai', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const openaiConfigured = !!process.env.OPENAI_API_KEY;
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    
    res.json({ 
      id: existing.id,
      openaiConfigured,
      openaiModel,
      message: 'OpenAI is managed centrally by administrator'
    });
  } catch (error) {
    console.error('Get OpenAI config error:', error);
    res.status(500).json({ error: 'Failed to get OpenAI config' });
  }
});

router.put('/:id/bot-toggle', async (req: AuthRequest, res: Response) => {
  try {
    const { botEnabled } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { botEnabled: botEnabled ?? !existing.botEnabled }
    });
    
    res.json({ id: business.id, botEnabled: business.botEnabled });
  } catch (error) {
    console.error('Toggle bot error:', error);
    res.status(500).json({ error: 'Failed to toggle bot' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // Check if this is the user's last business
    const businessCount = await prisma.business.count({
      where: { userId: req.userId }
    });
    
    if (businessCount <= 1) {
      return res.status(400).json({ 
        error: 'No puedes eliminar tu único negocio. Debes tener al menos un negocio activo.' 
      });
    }
    
    await prisma.business.delete({ where: { id: req.params.id } });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

router.post('/:id/generate-injection-code', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const code = randomBytes(6).toString('hex').toUpperCase();
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { injectionCode: code }
    });
    
    res.json({ 
      injectionCode: business.injectionCode,
      gptUrl: process.env.GPT_PROMPT_URL || null
    });
  } catch (error) {
    console.error('Generate injection code error:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

router.get('/:id/injection-code', async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId },
      select: { injectionCode: true }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json({ 
      injectionCode: business.injectionCode,
      gptUrl: process.env.GPT_PROMPT_URL || null
    });
  } catch (error) {
    console.error('Get injection code error:', error);
    res.status(500).json({ error: 'Failed to get code' });
  }
});

router.post('/:id/reset-config', async (req: AuthRequest, res: Response) => {
  try {
    const { instanceId } = req.body;
    
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // If instanceId provided, verify it belongs to this business
    if (instanceId) {
      const instance = await prisma.whatsAppInstance.findFirst({
        where: { id: instanceId, businessId: req.params.id }
      });
      if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
      }
    }
    
    // Get prompt IDs based on scope (instance-specific or all business prompts)
    const promptWhere = instanceId 
      ? { businessId: req.params.id, instanceId }
      : { businessId: req.params.id };
    
    const prompts = await prisma.agentPrompt.findMany({
      where: promptWhere,
      select: { id: true }
    });
    const promptIds = prompts.map(p => p.id);
    
    // Build transaction based on scope
    const transactions = [];
    
    if (instanceId) {
      // Instance-specific reset: only delete instance-specific data
      transactions.push(
        // Delete instance-specific products
        prisma.product.deleteMany({ where: { businessId: req.params.id, instanceId } }),
        // Delete instance-specific delivery zones
        prisma.deliveryZone.deleteMany({ where: { businessId: req.params.id, instanceId } }),
        // Delete instance-specific extraction fields
        prisma.extractionField.deleteMany({ where: { businessId: req.params.id, instanceId } }),
        // Delete instance-specific funnel stages
        prisma.funnelStage.deleteMany({ where: { businessId: req.params.id, instanceId } }),
        // Delete instance-specific prompt sections
        prisma.promptSection.deleteMany({ where: { businessId: req.params.id, instanceId } }),
        // Delete agent files for this instance's prompt
        prisma.agentFile.deleteMany({ where: { promptId: { in: promptIds } } }),
        // Delete custom tools for this instance's prompt
        prisma.agentTool.deleteMany({ where: { promptId: { in: promptIds } } }),
        // Reset instance-specific prompts
        prisma.agentPrompt.updateMany({ 
          where: { businessId: req.params.id, instanceId },
          data: {
            prompt: '',
            bufferSeconds: 10,
            historyLimit: 15,
            splitMessages: true
          }
        })
      );
    } else {
      // Full business reset: delete everything
      transactions.push(
        prisma.product.deleteMany({ where: { businessId: req.params.id } }),
        prisma.deliveryZone.deleteMany({ where: { businessId: req.params.id } }),
        prisma.extractionField.deleteMany({ where: { businessId: req.params.id } }),
        prisma.funnelStage.deleteMany({ where: { businessId: req.params.id } }),
        prisma.promptSection.deleteMany({ where: { businessId: req.params.id } }),
        prisma.agentFile.deleteMany({ where: { promptId: { in: promptIds } } }),
        prisma.agentTool.deleteMany({ where: { promptId: { in: promptIds } } }),
        prisma.agentPrompt.updateMany({ 
          where: { businessId: req.params.id },
          data: {
            prompt: '',
            bufferSeconds: 10,
            historyLimit: 15,
            splitMessages: true
          }
        })
      );
    }
    
    await prisma.$transaction(transactions);
    
    const scope = instanceId ? `instance ${instanceId}` : `business ${req.params.id}`;
    console.log(`[Business] Reset config for ${scope}`);
    
    res.json({ 
      success: true, 
      message: instanceId 
        ? 'Configuracion de instancia reiniciada' 
        : 'Configuracion reiniciada completamente',
      scope: instanceId ? 'instance' : 'business',
      deletedItems: { 
        products: true, 
        deliveryZones: true, 
        extractionFields: true, 
        funnelStages: true, 
        promptSections: true, 
        agentFiles: true, 
        customTools: true 
      }
    });
  } catch (error) {
    console.error('Reset config error:', error);
    res.status(500).json({ error: 'Failed to reset configuration' });
  }
});

router.get('/:id/stats', async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: {
        instances: {
          select: { id: true, status: true, phoneNumber: true }
        }
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const [productCount, messageCount, contactCount, orderCount, appointmentCount, campaignCount] = await Promise.all([
      prisma.product.count({ where: { businessId: req.params.id } }),
      prisma.messageLog.count({ where: { businessId: req.params.id } }),
      prisma.contact.count({ where: { businessId: req.params.id } }),
      prisma.order.count({ where: { businessId: req.params.id } }),
      prisma.appointment.count({ where: { businessId: req.params.id } }),
      prisma.broadcastCampaign.count({ 
        where: { 
          businessId: req.params.id,
          status: { in: ['COMPLETED', 'PAUSED', 'RUNNING'] }
        } 
      })
    ]);

    const instance = business.instances?.[0];
    const whatsappStatus = instance?.status || 'disconnected';
    const whatsappPhone = instance?.phoneNumber || null;

    res.json({
      whatsapp: {
        status: whatsappStatus,
        connected: whatsappStatus === 'open' || whatsappStatus === 'connected',
        phone: whatsappPhone
      },
      products: productCount,
      messages: messageCount,
      contacts: contactCount,
      orders: orderCount,
      appointments: appointmentCount,
      campaigns: campaignCount
    });
  } catch (error) {
    console.error('Get business stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;
