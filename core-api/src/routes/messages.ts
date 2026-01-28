import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function getUserWithRole(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, parentUserId: true }
  });
}

async function isAdvisorForBusiness(userId: string, businessId: string): Promise<boolean> {
  const userBusinessRole = await prisma.userBusinessRole.findUnique({
    where: {
      userId_businessId: { userId, businessId }
    }
  });
  return userBusinessRole?.role === 'ADVISOR' && userBusinessRole?.isActive === true;
}

async function checkBusinessAccess(userId: string, businessId: string, role?: string, parentUserId?: string | null) {
  if (role === 'ASESOR' && parentUserId) {
    return prisma.business.findFirst({ where: { id: businessId, userId: parentUserId } });
  }
  const ownBusiness = await prisma.business.findFirst({ where: { id: businessId, userId } });
  if (ownBusiness) return ownBusiness;
  
  const isAdvisor = await isAdvisorForBusiness(userId, businessId);
  if (isAdvisor) {
    return prisma.business.findFirst({ where: { id: businessId } });
  }
  return null;
}

async function getAssignedContactPhones(userId: string, businessId: string) {
  const assignments = await prisma.contactAssignment.findMany({
    where: { userId, businessId },
    select: { contactPhone: true }
  });
  return assignments.map(a => a.contactPhone);
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, phone, limit = '50', offset = '0' } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const user = await getUserWithRole(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const where: any = { businessId: business_id as string };
    
    const isAdvisorRole = user.role === 'ASESOR' || await isAdvisorForBusiness(req.userId!, business_id as string);
    if (isAdvisorRole) {
      const assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (assignedPhones.length === 0) {
        return res.json([]);
      }
      where.OR = assignedPhones.flatMap(p => [{ sender: p }, { recipient: p }]);
    } else if (phone) {
      where.OR = [
        { sender: phone as string },
        { recipient: phone as string }
      ];
    }
    
    const messages = await prisma.messageLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string)
    });
    
    res.json(messages);
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

