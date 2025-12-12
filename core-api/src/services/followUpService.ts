import prisma from './prisma.js';

export async function scheduleFollowUp(businessId: string, contactPhone: string): Promise<void> {
  try {
    const cleanPhone = contactPhone.replace(/\D/g, '');
    
    const [config, contact] = await Promise.all([
      prisma.followUpConfig.findUnique({ where: { businessId } }),
      prisma.contact.findUnique({
        where: { businessId_phone: { businessId, phone: cleanPhone } }
      })
    ]);
    
    if (!config || !config.enabled) {
      return;
    }
    
    if (contact?.remindersPaused) {
      console.log(`[FOLLOW-UP] Skipping - reminders paused for ${cleanPhone}`);
      return;
    }
    
    await prisma.reminder.updateMany({
      where: {
        businessId,
        contactPhone,
        status: 'pending'
      },
      data: {
        status: 'cancelled_rescheduled'
      }
    });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayAttempts = await prisma.reminder.count({
      where: {
        businessId,
        contactPhone,
        status: 'executed',
        executedAt: { gte: today }
      }
    });
    
    const maxAttempts = Array.isArray(config.followUpSteps) 
      ? (config.followUpSteps as any[]).length 
      : config.maxDailyAttempts;
    
    if (todayAttempts >= maxAttempts) {
      return;
    }
    
    let delayMinutes = config.firstDelayMinutes;
    if (Array.isArray(config.followUpSteps) && config.followUpSteps[todayAttempts]) {
      const step = (config.followUpSteps as any[])[todayAttempts];
      if (step && typeof step.delayMinutes === 'number') {
        delayMinutes = step.delayMinutes;
      }
    } else {
      if (todayAttempts === 1) delayMinutes = config.secondDelayMinutes;
      else if (todayAttempts >= 2) delayMinutes = config.thirdDelayMinutes;
    }
    
    const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);
    
    await prisma.reminder.create({
      data: {
        businessId,
        contactPhone,
        scheduledAt,
        type: 'auto',
        attemptNumber: todayAttempts + 1,
        configId: config.id
      }
    });
    
    console.log(`[FOLLOW-UP] Scheduled follow-up for ${contactPhone} in ${delayMinutes} minutes (attempt ${todayAttempts + 1})`);
  } catch (err) {
    console.error('[FOLLOW-UP] Failed to schedule follow-up:', err);
  }
}

export async function cancelPendingFollowUps(businessId: string, contactPhone: string): Promise<number> {
  try {
    const result = await prisma.reminder.updateMany({
      where: {
        businessId,
        contactPhone,
        status: 'pending'
      },
      data: {
        status: 'cancelled_user_replied'
      }
    });
    
    if (result.count > 0) {
      console.log(`[FOLLOW-UP] Cancelled ${result.count} pending reminder(s) for ${contactPhone} - user replied`);
    }
    
    return result.count;
  } catch (err) {
    console.error('[FOLLOW-UP] Failed to cancel pending reminders:', err);
    return 0;
  }
}
