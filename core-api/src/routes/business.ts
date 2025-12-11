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
    const { name, description, industry, logoUrl, agentVersion, timezone, currencyCode, currencySymbol, businessObjective } = req.body;
    
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (agentVersion === 'v2') {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { isPro: true }
      });
      
      if (!user?.isPro) {
        return res.status(403).json({ error: 'Agent V2 solo esta disponible para usuarios Pro. Contacta a soporte para actualizar tu plan.' });
      }
    }
    
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (industry !== undefined) updateData.industry = industry;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (currencyCode !== undefined) updateData.currencyCode = currencyCode;
    if (currencySymbol !== undefined) updateData.currencySymbol = currencySymbol;
    if (businessObjective !== undefined && ['SALES', 'APPOINTMENTS'].includes(businessObjective)) {
      updateData.businessObjective = businessObjective;
    }
    if (agentVersion !== undefined && ['v1', 'v2'].includes(agentVersion)) {
      updateData.agentVersion = agentVersion;
    }
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: updateData
    });
    
    res.json(business);
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({ error: 'Failed to update business' });
  }
});

router.get('/:id/openai', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const openaiConfigured = !!process.env.OPENAI_API_KEY;
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    
    res.json({ 
      id: existing.id,
      openaiConfigured,
      openaiModel,
      message: 'OpenAI is managed centrally by administrator'
    });
  } catch (error) {
    console.error('Get OpenAI config error:', error);
    res.status(500).json({ error: 'Failed to get OpenAI config' });
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

router.post('/:id/generate-injection-code', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const code = Math.random().toString(36).substring(2, 8).toUpperCase() + 
                 Math.random().toString(36).substring(2, 6).toUpperCase();
    
    const business = await prisma.business.update({
      where: { id: req.params.id },
      data: { injectionCode: code }
    });
    
    res.json({ 
      injectionCode: business.injectionCode,
      gptUrl: process.env.GPT_PROMPT_URL || null
    });
  } catch (error) {
    console.error('Generate injection code error:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

router.get('/:id/injection-code', async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.userId },
      select: { injectionCode: true }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json({ 
      injectionCode: business.injectionCode,
      gptUrl: process.env.GPT_PROMPT_URL || null
    });
  } catch (error) {
    console.error('Get injection code error:', error);
    res.status(500).json({ error: 'Failed to get code' });
  }
});

export default router;
