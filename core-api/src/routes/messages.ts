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
    const { business_id, instance_id, include_archived } = req.query;
    
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
    
    let assignedPhones: string[] = [];
    const isAdvisor = user.role === 'ASESOR' || await isAdvisorForBusiness(req.userId!, business_id as string);
    if (isAdvisor) {
      assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (assignedPhones.length === 0) {
        return res.json([]);
      }
    }
    
    // Get list of archived instance IDs to filter out (unless include_archived is true)
    let archivedInstanceIds: string[] = [];
    if (include_archived !== 'true') {
      const archivedInstances = await prisma.whatsAppInstance.findMany({
        where: { 
          businessId: business_id as string,
          archivedAt: { not: null }
        },
        select: { id: true }
      });
      archivedInstanceIds = archivedInstances.map(i => i.id);
    }
    
    const whereClause: any = { businessId: business_id as string };
    
    if (instance_id) {
      whereClause.instanceId = instance_id as string;
    } else if (archivedInstanceIds.length > 0) {
      // Exclude messages from archived instances
      whereClause.OR = [
        { instanceId: { notIn: archivedInstanceIds } },
        { instanceId: null }
      ];
    }
    
    if (isAdvisor && assignedPhones.length > 0) {
      // Need to combine with assigned phones filter
      const phoneFilter = assignedPhones.flatMap(p => [{ sender: p }, { recipient: p }]);
      if (whereClause.OR) {
        // Complex: need both archived filter AND phone filter
        whereClause.AND = [
          { OR: whereClause.OR },
          { OR: phoneFilter }
        ];
        delete whereClause.OR;
      } else {
        whereClause.OR = phoneFilter;
      }
    }
    
    const messages = await prisma.messageLog.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });
    
    const conversationsMap = new Map<string, {
      phone: string;
      contactName: string;
      lastMessage: string | null;
      lastMessageAt: Date;
      lastMessageDirection: 'inbound' | 'outbound';
      messageCount: number;
      unread: number;
      instanceId: string | null;
    }>();
    
    messages.forEach(msg => {
      let phone: string;
      if (msg.direction === 'inbound') {
        phone = msg.sender || 'unknown';
      } else {
        phone = msg.recipient || 'unknown';
      }
      if (phone === 'unknown' || phone === 'bot' || phone === 'system') return;
      
      const metadata = msg.metadata as any;
      
      // Priority: use contactPhone from metadata (already resolved), then clean sender/recipient
      // This handles cases where the original sender was @lid but we have the resolved phone
      if (metadata?.contactPhone) {
        phone = metadata.contactPhone.toString().replace(/\D/g, '');
      } else {
        // Normalize phone: remove @s.whatsapp.net, @lid suffixes and keep only digits
        phone = phone.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
      }
      
      // Skip invalid phones (too short) or @lid numbers that weren't resolved (too long, typically 15+ digits)
      if (!phone || phone.length < 8 || phone.length > 15) return;
      
      const contactName = metadata?.contactName || metadata?.pushName || '';
      
      // Use phone+instanceId as key to separate conversations per instance
      const instanceId = msg.instanceId || 'default';
      const conversationKey = `${phone}_${instanceId}`;
      
      if (!conversationsMap.has(conversationKey)) {
        conversationsMap.set(conversationKey, {
          phone,
          contactName,
          lastMessage: msg.message,
          lastMessageAt: msg.createdAt,
          lastMessageDirection: msg.direction as 'inbound' | 'outbound',
          messageCount: 1,
          unread: msg.direction === 'inbound' ? 1 : 0,
          instanceId: msg.instanceId
        });
      } else {
        const conv = conversationsMap.get(conversationKey)!;
        conv.messageCount++;
        if (msg.direction === 'inbound') {
          conv.unread++;
        }
        if (!conv.contactName && contactName) {
          conv.contactName = contactName;
        }
      }
    });
    
    const conversations = Array.from(conversationsMap.values())
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
    
    res.json(conversations);
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
