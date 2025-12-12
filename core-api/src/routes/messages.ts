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

async function checkBusinessAccess(userId: string, businessId: string, role?: string, parentUserId?: string | null) {
  if (role === 'ASESOR' && parentUserId) {
    return prisma.business.findFirst({ where: { id: businessId, userId: parentUserId } });
  }
  return prisma.business.findFirst({ where: { id: businessId, userId } });
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
    
    if (user.role === 'ASESOR') {
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
    const { business_id } = req.query;
    
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
    if (user.role === 'ASESOR') {
      assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (assignedPhones.length === 0) {
        return res.json([]);
      }
    }
    
    const whereClause: any = { businessId: business_id as string };
    if (user.role === 'ASESOR' && assignedPhones.length > 0) {
      whereClause.OR = assignedPhones.flatMap(p => [{ sender: p }, { recipient: p }]);
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
      messageCount: number;
      unread: number;
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
      const contactName = metadata?.contactName || metadata?.pushName || '';
      
      if (!conversationsMap.has(phone)) {
        conversationsMap.set(phone, {
          phone,
          contactName,
          lastMessage: msg.message,
          lastMessageAt: msg.createdAt,
          messageCount: 1,
          unread: msg.direction === 'inbound' ? 1 : 0
        });
      } else {
        const conv = conversationsMap.get(phone)!;
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
    const { business_id } = req.query;
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
    
    if (user.role === 'ASESOR') {
      const assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (!assignedPhones.includes(phone)) {
        return res.status(403).json({ error: 'Access denied to this conversation' });
      }
    }
    
    const messages = await prisma.messageLog.findMany({
      where: {
        businessId: business_id as string,
        OR: [
          { sender: phone },
          { recipient: phone }
        ]
      },
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
    const { business_id } = req.query;
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
    
    if (user.role === 'ASESOR') {
      const assignedPhones = await getAssignedContactPhones(req.userId!, business_id as string);
      if (!assignedPhones.includes(phone)) {
        return res.status(403).json({ error: 'Access denied to this conversation' });
      }
    }
    
    const instance = await prisma.whatsAppInstance.findFirst({
      where: { businessId: business_id as string },
      include: { metaCredential: true }
    });
    
    if (!instance) {
      return res.json({ 
        provider: null,
        requiresTemplate: false,
        windowOpen: true,
        message: 'No WhatsApp instance'
      });
    }
    
    if (instance.provider !== 'META_CLOUD') {
      return res.json({
        provider: 'BAILEYS',
        requiresTemplate: false,
        windowOpen: true,
        message: 'Baileys does not require templates'
      });
    }
    
    const lastInboundMessage = await prisma.messageLog.findFirst({
      where: {
        businessId: business_id as string,
        sender: phone,
        direction: 'inbound'
      },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!lastInboundMessage) {
      return res.json({
        provider: 'META_CLOUD',
        requiresTemplate: true,
        windowOpen: false,
        lastClientMessage: null,
        message: 'No previous messages from client - template required to initiate'
      });
    }
    
    const hoursSinceLastMessage = (Date.now() - lastInboundMessage.createdAt.getTime()) / (1000 * 60 * 60);
    const windowOpen = hoursSinceLastMessage < 24;
    
    return res.json({
      provider: 'META_CLOUD',
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

export default router;
