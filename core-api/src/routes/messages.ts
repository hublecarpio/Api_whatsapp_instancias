import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id, phone, limit = '50', offset = '0' } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const where: any = { businessId: business_id as string };
    if (phone) {
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
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const messages = await prisma.messageLog.findMany({
      where: { businessId: business_id as string },
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
      const phone = msg.sender || msg.recipient || 'unknown';
      if (phone === 'unknown') return;
      
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
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
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

export default router;
