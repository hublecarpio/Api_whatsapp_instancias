import { Router, Response } from 'express';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, industry, logoUrl } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Business name is required' });
    }
    
    const business = await prisma.business.create({
      data: {
        userId: req.userId!,
        name,
        description,
        industry,
        logoUrl
      }
    });
    
    res.status(201).json(business);
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const businesses = await prisma.business.findMany({
      where: { userId: req.userId },
      include: {
        instances: true,
        _count: { select: { products: true, messages: true } }
      }
    });
    
    res.json(businesses);
  } catch (error) {
    console.error('Get businesses error:', error);
    res.status(500).json({ error: 'Failed to get businesses' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: {
        instances: true,
        policy: true,
        promptMaster: true,
        _count: { select: { products: true, messages: true } }
      }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json(business);
  } catch (error) {
    console.error('Get business error:', error);
    res.status(500).json({ error: 'Failed to get business' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, industry, logoUrl } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { name, description, industry, logoUrl }
    });
    
    res.json(business);
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({ error: 'Failed to update business' });
  }
});

router.put('/:id/openai', async (req: AuthRequest, res: Response) => {
  try {
    const { openaiApiKey, openaiModel } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { 
        openaiApiKey: openaiApiKey || existing.openaiApiKey,
        openaiModel: openaiModel || existing.openaiModel
      }
    });
    
    res.json({ 
      id: business.id, 
      openaiModel: business.openaiModel,
      hasApiKey: !!business.openaiApiKey 
    });
  } catch (error) {
    console.error('Update OpenAI config error:', error);
    res.status(500).json({ error: 'Failed to update OpenAI config' });
  }
});

router.put('/:id/bot-toggle', async (req: AuthRequest, res: Response) => {
  try {
    const { botEnabled } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { botEnabled: botEnabled ?? !existing.botEnabled }
    });
    
    res.json({ id: business.id, botEnabled: business.botEnabled });
  } catch (error) {
    console.error('Toggle bot error:', error);
    res.status(500).json({ error: 'Failed to toggle bot' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.business.delete({ where: { id: req.params.id } });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

export default router;
