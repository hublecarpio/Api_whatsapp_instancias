import prisma from './prisma.js';

export type TriggerSource = 'ai' | 'user';

export async function scheduleFollowUp(
  businessId: string, 
  contactPhone: string,
  source: TriggerSource = 'ai'
): Promise<void> {
  try {
    const cleanPhone = contactPhone.replace(/\D/g, '');
    
    console.log(`[FOLLOW-UP] scheduleFollowUp called - business: ${businessId}, phone: ${cleanPhone}, source: ${source}`);
    
    const [config, contact] = await Promise.all([
      prisma.followUpConfig.findUnique({ where: { businessId } }),
      prisma.contact.findUnique({
        where: { businessId_phone: { businessId, phone: cleanPhone } }
      })
    ]);
    
    if (!config) {
      console.log(`[FOLLOW-UP] No config found for business ${businessId}`);
      return;
    }
    
    if (!config.enabled) {
      console.log(`[FOLLOW-UP] Config disabled for business ${businessId}`);
      return;
    }
    
    const triggerMode = (config as any).triggerMode || 'user';
    console.log(`[FOLLOW-UP] Config triggerMode: ${triggerMode}, source: ${source}`);
    
    const shouldTrigger = 
      triggerMode === 'any' ||
      (triggerMode === 'agent' && source === 'ai') ||
      (triggerMode === 'user' && source === 'user');
    
    if (!shouldTrigger) {
      console.log(`[FOLLOW-UP] Skipping - triggerMode '${triggerMode}' does not match source '${source}'`);
      return;
    }
    
    if (contact?.remindersPaused) {
      console.log(`[FOLLOW-UP] Skipping - reminders paused for ${cleanPhone}`);
      return;
    }
    
    await prisma.reminder.updateMany({
      where: {
        businessId,
        contactPhone: cleanPhone,
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
        contactPhone: cleanPhone,
        status: 'executed',
        executedAt: { gte: today }
      }
    });
    
    const maxAttempts = Array.isArray(config.followUpSteps) 
      ? (config.followUpSteps as any[]).length 
      : config.maxDailyAttempts;
    
    if (todayAttempts >= maxAttempts) {
      console.log(`[FOLLOW-UP] Skipping - max attempts reached (${todayAttempts}/${maxAttempts})`);
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
    
    let scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);
    
    const allowedStartHour = config.allowedStartHour ?? 9;
    const allowedEndHour = config.allowedEndHour ?? 21;
    const weekendsEnabled = config.weekendsEnabled ?? false;
    
    const checkAndAdjustSchedule = (date: Date): Date => {
      const hour = date.getHours();
      const dayOfWeek = date.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      if (!weekendsEnabled && isWeekend) {
        const daysUntilMonday = dayOfWeek === 0 ? 1 : 2;
        date.setDate(date.getDate() + daysUntilMonday);
        date.setHours(allowedStartHour, 0, 0, 0);
        return checkAndAdjustSchedule(date);
      }
      
      if (hour < allowedStartHour) {
        date.setHours(allowedStartHour, 0, 0, 0);
      } else if (hour >= allowedEndHour) {
        date.setDate(date.getDate() + 1);
        date.setHours(allowedStartHour, 0, 0, 0);
        return checkAndAdjustSchedule(date);
      }
      
      return date;
    };
    
    scheduledAt = checkAndAdjustSchedule(scheduledAt);
    
    const reminder = await prisma.reminder.create({
      data: {
        businessId,
        contactPhone: cleanPhone,
        scheduledAt,
        type: 'auto',
        attemptNumber: todayAttempts + 1,
        configId: config.id
      }
    });
    
    console.log(`[FOLLOW-UP] ✓ Created reminder ${reminder.id} for ${cleanPhone} scheduled at ${scheduledAt.toISOString()} (attempt ${todayAttempts + 1}, delay: ${delayMinutes}min)`);
  } catch (err) {
    console.error('[FOLLOW-UP] Failed to schedule follow-up:', err);
  }
}

export async function cancelPendingFollowUps(businessId: string, contactPhone: string): Promise<number> {
  try {
    const cleanPhone = contactPhone.replace(/\D/g, '');
    
    const result = await prisma.reminder.updateMany({
      where: {
        businessId,
        contactPhone: cleanPhone,
        status: 'pending'
      },
      data: {
        status: 'cancelled_user_replied'
      }
    });
    
    if (result.count > 0) {
      console.log(`[FOLLOW-UP] Cancelled ${result.count} pending reminder(s) for ${cleanPhone} - user replied`);
    }
    
    return result.count;
  } catch (err) {
    console.error('[FOLLOW-UP] Failed to cancel pending reminders:', err);
    return 0;
  }
}
