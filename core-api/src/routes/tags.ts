import { Router, Response } from 'express';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import prisma from '../services/prisma';
import { isOpenAIConfigured, getOpenAIClient, getDefaultModel, logTokenUsage } from '../services/openaiService.js';

const router = Router();

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

const DEFAULT_TAGS = [
  { name: 'Nuevo', color: '#22C55E', description: 'Cliente que acaba de contactar por primera vez', order: 0 },
  { name: 'Interesado', color: '#3B82F6', description: 'Cliente que mostró interés en productos o servicios', order: 1 },
  { name: 'Negociando', color: '#EAB308', description: 'Cliente en proceso de cotización o negociación', order: 2 },
  { name: 'Pendiente', color: '#F97316', description: 'Esperando respuesta o acción del cliente', order: 3 },
  { name: 'Cerrado', color: '#10B981', description: 'Venta completada exitosamente', order: 4 },
  { name: 'Perdido', color: '#6B7280', description: 'Cliente que no concretó la compra', order: 5 },
];

router.get('/', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }

    const user = await getUserWithRole(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const tags = await prisma.tag.findMany({
      where: { businessId: business_id as string },
      include: {
        stagePrompt: true,
        _count: {
          select: { assignments: true }
        }
      },
      orderBy: { order: 'asc' }
    });

    res.json(tags);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, name, color, description, order } = req.body;

    if (!business_id || !name) {
      res.status(400).json({ error: 'business_id and name are required' });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const maxOrder = await prisma.tag.aggregate({
      where: { businessId: business_id },
      _max: { order: true }
    });

    const tag = await prisma.tag.create({
      data: {
        businessId: business_id,
        name,
        color: color || '#6B7280',
        description: description || '',
        order: order ?? (maxOrder._max.order ?? -1) + 1
      }
    });

    res.status(201).json(tag);
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(400).json({ error: 'Tag name already exists for this business' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, color, description, order } = req.body;

    const tag = await prisma.tag.findFirst({
      where: { id },
      include: { business: true }
    });

    if (!tag || tag.business.userId !== req.userId) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const updated = await prisma.tag.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(color && { color }),
        ...(description !== undefined && { description }),
        ...(order !== undefined && { order })
      }
    });

    res.json(updated);
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(400).json({ error: 'Tag name already exists for this business' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const tag = await prisma.tag.findFirst({
      where: { id },
      include: { business: true }
    });

    if (!tag || tag.business.userId !== req.userId) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    await prisma.tag.delete({ where: { id } });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/reorder', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, tag_orders } = req.body;

    if (!business_id || !tag_orders || !Array.isArray(tag_orders)) {
      res.status(400).json({ error: 'business_id and tag_orders array required' });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    await prisma.$transaction(
      tag_orders.map((item: { id: string; order: number }) =>
        prisma.tag.update({
          where: { id: item.id },
          data: { order: item.order }
        })
      )
    );

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/init-defaults', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id } = req.body;

    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const existingTags = await prisma.tag.count({
      where: { businessId: business_id }
    });

    if (existingTags > 0) {
      res.status(400).json({ error: 'Business already has tags' });
      return;
    }

    const tags = await prisma.tag.createMany({
      data: DEFAULT_TAGS.map(tag => ({
        businessId: business_id,
        ...tag,
        isDefault: true
      }))
    });

    const createdTags = await prisma.tag.findMany({
      where: { businessId: business_id },
      orderBy: { order: 'asc' }
    });

    res.status(201).json(createdTags);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/stage-prompt', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { promptOverride, systemContext, toolsOverride } = req.body;

    const tag = await prisma.tag.findFirst({
      where: { id },
      include: { business: true }
    });

    if (!tag || tag.business.userId !== req.userId) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const stagePrompt = await prisma.stagePrompt.upsert({
      where: { tagId: id },
      update: {
        promptOverride,
        systemContext,
        toolsOverride
      },
      create: {
        tagId: id,
        promptOverride,
        systemContext,
        toolsOverride
      }
    });

    res.json(stagePrompt);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/assign', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, contact_phone, tag_id, source } = req.body;

    if (!business_id || !contact_phone || !tag_id) {
      res.status(400).json({ error: 'business_id, contact_phone, and tag_id are required' });
      return;
    }

    const user = await getUserWithRole(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const business = await checkBusinessAccess(req.userId!, business_id, user.role, user.parentUserId);
    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const tag = await prisma.tag.findFirst({
      where: { id: tag_id, businessId: business_id }
    });

    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const existingAssignment = await prisma.tagAssignment.findUnique({
      where: {
        businessId_contactPhone: {
          businessId: business_id,
          contactPhone: contact_phone
        }
      }
    });

    if (existingAssignment) {
      await prisma.tagHistory.updateMany({
        where: {
          businessId: business_id,
          contactPhone: contact_phone,
          removedAt: null
        },
        data: { removedAt: new Date() }
      });
    }

    const assignment = await prisma.tagAssignment.upsert({
      where: {
        businessId_contactPhone: {
          businessId: business_id,
          contactPhone: contact_phone
        }
      },
      update: {
        tagId: tag_id,
        assignedAt: new Date(),
        assignedBy: req.userId,
        source: source || 'manual'
      },
      create: {
        tagId: tag_id,
        businessId: business_id,
        contactPhone: contact_phone,
        assignedBy: req.userId,
        source: source || 'manual'
      }
    });

    await prisma.tagHistory.create({
      data: {
        tagId: tag_id,
        businessId: business_id,
        contactPhone: contact_phone,
        source: source || 'manual'
      }
    });

    res.json(assignment);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/assign', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, contact_phone } = req.body;

    if (!business_id || !contact_phone) {
      res.status(400).json({ error: 'business_id and contact_phone are required' });
      return;
    }

    const user = await getUserWithRole(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const business = await checkBusinessAccess(req.userId!, business_id, user.role, user.parentUserId);
    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    await prisma.tagHistory.updateMany({
      where: {
        businessId: business_id,
        contactPhone: contact_phone,
        removedAt: null
      },
      data: { removedAt: new Date() }
    });

    await prisma.tagAssignment.delete({
      where: {
        businessId_contactPhone: {
          businessId: business_id,
          contactPhone: contact_phone
        }
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

router.get('/assignments', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, tag_id } = req.query;

    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }

    const user = await getUserWithRole(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const where: any = { businessId: business_id };
    if (tag_id) {
      where.tagId = tag_id;
    }

    const assignments = await prisma.tagAssignment.findMany({
      where,
      include: {
        tag: true
      },
      orderBy: { assignedAt: 'desc' }
    });

    res.json(assignments);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history/:contact_phone', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id } = req.query;

    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { id: business_id as string, userId: req.userId }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const history = await prisma.tagHistory.findMany({
      where: {
        businessId: business_id as string,
        contactPhone: contact_phone
      },
      include: {
        tag: true
      },
      orderBy: { assignedAt: 'desc' }
    });

    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/contact/:contact_phone', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id } = req.query;

    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { id: business_id as string, userId: req.userId }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const assignment = await prisma.tagAssignment.findUnique({
      where: {
        businessId_contactPhone: {
          businessId: business_id as string,
          contactPhone: contact_phone
        }
      },
      include: {
        tag: {
          include: {
            stagePrompt: true
          }
        }
      }
    });

    res.json(assignment);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/suggest-stage', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, contact_phone } = req.body;

    if (!business_id || !contact_phone) {
      res.status(400).json({ error: 'business_id and contact_phone are required' });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { id: business_id, userId: req.userId },
      include: { tags: true }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }


    const messages = await prisma.messageLog.findMany({
      where: {
        businessId: business_id,
        OR: [
          { sender: { contains: contact_phone } },
          { recipient: { contains: contact_phone } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    if (messages.length === 0) {
      res.status(400).json({ error: 'No messages found for this contact' });
      return;
    }

    const conversationHistory = messages.reverse().map(m => {
      const role = m.direction === 'inbound' ? 'Cliente' : 'Agente';
      return `${role}: ${m.message || '[media]'}`;
    }).join('\n');

    const tagsDescription = business.tags.map(t => 
      `- ${t.name}: ${t.description || 'Sin descripción'}`
    ).join('\n');

    const prompt = `Analiza la siguiente conversación y determina en qué etapa del proceso de venta se encuentra el cliente.

Etapas disponibles:
${tagsDescription}

Conversación:
${conversationHistory}

Responde SOLO con el nombre exacto de la etapa que mejor describe la situación actual del cliente. No agregues explicaciones.`;

    if (!isOpenAIConfigured()) {
      res.status(400).json({ error: 'OpenAI not configured. Contact administrator.' });
      return;
    }

    const openai = getOpenAIClient();
    const modelToUse = getDefaultModel();
    
    const openaiResponse = await openai.chat.completions.create({
      model: modelToUse,
      messages: [
        { role: 'system', content: 'Eres un asistente que clasifica clientes en etapas de venta.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 50
    });

    if (openaiResponse.usage) {
      await logTokenUsage({
        businessId: business_id,
        feature: 'stage_suggestion',
        model: modelToUse,
        promptTokens: openaiResponse.usage.prompt_tokens,
        completionTokens: openaiResponse.usage.completion_tokens,
        totalTokens: openaiResponse.usage.total_tokens
      });
    }

    const suggestedStageName = openaiResponse.choices[0]?.message?.content?.trim();
    
    const matchedTag = business.tags.find(t => 
      t.name.toLowerCase() === suggestedStageName?.toLowerCase()
    );

    if (matchedTag) {
      res.json({
        success: true,
        suggestedTag: matchedTag,
        confidence: 'high'
      });
    } else {
      const closestTag = business.tags.find(t =>
        suggestedStageName?.toLowerCase().includes(t.name.toLowerCase()) ||
        t.name.toLowerCase().includes(suggestedStageName?.toLowerCase() || '')
      );
      
      res.json({
        success: true,
        suggestedTag: closestTag || business.tags[0],
        suggestedName: suggestedStageName,
        confidence: closestTag ? 'medium' : 'low'
      });
    }
  } catch (error: any) {
    console.error('Stage suggestion error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/contact/:contact_phone/bot-status', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id } = req.query;
    
    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }
    
    const cleanPhone = contact_phone.replace(/\D/g, '').replace(/:.*$/, '');
    
    const settings = await prisma.contactSettings.findFirst({
      where: {
        businessId: business_id as string,
        contactPhone: cleanPhone
      }
    });
    
    res.json({
      botDisabled: settings?.botDisabled || false,
      notes: settings?.notes || null
    });
  } catch (error: any) {
    console.error('Get contact bot status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/contact/:contact_phone/bot-toggle', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id, botDisabled } = req.body;
    
    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }
    
    if (typeof botDisabled !== 'boolean') {
      res.status(400).json({ error: 'botDisabled must be a boolean' });
      return;
    }
    
    const cleanPhone = contact_phone.replace(/\D/g, '').replace(/:.*$/, '');
    
    let settings = await prisma.contactSettings.findFirst({
      where: {
        businessId: business_id,
        contactPhone: cleanPhone
      }
    });
    
    if (settings) {
      settings = await prisma.contactSettings.update({
        where: { id: settings.id },
        data: { botDisabled }
      });
    } else {
      settings = await prisma.contactSettings.create({
        data: {
          businessId: business_id,
          contactPhone: cleanPhone,
          botDisabled
        }
      });
    }
    
    res.json({
      success: true,
      botDisabled: settings.botDisabled
    });
  } catch (error: any) {
    console.error('Toggle contact bot error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/contact/:contact_phone/extracted-data', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id } = req.query;
    
    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }
    
    const business = await prisma.business.findFirst({
      where: { id: business_id as string, userId: req.userId }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }
    
    const settings = await prisma.contactSettings.findFirst({
      where: {
        businessId: business_id as string,
        contactPhone: contact_phone
      }
    });
    
    let extractedData: Record<string, any> = {};
    if (settings?.notes) {
      try {
        const parsed = JSON.parse(settings.notes);
        extractedData = parsed.extractedData || {};
      } catch {}
    }

    const currentTag = await prisma.tagAssignment.findUnique({
      where: {
        businessId_contactPhone: {
          businessId: business_id as string,
          contactPhone: contact_phone
        }
      },
      include: { tag: true }
    });
    
    res.json({
      extractedData,
      currentStage: currentTag?.tag ? {
        id: currentTag.tag.id,
        name: currentTag.tag.name,
        color: currentTag.tag.color
      } : null,
      assignedAt: currentTag?.assignedAt,
      source: currentTag?.source
    });
  } catch (error: any) {
    console.error('Get contact extracted data error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/contact/:contact_phone/reminder-status', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id } = req.query;
    
    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }
    
    const cleanPhone = contact_phone.replace(/\D/g, '').replace(/:.*$/, '');
    
    const contact = await prisma.contact.findUnique({
      where: {
        businessId_phone: {
          businessId: business_id as string,
          phone: cleanPhone
        }
      }
    });
    
    res.json({
      remindersPaused: contact?.remindersPaused || false
    });
  } catch (error: any) {
    console.error('Get contact reminder status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/contact/:contact_phone/reminder-toggle', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contact_phone } = req.params;
    const { business_id, remindersPaused } = req.body;
    
    if (!business_id) {
      res.status(400).json({ error: 'business_id is required' });
      return;
    }
    
    if (typeof remindersPaused !== 'boolean') {
      res.status(400).json({ error: 'remindersPaused must be a boolean' });
      return;
    }
    
    const cleanPhone = contact_phone.replace(/\D/g, '').replace(/:.*$/, '');
    
    const contact = await prisma.contact.upsert({
      where: {
        businessId_phone: {
          businessId: business_id,
          phone: cleanPhone
        }
      },
      update: { remindersPaused },
      create: {
        businessId: business_id,
        phone: cleanPhone,
        remindersPaused,
        firstMessageAt: new Date(),
        lastMessageAt: new Date()
      }
    });
    
    console.log(`[REMINDERS] Contact ${cleanPhone} reminders ${remindersPaused ? 'paused' : 'resumed'}`);
    
    res.json({
      success: true,
      remindersPaused: contact.remindersPaused
    });
  } catch (error: any) {
    console.error('Toggle contact reminder error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
