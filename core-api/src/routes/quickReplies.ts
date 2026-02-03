import { Router, Response } from 'express';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import prisma from '../services/prisma';

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

    const quickReplies = await prisma.quickReply.findMany({
      where: { businessId: business_id as string },
      orderBy: { order: 'asc' }
    });

    res.json(quickReplies);
  } catch (error: any) {
    console.error('[QUICK_REPLIES] Error fetching:', error);
    res.status(500).json({ error: 'Failed to fetch quick replies' });
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, shortcut, title, message, order } = req.body;
    
    if (!business_id || !shortcut || !title || !message) {
      res.status(400).json({ error: 'business_id, shortcut, title and message are required' });
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

    const cleanShortcut = shortcut.toLowerCase().replace(/[^a-z0-9_-]/g, '').substring(0, 30);
    if (!cleanShortcut) {
      res.status(400).json({ error: 'Shortcut must contain valid characters (a-z, 0-9, _, -)' });
      return;
    }

    const existing = await prisma.quickReply.findFirst({
      where: { businessId: business_id, shortcut: cleanShortcut }
    });
    if (existing) {
      res.status(409).json({ error: 'Shortcut already exists' });
      return;
    }

    const quickReply = await prisma.quickReply.create({
      data: {
        businessId: business_id,
        shortcut: cleanShortcut,
        title: title.substring(0, 100),
        message: message.substring(0, 2000),
        order: order || 0
      }
    });

    res.status(201).json(quickReply);
  } catch (error: any) {
    console.error('[QUICK_REPLIES] Error creating:', error);
    res.status(500).json({ error: 'Failed to create quick reply' });
  }
});

router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { shortcut, title, message, order } = req.body;

    const user = await getUserWithRole(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const quickReply = await prisma.quickReply.findUnique({
      where: { id },
      include: { business: true }
    });

    if (!quickReply) {
      res.status(404).json({ error: 'Quick reply not found' });
      return;
    }

    const hasAccess = await checkBusinessAccess(req.userId!, quickReply.businessId, user.role, user.parentUserId);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title.substring(0, 100);
    if (message !== undefined) updateData.message = message.substring(0, 2000);
    if (order !== undefined) updateData.order = order;
    
    if (shortcut !== undefined) {
      const cleanShortcut = shortcut.toLowerCase().replace(/[^a-z0-9_-]/g, '').substring(0, 30);
      if (!cleanShortcut) {
        res.status(400).json({ error: 'Shortcut must contain valid characters' });
        return;
      }
      const existing = await prisma.quickReply.findFirst({
        where: { businessId: quickReply.businessId, shortcut: cleanShortcut, NOT: { id } }
      });
      if (existing) {
        res.status(409).json({ error: 'Shortcut already exists' });
        return;
      }
      updateData.shortcut = cleanShortcut;
    }

    const updated = await prisma.quickReply.update({
      where: { id },
      data: updateData
    });

    res.json(updated);
  } catch (error: any) {
    console.error('[QUICK_REPLIES] Error updating:', error);
    res.status(500).json({ error: 'Failed to update quick reply' });
  }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const user = await getUserWithRole(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const quickReply = await prisma.quickReply.findUnique({
      where: { id }
    });

    if (!quickReply) {
      res.status(404).json({ error: 'Quick reply not found' });
      return;
    }

    const hasAccess = await checkBusinessAccess(req.userId!, quickReply.businessId, user.role, user.parentUserId);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.quickReply.delete({ where: { id } });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[QUICK_REPLIES] Error deleting:', error);
    res.status(500).json({ error: 'Failed to delete quick reply' });
  }
});

router.put('/reorder', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { business_id, items } = req.body;
    
    if (!business_id || !items || !Array.isArray(items)) {
      res.status(400).json({ error: 'business_id and items array are required' });
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

    await prisma.$transaction(
      items.map((item: { id: string; order: number }) =>
        prisma.quickReply.update({
          where: { id: item.id },
          data: { order: item.order }
        })
      )
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('[QUICK_REPLIES] Error reordering:', error);
    res.status(500).json({ error: 'Failed to reorder quick replies' });
  }
});

export default router;
