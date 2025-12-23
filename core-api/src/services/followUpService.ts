import prisma from './prisma.js';
import { getReminderQueue, ReminderJobData } from './queues/index.js';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { getDay, getHours, getMinutes, setHours, setMinutes, setSeconds, setMilliseconds, addDays } from 'date-fns';

export type TriggerSource = 'ai' | 'user';

export async function scheduleFollowUp(
  businessId: string, 
  contactPhone: string,
  source: TriggerSource = 'ai'
): Promise<void> {
  try {
    const cleanPhone = contactPhone.replace(/\D/g, '');
    
    console.log(`[FOLLOW-UP] scheduleFollowUp called - business: ${businessId}, phone: ${cleanPhone}, source: ${source}`);
    
    const [config, contact, business] = await Promise.all([
      prisma.followUpConfig.findFirst({ 
        where: { businessId },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.contact.findUnique({
        where: { businessId_phone: { businessId, phone: cleanPhone } }
      }),
      prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } })
    ]);
    
    const timezone = business?.timezone || 'America/Lima';
    
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
    
    const checkAndAdjustSchedule = (utcDate: Date, depth: number = 0): Date => {
      if (depth > 10) return utcDate;
      
      const zonedDate = toZonedTime(utcDate, timezone);
      const hour = getHours(zonedDate);
      const dayOfWeek = getDay(zonedDate);
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      if (!weekendsEnabled && isWeekend) {
        const daysUntilMonday = dayOfWeek === 0 ? 1 : 2;
        let adjustedZoned = addDays(zonedDate, daysUntilMonday);
        adjustedZoned = setHours(adjustedZoned, allowedStartHour);
        adjustedZoned = setMinutes(adjustedZoned, 0);
        adjustedZoned = setSeconds(adjustedZoned, 0);
        adjustedZoned = setMilliseconds(adjustedZoned, 0);
        const newUtc = fromZonedTime(adjustedZoned, timezone);
        return checkAndAdjustSchedule(newUtc, depth + 1);
      }
      
      if (hour < allowedStartHour) {
        let adjustedZoned = setHours(zonedDate, allowedStartHour);
        adjustedZoned = setMinutes(adjustedZoned, 0);
        adjustedZoned = setSeconds(adjustedZoned, 0);
        adjustedZoned = setMilliseconds(adjustedZoned, 0);
        return fromZonedTime(adjustedZoned, timezone);
      } else if (hour >= allowedEndHour) {
        let adjustedZoned = addDays(zonedDate, 1);
        adjustedZoned = setHours(adjustedZoned, allowedStartHour);
        adjustedZoned = setMinutes(adjustedZoned, 0);
        adjustedZoned = setSeconds(adjustedZoned, 0);
        adjustedZoned = setMilliseconds(adjustedZoned, 0);
        const newUtc = fromZonedTime(adjustedZoned, timezone);
        return checkAndAdjustSchedule(newUtc, depth + 1);
      }
      
      return utcDate;
    };
    
    scheduledAt = checkAndAdjustSchedule(scheduledAt);
    const finalZoned = toZonedTime(scheduledAt, timezone);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    console.log(`[FOLLOW-UP] Scheduled time: ${scheduledAt.toISOString()} (timezone: ${timezone}, local hour: ${getHours(finalZoned)}:${String(getMinutes(finalZoned)).padStart(2, '0')}, day: ${dayNames[getDay(finalZoned)]})`);
    
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
    
    // Add to BullMQ queue if available
    const reminderQueue = getReminderQueue();
    if (reminderQueue) {
      const delay = Math.max(0, scheduledAt.getTime() - Date.now());
      const jobData: ReminderJobData = {
        reminderId: reminder.id,
        businessId,
        contactPhone: cleanPhone,
        attemptNumber: todayAttempts + 1,
        type: 'auto'
      };
      
      await reminderQueue.add(
        `reminder-${reminder.id}`,
        jobData,
        { 
          jobId: `reminder-${reminder.id}`,
          delay 
        }
      );
      console.log(`[FOLLOW-UP] ✓ Created reminder ${reminder.id} and added to queue for ${cleanPhone} scheduled at ${scheduledAt.toISOString()} (attempt ${todayAttempts + 1}, delay: ${delayMinutes}min, queueDelay: ${Math.round(delay/1000)}s)`);
    } else {
      // Legacy mode - reminder will be picked up by setInterval worker
      console.log(`[FOLLOW-UP] ✓ Created reminder ${reminder.id} for ${cleanPhone} scheduled at ${scheduledAt.toISOString()} (attempt ${todayAttempts + 1}, delay: ${delayMinutes}min) [legacy mode]`);
    }
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
