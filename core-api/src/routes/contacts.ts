import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { search, page = '1', limit = '50', businessId } = req.query;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const whereClause: any = { businessId: business.id };
    if (search) {
      whereClause.OR = [
        { contactPhone: { contains: search as string } },
        { contactName: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    const contactSettings = await prisma.contactSettings.findMany({
      where: whereClause,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limitNum
    });

    const phoneNumbers = contactSettings.map((c: any) => c.contactPhone);
    
    const [extractedData, orders, messages] = await Promise.all([
      prisma.contactExtractedData.findMany({
        where: { businessId: business.id, contactPhone: { in: phoneNumbers } }
      }),
      prisma.order.findMany({
        where: { businessId: business.id, contactPhone: { in: phoneNumbers } },
        select: { id: true, contactPhone: true, status: true, totalAmount: true, createdAt: true }
      }),
      prisma.$queryRaw`
        SELECT "contactPhone", COUNT(*)::int as count, MAX("createdAt") as "lastMessageAt"
        FROM "Message"
        WHERE "businessId" = ${business.id} AND "contactPhone" = ANY(${phoneNumbers})
        GROUP BY "contactPhone"
      ` as Promise<any[]>
    ]);

    const instances = await prisma.whatsAppInstance.findMany({
      where: { businessId: business.id },
      select: { id: true, name: true, provider: true }
    });
    const instanceMap = new Map(instances.map((i: any) => [i.id, i]));

    const contacts = contactSettings.map((contact: any) => {
      const contactOrders = orders.filter((o: any) => o.contactPhone === contact.contactPhone);
      const contactExtracted = extractedData.filter((e: any) => e.contactPhone === contact.contactPhone);
      const msgStats = messages.find((m: any) => m.contactPhone === contact.contactPhone);
      const instance = contact.instanceId ? instanceMap.get(contact.instanceId) : null;

      return {
        id: contact.id,
        phone: contact.contactPhone,
        name: contact.contactName,
        botDisabled: contact.botDisabled,
        notes: contact.notes,
        archivedAt: contact.archivedAt,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
        instance: instance ? { id: instance.id, name: instance.name, provider: instance.provider } : null,
        stats: {
          ordersCount: contactOrders.length,
          totalSpent: contactOrders.reduce((sum: number, o: any) => sum + o.totalAmount, 0),
          messagesCount: msgStats?.count || 0,
          lastMessageAt: msgStats?.lastMessageAt || null
        },
        extractedData: contactExtracted.reduce((acc: any, e: any) => {
          acc[e.fieldKey] = e.fieldValue;
          return acc;
        }, {} as Record<string, string | null>)
      };
    });

    const total = await prisma.contactSettings.count({ where: whereClause });

    res.json({
      contacts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error: any) {
    console.error('[CONTACTS] Error listing contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/export/csv', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { businessId } = req.query;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const contactSettings = await prisma.contactSettings.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: 'desc' }
    });

    const phoneNumbers = contactSettings.map((c: any) => c.contactPhone);

    const [extractedData, orders] = await Promise.all([
      prisma.contactExtractedData.findMany({
        where: { businessId: business.id, contactPhone: { in: phoneNumbers } }
      }),
      prisma.order.findMany({
        where: { businessId: business.id, contactPhone: { in: phoneNumbers } },
        select: { contactPhone: true, totalAmount: true }
      })
    ]);

    const allFields = [...new Set(extractedData.map((e: any) => e.fieldKey))];

    const headers = ['Telefono', 'Nombre', 'Total Pedidos', 'Total Gastado', 'Bot Desactivado', 'Notas', 'Creado', 'Actualizado', ...allFields];
    
    const rows = contactSettings.map((contact: any) => {
      const contactOrders = orders.filter((o: any) => o.contactPhone === contact.contactPhone);
      const contactExtracted = extractedData.filter((e: any) => e.contactPhone === contact.contactPhone);
      
      const extractedValues = allFields.map((field: string) => {
        const data = contactExtracted.find((e: any) => e.fieldKey === field);
        return data?.fieldValue || '';
      });

      return [
        contact.contactPhone,
        contact.contactName || '',
        contactOrders.length.toString(),
        contactOrders.reduce((sum: number, o: any) => sum + o.totalAmount, 0).toFixed(2),
        contact.botDisabled ? 'Si' : 'No',
        (contact.notes || '').replace(/"/g, '""'),
        new Date(contact.createdAt).toISOString(),
        new Date(contact.updatedAt).toISOString(),
        ...extractedValues.map((v: string) => (v || '').replace(/"/g, '""'))
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map((row: string[]) => row.map((cell: string) => `"${cell}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=contactos_${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csvContent);
  } catch (error: any) {
    console.error('[CONTACTS] Error exporting CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:phone', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { phone } = req.params;
    const { businessId } = req.query;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const contact = await prisma.contactSettings.findFirst({
      where: { businessId: business.id, contactPhone: phone }
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    const [extractedData, orders, appointments, messages, instances] = await Promise.all([
      prisma.contactExtractedData.findMany({
        where: { businessId: business.id, contactPhone: phone }
      }),
      prisma.order.findMany({
        where: { businessId: business.id, contactPhone: phone },
        include: { items: true },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.appointment.findMany({
        where: { businessId: business.id, contactPhone: phone },
        orderBy: { scheduledAt: 'desc' }
      }),
      prisma.$queryRaw`
        SELECT * FROM "Message"
        WHERE "businessId" = ${business.id} AND "contactPhone" = ${phone}
        ORDER BY "createdAt" DESC
        LIMIT 100
      ` as Promise<any[]>,
      prisma.whatsAppInstance.findMany({
        where: { businessId: business.id },
        select: { id: true, name: true, provider: true }
      })
    ]);

    const instanceMap = new Map(instances.map((i: any) => [i.id, i]));
    const instancesUsed = [...new Set(messages.map((m: any) => m.instanceId).filter(Boolean))];
    const usedInstances = instancesUsed.map((id: string) => instanceMap.get(id)).filter(Boolean);

    const timeline = [
      ...orders.map((o: any) => ({
        type: 'order' as const,
        id: o.id,
        date: o.createdAt,
        data: { status: o.status, amount: o.totalAmount }
      })),
      ...appointments.map((a: any) => ({
        type: 'appointment' as const,
        id: a.id,
        date: a.createdAt,
        data: { status: a.status, scheduledAt: a.scheduledAt, service: a.service }
      })),
      { type: 'created' as const, id: contact.id, date: contact.createdAt, data: {} }
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({
      id: contact.id,
      phone: contact.contactPhone,
      name: contact.contactName,
      botDisabled: contact.botDisabled,
      notes: contact.notes,
      archivedAt: contact.archivedAt,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      extractedData: extractedData.reduce((acc: any, e: any) => {
        acc[e.fieldKey] = e.fieldValue;
        return acc;
      }, {} as Record<string, string | null>),
      orders,
      appointments,
      messages: messages.slice(0, 50),
      instancesUsed: usedInstances,
      timeline
    });
  } catch (error: any) {
    console.error('[CONTACTS] Error getting contact:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:phone', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { phone } = req.params;
    const { contactName, notes, botDisabled, businessId } = req.body;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const existing = await prisma.contactSettings.findFirst({
      where: { businessId: business.id, contactPhone: phone }
    });

    let contact;
    if (existing) {
      contact = await prisma.contactSettings.update({
        where: { id: existing.id },
        data: {
          ...(contactName !== undefined && { contactName }),
          ...(notes !== undefined && { notes }),
          ...(botDisabled !== undefined && { botDisabled })
        }
      });
    } else {
      contact = await prisma.contactSettings.create({
        data: {
          businessId: business.id,
          contactPhone: phone,
          contactName,
          notes,
          botDisabled: botDisabled || false
        }
      });
    }

    res.json(contact);
  } catch (error: any) {
    console.error('[CONTACTS] Error updating contact:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
