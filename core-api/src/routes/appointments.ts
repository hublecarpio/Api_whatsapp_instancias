import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../services/prisma.js';

const router = express.Router();

const INTERNAL_AGENT_SECRET = process.env.INTERNAL_AGENT_SECRET || 'internal-agent-secret-change-me';

async function scheduleAppointmentReminder(
  businessId: string,
  appointmentId: string,
  contactPhone: string,
  contactName: string | null,
  scheduledAt: Date,
  minutesBefore: number = 60
): Promise<void> {
  const reminderTime = new Date(scheduledAt.getTime() - minutesBefore * 60000);
  
  if (reminderTime <= new Date()) {
    console.log(`[APPOINTMENT REMINDER] Skipped - reminder time already passed for ${appointmentId}`);
    return;
  }
  
  const dateStr = scheduledAt.toLocaleDateString('es-PE', { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long' 
  });
  const timeStr = scheduledAt.toLocaleTimeString('es-PE', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  
  await prisma.reminder.create({
    data: {
      businessId,
      contactPhone,
      contactName,
      scheduledAt: reminderTime,
      type: 'appointment_reminder',
      status: 'pending',
      messageTemplate: `Recordatorio de cita: ${contactName || 'Cliente'}, tienes una cita programada para ${dateStr} a las ${timeStr}. Te esperamos!`,
      generatedMessage: null
    }
  });
  
  console.log(`[APPOINTMENT REMINDER] Scheduled for ${contactPhone} at ${reminderTime.toISOString()}`);
}

function parseTime(time: string): { hours: number; minutes: number } {
  const [hours, minutes] = time.split(':').map(Number);
  return { hours, minutes };
}

function timeToMinutes(time: string): number {
  const { hours, minutes } = parseTime(time);
  return hours * 60 + minutes;
}

async function checkAvailability(
  businessId: string,
  scheduledAt: Date,
  durationMinutes: number,
  excludeAppointmentId?: string
): Promise<{ available: boolean; reason?: string }> {
  const dayOfWeek = scheduledAt.getDay();
  const timeStr = scheduledAt.toTimeString().slice(0, 5);
  const appointmentMinutes = timeToMinutes(timeStr);
  const endMinutes = appointmentMinutes + durationMinutes;

  const availability = await prisma.businessAvailability.findFirst({
    where: {
      businessId,
      dayOfWeek,
      isBlocked: false
    }
  });

  if (!availability) {
    return { available: false, reason: 'No hay disponibilidad configurada para este día' };
  }

  const startMinutes = timeToMinutes(availability.startTime);
  const availEndMinutes = timeToMinutes(availability.endTime);

  if (appointmentMinutes < startMinutes || endMinutes > availEndMinutes) {
    return { 
      available: false, 
      reason: `Horario fuera del rango de atención (${availability.startTime} - ${availability.endTime})` 
    };
  }

  const dateStart = new Date(scheduledAt);
  dateStart.setHours(0, 0, 0, 0);
  const dateEnd = new Date(dateStart);
  dateEnd.setDate(dateEnd.getDate() + 1);

  const blockedSlot = await prisma.businessAvailability.findFirst({
    where: {
      businessId,
      isBlocked: true,
      blockDate: {
        gte: dateStart,
        lt: dateEnd
      }
    }
  });

  if (blockedSlot) {
    return { available: false, reason: blockedSlot.blockReason || 'Fecha bloqueada' };
  }

  const appointmentEnd = new Date(scheduledAt.getTime() + durationMinutes * 60000);

  const potentialConflicts = await prisma.appointment.findMany({
    where: {
      businessId,
      status: { in: ['PENDING', 'CONFIRMED'] },
      id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
      scheduledAt: {
        gte: new Date(scheduledAt.getTime() - 24 * 60 * 60000),
        lt: new Date(scheduledAt.getTime() + 24 * 60 * 60000)
      }
    },
    orderBy: { scheduledAt: 'asc' }
  });

  for (const existing of potentialConflicts) {
    const existingEnd = new Date(existing.scheduledAt.getTime() + existing.durationMinutes * 60000);
    if (scheduledAt < existingEnd && appointmentEnd > existing.scheduledAt) {
      const conflictTime = existing.scheduledAt.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
      return { available: false, reason: `Ya existe una cita a las ${conflictTime}` };
    }
  }

  return { available: true };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { status, from, to, contactPhone } = req.query;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const where: any = { businessId: business.id };

    if (status) {
      where.status = status;
    }

    if (from || to) {
      where.scheduledAt = {};
      if (from) where.scheduledAt.gte = new Date(from as string);
      if (to) where.scheduledAt.lte = new Date(to as string);
    }

    if (contactPhone) {
      where.contactPhone = { contains: contactPhone as string };
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: { scheduledAt: 'asc' }
    });

    res.json(appointments);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error listing:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { month, year } = req.query;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const targetMonth = month ? parseInt(month as string) : new Date().getMonth();
    const targetYear = year ? parseInt(year as string) : new Date().getFullYear();

    const startDate = new Date(targetYear, targetMonth, 1);
    const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

    const appointments = await prisma.appointment.findMany({
      where: {
        businessId: business.id,
        scheduledAt: {
          gte: startDate,
          lte: endDate
        },
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] }
      },
      orderBy: { scheduledAt: 'asc' }
    });

    const availability = await prisma.businessAvailability.findMany({
      where: { businessId: business.id }
    });

    res.json({
      appointments,
      availability,
      month: targetMonth,
      year: targetYear
    });
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error getting calendar:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/check-availability', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { date, duration } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Fecha requerida' });
    }

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const scheduledAt = new Date(date as string);
    const durationMinutes = duration ? parseInt(duration as string) : 60;

    const result = await checkAvailability(business.id, scheduledAt, durationMinutes);

    res.json(result);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error checking availability:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const appointment = await prisma.appointment.findFirst({
      where: { id, businessId: business.id }
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error getting:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { contactPhone, contactName, scheduledAt, durationMinutes, service, notes } = req.body;

    if (!contactPhone || !scheduledAt) {
      return res.status(400).json({ error: 'contactPhone y scheduledAt son requeridos' });
    }

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const scheduledDate = new Date(scheduledAt);
    const duration = durationMinutes || 60;

    const availabilityCheck = await checkAvailability(business.id, scheduledDate, duration);
    if (!availabilityCheck.available) {
      return res.status(400).json({ error: availabilityCheck.reason });
    }

    const appointment = await prisma.appointment.create({
      data: {
        businessId: business.id,
        contactPhone: contactPhone.replace(/\D/g, ''),
        contactName,
        scheduledAt: scheduledDate,
        durationMinutes: duration,
        service,
        notes,
        createdBy: 'dashboard'
      }
    });

    const appointmentConfig = business.appointmentConfig as any;
    const reminderMinutes = appointmentConfig?.reminderMinutesBefore || 60;
    
    await scheduleAppointmentReminder(
      business.id,
      appointment.id,
      appointment.contactPhone,
      appointment.contactName,
      scheduledDate,
      reminderMinutes
    );

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error creating:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const { scheduledAt, durationMinutes, service, notes, contactName } = req.body;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const existing = await prisma.appointment.findFirst({
      where: { id, businessId: business.id }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    if (scheduledAt) {
      const scheduledDate = new Date(scheduledAt);
      const duration = durationMinutes || existing.durationMinutes;
      
      const availabilityCheck = await checkAvailability(business.id, scheduledDate, duration, id);
      if (!availabilityCheck.available) {
        return res.status(400).json({ error: availabilityCheck.reason });
      }
    }

    const appointment = await prisma.appointment.update({
      where: { id },
      data: {
        scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
        durationMinutes,
        service,
        notes,
        contactName
      }
    });

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error updating:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const appointment = await prisma.appointment.update({
      where: { id, businessId: business.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date()
      }
    });

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error confirming:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/complete', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const appointment = await prisma.appointment.update({
      where: { id, businessId: business.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date()
      }
    });

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error completing:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const { reason } = req.body;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const appointment = await prisma.appointment.update({
      where: { id, businessId: business.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason
      }
    });

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error cancelling:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/no-show', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const appointment = await prisma.appointment.update({
      where: { id, businessId: business.id },
      data: {
        status: 'NO_SHOW'
      }
    });

    res.json(appointment);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error marking no-show:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await prisma.appointment.delete({
      where: { id, businessId: business.id }
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error deleting:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/availability/config', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const availability = await prisma.businessAvailability.findMany({
      where: { businessId: business.id, isBlocked: false },
      orderBy: { dayOfWeek: 'asc' }
    });

    res.json(availability);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error getting availability config:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/availability/config', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { schedule } = req.body;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await prisma.businessAvailability.deleteMany({
      where: { businessId: business.id, isBlocked: false }
    });

    if (schedule && Array.isArray(schedule)) {
      for (const slot of schedule) {
        await prisma.businessAvailability.create({
          data: {
            businessId: business.id,
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            endTime: slot.endTime,
            isBlocked: false
          }
        });
      }
    }

    const availability = await prisma.businessAvailability.findMany({
      where: { businessId: business.id, isBlocked: false },
      orderBy: { dayOfWeek: 'asc' }
    });

    res.json(availability);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error saving availability config:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/availability/block', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { date, reason } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Fecha requerida' });
    }

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const blockDate = new Date(date);

    const block = await prisma.businessAvailability.create({
      data: {
        businessId: business.id,
        dayOfWeek: blockDate.getDay(),
        startTime: '00:00',
        endTime: '23:59',
        isBlocked: true,
        blockDate,
        blockReason: reason
      }
    });

    res.json(block);
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error blocking date:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/availability/block/:id', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const business = await prisma.business.findFirst({
      where: { userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await prisma.businessAvailability.delete({
      where: { id, businessId: business.id, isBlocked: true }
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[APPOINTMENTS] Error unblocking date:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/internal/schedule', async (req, res) => {
  try {
    const internalSecret = req.headers['x-internal-secret'];
    
    if (internalSecret !== INTERNAL_AGENT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { businessId, contactPhone, contactName, scheduledAt, durationMinutes, service, notes } = req.body;

    if (!businessId || !contactPhone || !scheduledAt) {
      return res.status(400).json({ error: 'businessId, contactPhone y scheduledAt son requeridos' });
    }

    const scheduledDate = new Date(scheduledAt);
    const duration = durationMinutes || 60;

    const availabilityCheck = await checkAvailability(businessId, scheduledDate, duration);
    if (!availabilityCheck.available) {
      return res.json({ 
        success: false, 
        error: availabilityCheck.reason 
      });
    }

    const appointment = await prisma.appointment.create({
      data: {
        businessId,
        contactPhone: contactPhone.replace(/\D/g, ''),
        contactName,
        scheduledAt: scheduledDate,
        durationMinutes: duration,
        service,
        notes,
        createdBy: 'agent'
      }
    });

    console.log(`[APPOINTMENTS INTERNAL] Created appointment ${appointment.id} for ${contactPhone}`);

    const business = await prisma.business.findUnique({ where: { id: businessId } });
    const appointmentConfig = (business?.appointmentConfig as any) || {};
    const reminderMinutes = appointmentConfig?.reminderMinutesBefore || 60;
    
    await scheduleAppointmentReminder(
      businessId,
      appointment.id,
      appointment.contactPhone,
      appointment.contactName,
      scheduledDate,
      reminderMinutes
    );

    res.json({
      success: true,
      appointment
    });
  } catch (error: any) {
    console.error('[APPOINTMENTS INTERNAL] Error scheduling:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/internal/availability', async (req, res) => {
  try {
    const internalSecret = req.headers['x-internal-secret'];
    
    if (internalSecret !== INTERNAL_AGENT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { businessId, date } = req.query;

    if (!businessId || !date) {
      return res.status(400).json({ error: 'businessId y date son requeridos' });
    }

    const targetDate = new Date(date as string);
    const dayOfWeek = targetDate.getDay();

    const availability = await prisma.businessAvailability.findFirst({
      where: {
        businessId: businessId as string,
        dayOfWeek,
        isBlocked: false
      }
    });

    if (!availability) {
      return res.json({ 
        available: false, 
        slots: [],
        reason: 'No hay horario configurado para este día'
      });
    }

    const dateStart = new Date(targetDate);
    dateStart.setHours(0, 0, 0, 0);
    const dateEnd = new Date(dateStart);
    dateEnd.setDate(dateEnd.getDate() + 1);

    const blocked = await prisma.businessAvailability.findFirst({
      where: {
        businessId: businessId as string,
        isBlocked: true,
        blockDate: {
          gte: dateStart,
          lt: dateEnd
        }
      }
    });

    if (blocked) {
      return res.json({
        available: false,
        slots: [],
        reason: blocked.blockReason || 'Fecha bloqueada'
      });
    }

    const existingAppointments = await prisma.appointment.findMany({
      where: {
        businessId: businessId as string,
        status: { in: ['PENDING', 'CONFIRMED'] },
        scheduledAt: {
          gte: dateStart,
          lt: dateEnd
        }
      },
      orderBy: { scheduledAt: 'asc' }
    });

    const slots: { time: string; available: boolean }[] = [];
    const startMinutes = timeToMinutes(availability.startTime);
    const endMinutes = timeToMinutes(availability.endTime);
    const slotDuration = 60;

    for (let minutes = startMinutes; minutes < endMinutes; minutes += slotDuration) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      
      const slotStart = new Date(targetDate);
      slotStart.setHours(hours, mins, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + slotDuration * 60000);

      const isOccupied = existingAppointments.some(apt => {
        const aptEnd = new Date(apt.scheduledAt.getTime() + apt.durationMinutes * 60000);
        return slotStart < aptEnd && slotEnd > apt.scheduledAt;
      });

      slots.push({ time: timeStr, available: !isOccupied });
    }

    res.json({
      available: true,
      businessHours: {
        start: availability.startTime,
        end: availability.endTime
      },
      slots,
      existingAppointments: existingAppointments.map(a => ({
        time: a.scheduledAt.toTimeString().slice(0, 5),
        duration: a.durationMinutes,
        service: a.service
      }))
    });
  } catch (error: any) {
    console.error('[APPOINTMENTS INTERNAL] Error checking availability:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
