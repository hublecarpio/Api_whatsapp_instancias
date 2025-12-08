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
    
    let config = await prisma.followUpConfig.findUnique({
      where: { businessId }
    });
    
    if (!config) {
      config = await prisma.followUpConfig.create({
        data: { businessId }
      });
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
      enabled,
      firstDelayMinutes,
      secondDelayMinutes,
      thirdDelayMinutes,
      maxDailyAttempts,
      pressureLevel,
      allowedStartHour,
      allowedEndHour,
      weekendsEnabled
    } = req.body;
    
    const config = await prisma.followUpConfig.upsert({
      where: { businessId },
      update: {
        enabled: enabled ?? undefined,
        firstDelayMinutes: firstDelayMinutes ?? undefined,
        secondDelayMinutes: secondDelayMinutes ?? undefined,
        thirdDelayMinutes: thirdDelayMinutes ?? undefined,
        maxDailyAttempts: maxDailyAttempts ?? undefined,
        pressureLevel: pressureLevel ?? undefined,
        allowedStartHour: allowedStartHour ?? undefined,
        allowedEndHour: allowedEndHour ?? undefined,
        weekendsEnabled: weekendsEnabled ?? undefined
      },
      create: {
        businessId,
        enabled: enabled ?? true,
        firstDelayMinutes: firstDelayMinutes ?? 15,
        secondDelayMinutes: secondDelayMinutes ?? 60,
        thirdDelayMinutes: thirdDelayMinutes ?? 240,
        maxDailyAttempts: maxDailyAttempts ?? 3,
        pressureLevel: pressureLevel ?? 1,
        allowedStartHour: allowedStartHour ?? 9,
        allowedEndHour: allowedEndHour ?? 21,
        weekendsEnabled: weekendsEnabled ?? false
      }
    });
    
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

export default router;
