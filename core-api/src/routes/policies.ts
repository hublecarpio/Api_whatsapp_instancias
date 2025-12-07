import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

async function checkBusinessAccess(userId: string, businessId: string) {
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, shippingPolicy, refundPolicy, brandVoice, allowedHours } = req.body;
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existing = await prisma.policy.findUnique({ where: { businessId } });
    if (existing) {
      return res.status(400).json({ error: 'Policy already exists, use PUT to update' });
    }
    
    const policy = await prisma.policy.create({
      data: { businessId, shippingPolicy, refundPolicy, brandVoice, allowedHours }
    });
    
    res.status(201).json(policy);
  } catch (error) {
    console.error('Create policy error:', error);
    res.status(500).json({ error: 'Failed to create policy' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id query param is required' });
    }
    
    const business = await checkBusinessAccess(req.userId!, business_id as string);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const policy = await prisma.policy.findUnique({
      where: { businessId: business_id as string }
    });
    
    res.json(policy || null);
  } catch (error) {
    console.error('Get policy error:', error);
    res.status(500).json({ error: 'Failed to get policy' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { shippingPolicy, refundPolicy, brandVoice, allowedHours } = req.body;
    
    const existing = await prisma.policy.findUnique({
      where: { id: req.params.id },
      include: { business: { select: { userId: true } } }
    });
    
    if (!existing || existing.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    
    const policy = await prisma.policy.update({
      where: { id: req.params.id },
      data: { 
        shippingPolicy: shippingPolicy ?? existing.shippingPolicy,
        refundPolicy: refundPolicy ?? existing.refundPolicy,
        brandVoice: brandVoice ?? existing.brandVoice,
        allowedHours: allowedHours ?? existing.allowedHours
      }
    });
    
    res.json(policy);
  } catch (error) {
    console.error('Update policy error:', error);
    res.status(500).json({ error: 'Failed to update policy' });
  }
});

export default router;
