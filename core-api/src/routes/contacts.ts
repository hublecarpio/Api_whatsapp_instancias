import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { search, page = '1', limit = '50', businessId, archived, tag } = req.query;

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

    const whereClause: any = { 
      businessId: business.id
    };
    
    if (archived === 'true') {
      whereClause.isArchived = true;
    } else if (archived === 'false') {
      whereClause.isArchived = false;
    }
    
    if (search) {
      whereClause.OR = [
        { phone: { contains: search as string } },
        { name: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    if (tag) {
      whereClause.tags = { has: tag as string };
    }

    const contacts = await prisma.contact.findMany({
      where: whereClause,
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: limitNum
    });

    const phoneNumbers = contacts.map((c: any) => c.phone);
    
    const [extractedData, orders] = await Promise.all([
      prisma.contactExtractedData.findMany({
        where: { businessId: business.id, contactPhone: { in: phoneNumbers } }
      }),
      prisma.order.findMany({
        where: { businessId: business.id, contactPhone: { in: phoneNumbers } },
        select: { id: true, contactPhone: true, status: true, totalAmount: true, createdAt: true }
      })
    ]);

    const enrichedContacts = contacts.map((contact: any) => {
      const contactOrders = orders.filter((o: any) => o.contactPhone === contact.phone);
      const contactExtracted = extractedData.filter((e: any) => e.contactPhone === contact.phone);

      return {
        id: contact.id,
        phone: contact.phone,
        name: contact.name,
        email: contact.email,
        tags: contact.tags,
        notes: contact.notes,
        source: contact.source,
        botDisabled: contact.botDisabled,
        isArchived: contact.isArchived,
        firstMessageAt: contact.firstMessageAt,
        lastMessageAt: contact.lastMessageAt,
        messageCount: contact.messageCount,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
        stats: {
          ordersCount: contactOrders.length,
          totalSpent: contactOrders.reduce((sum: number, o: any) => sum + o.totalAmount, 0)
        },
        extractedData: contactExtracted.reduce((acc: any, e: any) => {
          acc[e.fieldKey] = e.fieldValue;
          return acc;
        }, {} as Record<string, string | null>)
      };
    });

    const total = await prisma.contact.count({ where: whereClause });

    res.json({
      contacts: enrichedContacts,
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

router.get('/tags', async (req: AuthRequest, res: Response) => {
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

    const contacts = await prisma.contact.findMany({
      where: { businessId: business.id },
      select: { tags: true }
    });

    const tagCounts: Record<string, number> = {};
    contacts.forEach((c: any) => {
      c.tags.forEach((tag: string) => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });

    const tags = Object.entries(tagCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ tags });
  } catch (error: any) {
    console.error('[CONTACTS] Error getting tags:', error);
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

    const contacts = await prisma.contact.findMany({
      where: { businessId: business.id, isArchived: false },
      orderBy: { lastMessageAt: 'desc' }
    });

    const phoneNumbers = contacts.map((c: any) => c.phone);

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

    const headers = ['Telefono', 'Nombre', 'Email', 'Tags', 'Mensajes', 'Total Pedidos', 'Total Gastado', 'Bot Desactivado', 'Notas', 'Primer Mensaje', 'Ultimo Mensaje', ...allFields];
    
    const rows = contacts.map((contact: any) => {
      const contactOrders = orders.filter((o: any) => o.contactPhone === contact.phone);
      const contactExtracted = extractedData.filter((e: any) => e.contactPhone === contact.phone);
      
      const extractedValues = allFields.map((field: string) => {
        const data = contactExtracted.find((e: any) => e.fieldKey === field);
        return data?.fieldValue || '';
      });

      return [
        contact.phone,
        contact.name || '',
        contact.email || '',
        (contact.tags || []).join('; '),
        contact.messageCount.toString(),
        contactOrders.length.toString(),
        contactOrders.reduce((sum: number, o: any) => sum + o.totalAmount, 0).toFixed(2),
        contact.botDisabled ? 'Si' : 'No',
        (contact.notes || '').replace(/"/g, '""'),
        new Date(contact.firstMessageAt).toISOString(),
        new Date(contact.lastMessageAt).toISOString(),
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

// IMPORTANT: This route MUST be before any /:phone routes to avoid parameter matching issues
router.post('/refresh', async (req: AuthRequest, res: Response) => {
  console.log('[CONTACTS REFRESH] Endpoint hit - request received');
  try {
    const userId = req.userId;
    const { businessId } = req.body;

    console.log(`[CONTACTS REFRESH] Starting refresh for businessId=${businessId}, userId=${userId}`);

    if (!businessId) {
      console.log('[CONTACTS REFRESH] Error: businessId not provided');
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      console.log(`[CONTACTS REFRESH] Business not found for id=${businessId}, userId=${userId}`);
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    console.log(`[CONTACTS REFRESH] Found business: ${business.name} (${business.id})`);

    const phoneStats: Record<string, {
      firstMessageAt: Date;
      lastMessageAt: Date;
      messageCount: number;
      name: string | null;
    }> = {};

    const BATCH_SIZE = 10000;
    let cursor: string | undefined;
    let totalMessages = 0;
    let batchNumber = 0;

    while (true) {
      const messages = await prisma.messageLog.findMany({
        where: { businessId: business.id },
        select: {
          id: true,
          sender: true,
          recipient: true,
          direction: true,
          createdAt: true,
          metadata: true
        },
        take: BATCH_SIZE,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
        orderBy: { id: 'asc' }
      });

      if (messages.length === 0) break;

      batchNumber++;
      totalMessages += messages.length;
      cursor = messages[messages.length - 1].id;

      for (const msg of messages) {
        const phone = msg.direction === 'inbound' ? msg.sender : msg.recipient;
        if (!phone || phone === business.id) continue;

        const cleanPhone = phone.replace('@s.whatsapp.net', '').replace('@c.us', '');

        if (!phoneStats[cleanPhone]) {
          phoneStats[cleanPhone] = {
            firstMessageAt: msg.createdAt,
            lastMessageAt: msg.createdAt,
            messageCount: 0,
            name: null
          };
        }

        phoneStats[cleanPhone].messageCount++;
        if (msg.createdAt < phoneStats[cleanPhone].firstMessageAt) {
          phoneStats[cleanPhone].firstMessageAt = msg.createdAt;
        }
        if (msg.createdAt > phoneStats[cleanPhone].lastMessageAt) {
          phoneStats[cleanPhone].lastMessageAt = msg.createdAt;
        }

        if (msg.direction === 'inbound' && msg.metadata) {
          const meta = msg.metadata as any;
          if (meta.pushName && !phoneStats[cleanPhone].name) {
            phoneStats[cleanPhone].name = meta.pushName;
          }
        }
      }

      console.log(`[CONTACTS REFRESH] Processed batch ${batchNumber}: ${messages.length} messages (total: ${totalMessages})`);

      if (messages.length < BATCH_SIZE) break;
    }

    console.log(`[CONTACTS REFRESH] Completed processing ${totalMessages} messages in ${batchNumber} batches for business ${business.id}`);

    const phoneEntries = Object.entries(phoneStats);
    const phonesToCheck = phoneEntries.map(([phone]) => phone);
    
    const existingContacts = await prisma.contact.findMany({
      where: { 
        businessId: business.id, 
        phone: { in: phonesToCheck } 
      },
      select: { phone: true, firstMessageAt: true, lastMessageAt: true, messageCount: true, name: true }
    });
    
    const existingMap = new Map(existingContacts.map(c => [c.phone, c]));
    
    let created = 0;
    let updated = 0;
    
    const upsertPromises = phoneEntries.map(async ([phone, stats]) => {
      const existing = existingMap.get(phone);
      
      if (existing) {
        const updates: any = {};
        if (!existing.firstMessageAt || stats.firstMessageAt < existing.firstMessageAt) {
          updates.firstMessageAt = stats.firstMessageAt;
        }
        if (!existing.lastMessageAt || stats.lastMessageAt > existing.lastMessageAt) {
          updates.lastMessageAt = stats.lastMessageAt;
        }
        if (stats.messageCount > (existing.messageCount || 0)) {
          updates.messageCount = stats.messageCount;
        }
        if (!existing.name && stats.name) {
          updates.name = stats.name;
        }

        if (Object.keys(updates).length > 0) {
          await prisma.contact.update({
            where: { businessId_phone: { businessId: business.id, phone } },
            data: updates
          });
          return 'updated';
        }
        return 'unchanged';
      } else {
        await prisma.contact.create({
          data: {
            businessId: business.id,
            phone,
            name: stats.name,
            firstMessageAt: stats.firstMessageAt,
            lastMessageAt: stats.lastMessageAt,
            messageCount: stats.messageCount,
            source: 'SYNC',
            tags: [],
            isArchived: false,
            botDisabled: false
          }
        });
        return 'created';
      }
    });
    
    const results = await Promise.all(upsertPromises);
    created = results.filter(r => r === 'created').length;
    updated = results.filter(r => r === 'updated').length;

    console.log(`[CONTACTS REFRESH] Completed for business ${business.id}: created=${created}, updated=${updated}`);
    res.json({ success: true, created, updated, total: Object.keys(phoneStats).length });
  } catch (error: any) {
    console.error('[CONTACTS REFRESH] Error:', error);
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

    const contact = await prisma.contact.findUnique({
      where: { businessId_phone: { businessId: business.id, phone } }
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    const [extractedData, orders, appointments, messageCount] = await Promise.all([
      prisma.contactExtractedData.findMany({
        where: { businessId: business.id, contactPhone: phone }
      }),
      prisma.order.findMany({
        where: { businessId: business.id, contactPhone: phone },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: 20
      }),
      prisma.appointment.findMany({
        where: { businessId: business.id, contactPhone: phone },
        orderBy: { scheduledAt: 'desc' },
        take: 20
      }),
      prisma.messageLog.count({
        where: { 
          businessId: business.id,
          OR: [
            { sender: phone },
            { recipient: phone }
          ]
        }
      })
    ]);

    const instancesUsed = await prisma.whatsAppInstance.findMany({
      where: { businessId: business.id },
      select: { id: true, name: true, provider: true }
    });

    const timeline = [
      ...orders.slice(0, 10).map((o: any) => ({
        type: 'order' as const,
        id: o.id,
        date: o.createdAt,
        data: { status: o.status, amount: o.totalAmount }
      })),
      ...appointments.slice(0, 10).map((a: any) => ({
        type: 'appointment' as const,
        id: a.id,
        date: a.createdAt,
        data: { status: a.status, scheduledAt: a.scheduledAt, service: a.service }
      })),
      { type: 'created' as const, id: contact.id, date: contact.createdAt, data: {} }
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const stats = {
      ordersCount: orders.length,
      totalSpent: orders.reduce((sum: number, o: any) => sum + (o.totalAmount || 0), 0),
      messagesCount: messageCount,
      lastMessageAt: contact.lastMessageAt?.toISOString() || null
    };

    res.json({
      id: contact.id,
      phone: contact.phone,
      name: contact.name,
      email: contact.email,
      tags: contact.tags,
      notes: contact.notes,
      source: contact.source,
      botDisabled: contact.botDisabled,
      isArchived: contact.isArchived,
      firstMessageAt: contact.firstMessageAt,
      lastMessageAt: contact.lastMessageAt,
      messageCount: contact.messageCount,
      metadata: contact.metadata,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      stats,
      instancesUsed,
      extractedData: extractedData.reduce((acc: any, e: any) => {
        acc[e.fieldKey] = e.fieldValue;
        return acc;
      }, {} as Record<string, string | null>),
      orders: orders.slice(0, 10),
      appointments: appointments.slice(0, 10),
      timeline: timeline.slice(0, 15)
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
    const { name, email, notes, botDisabled, tags, isArchived, businessId, extractedData } = req.body;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const existing = await prisma.contact.findUnique({
      where: { businessId_phone: { businessId: business.id, phone } }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(email !== undefined && { email }),
        ...(notes !== undefined && { notes }),
        ...(botDisabled !== undefined && { botDisabled }),
        ...(tags !== undefined && { tags }),
        ...(isArchived !== undefined && { isArchived })
      }
    });

    if (extractedData && typeof extractedData === 'object') {
      const existingData = await prisma.contactExtractedData.findMany({
        where: { businessId: business.id, contactPhone: phone }
      });
      const existingKeys = existingData.map(d => d.fieldKey);
      const newKeys = Object.keys(extractedData);
      
      const keysToDelete = existingKeys.filter(k => !newKeys.includes(k));
      if (keysToDelete.length > 0) {
        await prisma.contactExtractedData.deleteMany({
          where: { businessId: business.id, contactPhone: phone, fieldKey: { in: keysToDelete } }
        });
      }
      
      for (const [key, value] of Object.entries(extractedData)) {
        if (key.trim()) {
          await prisma.contactExtractedData.upsert({
            where: { businessId_contactPhone_fieldKey: { businessId: business.id, contactPhone: phone, fieldKey: key } },
            create: { businessId: business.id, contactPhone: phone, fieldKey: key, fieldValue: String(value || '') },
            update: { fieldValue: String(value || '') }
          });
        }
      }
    }

    const updatedExtractedData = await prisma.contactExtractedData.findMany({
      where: { businessId: business.id, contactPhone: phone }
    });
    const extractedDataMap: Record<string, string> = {};
    updatedExtractedData.forEach(d => {
      extractedDataMap[d.fieldKey] = d.fieldValue || '';
    });

    res.json({ ...contact, extractedData: extractedDataMap });
  } catch (error: any) {
    console.error('[CONTACTS] Error updating contact:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:phone/tags', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { phone } = req.params;
    const { tag, businessId } = req.body;

    if (!businessId || !tag) {
      return res.status(400).json({ error: 'businessId y tag son requeridos' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const existing = await prisma.contact.findUnique({
      where: { businessId_phone: { businessId: business.id, phone } }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    const currentTags = existing.tags || [];
    if (!currentTags.includes(tag)) {
      currentTags.push(tag);
    }

    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { tags: currentTags }
    });

    res.json(contact);
  } catch (error: any) {
    console.error('[CONTACTS] Error adding tag:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:phone/tags/:tag', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { phone, tag } = req.params;
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

    const existing = await prisma.contact.findUnique({
      where: { businessId_phone: { businessId: business.id, phone } }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    const currentTags = (existing.tags || []).filter((t: string) => t !== tag);

    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { tags: currentTags }
    });

    res.json(contact);
  } catch (error: any) {
    console.error('[CONTACTS] Error removing tag:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:phone/archive', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { phone } = req.params;
    const { businessId } = req.body;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const contact = await prisma.contact.update({
      where: { businessId_phone: { businessId: business.id, phone } },
      data: { isArchived: true }
    });

    res.json(contact);
  } catch (error: any) {
    console.error('[CONTACTS] Error archiving contact:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:phone/unarchive', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const { phone } = req.params;
    const { businessId } = req.body;

    if (!businessId) {
      return res.status(400).json({ error: 'businessId es requerido' });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId as string, userId }
    });

    if (!business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const contact = await prisma.contact.update({
      where: { businessId_phone: { businessId: business.id, phone } },
      data: { isArchived: false }
    });

    res.json(contact);
  } catch (error: any) {
    console.error('[CONTACTS] Error unarchiving contact:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