router.get('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const { 
      business_id, 
      instance_id, 
      include_archived,
      limit = '50',
      offset = '0',
      tag_id,
      search
    } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const limitNum = Math.min(parseInt(limit as string) || 50, 100);
    const offsetNum = parseInt(offset as string) || 0;
    
    const user = await getUserWithRole(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    let assignedPhones: string[] = [];
    const isAdvisor = user.role === 'ASESOR' || await isAdvisorForBusiness(req.userId!, business_id as string);
    if (isAdvisor) {
      assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (assignedPhones.length === 0) {
        return res.json({ conversations: [], hasMore: false, total: 0 });
      }
    }
    
    // OPTIMIZED: Use Contact table with proper pagination instead of loading all messages
    const contactWhereClause: any = { 
      businessId: business_id as string,
      isArchived: include_archived === 'true' ? undefined : false
    };
    
    // Build phone filter conditions that need to be intersected
    let phoneFilterConditions: string[][] = [];
    
    // Filter by assigned phones for advisors
    if (isAdvisor && assignedPhones.length > 0) {
      phoneFilterConditions.push(assignedPhones);
    }
    
    // Filter by tag
    if (tag_id) {
      const tagAssignments = await prisma.tagAssignment.findMany({
        where: { 
          tagId: tag_id as string,
          tag: { businessId: business_id as string }
        },
        select: { contactPhone: true }
      });
      const tagFilterPhones = tagAssignments.map(ta => ta.contactPhone);
      if (tagFilterPhones.length === 0) {
        return res.json({ conversations: [], hasMore: false, total: 0 });
      }
      phoneFilterConditions.push(tagFilterPhones);
    }
    
    // Intersect all phone filters
    if (phoneFilterConditions.length > 0) {
      const intersectedPhones = phoneFilterConditions.reduce((acc, curr) => 
        acc.filter(phone => curr.includes(phone))
      );
      if (intersectedPhones.length === 0) {
        return res.json({ conversations: [], hasMore: false, total: 0 });
      }
      contactWhereClause.phone = { in: intersectedPhones };
    }
    
    // Apply search filter at DB level (combined with AND, not overwriting)
    if (search && typeof search === 'string' && search.trim()) {
      const searchTerm = search.trim();
      // If we already have a phone filter, add search as additional AND condition
      if (contactWhereClause.phone) {
        contactWhereClause.AND = [
          { phone: contactWhereClause.phone },
          { 
            OR: [
              { phone: { contains: searchTerm } },
              { name: { contains: searchTerm, mode: 'insensitive' } }
            ]
          }
        ];
        delete contactWhereClause.phone;
      } else {
        contactWhereClause.OR = [
          { phone: { contains: searchTerm } },
          { name: { contains: searchTerm, mode: 'insensitive' } }
        ];
      }
    }
    
    // Get total count (without pagination)
    const total = await prisma.contact.count({ where: contactWhereClause });
    
    // Get paginated contacts from Contact table (much faster than loading all messages)
    const contacts = await prisma.contact.findMany({
      where: contactWhereClause,
      orderBy: { lastMessageAt: 'desc' },
      skip: offsetNum,
      take: limitNum,
      select: {
        id: true,
        phone: true,
        name: true,
        lastMessageAt: true,
        messageCount: true,
        metadata: true
      }
    });
    
    if (contacts.length === 0) {
      return res.json({ conversations: [], hasMore: false, total: 0 });
    }
    
    // Get last message for each contact efficiently using batched queries
    // Process in batches of 10 to avoid saturating DB connection pool
    const BATCH_SIZE = 10;
    const lastMessageResults: Array<{ phone: string; lastMsg: any }> = [];
    
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (contact) => {
        // Build search patterns for this phone
        const phonePatterns = [
          contact.phone,
          `${contact.phone}@s.whatsapp.net`,
          `${contact.phone}@lid`
        ];
        
        // Build message query with optional instance_id filter
        const messageWhere: any = {
          businessId: business_id as string,
          OR: [
            { sender: { in: phonePatterns } },
            { recipient: { in: phonePatterns } }
          ]
        };
        
        // Filter by instance if specified
        if (instance_id) {
          messageWhere.instanceId = instance_id as string;
        }
        
        const lastMsg = await prisma.messageLog.findFirst({
          where: messageWhere,
          orderBy: { createdAt: 'desc' },
          select: {
            message: true,
            direction: true,
            instanceId: true
          }
        });
        
        return { phone: contact.phone, lastMsg };
      });
      
      const batchResults = await Promise.all(batchPromises);
      lastMessageResults.push(...batchResults);
    }
    
    // Create a map for quick lookup
    const lastMessageMap = new Map<string, {
      message: string | null;
      direction: string;
      instanceId: string | null;
    }>();
    lastMessageResults.forEach(({ phone, lastMsg }) => {
      if (lastMsg) {
        lastMessageMap.set(phone, {
          message: lastMsg.message,
          direction: lastMsg.direction,
          instanceId: lastMsg.instanceId
        });
      }
    });
    
    // Build conversation response
    const conversations = contacts.map(contact => {
      const lastMsg = lastMessageMap.get(contact.phone);
      return {
        phone: contact.phone,
        contactName: contact.name || '',
        lastMessage: lastMsg?.message || null,
        lastMessageAt: contact.lastMessageAt,
        lastMessageDirection: (lastMsg?.direction || 'inbound') as 'inbound' | 'outbound',
        messageCount: contact.messageCount,
        unread: 0, // Will be calculated separately if needed
        instanceId: lastMsg?.instanceId || null
      };
    });
    
    const hasMore = offsetNum + limitNum < total;
    
    res.json({ 
      conversations, 
      hasMore,
      total 
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

router.get('/conversation/:phone', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, instance_id } = req.query;
    const { phone } = req.params;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const user = await getUserWithRole(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const isAdvisorRole = user.role === 'ASESOR' || await isAdvisorForBusiness(req.userId!, business_id as string);
    if (isAdvisorRole) {
      const assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (!assignedPhones.includes(phone)) {
        return res.status(403).json({ error: 'Access denied to this conversation' });
      }
    }
    
    // Normalize phone to digits only
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Search for all possible formats of this phone number
    const phoneVariants = [
      cleanPhone,
      `${cleanPhone}@s.whatsapp.net`,
      `${cleanPhone}@lid`
    ];
    
    const whereClause: any = {
      businessId: business_id as string,
      OR: phoneVariants.flatMap(p => [
        { sender: p },
        { recipient: p }
      ])
    };
    
    if (instance_id) {
      whereClause.instanceId = instance_id as string;
    }
    
    const messages = await prisma.messageLog.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' }
    });
    
    res.json(messages);
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

router.get('/conversation/:phone/window-status', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, instance_id } = req.query;
    const { phone } = req.params;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const user = await getUserWithRole(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const isAdvisorRole = user.role === 'ASESOR' || await isAdvisorForBusiness(req.userId!, business_id as string);
    if (isAdvisorRole) {
      const assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (!assignedPhones.includes(phone)) {
        return res.status(403).json({ error: 'Access denied to this conversation' });
      }
    }
    
    // Find the specific instance if instance_id is provided, otherwise fall back to first
    const instanceWhere: any = { businessId: business_id as string };
    if (instance_id) {
      instanceWhere.id = instance_id as string;
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: instanceWhere,
      include: { metaCredential: true, metaCoexistCredential: true }
    });
    
    if (!instance) {
      return res.json({ 
        provider: null,
        requiresTemplate: false,
        windowOpen: true,
        message: 'No WhatsApp instance'
      });
    }
    
    // Baileys does not require templates
    if (instance.provider === 'BAILEYS') {
      return res.json({
        provider: 'BAILEYS',
        requiresTemplate: false,
        windowOpen: true,
        message: 'Baileys does not require templates'
      });
    }
    
    // META_CLOUD and META_COEXIST require template check
    const isMetaProvider = ['META_CLOUD', 'META_COEXIST'].includes(instance.provider);
    if (!isMetaProvider) {
      return res.json({
        provider: instance.provider,
        requiresTemplate: false,
        windowOpen: true,
        message: 'Unknown provider - assuming no template required'
      });
    }
    
    // Build query for last inbound message - filter by instance if provided
    const messageWhere: any = {
      businessId: business_id as string,
      sender: phone,
      direction: 'inbound'
    };
    if (instance_id) {
      messageWhere.instanceId = instance_id as string;
    }
    
    const lastInboundMessage = await prisma.messageLog.findFirst({
      where: messageWhere,
      orderBy: { createdAt: 'desc' }
    });
    
    if (!lastInboundMessage) {
      return res.json({
        provider: instance.provider,
        requiresTemplate: true,
        windowOpen: false,
        lastClientMessage: null,
        message: 'No previous messages from client - template required to initiate'
      });
    }
    
    const hoursSinceLastMessage = (Date.now() - lastInboundMessage.createdAt.getTime()) / (1000 * 60 * 60);
    const windowOpen = hoursSinceLastMessage < 24;
    
    return res.json({
      provider: instance.provider,
      requiresTemplate: !windowOpen,
      windowOpen,
      lastClientMessage: lastInboundMessage.createdAt,
      hoursSinceLastMessage: Math.round(hoursSinceLastMessage * 10) / 10,
      hoursRemaining: windowOpen ? Math.round((24 - hoursSinceLastMessage) * 10) / 10 : 0,
      message: windowOpen 
        ? `Window open - ${Math.round((24 - hoursSinceLastMessage) * 10) / 10}h remaining`
        : 'Window closed - template required'
    });
  } catch (error) {
    console.error('Get window status error:', error);
    res.status(500).json({ error: 'Failed to get window status' });
  }
});

