import { Router, Request, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/billing.js';

const router = Router();

router.use(authMiddleware);
router.use(requireActiveSubscription);

router.get('/config/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const { instanceId } = req.query;
    
    let config;
    
    if (instanceId) {
      config = await prisma.followUpConfig.findUnique({
        where: { instanceId: instanceId as string }
      });
      
      if (!config) {
        config = await prisma.followUpConfig.create({
          data: { businessId, instanceId: instanceId as string }
        });
      }
    } else {
      config = await prisma.followUpConfig.findFirst({
        where: { businessId, instanceId: null }
      });
      
      if (!config) {
        config = await prisma.followUpConfig.create({
          data: { businessId }
        });
      }
    }
    
    res.json(config);
  } catch (error) {
    console.error('Error fetching config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

router.put('/config/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const {
      instanceId,
      enabled,
      firstDelayMinutes,
      secondDelayMinutes,
      thirdDelayMinutes,
      maxDailyAttempts,
      pressureLevel,
      allowedStartHour,
      allowedEndHour,
      weekendsEnabled,
      triggerMode,
      stopOnReply,
      followUpSteps,
      metaTemplateId,
      templateVariables,
      templateEnabled
    } = req.body;
    
    if (triggerMode && !['user', 'agent', 'any'].includes(triggerMode)) {
      return res.status(400).json({ error: 'triggerMode must be one of: user, agent, any' });
    }
    
    const updateData = {
      enabled: enabled ?? undefined,
      firstDelayMinutes: firstDelayMinutes ?? undefined,
      secondDelayMinutes: secondDelayMinutes ?? undefined,
      thirdDelayMinutes: thirdDelayMinutes ?? undefined,
      maxDailyAttempts: maxDailyAttempts ?? undefined,
      pressureLevel: pressureLevel ?? undefined,
      allowedStartHour: allowedStartHour ?? undefined,
      allowedEndHour: allowedEndHour ?? undefined,
      weekendsEnabled: weekendsEnabled ?? undefined,
      triggerMode: triggerMode ?? undefined,
      stopOnReply: stopOnReply ?? undefined,
      followUpSteps: followUpSteps !== undefined ? followUpSteps : undefined,
      metaTemplateId: metaTemplateId !== undefined ? metaTemplateId : undefined,
      templateVariables: templateVariables !== undefined ? templateVariables : undefined,
      templateEnabled: templateEnabled !== undefined ? templateEnabled : undefined
    };
    
    const createData = {
      businessId,
      instanceId: instanceId || undefined,
      enabled: enabled ?? true,
      firstDelayMinutes: firstDelayMinutes ?? 15,
      secondDelayMinutes: secondDelayMinutes ?? 60,
      thirdDelayMinutes: thirdDelayMinutes ?? 240,
      maxDailyAttempts: maxDailyAttempts ?? 3,
      pressureLevel: pressureLevel ?? 1,
      allowedStartHour: allowedStartHour ?? 9,
      allowedEndHour: allowedEndHour ?? 21,
      weekendsEnabled: weekendsEnabled ?? false,
      triggerMode: triggerMode ?? 'user',
      stopOnReply: stopOnReply ?? true,
      followUpSteps: followUpSteps ?? null,
      metaTemplateId: metaTemplateId ?? null,
      templateVariables: templateVariables ?? null,
      templateEnabled: templateEnabled ?? false
    };
    
    let config;
    
    if (instanceId) {
      config = await prisma.followUpConfig.upsert({
        where: { instanceId },
        update: updateData,
        create: createData
      });
    } else {
      const existing = await prisma.followUpConfig.findFirst({
        where: { businessId, instanceId: null }
      });
      
      if (existing) {
        config = await prisma.followUpConfig.update({
          where: { id: existing.id },
          data: updateData
        });
      } else {
        config = await prisma.followUpConfig.create({
          data: createData
        });
      }
    }
    
    // IMPORTANT: If config is being disabled, cancel all pending reminders
    if (enabled === false) {
      const cancelResult = await prisma.reminder.updateMany({
        where: {
          businessId,
          status: 'pending',
          ...(instanceId ? { instanceId } : {})
        },
        data: { status: 'cancelled_config_disabled' }
      });
      console.log(`[FOLLOW-UP] Config disabled - cancelled ${cancelResult.count} pending reminders for business ${businessId}`);
    }
    
    res.json(config);
  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

router.get('/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const { status, contactPhone } = req.query;
    
    const where: any = { businessId };
    if (status) where.status = status;
    if (contactPhone) where.contactPhone = contactPhone;
    
    const reminders = await prisma.reminder.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      take: 100
    });
    
    res.json(reminders);
  } catch (error) {
    console.error('Error fetching reminders:', error);
    res.status(500).json({ error: 'Failed to fetch reminders' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      business_id,
      contact_phone,
      contact_name,
      scheduled_at,
      message_template,
      type = 'manual'
    } = req.body;
    
    if (!business_id || !contact_phone || !scheduled_at) {
      return res.status(400).json({ error: 'business_id, contact_phone, and scheduled_at are required' });
    }
    
    const reminder = await prisma.reminder.create({
      data: {
        businessId: business_id,
        contactPhone: contact_phone,
        contactName: contact_name,
        scheduledAt: new Date(scheduled_at),
        messageTemplate: message_template,
        type
      }
    });
    
    res.status(201).json(reminder);
  } catch (error) {
    console.error('Error creating reminder:', error);
    res.status(500).json({ error: 'Failed to create reminder' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    await prisma.reminder.update({
      where: { id },
      data: { status: 'cancelled' }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling reminder:', error);
    res.status(500).json({ error: 'Failed to cancel reminder' });
  }
});

router.get('/pending/count/:businessId', async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const count = await prisma.reminder.count({
      where: {
        businessId,
        status: 'pending'
      }
    });
    
    res.json({ count });
  } catch (error) {
    console.error('Error counting reminders:', error);
    res.status(500).json({ error: 'Failed to count reminders' });
  }
});

router.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const reminder = await prisma.reminder.findUnique({
      where: { id }
    });
    
    if (!reminder) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    
    if (!['failed', 'template_error', 'no_template'].includes(reminder.status)) {
      return res.status(400).json({ error: 'Only failed reminders can be retried' });
    }
    
    const retryDelay = Math.pow(2, reminder.retryCount + 1) * 60 * 1000;
    const newScheduledAt = new Date(Date.now() + retryDelay);
    
    await prisma.reminder.update({
      where: { id },
      data: {
        status: 'pending',
        scheduledAt: newScheduledAt,
        retryCount: reminder.retryCount + 1,
        lastError: null,
        processingAt: null
      }
    });
    
    res.json({ success: true, scheduledAt: newScheduledAt });
  } catch (error) {
    console.error('Error retrying reminder:', error);
    res.status(500).json({ error: 'Failed to retry reminder' });
  }
});

export default router;