router.delete('/conversation', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, phone, instance_id, include_orders, include_appointments } = req.query;
    
    if (!business_id || !phone) {
      return res.status(400).json({ error: 'business_id and phone are required' });
    }
    
    const user = await getUserWithRole(req.userId!);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string, user.role, user.parentUserId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const normalizedPhone = (phone as string).replace(/\D/g, '');
    const deletedCounts: Record<string, number> = {};
    
    const messageWhere: any = {
      businessId: business_id as string,
      OR: [
        { sender: { contains: normalizedPhone } },
        { recipient: { contains: normalizedPhone } }
      ]
    };
    if (instance_id) {
      messageWhere.instanceId = instance_id as string;
    }
    
    const messages = await prisma.messageLog.deleteMany({ where: messageWhere });
    deletedCounts.messages = messages.count;
    
    const extractedData = await prisma.contactExtractedData.deleteMany({
      where: { businessId: business_id as string, contactPhone: normalizedPhone }
    });
    deletedCounts.extractedData = extractedData.count;
    
    const funnelState = await prisma.contactFunnelState.deleteMany({
      where: { businessId: business_id as string, contactPhone: normalizedPhone }
    });
    deletedCounts.funnelState = funnelState.count;
    
    const tagAssignments = await prisma.tagAssignment.deleteMany({
      where: { businessId: business_id as string, contactPhone: normalizedPhone }
    });
    deletedCounts.tagAssignments = tagAssignments.count;
    
    const messageBuffer = await prisma.messageBuffer.deleteMany({
      where: { businessId: business_id as string, contactPhone: normalizedPhone }
    });
    deletedCounts.messageBuffer = messageBuffer.count;
    
    const intentLogs = await prisma.intentLog.deleteMany({
      where: { businessId: business_id as string, contactPhone: normalizedPhone }
    });
    deletedCounts.intentLogs = intentLogs.count;
    
    const reminders = await prisma.reminder.deleteMany({
      where: { businessId: business_id as string, contactPhone: normalizedPhone }
    });
    deletedCounts.reminders = reminders.count;
    
    if (include_orders === 'true') {
      const orders = await prisma.order.deleteMany({
        where: { businessId: business_id as string, contactPhone: normalizedPhone }
      });
      deletedCounts.orders = orders.count;
    }
    
    if (include_appointments === 'true') {
      const appointments = await prisma.appointment.deleteMany({
        where: { businessId: business_id as string, contactPhone: normalizedPhone }
      });
      deletedCounts.appointments = appointments.count;
    }
    
    console.log(`Deleted conversation for ${normalizedPhone}:`, deletedCounts);
    
    res.json({
      success: true,
      message: 'Conversation deleted successfully',
      deleted: deletedCounts
    });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
